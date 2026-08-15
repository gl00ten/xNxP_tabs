// Firefox MV2: polyfill + core loaded via manifest background.scripts
const Core = globalThis.xNxPCore;

// Session-scoped restore state (cleared when the browser quits).
const SESSION_RESTORE_DONE_KEY = "startupRestoreDone";
const SESSION_RESTORE_STARTED_KEY = "restoreStartedAt";
/** Keep URL-restore open this long for progressive session restore. */
const RESTORE_GRACE_MS = 20000;

let tabInfoList = {};
let sessionRestoreCompleted = false;
/** When restore mode began this browser session (ms), or null. */
let restoreStartedAt = null;

const DEBUG_LOG_MAX = 80;
let debugMode = false;
let debugLogs = [];

let saveTabInfoTimer = null;
const SAVE_DEBOUNCE_MS = 300;

/** One chain so merge / create / update / remove never interleave. */
let mutationChain = Promise.resolve();
let readyPromise = null;

// --- debug ---------------------------------------------------------------

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
    /* ignore */
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

// --- session restore -----------------------------------------------------

function hasSessionStorage() {
  return !!(
    typeof browser !== "undefined" &&
    browser.storage &&
    browser.storage.session
  );
}

/** URL usable as restore identity (not empty / new-tab / about:). */
function hasRestoreIdentityUrl(url) {
  url = url || "";
  if (!url) return false;
  if (url.startsWith("about:")) return false;
  if (url.startsWith("chrome://newtab")) return false;
  if (url.startsWith("edge://newtab")) return false;
  if (url.startsWith("chrome://new-tab-page")) return false;
  return true;
}

function liveRecord(tabKey) {
  const rec = tabInfoList[tabKey];
  if (!rec || Core.isPendingRestoreRecord(rec)) return null;
  return rec;
}

async function loadSessionRestoreState() {
  if (!hasSessionStorage()) return;
  try {
    const r = await browser.storage.session.get([
      SESSION_RESTORE_DONE_KEY,
      SESSION_RESTORE_STARTED_KEY,
    ]);
    sessionRestoreCompleted = !!r[SESSION_RESTORE_DONE_KEY];
    const started = r[SESSION_RESTORE_STARTED_KEY];
    restoreStartedAt =
      typeof started === "number" && isFinite(started) ? started : null;
  } catch (err) {
    logDebug("storage.session get failed", err);
  }
}

async function persistRestoreStartedAt(ts) {
  if (!hasSessionStorage()) return;
  try {
    await browser.storage.session.set({ [SESSION_RESTORE_STARTED_KEY]: ts });
  } catch (err) {
    logDebug("storage.session set startedAt failed", err);
  }
}

async function markSessionRestoreCompleted() {
  sessionRestoreCompleted = true;
  restoreStartedAt = null;
  if (!hasSessionStorage()) return;
  try {
    await browser.storage.session.set({
      [SESSION_RESTORE_DONE_KEY]: true,
      [SESSION_RESTORE_STARTED_KEY]: null,
    });
  } catch (err) {
    logDebug("storage.session set done failed", err);
  }
}

async function ensureRestoreWindowStarted() {
  if (sessionRestoreCompleted || restoreStartedAt != null) return;
  restoreStartedAt = Date.now();
  await persistRestoreStartedAt(restoreStartedAt);
}

function restoreGraceExpired() {
  return (
    restoreStartedAt != null &&
    Date.now() - restoreStartedAt >= RESTORE_GRACE_MS
  );
}

/**
 * End restore mode when pending history is gone, grace elapsed, or forced.
 * Drops leftover pending records and persists.
 */
async function maybeFinishRestore(force) {
  if (sessionRestoreCompleted) return false;
  const pending = Core.countPendingRestoreRecords(tabInfoList);
  if (!force && pending > 0 && !restoreGraceExpired()) return false;

  tabInfoList = Core.stripPendingRestoreRecords(tabInfoList);
  await saveTabInfoListNow();
  await markSessionRestoreCompleted();
  logDebug("session restore completed", {
    forced: !!force,
    pendingBefore: pending,
  });
  return true;
}

/** Claim one live tab against pending history. Returns true if claimed. */
async function tryClaimPending(tab) {
  if (sessionRestoreCompleted || !tab) return false;
  if (!hasRestoreIdentityUrl(tab.url)) return false;
  const claimed = Core.claimPendingRestoreForTab(tabInfoList, tab);
  if (!claimed.claimed) return false;
  tabInfoList = claimed.list;
  scheduleSaveTabInfoList();
  await maybeFinishRestore(false);
  return true;
}

