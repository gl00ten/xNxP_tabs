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
   * Unload only tabs that appear in the current UI list (search/filters).
   * keepTabId is never unloaded (usually the active tab).
   * @param {Array} liveTabs - browser.tabs.query result
   * @param {Array<number>} listedIds - tab ids currently shown in the table
   * @param {number|null} keepTabId
   */
  function selectUnloadListedIds(liveTabs, listedIds, keepTabId) {
    const listed = new Set(listedIds || []);
    return liveTabs
      .filter((t) => listed.has(t.id))
      .filter((t) => keepTabId == null || t.id !== keepTabId)
      .filter((t) => !t.pinned && !t.discarded && isDiscardableUrl(t.url))
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

  function formatDateParts(timestamp, fallbackText) {
    if (fallbackText === undefined) fallbackText = "";
    if (!timestamp) {
      return fallbackText
        ? { date: fallbackText, time: "" }
        : null;
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

  function formatShortDate(timestamp, fallbackText) {
    if (fallbackText === undefined) fallbackText = "";
    const parts = formatDateParts(timestamp, fallbackText);
    if (!parts) return fallbackText;
    if (!parts.time) return parts.date;
    return parts.date + " " + parts.time;
  }

  /**
   * Simple relative age among open tabs.
   * t = 0 → most recently last-opened (no color)
   * t → 1 → oldest last-opened (orange)
   * Linear: none → blue → orange
   */
  function getAgeT(timestamp, minTs, maxTs) {
    if (!timestamp || !isFinite(minTs) || !isFinite(maxTs) || minTs >= maxTs) {
      return null;
    }
    const t = (maxTs - timestamp) / (maxTs - minTs);
    if (!isFinite(t)) return null;
    return Math.min(1, Math.max(0, t));
  }

  /**
   * Soft full-row tint from last-opened age among open tabs.
   * Most recent: null (default row). Then linear none → blue → orange.
   * Kept very light so it reads as a wash, not a painted stripe.
   */
  function getAgeColors(timestamp, minTs, maxTs) {
    const t = getAgeT(timestamp, minTs, maxTs);
    if (t == null || t <= 0) return null;

    // 0 → blue (210), 1 → orange (28)
    const hue = 210 - t * 182;
    // Soft: low sat, high light — blends with white rows
    const sat = 8 + t * 38;
    const light = 98.5 - t * 6;

    const wash = "hsl(" + hue + ", " + sat + "%, " + light + "%)";
    return { t: t, wash: wash };
  }

  /** Wash color string, or null. */
  function getAgeBackground(timestamp, minTs, maxTs) {
    const colors = getAgeColors(timestamp, minTs, maxTs);
    return colors ? colors.wash : null;
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
    selectUnloadListedIds,
    selectUnloadInWindowIds,
    analyzeDuplicates,
    countTabLoadStats,
    formatWindowLabel,
    formatDateParts,
    formatShortDate,
    getAgeT,
    getAgeColors,
    getAgeBackground,
    buildWindowUnloadRows,
    chunkIds,
  };
});
