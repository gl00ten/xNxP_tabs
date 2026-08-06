// Chrome MV3 service worker: load polyfill + pure helpers first
importScripts("browser-polyfill.js", "lib/core.js");

const Core = globalThis.xNxPCore;

/** storage.session key: URL restore finished for this browser session. */
const SESSION_RESTORE_KEY = "startupRestoreDone";

let tabInfoList = {};
/** In-memory mirror; storage.session is the source of truth across SW restarts. */
let sessionRestoreCompleted = false;

const DEBUG_LOG_MAX = 80;
let debugMode = false;
let debugLogs = [];

let saveTabInfoTimer = null;
const SAVE_DEBOUNCE_MS = 300;

/** Single-flight init so messages wait until history is loaded + first sync runs. */
let readyPromise = null;

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

function hasSessionStorage() {
  return !!(
    typeof browser !== "undefined" &&
    browser.storage &&
    browser.storage.session
  );
}

/**
 * Session-lifetime flag: survives MV3 SW restarts, cleared when browser quits.
 * Falls back to in-memory only if storage.session is unavailable.
 */
async function loadSessionRestoreCompleted() {
  if (hasSessionStorage()) {
    try {
      const r = await browser.storage.session.get(SESSION_RESTORE_KEY);
      sessionRestoreCompleted = !!r[SESSION_RESTORE_KEY];
      return sessionRestoreCompleted;
    } catch (err) {
      logDebug("storage.session get failed", err);
    }
  }
  return sessionRestoreCompleted;
}

async function markSessionRestoreCompleted() {
  sessionRestoreCompleted = true;
  if (hasSessionStorage()) {
    try {
      await browser.storage.session.set({ [SESSION_RESTORE_KEY]: true });
    } catch (err) {
      logDebug("storage.session set failed", err);
    }
  }
}

async function saveTabInfoListNow() {
  if (saveTabInfoTimer) {
    clearTimeout(saveTabInfoTimer);
    saveTabInfoTimer = null;
  }
  try {
    await browser.storage.local.set({ tabInfoList: tabInfoList });
    logDebug("tabInfoList saved", {
      tracked: Object.keys(tabInfoList).length,
    });
  } catch (err) {
    logDebug("tabInfoList save failed", err);
    throw err;
  }
}

function scheduleSaveTabInfoList() {
  if (saveTabInfoTimer) clearTimeout(saveTabInfoTimer);
  saveTabInfoTimer = setTimeout(() => {
    saveTabInfoTimer = null;
    saveTabInfoListNow().catch(() => {});
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Sync in-memory history with live tabs.
 * URL restore only when session restore has not completed for this browser session.
 */
async function syncActiveTabs(options) {
  options = options || {};
  const tabs = await browser.tabs.query({});
  const mode = Core.getHistoryMergeMode(sessionRestoreCompleted);

  logDebug("syncActiveTabs query", {
    openTabs: tabs.length,
    mode: mode,
    sessionRestoreCompleted: sessionRestoreCompleted,
  });

  tabInfoList = Core.mergeLiveTabsWithHistory(tabs, tabInfoList, { mode: mode });

  if (mode === "restore") {
    // Persist history first, then mark session so a crash mid-save can re-restore
    if (options.flush) {
      await saveTabInfoListNow();
    } else {
      scheduleSaveTabInfoList();
    }
    await markSessionRestoreCompleted();
  } else if (options.flush) {
    await saveTabInfoListNow();
  } else {
    scheduleSaveTabInfoList();
  }

  return { openTabs: tabs.length, mode: mode };
}

async function updateTabInfo(tabId, changeInfo, tab) {
  if (!tab) return;
  await ensureReady();

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
    await ensureReady();
    const tab = await browser.tabs.get(activeInfo.tabId);
    await updateTabInfo(activeInfo.tabId, { active: true }, tab);
  } catch (err) {
    logDebug("onTabActivated failed", err);
  }
}

async function onTabRemoved(tabId /*, removeInfo */) {
  await ensureReady();
  const tabKey = generateTabKey(tabId);

  if (tabInfoList[tabKey]) {
    delete tabInfoList[tabKey];
    scheduleSaveTabInfoList();
  }
}

async function onTabCreated(tab) {
  await ensureReady();
  const tabKey = generateTabKey(tab.id);

  if (tabInfoList[tabKey]) {
    return;
  }

  // Restored tabs often arrive with a real URL; do not stamp firstOpened=now.
  // Leave them for id match or restore-mode sync if still needed this session.
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
  await ensureReady();
  debugMode = !!enabled;
  await browser.storage.local.set({ debugMode: debugMode });
  logDebug("debugMode set", { debugMode: debugMode });
  return { ok: true, debugMode: debugMode };
}

async function handleGetDebugReport() {
  await ensureReady();
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
      manifestVersion: 3,
      sessionRestoreCompleted: sessionRestoreCompleted,
      hasSessionStorage: hasSessionStorage(),
    },
  };
}

/**
 * Popup entry point: wait for init, run session-aware sync, flush save, return records.
 */
async function handleSyncAndGetTabInfo() {
  await ensureReady();
  const syncResult = await syncActiveTabs({ flush: true });
  return {
    ok: true,
    tabInfoList: tabInfoList,
    meta: {
      openTabs: syncResult.openTabs,
      tracked: Object.keys(tabInfoList).length,
      mode: syncResult.mode,
      sessionRestoreCompleted: sessionRestoreCompleted,
      source: "background-sync",
    },
  };
}

function ensureReady() {
  if (!readyPromise) {
    readyPromise = initializeBackground().catch((err) => {
      // Allow a later retry if init failed hard
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

async function initializeBackground() {
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
    await loadSessionRestoreCompleted();

    logDebug("background init start", {
      stored: Object.keys(tabInfoList).length,
      debugMode: debugMode,
      sessionRestoreCompleted: sessionRestoreCompleted,
    });

    // First sync this SW lifetime: restore only if not yet done this browser session
    await syncActiveTabs({ flush: true });
    logDebug("background init done", {
      tracked: Object.keys(tabInfoList).length,
      sessionRestoreCompleted: sessionRestoreCompleted,
    });
  } catch (err) {
    console.error("Background initial load failed:", err);
    logDebug("background init failed", err);
    throw err;
  }
}

browser.tabs.onCreated.addListener((tab) => {
  onTabCreated(tab).catch((err) => logDebug("onTabCreated failed", err));
});
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  updateTabInfo(tabId, changeInfo, tab).catch((err) =>
    logDebug("updateTabInfo failed", err)
  );
});
browser.tabs.onActivated.addListener((activeInfo) => {
  onTabActivated(activeInfo).catch((err) =>
    logDebug("onTabActivated failed", err)
  );
});
browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
  onTabRemoved(tabId, removeInfo).catch((err) =>
    logDebug("onTabRemoved failed", err)
  );
});

browser.runtime.onMessage.addListener((request) => {
  const type = typeof request === "string" ? request : request && request.type;

  if (type === "setDebugMode") {
    return handleSetDebugMode(!!(request && request.enabled));
  }
  if (type === "getDebugReport") {
    return handleGetDebugReport();
  }
  if (type === "syncAndGetTabInfo") {
    return handleSyncAndGetTabInfo();
  }

  return Promise.resolve({ ok: false, error: "Unknown request" });
});

// Kick off init; popup messages also await ensureReady()
ensureReady().catch((err) => {
  console.error("Background ensureReady failed:", err);
});