// --- mutation queue + persistence ----------------------------------------

function enqueueTabMutation(fn) {
  const run = mutationChain.then(() => fn());
  mutationChain = run.then(
    () => undefined,
    (err) => {
      logDebug("tab mutation failed", err);
    }
  );
  return run;
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
      pending: Core.countPendingRestoreRecords(tabInfoList),
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
    // Run on the queue so we never write a half-updated list.
    enqueueTabMutation(() => saveTabInfoListNow()).catch(() => {});
  }, SAVE_DEBOUNCE_MS);
}

// --- tab list mutations (always via the queue) ---------------------------

async function doSyncActiveTabs(options) {
  options = options || {};
  const tabs = await browser.tabs.query({});
  const mode = Core.getHistoryMergeMode(sessionRestoreCompleted);

  logDebug("syncActiveTabs", {
    openTabs: tabs.length,
    mode: mode,
    sessionRestoreCompleted: sessionRestoreCompleted,
  });

  tabInfoList = Core.mergeLiveTabsWithHistory(tabs, tabInfoList, { mode: mode });

  if (mode === "restore") {
    await ensureRestoreWindowStarted();
    const finished = await maybeFinishRestore(!!options.forceCompleteRestore);
    if (!finished) {
      if (options.flush) await saveTabInfoListNow();
      else scheduleSaveTabInfoList();
    }
  } else if (options.flush) {
    await saveTabInfoListNow();
  } else {
    scheduleSaveTabInfoList();
  }

  return {
    openTabs: tabs.length,
    mode: mode,
    pendingRestore: Core.countPendingRestoreRecords(tabInfoList),
  };
}

/** True when this window is the one the user is looking at. */
async function isWindowFocused(windowId) {
  if (windowId == null) return false;
  try {
    const win = await browser.windows.get(windowId);
    return !!win.focused;
  } catch (_) {
    return false;
  }
}

async function doUpdateTabInfo(tabId, changeInfo, tab) {
  if (!tab) return;

  const shouldUpdate =
    changeInfo.status === "complete" ||
    changeInfo.title ||
    changeInfo.url ||
    changeInfo.active === true ||
    changeInfo.userAttention === true ||
    changeInfo.discarded !== undefined ||
    changeInfo.audible !== undefined;
  if (!shouldUpdate) return;

  const tabKey = String(tabId);

  // Still restoring: claim by URL, or wait until the tab has a real URL.
  if (!sessionRestoreCompleted) {
    await ensureRestoreWindowStarted();
    if (await tryClaimPending(tab)) return;

    if (!hasRestoreIdentityUrl(tab.url)) {
      // No identity yet — don't stamp "first opened = now".
      await maybeFinishRestore(false);
      return;
    }

    // Real URL, no pending match: new tab opened during the restore window.
    // firstOpened = now; lastOpened only if this window is focused.
    if (!liveRecord(tabKey)) {
      const focused = await isWindowFocused(tab.windowId);
      tabInfoList[tabKey] = Core.buildTabRecordFromLive(tab, null, {
        forceFirstOpened: true,
        forceLastOpened: focused,
      });
      scheduleSaveTabInfoList();
      await maybeFinishRestore(false);
      return;
    }
  }

  // lastOpened only on real attention: focused window + (activation or focus).
  let forceLast = false;
  if (changeInfo.userAttention === true) {
    forceLast = true;
  } else if (changeInfo.active === true) {
    forceLast = await isWindowFocused(tab.windowId);
  }

  const existing = liveRecord(tabKey);
  tabInfoList[tabKey] = Core.buildTabRecordFromLive(tab, existing, {
    forceLastOpened: forceLast,
  });
  scheduleSaveTabInfoList();
}

async function doOnTabRemoved(tabId) {
  const tabKey = String(tabId);
  if (liveRecord(tabKey)) {
    delete tabInfoList[tabKey];
    scheduleSaveTabInfoList();
  }
}

async function doOnTabCreated(tab) {
  const tabKey = String(tab.id);
  if (liveRecord(tabKey)) return;

  if (!sessionRestoreCompleted) {
    await ensureRestoreWindowStarted();
    if (await tryClaimPending(tab)) return;
    // Wait for a real URL (via onUpdated) before stamping a new record.
    if (!hasRestoreIdentityUrl(tab.url)) {
      await maybeFinishRestore(false);
      return;
    }
  }

  // New tab: firstOpened always. lastOpened only if the user is looking.
  const focused = await isWindowFocused(tab.windowId);
  tabInfoList[tabKey] = Core.buildTabRecordFromLive(tab, null, {
    forceFirstOpened: true,
    forceLastOpened: focused,
  });
  scheduleSaveTabInfoList();
  if (!sessionRestoreCompleted) await maybeFinishRestore(false);
}

