let tabInfoList = {};

const DEBUG_LOG_MAX = 80;
let debugMode = false;
let debugLogs = [];

function logDebug(message, data = null) {
  if (!debugMode) return;

  const entry = {
    t: new Date().toISOString(),
    msg: message,
    data: data == null ? null : sanitizeDebugData(data),
  };

  debugLogs.push(entry);
  if (debugLogs.length > DEBUG_LOG_MAX) {
    debugLogs = debugLogs.slice(-DEBUG_LOG_MAX);
  }

  try {
    console.log("[xNxP Tabs]", message, data ?? "");
  } catch (_) {
    // ignore
  }

  // Fire-and-forget persist (best effort)
  browser.storage.local.set({ debugLogs }).catch(() => {});
}

function sanitizeDebugData(data) {
  try {
    if (data instanceof Error) {
      return { name: data.name, message: data.message, stack: data.stack };
    }
    return JSON.parse(JSON.stringify(data));
  } catch (_) {
    return String(data);
  }
}

// Generate a stable key for each browser tab
function generateTabKey(tabId) {
  return String(tabId);
}

function generateRestoreKey(tab) {
  return tab.url || "";
}

// One-time migration helper for legacy records saved before we added *Ts fields.
function backfillTimestamps(list) {
  for (const key in list) {
    const r = list[key];
    if (r.firstOpened && !r.firstOpenedTs) {
      const p = Date.parse(r.firstOpened);
      r.firstOpenedTs = Number.isNaN(p) ? Date.now() : p;
    }
    if (r.lastOpened && !r.lastOpenedTs) {
      const p = Date.parse(r.lastOpened);
      r.lastOpenedTs = Number.isNaN(p) ? Date.now() : p;
    }
  }
}

function nowString() {
  return new Date().toLocaleString();
}

function nowTimestamp() {
  return Date.now();
}

// Shared helper to construct a tab record.
// Removes heavy duplication between onCreated, updateTabInfo, and syncActiveTabs
// while keeping the different "intent" cases explicit via options.
function buildTabRecord(tab, previousRecord = null, options = {}) {
  const {
    forceFirstOpened = false,
    forceLastOpened = false,
  } = options;

  const now = nowString();
  const nowTs = nowTimestamp();

  const firstOpened = forceFirstOpened || !previousRecord?.firstOpened
    ? now
    : previousRecord.firstOpened;

  const firstOpenedTs = forceFirstOpened || !previousRecord?.firstOpenedTs
    ? nowTs
    : previousRecord.firstOpenedTs;

  let lastOpened;
  let lastOpenedTs;

  if (forceLastOpened || (tab.active && !previousRecord?.lastOpened)) {
    lastOpened = now;
    lastOpenedTs = nowTs;
  } else if (previousRecord) {
    lastOpened = previousRecord.lastOpened || "";
    lastOpenedTs = previousRecord.lastOpenedTs || 0;
  } else {
    lastOpened = "";
    lastOpenedTs = 0;
  }

  // Fallback: if we have firstOpened but no lastOpened, use the firstOpened time.
  // This cleans up old data, restored tabs that were never activated,
  // and prevents blank "Last Opened" values in the UI.
  if (!lastOpened && firstOpened) {
    lastOpened = firstOpened;
    lastOpenedTs = firstOpenedTs;
  }

  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title || "",
    url: tab.url || "",
    favIconUrl: tab.favIconUrl || previousRecord?.favIconUrl || "",
    audible: !!tab.audible,
    firstOpened,
    firstOpenedTs,
    lastOpened,
    lastOpenedTs,
  };
}

