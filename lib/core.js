/**
 * Pure helpers for xNxP Tabs — usable in the extension and in Node unit tests.
 * UMD-style export: attaches to globalThis.xNxPCore and module.exports.
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
   * Prefer stored lastOpenedTs, but never ignore a newer browser lastAccessed.
   * Empty storage → lastAccessed; current time only if both missing.
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

    let lastOpenedTs;
    let lastOpened;
    if (options.forceLastOpened) {
      lastOpenedTs = nowMs;
      lastOpened = nowStr;
    } else if (previousRecord && previousRecord.lastOpenedTs) {
      lastOpenedTs = previousRecord.lastOpenedTs;
      lastOpened =
        previousRecord.lastOpened || tsToLocaleString(lastOpenedTs, nowStr);
      if (accessed > lastOpenedTs) {
        lastOpenedTs = accessed;
        lastOpened = accessedStr;
      }
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

  /**
   * URL-based restoration runs once per browser session, not per SW restart.
   * sessionRestoreCompleted comes from storage.session (or equivalent).
   */
  function getHistoryMergeMode(sessionRestoreCompleted) {
    return sessionRestoreCompleted ? "live" : "restore";
  }

  /**
   * One sync step with session-lifetime restore flag (for tests + shared logic).
   * Mutates sessionState.restoreCompleted to true after a restore-mode merge.
   *
   * @param {Array} liveTabs
   * @param {object} storedList
   * @param {{ restoreCompleted?: boolean }} sessionState - survives SW restarts
   * @param {object} [options] - nowMs, nowStr
   * @returns {{ list: object, mode: string, sessionState: object }}
   */
  function runSessionAwareSync(liveTabs, storedList, sessionState, options) {
    const state =
      sessionState && typeof sessionState === "object"
        ? sessionState
        : { restoreCompleted: false };
    const mode = getHistoryMergeMode(!!state.restoreCompleted);
    const list = mergeLiveTabsWithHistory(liveTabs, storedList, {
      mode: mode,
      nowMs: options && options.nowMs,
      nowStr: options && options.nowStr,
    });
    if (mode === "restore") {
      state.restoreCompleted = true;
    }
    return { list: list, mode: mode, sessionState: state };
  }

  /**
   * Match live tabs to stored history.
   *
   * mode "live" (default while browsing):
   *   Only match by exact tab id (trust id; URL may change via navigation).
   *   Never move history between two open tabs that share a URL.
   *
   * mode "restore" (startup only):
   *   1) Match by exact tab id only when stored and live URLs are equal
   *      and non-empty (IDs are reused across browser restarts).
   *   2) Match remaining live tabs to remaining stored records by URL
   *      (prefer oldest firstOpenedTs). Never match empty URLs.
   */
  function mergeLiveTabsWithHistory(liveTabs, storedList, options) {
    options = options || {};
    const mode = options.mode === "restore" ? "restore" : "live";
    const nowMs = options.nowMs != null ? options.nowMs : Date.now();
    const nowStr = options.nowStr || new Date(nowMs).toLocaleString();
    const stored = storedList && typeof storedList === "object" ? storedList : {};
    const usedStoredKeys = new Set();
    const result = {};

    // Pass 1: exact tab id
    for (let i = 0; i < liveTabs.length; i++) {
      const tab = liveTabs[i];
      const key = String(tab.id);
      if (!stored[key] || usedStoredKeys.has(key)) continue;

      if (mode === "restore") {
        const storedUrl = stored[key].url || "";
        const liveUrl = tab.url || "";
        // IDs recycle after full browser restart — require matching non-empty URL
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
        // Empty URL is not a real identity — never pool or match it
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

    // Pass 3: remaining live tabs — no history (use lastAccessed)
    for (let i = 0; i < liveTabs.length; i++) {
      const tab = liveTabs[i];
      const key = String(tab.id);
      if (result[key]) continue;
      result[key] = buildTabRecordFromLive(tab, null, {
        nowMs: nowMs,
        nowStr: nowStr,
      });
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
   * Exact-URL duplicates. Keep the most recently accessed tab and the active
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

  function formatDateParts(timestamp, fallbackText) {
    if (fallbackText === undefined) fallbackText = "";
    if (!timestamp) {
      return fallbackText ? { date: fallbackText, time: "" } : null;
    }

    const date = new Date(timestamp);
    const year = String(date.getFullYear()).slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");

    return {
      date: year + "." + month + "." + day,
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
   * Popup single-tab close: only delete the record after removeFn succeeds.
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
