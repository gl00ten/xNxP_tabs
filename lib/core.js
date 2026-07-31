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

  function getLastOpenedTsForTab(tab, tabInfoList) {
    const info =
      tabInfoList && tab.id != null ? tabInfoList[String(tab.id)] : null;
    if (info && info.lastOpenedTs) return info.lastOpenedTs;
    if (tab.lastAccessed) return tab.lastAccessed;
    return 0;
  }

  /**
   * Tabs to unload (discard) when keeping a specific tab id (all windows).
   */
  function selectUnloadAllOthersIds(tabs, keepTabId) {
    return tabs
      .filter(
        (t) =>
          t.id !== keepTabId &&
          !t.pinned &&
          !t.discarded &&
          isDiscardableUrl(t.url)
      )
      .map((t) => t.id);
  }

  /**
   * Tabs to unload in one window, keeping that window's active tab.
   */
  function selectUnloadInWindowIds(tabs) {
    const active = tabs.find((t) => t.active);
    return tabs
      .filter(
        (t) =>
          (!active || t.id !== active.id) &&
          !t.pinned &&
          !t.discarded &&
          isDiscardableUrl(t.url)
      )
      .map((t) => t.id);
  }

  /**
   * Exact-URL duplicates. Keep newest lastOpened (+ all active). Close older.
   * @param {Array} tabs - browser tab objects
   * @param {Object} tabInfoList - map of tabId string → { lastOpenedTs }
   */
  function analyzeDuplicates(tabs, tabInfoList) {
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
        if (tab.active) keepIds.add(tab.id);
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

    return { toCloseIds, count: toCloseIds.length, groups };
  }

  function countTabLoadStats(tabs) {
    let loaded = 0;
    let discarded = 0;
    for (const tab of tabs) {
      if (tab.discarded) discarded += 1;
      else loaded += 1;
    }
    return { total: tabs.length, loaded, discarded };
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

  function formatShortDate(timestamp, fallbackText) {
    if (fallbackText === undefined) fallbackText = "";
    if (!timestamp) return fallbackText;

    const date = new Date(timestamp);
    const year = String(date.getFullYear()).slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");

    return year + "." + month + "." + day + " " + hour + ":" + minute;
  }

  function getAgeBackground(timestamp, minTs, maxTs) {
    if (!timestamp || !isFinite(minTs) || !isFinite(maxTs) || minTs >= maxTs) {
      return null;
    }

    // t=0 recent → cool blue; t=1 oldest → warm orange
    // Curve slightly boosted so mid-age tabs pick up more amber (less "all blue")
    const t = (maxTs - timestamp) / (maxTs - minTs);
    const u = Math.pow(t, 0.72);
    // 205 (blue) → 28 (orange)
    const hue = 205 - u * 177;
    const sat = 18 + u * 62;
    const light = 96 - u * 12;

    return "hsl(" + hue + ", " + sat + "%, " + light + "%)";
  }

  /**
   * Build window picker rows with unloadable counts, sorted descending.
   */
  function buildWindowUnloadRows(windows, tabsByWindow, currentWindowId) {
    const rows = windows.map((win) => {
      const tabs = tabsByWindow[win.id] || win.tabs || [];
      const active = tabs.find((t) => t.active);
      const loaded = tabs.filter((t) => !t.discarded).length;
      const unloadIds = selectUnloadInWindowIds(tabs);
      return {
        win,
        tabs,
        active,
        loaded,
        unloadable: unloadIds.length,
        unloadIds,
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

  function chunkIds(ids, chunkSize) {
    const size = chunkSize || 80;
    const chunks = [];
    for (let i = 0; i < ids.length; i += size) {
      chunks.push(ids.slice(i, i + size));
    }
    return chunks;
  }

  return {
    isDiscardableUrl,
    getLastOpenedTsForTab,
    selectUnloadAllOthersIds,
    selectUnloadInWindowIds,
    analyzeDuplicates,
    countTabLoadStats,
    formatWindowLabel,
    formatShortDate,
    getAgeBackground,
    buildWindowUnloadRows,
    chunkIds,
  };
});
