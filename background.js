const Core = globalThis.xNxPCore;

let tabInfoList = {};
let didStartupRestore = false;

const DEBUG_LOG_MAX = 80;
let debugMode = false;
let debugLogs = [];

let saveTabInfoTimer = null;
const SAVE_DEBOUNCE_MS = 300;

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

function generateTabKey(tabId) {
  return String(tabId);
}

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

function scheduleSaveTabInfoList() {
  if (saveTabInfoTimer) clearTimeout(saveTabInfoTimer);
  saveTabInfoTimer = setTimeout(async () => {
    saveTabInfoTimer = null;
    try {
      await browser.storage.local.set({ tabInfoList: tabInfoList });
      logDebug("tabInfoList saved", {
        tracked: Object.keys(tabInfoList).length,
      });
    } catch (err) {
      logDebug("tabInfoList save failed", err);
    }
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Sync in-memory history with live tabs.
 * First call after load uses URL restore for session restore; later calls
 * only match by tab id (never steal history between two open same-URL tabs).
 */
async function syncActiveTabs() {
  const tabs = await browser.tabs.query({});
  logDebug("syncActiveTabs query", {
    openTabs: tabs.length,
    mode: didStartupRestore ? "live" : "restore",
  });

  const mode = didStartupRestore ? "live" : "restore";
  tabInfoList = Core.mergeLiveTabsWithHistory(tabs, tabInfoList, { mode: mode });
  didStartupRestore = true;

  scheduleSaveTabInfoList();
  return tabs.length;
}

async function updateTabInfo(tabId, changeInfo, tab) {
  if (!tab) return;

  const shouldUpdate =
    changeInfo.status === "complete" ||
    changeInfo.title ||
    changeInfo.url ||
    changeInfo.active === true;

  if (!shouldUpdate) return;

  const tabKey = generateTabKey(tabId);
  // Only exact tab id — never pull history from another open tab by URL
  const existingTabInfo = tabInfoList[tabKey] || null;

  tabInfoList[tabKey] = Core.buildTabRecordFromLive(tab, existingTabInfo, {
    forceLastOpened: changeInfo.active === true,
  });

  scheduleSaveTabInfoList();
}

async function onTabActivated(activeInfo) {
  try {
    const tab = await browser.tabs.get(activeInfo.tabId);
    await updateTabInfo(activeInfo.tabId, { active: true }, tab);
  } catch (err) {
    logDebug("onTabActivated failed", err);
  }
}

async function onTabRemoved(tabId /*, removeInfo */) {
  const tabKey = generateTabKey(tabId);

  if (tabInfoList[tabKey]) {
    delete tabInfoList[tabKey];
    scheduleSaveTabInfoList();
  }
}

async function onTabCreated(tab) {
  const tabKey = generateTabKey(tab.id);

  if (tabInfoList[tabKey]) {
    return;
  }

  // Restored tabs often arrive with a real URL; do not stamp firstOpened=now.
  // Leave them for live id match or next restore-mode sync if still needed.
  const url = tab.url || "";
  const isLikelyRestoredTab =
    url !== "" &&
    !url.startsWith("about:") &&
    !url.startsWith("chrome://newtab") &&
    !url.startsWith("edge://newtab") &&
    !url.startsWith("chrome://new-tab-page");

  if (isLikelyRestoredTab) {
    return;
  }

  tabInfoList[tabKey] = Core.buildTabRecordFromLive(tab, null, {
    forceFirstOpened: true,
    forceLastOpened: true,
  });

  scheduleSaveTabInfoList();
}

async function handleSetDebugMode(enabled) {
  debugMode = !!enabled;
  await browser.storage.local.set({ debugMode: debugMode });
  logDebug("debugMode set", { debugMode: debugMode });
  return { ok: true, debugMode: debugMode };
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
      debugMode: debugMode,
      trackedTabs: Object.keys(tabInfoList).length,
      storageKeys: storageKeys,
      logs: debugLogs.slice(),
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      manifestVersion: 2,
      didStartupRestore: didStartupRestore,
    },
  };
}

browser.tabs.onCreated.addListener(onTabCreated);
browser.tabs.onUpdated.addListener(updateTabInfo);
browser.tabs.onActivated.addListener(onTabActivated);
browser.tabs.onRemoved.addListener(onTabRemoved);

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

(async () => {
  try {
    const result = await browser.storage.local.get([
      "tabInfoList",
      "debugMode",
      "debugLogs",
    ]);
    tabInfoList = result.tabInfoList || {};
    debugMode = !!result.debugMode;
    debugLogs = Array.isArray(result.debugLogs)
      ? result.debugLogs.slice(-DEBUG_LOG_MAX)
      : [];

    backfillTimestamps(tabInfoList);
    logDebug("background init start", {
      stored: Object.keys(tabInfoList).length,
      debugMode: debugMode,
    });

    // First sync uses restore mode (URL match for unmatched ids only)
    didStartupRestore = false;
    await syncActiveTabs();
    logDebug("background init done", {
      tracked: Object.keys(tabInfoList).length,
    });
  } catch (err) {
    console.error("Background initial load failed:", err);
    logDebug("background init failed", err);
  }
})();
