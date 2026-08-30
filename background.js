// Firefox MV3: polyfill + core loaded via manifest background.scripts
// (Firefox uses event-page scripts; Chrome uses service_worker + importScripts.)
const Core = globalThis.xNxPCore;

// Session restore (cleared when the browser quits).
const SESSION_DONE_KEY = "startupRestoreDone";
const SESSION_STARTED_KEY = "restoreStartedAt";
const RESTORE_GRACE_MS = 20000;
const SAVE_DEBOUNCE_MS = 300;
const DEBUG_LOG_MAX = 80;

let tabInfoList = {};
let sessionRestoreCompleted = false;
let restoreStartedAt = null; // ms when restore window began, or null

let debugMode = false;
let debugLogs = [];

let saveTimer = null;
let mutationChain = Promise.resolve();
let readyPromise = null;

// --- small helpers -------------------------------------------------------

function logDebug(message, data = null) {
  if (!debugMode) return;
  const entry = {
    t: new Date().toISOString(),
    msg: message,
    data:
      data == null
        ? null
        : data instanceof Error
          ? { name: data.name, message: data.message }
          : data,
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
  // Debug only — do not spam storage on every log
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
  return !!(browser.storage && browser.storage.session);
}

/** URL good enough to match history during restore (not empty / new-tab). */
function hasIdentityUrl(url) {
  url = url || "";
  if (!url || url.startsWith("about:")) return false;
  if (url.startsWith("chrome://newtab")) return false;
  if (url.startsWith("edge://newtab")) return false;
  if (url.startsWith("chrome://new-tab-page")) return false;
  return true;
}

function liveRecord(tabKey) {
  const rec = tabInfoList[tabKey];
  return rec && !Core.isPendingRestoreRecord(rec) ? rec : null;
}

/** True if stored history fields we care about actually changed. */
function historyChanged(before, after) {
  if (!before) return true;
  return (
    before.url !== after.url ||
    before.title !== after.title ||
    before.windowId !== after.windowId ||
    before.discarded !== after.discarded ||
    before.audible !== after.audible ||
    before.favIconUrl !== after.favIconUrl ||
    before.firstOpenedTs !== after.firstOpenedTs ||
    before.lastOpenedTs !== after.lastOpenedTs
  );
}

async function windowFocused(windowId) {
  if (windowId == null) return false;
  try {
    return !!(await browser.windows.get(windowId)).focused;
  } catch (_) {
    return false;
  }
}

// --- session restore -----------------------------------------------------

async function loadSessionRestoreState() {
  if (!hasSessionStorage()) return;
  try {
    const r = await browser.storage.session.get([
      SESSION_DONE_KEY,
      SESSION_STARTED_KEY,
    ]);
    sessionRestoreCompleted = !!r[SESSION_DONE_KEY];
    const started = r[SESSION_STARTED_KEY];
    restoreStartedAt =
      typeof started === "number" && isFinite(started) ? started : null;
  } catch (err) {
    logDebug("session get failed", err);
  }
}

async function setSession(partial) {
  if (!hasSessionStorage()) return;
  try {
    await browser.storage.session.set(partial);
  } catch (err) {
    logDebug("session set failed", err);
  }
}

async function beginRestoreWindow() {
  if (sessionRestoreCompleted || restoreStartedAt != null) return;
  restoreStartedAt = Date.now();
  await setSession({ [SESSION_STARTED_KEY]: restoreStartedAt });
}

function restoreGraceExpired() {
  return (
    restoreStartedAt != null &&
    Date.now() - restoreStartedAt >= RESTORE_GRACE_MS
  );
}

/** Finish restore when pending is gone, grace elapsed, or forced. */
async function maybeFinishRestore(force) {
  if (sessionRestoreCompleted) return false;
  const pending = Core.countPendingRestoreRecords(tabInfoList);
  if (!force && pending > 0 && !restoreGraceExpired()) return false;

  tabInfoList = Core.stripPendingRestoreRecords(tabInfoList);
  await saveNow();
  sessionRestoreCompleted = true;
  restoreStartedAt = null;
  await setSession({
    [SESSION_DONE_KEY]: true,
    [SESSION_STARTED_KEY]: null,
  });
  logDebug("restore done", { forced: !!force, pendingBefore: pending });
  return true;
}

async function tryClaimPending(tab) {
  if (sessionRestoreCompleted || !tab || !hasIdentityUrl(tab.url)) return false;
  const claimed = Core.claimPendingRestoreForTab(tabInfoList, tab);
  if (!claimed.claimed) return false;
  tabInfoList = claimed.list;
  scheduleSave();
  await maybeFinishRestore(false);
  return true;
}

// --- queue + save --------------------------------------------------------

function enqueue(fn) {
  const run = mutationChain.then(fn);
  mutationChain = run.then(
    () => undefined,
    (err) => logDebug("mutation failed", err)
  );
  return run;
}

async function saveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    await browser.storage.local.set({ tabInfoList });
  } catch (err) {
    logDebug("save failed", err);
    throw err;
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    enqueue(() => saveNow()).catch(() => {});
  }, SAVE_DEBOUNCE_MS);
}