// --- public entry points -------------------------------------------------

async function syncActiveTabs(options) {
  await ensureReady();
  return enqueueTabMutation(() => doSyncActiveTabs(options));
}

async function updateTabInfo(tabId, changeInfo, tab) {
  if (!tab) return;
  await ensureReady();
  return enqueueTabMutation(() => doUpdateTabInfo(tabId, changeInfo, tab));
}

async function onTabActivated(activeInfo) {
  try {
    await ensureReady();
    const tab = await browser.tabs.get(activeInfo.tabId);
    // tabs.onActivated also fires for the active tab in unfocused windows
    // (new window, background window). Only count focused windows.
    await updateTabInfo(activeInfo.tabId, { active: true }, tab);
  } catch (err) {
    logDebug("onTabActivated failed", err);
  }
}

/** User focused a window → its active tab was just looked at. */
async function onWindowFocusChanged(windowId) {
  if (
    windowId === browser.windows.WINDOW_ID_NONE ||
    windowId == null
  ) {
    return;
  }
  try {
    await ensureReady();
    const tabs = await browser.tabs.query({ active: true, windowId: windowId });
    const tab = tabs && tabs[0];
    if (!tab) return;
    await updateTabInfo(tab.id, { userAttention: true }, tab);
  } catch (err) {
    logDebug("onWindowFocusChanged failed", err);
  }
}

async function onTabRemoved(tabId) {
  await ensureReady();
  return enqueueTabMutation(() => doOnTabRemoved(tabId));
}

async function onTabCreated(tab) {
  await ensureReady();
  return enqueueTabMutation(() => doOnTabCreated(tab));
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
    /* ignore */
  }
  return {
    ok: true,
    report: {
      generatedAt: new Date().toISOString(),
      debugMode: debugMode,
      trackedTabs: Object.keys(Core.stripPendingRestoreRecords(tabInfoList))
        .length,
      pendingRestore: Core.countPendingRestoreRecords(tabInfoList),
      storageKeys: storageKeys,
      logs: debugLogs.slice(),
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      manifestVersion: 2,
      sessionRestoreCompleted: sessionRestoreCompleted,
      restoreStartedAt: restoreStartedAt,
      hasSessionStorage: hasSessionStorage(),
    },
  };
}

async function handleSyncAndGetTabInfo() {
  await ensureReady();
  const syncResult = await enqueueTabMutation(() =>
    doSyncActiveTabs({ flush: true })
  );
  const liveList = Core.stripPendingRestoreRecords(tabInfoList);
  return {
    ok: true,
    tabInfoList: liveList,
    meta: {
      openTabs: syncResult.openTabs,
      tracked: Object.keys(liveList).length,
      pendingRestore: syncResult.pendingRestore,
      mode: syncResult.mode,
      sessionRestoreCompleted: sessionRestoreCompleted,
      source: "background-sync",
    },
  };
}

function ensureReady() {
  if (!readyPromise) {
    readyPromise = initializeBackground().catch((err) => {
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
    await loadSessionRestoreState();

    logDebug("background init start", {
      stored: Object.keys(tabInfoList).length,
      pending: Core.countPendingRestoreRecords(tabInfoList),
      sessionRestoreCompleted: sessionRestoreCompleted,
      restoreStartedAt: restoreStartedAt,
    });

    await enqueueTabMutation(() => doSyncActiveTabs({ flush: true }));
    logDebug("background init done", {
      tracked: Object.keys(tabInfoList).length,
      pending: Core.countPendingRestoreRecords(tabInfoList),
      sessionRestoreCompleted: sessionRestoreCompleted,
    });
  } catch (err) {
    console.error("Background initial load failed:", err);
    logDebug("background init failed", err);
    throw err;
  }
}

// --- listeners -----------------------------------------------------------

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
browser.windows.onFocusChanged.addListener((windowId) => {
  onWindowFocusChanged(windowId).catch((err) =>
    logDebug("onWindowFocusChanged failed", err)
  );
});
browser.tabs.onRemoved.addListener((tabId) => {
  onTabRemoved(tabId).catch((err) => logDebug("onTabRemoved failed", err));
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

ensureReady().catch((err) => {
  console.error("Background ensureReady failed:", err);
});
