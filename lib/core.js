/**
 * Pure helpers for xNxP Tabs, usable in the extension and in Node unit tests.
 * UMD style export: attaches to globalThis.xNxPCore and module.exports.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.xNxPCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function isDiscardableUrl(url) {
    if (!url) return false;
    if (url.startsWith("about:")) return false;
    if (url.startsWith("moz-extension:")) return false;
    if (url.startsWith("chrome:")) return false;
    if (url.startsWith("chrome-extension:")) return false;
    if (url.startsWith("edge:")) return false;
    return true;
  }

  /**
   * For duplicate ranking: prefer our lastOpenedTs, else browser lastAccessed.
   * (lastAccessed is not used to advance stored "last opened" history.)
   */
  function getLastOpenedTsForTab(tab, tabInfoList) {
    const info =
      tabInfoList && tab.id != null ? tabInfoList[String(tab.id)] : null;
    const stored = info && info.lastOpenedTs ? info.lastOpenedTs : 0;
    const accessed = tab.lastAccessed || 0;
    if (stored && accessed) return Math.max(stored, accessed);
    if (stored) return stored;
    if (accessed) return accessed;
    return 0;
  }

  function tsToLocaleString(ts, fallbackStr) {
    if (ts) {
      try {
        return new Date(ts).toLocaleString();
      } catch (_) {
        /* fall through */
      }
    }
    return fallbackStr || "";
  }

  /**
   * Build a display/history record for one live tab.
   * @param {object|null} previousRecord - stored history for this tab id (or restored)
   * @param {object} options
   * @param {boolean} options.forceFirstOpened
   * @param {boolean} options.forceLastOpened
   * @param {number} options.nowMs
   */
  function buildTabRecordFromLive(tab, previousRecord, options) {
    options = options || {};
    const nowMs = options.nowMs != null ? options.nowMs : Date.now();
    const nowStr = options.nowStr || new Date(nowMs).toLocaleString();
    const accessed = tab.lastAccessed || 0;
    const accessedStr = tsToLocaleString(accessed, nowStr);

    let firstOpenedTs;
    let firstOpened;
    if (options.forceFirstOpened) {
      firstOpenedTs = nowMs;
      firstOpened = nowStr;
    } else if (previousRecord && previousRecord.firstOpenedTs) {
      firstOpenedTs = previousRecord.firstOpenedTs;
      firstOpened =
        previousRecord.firstOpened || tsToLocaleString(firstOpenedTs, nowStr);
    } else {
      firstOpenedTs = accessed || nowMs;
      firstOpened = accessed ? accessedStr : nowStr;
    }

    // "Last opened" = last time the user actually looked at the tab
    // (forceLastOpened). Do not advance it from tab.lastAccessed, browsers
    // update that for the active tab even in unfocused windows.
    let lastOpenedTs;
    let lastOpened;
    if (options.forceLastOpened) {
      lastOpenedTs = nowMs;
      lastOpened = nowStr;
    } else if (previousRecord && previousRecord.lastOpenedTs) {
      lastOpenedTs = previousRecord.lastOpenedTs;
      lastOpened =
        previousRecord.lastOpened || tsToLocaleString(lastOpenedTs, nowStr);
    } else if (accessed) {
      lastOpenedTs = accessed;
      lastOpened = accessedStr;
    } else {
      lastOpenedTs = firstOpenedTs;
      lastOpened = firstOpened;
    }

    return {
      id: tab.id,
      windowId: tab.windowId,
      title: tab.title || "",
      url: tab.url || "",
      favIconUrl:
        tab.favIconUrl || (previousRecord && previousRecord.favIconUrl) || "",
      audible: !!tab.audible,
      discarded: !!tab.discarded,
      firstOpened: firstOpened,
      firstOpenedTs: firstOpenedTs,
      lastOpened: lastOpened,
      lastOpenedTs: lastOpenedTs,
    };
  }

  /** Prefix when a pending restore record cannot keep its original storage key. */
  const PENDING_RESTORE_KEY_PREFIX = "p:";

  function isPendingRestoreRecord(rec) {
    return !!(rec && rec.pendingRestore);
  }

  function countPendingRestoreRecords(list) {
    if (!list || typeof list !== "object") return 0;
    let n = 0;
    for (const key of Object.keys(list)) {
      if (isPendingRestoreRecord(list[key])) n += 1;
    }
    return n;
  }

  /**
   * Drop unmatched startup placeholders so the popup only sees live tabs.
   */
  function stripPendingRestoreRecords(list) {
    if (!list || typeof list !== "object") return {};
    const out = {};
    for (const key of Object.keys(list)) {
      const rec = list[key];
      if (isPendingRestoreRecord(rec)) continue;
      out[key] = rec;
    }
    return out;
  }

  function clonePendingRestoreRecord(rec) {
    return {
      id: rec.id,
      windowId: rec.windowId,
      title: rec.title || "",
      url: rec.url || "",
      favIconUrl: rec.favIconUrl || "",
      audible: false,
      discarded: false,
      firstOpened: rec.firstOpened,
      firstOpenedTs: rec.firstOpenedTs,
      lastOpened: rec.lastOpened,
      lastOpenedTs: rec.lastOpenedTs,
      pendingRestore: true,
    };
  }

  function allocatePendingRestoreKey(result, preferredKey) {
    let keepKey = preferredKey;
    if (!result[keepKey]) return keepKey;
    keepKey = PENDING_RESTORE_KEY_PREFIX + preferredKey;
    while (result[keepKey]) {
      keepKey = PENDING_RESTORE_KEY_PREFIX + keepKey;
    }
    return keepKey;
  }

  /**
   * Bind one newly appeared live tab to the oldest pending restore record
   * with the same non empty URL (progressive session restore).
   */
  function claimPendingRestoreForTab(list, tab, options) {
    options = options || {};
    if (!tab || tab.id == null) {
      return { list: list || {}, claimed: false };
    }
    const stored = list && typeof list === "object" ? list : {};
    const key = String(tab.id);
    const url = tab.url || "";
    if (!url) {
      return { list: stored, claimed: false };
    }

    let bestKey = null;
    let bestRec = null;
    let bestTs = Infinity;
    for (const sk of Object.keys(stored)) {
      const rec = stored[sk];
      if (!isPendingRestoreRecord(rec)) continue;
      if ((rec.url || "") !== url) continue;
      const ts = rec.firstOpenedTs != null ? rec.firstOpenedTs : Infinity;
      if (ts < bestTs) {
        bestTs = ts;
        bestKey = sk;
        bestRec = rec;
      }
    }
    if (!bestRec) {
      return { list: stored, claimed: false };
    }

    const next = {};
    for (const sk of Object.keys(stored)) {
      if (sk === bestKey) continue;
      next[sk] = stored[sk];
    }
    next[key] = buildTabRecordFromLive(tab, bestRec, options);
    return { list: next, claimed: true };
  }

  /**
   * URL restore runs once per browser session (storage.session survives
   * background restarts within that session).
   */
  function getHistoryMergeMode(sessionRestoreCompleted) {
    return sessionRestoreCompleted ? "live" : "restore";
  }

  /**
   * One sync step with session restore flag (tests + shared logic).
   * Completes restore when pending is empty, or forceCompleteRestore is set.
   *
   * @param {Array} liveTabs
   * @param {object} storedList
   * @param {{ restoreCompleted?: boolean }} sessionState
   * @param {object} [options] - nowMs, nowStr, forceCompleteRestore
   * @returns {{ list: object, mode: string, sessionState: object, pendingRestore: number }}
   */
  function runSessionAwareSync(liveTabs, storedList, sessionState, options) {
    options = options || {};
    const state =
      sessionState && typeof sessionState === "object"
        ? sessionState
        : { restoreCompleted: false };
    const mode = getHistoryMergeMode(!!state.restoreCompleted);
    let list = mergeLiveTabsWithHistory(liveTabs, storedList, {
      mode: mode,
      nowMs: options.nowMs,
      nowStr: options.nowStr,
    });
    let pendingRestore = countPendingRestoreRecords(list);
    if (mode === "restore") {
      if (options.forceCompleteRestore) {
        list = stripPendingRestoreRecords(list);
        pendingRestore = 0;
        state.restoreCompleted = true;
      } else if (pendingRestore === 0) {
        state.restoreCompleted = true;
      }
    }
    return {
      list: list,
      mode: mode,
      sessionState: state,
      pendingRestore: pendingRestore,
    };
  }

  /**
   * Match live tabs to stored history.
   *
   * mode "live" (default while browsing):
   *   Only match by exact tab id (trust id; URL may change via navigation).
   *   Never move history between two open tabs that share a URL.
   *   Unmatched stored records are dropped (closed tabs).
   *
   * mode "restore" (startup only):
   *   1) Match by exact tab id only when stored and live URLs are equal
   *      and non empty (IDs are reused across browser restarts).
   *   2) Match remaining live tabs to remaining stored records by URL
   *      (prefer oldest firstOpenedTs). Never match empty URLs.
   *   3) Remaining live tabs get fresh history from lastAccessed.
   *   4) Unmatched stored URLs stay as pendingRestore placeholders
   *      until progressive session restore brings those tabs back.
   */
  function mergeLiveTabsWithHistory(liveTabs, storedList, options) {
    options = options || {};
    const mode = options.mode === "restore" ? "restore" : "live";
    const nowMs = options.nowMs != null ? options.nowMs : Date.now();
    const nowStr = options.nowStr || new Date(nowMs).toLocaleString();
    const stored = storedList && typeof storedList === "object" ? storedList : {};
    const usedStoredKeys = new Set();
    const result = {};

    // Pass 1: exact tab id (skip pending placeholders, they are not live)
    for (let i = 0; i < liveTabs.length; i++) {
      const tab = liveTabs[i];
      const key = String(tab.id);
      if (!stored[key] || usedStoredKeys.has(key)) continue;
      if (isPendingRestoreRecord(stored[key])) continue;

      if (mode === "restore") {
        const storedUrl = stored[key].url || "";
        const liveUrl = tab.url || "";
        // IDs recycle after full browser restart, require matching non empty URL
        if (!storedUrl || !liveUrl || storedUrl !== liveUrl) {
          continue;
        }
      }

      usedStoredKeys.add(key);
      result[key] = buildTabRecordFromLive(tab, stored[key], {
        nowMs: nowMs,
        nowStr: nowStr,
      });
    }

    // Pass 2 (restore only): URL match among unmatched stored records
    if (mode === "restore") {
      const byUrl = {};
      for (const sk of Object.keys(stored)) {
        if (usedStoredKeys.has(sk)) continue;
        const rec = stored[sk];
        if (!rec) continue;
        const url = rec.url || "";
        // Empty URL is not a real identity, never pool or match it
        if (!url) continue;
        if (!byUrl[url]) byUrl[url] = [];
        byUrl[url].push({ key: sk, rec: rec });
      }
      for (const url of Object.keys(byUrl)) {
        byUrl[url].sort(function (a, b) {
          const at = a.rec.firstOpenedTs || Infinity;
          const bt = b.rec.firstOpenedTs || Infinity;
          return at - bt;
        });
      }

      for (let i = 0; i < liveTabs.length; i++) {
        const tab = liveTabs[i];
        const key = String(tab.id);
        if (result[key]) continue;
        const url = tab.url || "";
        if (!url) continue;
        const pool = byUrl[url];
        if (pool && pool.length > 0) {
          const taken = pool.shift();
          usedStoredKeys.add(taken.key);
          result[key] = buildTabRecordFromLive(tab, taken.rec, {
            nowMs: nowMs,
            nowStr: nowStr,
          });
        }
      }
    }

    // Pass 3: remaining live tabs, no history (use lastAccessed).
    // Runs before pending retention so live ids always own their keys.
    for (let i = 0; i < liveTabs.length; i++) {
      const tab = liveTabs[i];
      const key = String(tab.id);
      if (result[key]) continue;
      result[key] = buildTabRecordFromLive(tab, null, {
        nowMs: nowMs,
        nowStr: nowStr,
      });
    }

    // Pass 4 (restore only): keep unmatched history for tabs not restored yet.
    // Rekey when the original storage key is already used by a live tab.
    if (mode === "restore") {
      for (const sk of Object.keys(stored)) {
        if (usedStoredKeys.has(sk)) continue;
        const rec = stored[sk];
        if (!rec) continue;
        const url = rec.url || "";
        if (!url) continue;
        const keepKey = allocatePendingRestoreKey(result, sk);
        result[keepKey] = clonePendingRestoreRecord(rec);
        usedStoredKeys.add(sk);
      }
    }

    return result;
  }

  /**
   * Unload listed tabs. Never unload any active tab (any window).
   */
  function selectUnloadListedIds(liveTabs, listedIds) {
    const listed = new Set(listedIds || []);
    return liveTabs
      .filter((t) => listed.has(t.id))
      .filter((t) => !t.active)
      .filter((t) => !t.pinned && !t.discarded && isDiscardableUrl(t.url))
      .map((t) => t.id);
  }

  /**
   * Tabs to unload in one window, keeping that window's active tab.
   */
  function selectUnloadInWindowIds(tabs) {
    return tabs
      .filter((t) => !t.active)
      .filter((t) => !t.pinned && !t.discarded && isDiscardableUrl(t.url))
      .map((t) => t.id);
  }

  /**
   * Exact URL duplicates. Keep the most recently accessed tab and the active
   * tab in the window where the action was started. Active tabs in other
   * windows are eligible, since every window has its own active tab.
   */
  function analyzeDuplicates(tabs, tabInfoList, protectedWindowId) {
    const byUrl = new Map();

    for (const tab of tabs) {
      if (tab.pinned) continue;
      if (!isDiscardableUrl(tab.url)) continue;
      const key = tab.url || "";
      if (!key) continue;
      if (!byUrl.has(key)) byUrl.set(key, []);
      byUrl.get(key).push(tab);
    }

    const toCloseIds = [];
    let groups = 0;

    for (const group of byUrl.values()) {
      if (group.length < 2) continue;
      groups += 1;

      const keepIds = new Set();
      for (const tab of group) {
        const protectActive =
          tab.active &&
          (protectedWindowId == null || tab.windowId === protectedWindowId);
        if (protectActive) keepIds.add(tab.id);
      }

      let best = group[0];
      let bestTs = getLastOpenedTsForTab(best, tabInfoList);
      for (let i = 1; i < group.length; i++) {
        const tab = group[i];
        const ts = getLastOpenedTsForTab(tab, tabInfoList);
        if (ts > bestTs) {
          best = tab;
          bestTs = ts;
        }
      }
      keepIds.add(best.id);

      for (const tab of group) {
        if (!keepIds.has(tab.id)) {
          toCloseIds.push(tab.id);
        }
      }
    }

    return { toCloseIds: toCloseIds, count: toCloseIds.length, groups: groups };
  }

  function countTabLoadStats(tabs) {
    let loaded = 0;
    let discarded = 0;
    for (const tab of tabs) {
      if (tab.discarded) discarded += 1;
      else loaded += 1;
    }
    return { total: tabs.length, loaded: loaded, discarded: discarded };
  }

  function formatWindowLabel(win, activeTab) {
    let label = (win && win.title) || "";
    if (label) {
      label = label
        .replace(/\s*[-–—]\s*Mozilla Firefox\s*$/i, "")
        .replace(/\s*[-–—]\s*Firefox Developer Edition\s*$/i, "")
        .replace(/\s*[-–—]\s*Firefox Nightly\s*$/i, "")
        .replace(/\s*[-–—]\s*Firefox\s*$/i, "")
        .replace(/\s*[-–—]\s*Nightly\s*$/i, "")
        .trim();
    }
    if (!label && activeTab) {
      label = activeTab.title || activeTab.url || "";
    }
    if (!label) {
      label = "Window " + (win && win.id != null ? win.id : "?");
    }
    return label;
  }

  const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS_SHORT = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  function formatDateParts(timestamp, fallbackText, options) {
    if (fallbackText === undefined) fallbackText = "";
    options = options || {};
    if (!timestamp) {
      return fallbackText ? { date: fallbackText, time: "" } : null;
    }

    const date = new Date(timestamp);
    const weekday = WEEKDAYS_SHORT[date.getDay()] || "";
    const month = MONTHS_SHORT[date.getMonth()] || "";
    const day = String(date.getDate());
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");

    // Same calendar year: "Wed 30 Aug". Older/newer year: "Wed 30 Aug 24".
    const nowMs = options.nowMs != null ? options.nowMs : Date.now();
    const nowYear = new Date(nowMs).getFullYear();
    let dateLabel = weekday + " " + day + " " + month;
    if (date.getFullYear() !== nowYear) {
      dateLabel += " " + String(date.getFullYear()).slice(-2);
    }

    return {
      date: dateLabel,
      time: hour + ":" + minute,
    };
  }

  function getAgeT(timestamp, minTs, maxTs) {
    if (!timestamp || !isFinite(minTs) || !isFinite(maxTs) || minTs >= maxTs) {
      return null;
    }
    const t = (maxTs - timestamp) / (maxTs - minTs);
    if (!isFinite(t)) return null;
    return Math.min(1, Math.max(0, t));
  }

  function getAgeColors(timestamp, minTs, maxTs) {
    const t = getAgeT(timestamp, minTs, maxTs);
    if (t == null || t <= 0) return null;

    const hue = 210 - t * 182;
    const sat = 8 + t * 38;
    const light = 98.5 - t * 6;

    return {
      t: t,
      wash: "hsl(" + hue + ", " + sat + "%, " + light + "%)",
    };
  }

  function buildWindowUnloadRows(windows, currentWindowId) {
    const rows = windows.map((win) => {
      const tabs = win.tabs || [];
      const active = tabs.find((t) => t.active);
      const loaded = tabs.filter((t) => !t.discarded).length;
      const unloadIds = selectUnloadInWindowIds(tabs);
      return {
        win: win,
        tabs: tabs,
        loaded: loaded,
        unloadable: unloadIds.length,
        unloadIds: unloadIds,
        isCurrent: currentWindowId != null && win.id === currentWindowId,
        label: formatWindowLabel(win, active),
      };
    });

    rows.sort((a, b) => {
      if (b.unloadable !== a.unloadable) return b.unloadable - a.unloadable;
      return (a.win.id || 0) - (b.win.id || 0);
    });

    return rows;
  }

  /** Chrome/Chromium discard accepts a single id; Firefox accepts arrays. */
  function shouldDiscardOneByOne(userAgent) {
    const ua = userAgent || "";
    if (/Firefox\//i.test(ua)) return false;
    if (/Chrome\//i.test(ua) || /Chromium\//i.test(ua) || /Edg\//i.test(ua)) {
      return true;
    }
    return false;
  }

  /**
   * Call tabs.discard via discardFn. Chrome: one id per call. Firefox: may batch arrays.
   * @param {number[]} tabIds
   * @param {(arg: number|number[]) => Promise<void>} discardFn
   * @param {{ oneByOne?: boolean, chunkSize?: number }} [options]
   * @returns {Promise<number>} successful discard count
   */
  async function discardTabIds(tabIds, discardFn, options) {
    options = options || {};
    if (!tabIds || !tabIds.length) return 0;
    let discarded = 0;
    const oneByOne = !!options.oneByOne;
    const chunkSize = options.chunkSize || 80;

    if (oneByOne) {
      for (let i = 0; i < tabIds.length; i++) {
        try {
          await discardFn(tabIds[i]);
          discarded += 1;
        } catch (_) {
          // skip (e.g. already gone)
        }
      }
      return discarded;
    }

    for (let i = 0; i < tabIds.length; i += chunkSize) {
      const chunk = tabIds.slice(i, i + chunkSize);
      try {
        await discardFn(chunk);
        discarded += chunk.length;
      } catch (_) {
        for (let j = 0; j < chunk.length; j++) {
          try {
            await discardFn(chunk[j]);
            discarded += 1;
          } catch (_) {
            // skip
          }
        }
      }
    }
    return discarded;
  }

  /**
   * Popup single tab close: only delete the record after removeFn succeeds.
   * @returns {Promise<{ ok: boolean, error?: Error }>}
   */
  async function tryCloseTabRecord(tabInfoList, tabKey, removeFn) {
    if (!tabInfoList || !tabKey || !tabInfoList[tabKey]) {
      return { ok: false, error: new Error("Tab not in list") };
    }
    const tabId = tabInfoList[tabKey].id;
    try {
      await removeFn(tabId);
      delete tabInfoList[tabKey];
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  return {
    isDiscardableUrl: isDiscardableUrl,
    getLastOpenedTsForTab: getLastOpenedTsForTab,
    buildTabRecordFromLive: buildTabRecordFromLive,
    isPendingRestoreRecord: isPendingRestoreRecord,
    countPendingRestoreRecords: countPendingRestoreRecords,
    stripPendingRestoreRecords: stripPendingRestoreRecords,
    claimPendingRestoreForTab: claimPendingRestoreForTab,
    getHistoryMergeMode: getHistoryMergeMode,
    runSessionAwareSync: runSessionAwareSync,
    mergeLiveTabsWithHistory: mergeLiveTabsWithHistory,
    selectUnloadListedIds: selectUnloadListedIds,
    selectUnloadInWindowIds: selectUnloadInWindowIds,
    analyzeDuplicates: analyzeDuplicates,
    countTabLoadStats: countTabLoadStats,
    formatWindowLabel: formatWindowLabel,
    formatDateParts: formatDateParts,
    getAgeColors: getAgeColors,
    buildWindowUnloadRows: buildWindowUnloadRows,
    shouldDiscardOneByOne: shouldDiscardOneByOne,
    discardTabIds: discardTabIds,
    tryCloseTabRecord: tryCloseTabRecord,
  };
});