async function syncActiveTabs() {
  const tabs = await browser.tabs.query({});
  logDebug("syncActiveTabs query", { openTabs: tabs.length });

  const oldTabInfoList = tabInfoList || {};
  const oldRecordsByRestoreKey = {};

  // Group old saved records by URL so restored tabs can inherit firstOpened
  for (let oldTabKey in oldTabInfoList) {
    const oldRecord = oldTabInfoList[oldTabKey];
    const restoreKey = oldRecord.url || "";

    if (!oldRecordsByRestoreKey[restoreKey]) {
      oldRecordsByRestoreKey[restoreKey] = [];
    }

    oldRecordsByRestoreKey[restoreKey].push(oldRecord);
  }

  const newTabInfoList = {};

  tabs.forEach(function (tab) {
    const tabKey = generateTabKey(tab.id);
    const restoreKey = generateRestoreKey(tab);
    const existingByTabId = oldTabInfoList[tabKey];

    let restoredRecord = null;

    if (oldRecordsByRestoreKey[restoreKey]?.length > 0) {
      // When multiple historical records exist for the same URL (very common),
      // pick the one with the oldest firstOpened time. This makes assignment
      // deterministic and biases toward preserving the true earliest time.
      const candidates = oldRecordsByRestoreKey[restoreKey];
      restoredRecord = candidates.reduce((best, current) => {
        const bestTs = best.firstOpenedTs || Infinity;
        const curTs = current.firstOpenedTs || Infinity;
        return curTs < bestTs ? current : best;
      });
      // Remove the chosen one from the pool
      const idx = candidates.indexOf(restoredRecord);
      if (idx > -1) candidates.splice(idx, 1);
    }

    const previousRecord = existingByTabId || restoredRecord;

    // No force* flags → prefers previousRecord values when available
    // (this is how we preserve historical firstOpened across restarts)
    newTabInfoList[tabKey] = buildTabRecord(tab, previousRecord);
  });

  tabInfoList = newTabInfoList;

  await browser.storage.local.set({ tabInfoList: tabInfoList });
  logDebug("syncActiveTabs saved", { tracked: Object.keys(tabInfoList).length });
  return tabs.length;
}

// Update tab info when a tab changes or becomes active
async function updateTabInfo(tabId, changeInfo, tab) {
  if (!tab) return;

  const shouldUpdate =
    changeInfo.status === "complete" ||
    changeInfo.title ||
    changeInfo.url ||
    changeInfo.active === true;

  if (!shouldUpdate) return;

  const tabKey = generateTabKey(tabId);
  let existingTabInfo = tabInfoList[tabKey];

  // If tab.id changed after browser restart, try to recover old record by URL
  if (!existingTabInfo && tab.url) {
    for (let oldTabKey in tabInfoList) {
      if (tabInfoList[oldTabKey].url === tab.url) {
        existingTabInfo = tabInfoList[oldTabKey];
        delete tabInfoList[oldTabKey];
        break;
      }
    }
  }

  // forceLastOpened when this update represents an activation event
  tabInfoList[tabKey] = buildTabRecord(tab, existingTabInfo, {
    forceLastOpened: changeInfo.active === true,
  });

  try {
    await browser.storage.local.set({ tabInfoList: tabInfoList });
  } catch (err) {
    logDebug("updateTabInfo storage failed", err);
  }
}

// Listener for onActivated event
async function onTabActivated(activeInfo) {
  try {
    const tab = await browser.tabs.get(activeInfo.tabId);
    await updateTabInfo(activeInfo.tabId, { active: true }, tab);
  } catch (err) {
    // Tab might have been closed
    logDebug("onTabActivated failed", err);
  }
}

// Listener for onRemoved event
async function onTabRemoved(tabId /*, removeInfo */) {
  const tabKey = generateTabKey(tabId);

  if (tabInfoList[tabKey]) {
    delete tabInfoList[tabKey];
    try {
      await browser.storage.local.set({ tabInfoList: tabInfoList });
    } catch (err) {
      logDebug("onTabRemoved storage failed", err);
    }
  }
}