function putRecord(tabKey, next, previous) {
  tabInfoList[tabKey] = next;
  if (historyChanged(previous, next)) scheduleSave();
}

// --- mutations (always run on the queue) ---------------------------------

async function doSync(options) {
  options = options || {};
  const tabs = await browser.tabs.query({});
  const mode = Core.getHistoryMergeMode(sessionRestoreCompleted);

  tabInfoList = Core.mergeLiveTabsWithHistory(tabs, tabInfoList, { mode });

  if (mode === "restore") {
    await beginRestoreWindow();
    const done = await maybeFinishRestore(!!options.forceCompleteRestore);
    if (!done) {
      if (options.flush) await saveNow();
      else scheduleSave();
    }
  } else if (options.flush) {
    await saveNow();
  } else {
    scheduleSave();
  }

  return {
    openTabs: tabs.length,
    mode,
    pendingRestore: Core.countPendingRestoreRecords(tabInfoList),
  };
}

/**
 * Apply a live tab update.
 * changeInfo.userAttention = window focus (always counts as last-opened).
 * changeInfo.active = tab activated (only if that window is focused).
 */
async function doUpdate(tabId, changeInfo, tab) {
  if (!tab) return;

  // Ignore noise: pure title / loading status spam. Titles refresh on popup sync.
  const interesting =
    changeInfo.url ||
    changeInfo.active === true ||
    changeInfo.userAttention === true ||
    changeInfo.discarded !== undefined ||
    changeInfo.audible !== undefined;
  if (!interesting) return;

  const tabKey = String(tabId);

  // Progressive restore: claim pending history, or wait for a real URL.
  if (!sessionRestoreCompleted) {
    await beginRestoreWindow();
    if (await tryClaimPending(tab)) return;

    if (!hasIdentityUrl(tab.url)) {
      await maybeFinishRestore(false);
      return;
    }

    if (!liveRecord(tabKey)) {
      const focused = await windowFocused(tab.windowId);
      putRecord(
        tabKey,
        Core.buildTabRecordFromLive(tab, null, {
          forceFirstOpened: true,
          forceLastOpened: focused,
        }),
        null
      );
      await maybeFinishRestore(false);
      return;
    }
  }

  let forceLast = false;
  if (changeInfo.userAttention === true) {
    forceLast = true;
  } else if (changeInfo.active === true) {
    forceLast = await windowFocused(tab.windowId);
  }

  const previous = liveRecord(tabKey);
  const next = Core.buildTabRecordFromLive(tab, previous, {
    forceLastOpened: forceLast,
  });
  putRecord(tabKey, next, previous);
}

async function doRemove(tabId) {
  const tabKey = String(tabId);
  if (!liveRecord(tabKey)) return;
  delete tabInfoList[tabKey];
  scheduleSave();
}