// Listener for onCreated event.
// This is the correct place to record "firstOpened" for genuinely new tabs
// created by the user during a browsing session.
async function onTabCreated(tab) {
  const tabKey = generateTabKey(tab.id);

  // Defensive: shouldn't happen, but don't clobber existing data
  if (tabInfoList[tabKey]) {
    return;
  }

  // Key heuristic for session restore safety:
  // If the tab already has a real URL at the moment it is "created",
  // it is almost certainly a tab being restored by the browser after
  // startup / session restore. We must NOT stamp firstOpened = "now"
  // in this case, or we would destroy historical data.
  //
  // Normal user-created tabs (Ctrl+T, links with target="_blank", etc.)
  // usually arrive with empty url or an internal new-tab page.
  const url = tab.url || "";
  const isLikelyRestoredTab =
    url !== "" &&
    !url.startsWith("about:") &&
    !url.startsWith("chrome://newtab") &&
    !url.startsWith("edge://newtab") &&
    !url.startsWith("chrome://new-tab-page");

  if (isLikelyRestoredTab) {
    return; // Let syncActiveTabs + updateTabInfo's URL recovery handle it
  }

  // For genuinely new tabs we force both firstOpened and lastOpened to now.
  // This prevents blank "Last Opened" values for tabs the user just created.
  // If the user later activates the tab, updateTabInfo will set the real time.
  tabInfoList[tabKey] = buildTabRecord(tab, null, {
    forceFirstOpened: true,
    forceLastOpened: true,
  });

  try {
    await browser.storage.local.set({ tabInfoList: tabInfoList });
  } catch (err) {
    logDebug("onTabCreated storage failed", err);
  }
}

async function handleSetDebugMode(enabled) {
  debugMode = !!enabled;
  await browser.storage.local.set({ debugMode });
  logDebug("debugMode set", { debugMode });
  return { ok: true, debugMode };
}

async function handleGetDebugReport() {
  let storageKeys = [];
  try {
    const all = await browser.storage.local.get(null);
    storageKeys = Object.keys(all || {});
  } catch (_) {
    // ignore
  }

  return {
    ok: true,
    report: {
      generatedAt: new Date().toISOString(),
      debugMode,
      trackedTabs: Object.keys(tabInfoList).length,
      storageKeys,
      logs: debugLogs.slice(),
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      manifestVersion: 2,
    },
  };
}

// Register listeners as early as possible so we don't miss events
// during startup / session restore (especially onCreated for restored tabs).
browser.tabs.onCreated.addListener(onTabCreated);
browser.tabs.onUpdated.addListener(updateTabInfo);
browser.tabs.onActivated.addListener(onTabActivated);
browser.tabs.onRemoved.addListener(onTabRemoved);

// Return a Promise from the listener (polyfill + Firefox event pages handle this
// more reliably than sendResponse after long async work).
browser.runtime.onMessage.addListener((request) => {
  const type = typeof request === "string" ? request : request && request.type;

  if (type === "setDebugMode") {
    return handleSetDebugMode(!!(request && request.enabled));
  }
  if (type === "getDebugReport") {
    return handleGetDebugReport();
  }

  return Promise.resolve({ ok: false, error: "Unknown request" });
});

// Load stored data, then sync with open tabs
(async () => {
  try {
    const result = await browser.storage.local.get([
      "tabInfoList",
      "debugMode",
      "debugLogs",
    ]);
    tabInfoList = result.tabInfoList || {};
    debugMode = !!result.debugMode;
    debugLogs = Array.isArray(result.debugLogs) ? result.debugLogs.slice(-DEBUG_LOG_MAX) : [];

    backfillTimestamps(tabInfoList);
    logDebug("background init start", {
      stored: Object.keys(tabInfoList).length,
      debugMode,
    });

    await syncActiveTabs();
    logDebug("background init done", {
      tracked: Object.keys(tabInfoList).length,
    });
  } catch (err) {
    console.error("Background initial load failed:", err);
    logDebug("background init failed", err);
  }
})();