async function doCreate(tab) {
  const tabKey = String(tab.id);
  if (liveRecord(tabKey)) return;

  if (!sessionRestoreCompleted) {
    await beginRestoreWindow();
    if (await tryClaimPending(tab)) return;
    if (!hasIdentityUrl(tab.url)) {
      await maybeFinishRestore(false);
      return;
    }
  }

  const focused = await windowFocused(tab.windowId);
  putRecord(
    tabKey,
    Core.buildTabRecordFromLive(tab, null, {
      forceFirstOpened: true,
      forceLastOpened: focused,
    }),
    null
  );
  if (!sessionRestoreCompleted) await maybeFinishRestore(false);
}

// --- public API (await ready, then queue) --------------------------------

function ensureReady() {
  if (!readyPromise) {
    readyPromise = init().catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

async function init() {
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
  await enqueue(() => doSync({ flush: true }));
  logDebug("init done", {
    tracked: Object.keys(tabInfoList).length,
    restoreDone: sessionRestoreCompleted,
  });
}

async function onActivated(activeInfo) {
  try {
    await ensureReady();
    const tab = await browser.tabs.get(activeInfo.tabId);
    await enqueue(() => doUpdate(tab.id, { active: true }, tab));
  } catch (err) {
    logDebug("onActivated failed", err);
  }
}

async function onFocusChanged(windowId) {
  if (windowId == null || windowId === browser.windows.WINDOW_ID_NONE) return;
  try {
    await ensureReady();
    const tabs = await browser.tabs.query({ active: true, windowId });
    const tab = tabs && tabs[0];
    if (!tab) return;
    await enqueue(() => doUpdate(tab.id, { userAttention: true }, tab));
  } catch (err) {
    logDebug("onFocusChanged failed", err);
  }
}

async function handleSyncAndGetTabInfo() {
  await ensureReady();
  const syncResult = await enqueue(() => doSync({ flush: true }));
  const live = Core.stripPendingRestoreRecords(tabInfoList);
  return {
    ok: true,
    tabInfoList: live,
    meta: {
      openTabs: syncResult.openTabs,
      tracked: Object.keys(live).length,
      pendingRestore: syncResult.pendingRestore,
      mode: syncResult.mode,
      sessionRestoreCompleted,
      source: "background-sync",
    },
  };
}

async function handleSetDebugMode(enabled) {
  await ensureReady();
  debugMode = !!enabled;
  await browser.storage.local.set({ debugMode });
  return { ok: true, debugMode };
}

async function handleGetDebugReport() {
  await ensureReady();
  let storageKeys = [];
  try {
    storageKeys = Object.keys((await browser.storage.local.get(null)) || {});
  } catch (_) {
    /* ignore */
  }
  return {
    ok: true,
    report: {
      generatedAt: new Date().toISOString(),
      debugMode,
      trackedTabs: Object.keys(Core.stripPendingRestoreRecords(tabInfoList))
        .length,
      pendingRestore: Core.countPendingRestoreRecords(tabInfoList),
      storageKeys,
      logs: debugLogs.slice(),
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      manifestVersion: 3,
      sessionRestoreCompleted,
      restoreStartedAt,
      hasSessionStorage: hasSessionStorage(),
    },
  };
}

// --- listeners -----------------------------------------------------------

browser.tabs.onCreated.addListener((tab) => {
  ensureReady()
    .then(() => enqueue(() => doCreate(tab)))
    .catch((err) => logDebug("onCreated failed", err));
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  ensureReady()
    .then(() => enqueue(() => doUpdate(tabId, changeInfo, tab)))
    .catch((err) => logDebug("onUpdated failed", err));
});

browser.tabs.onActivated.addListener((activeInfo) => {
  onActivated(activeInfo).catch((err) => logDebug("onActivated failed", err));
});

browser.windows.onFocusChanged.addListener((windowId) => {
  onFocusChanged(windowId).catch((err) =>
    logDebug("onFocusChanged failed", err)
  );
});

browser.tabs.onRemoved.addListener((tabId) => {
  ensureReady()
    .then(() => enqueue(() => doRemove(tabId)))
    .catch((err) => logDebug("onRemoved failed", err));
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
  console.error("Background init failed:", err);
});
