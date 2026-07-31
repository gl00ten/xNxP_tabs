// Pure helpers live in lib/core.js (unit-tested). Loaded before this file.
const Core = globalThis.xNxPCore;

/**
 * Load open tabs from the browser itself (like Tabhunter).
 * Does not depend on the background page being awake.
 * Merges first/last-opened history from storage when available.
 */
async function loadTabsDirectly() {
  const started = Date.now();
  const tabs = await browser.tabs.query({});
  const stored = await browser.storage.local.get("tabInfoList");
  const old = stored.tabInfoList && typeof stored.tabInfoList === "object"
    ? stored.tabInfoList
    : {};

  // URL → pool of historical records (for session restore / tab id churn)
  const oldByUrl = {};
  for (const key of Object.keys(old)) {
    const rec = old[key];
    if (!rec) continue;
    const url = rec.url || "";
    if (!oldByUrl[url]) oldByUrl[url] = [];
    oldByUrl[url].push(rec);
  }

  const now = Date.now();
  const nowStr = new Date().toLocaleString();
  const list = {};

  for (const tab of tabs) {
    const key = String(tab.id);
    let prev = old[key] || null;

    if (!prev) {
      const url = tab.url || "";
      const pool = oldByUrl[url];
      if (pool && pool.length > 0) {
        prev = pool.reduce((best, cur) => {
          const bestTs = best.firstOpenedTs || Infinity;
          const curTs = cur.firstOpenedTs || Infinity;
          return curTs < bestTs ? cur : best;
        });
        const idx = pool.indexOf(prev);
        if (idx > -1) pool.splice(idx, 1);
      }
    }

    const firstOpened = prev?.firstOpened || nowStr;
    const firstOpenedTs = prev?.firstOpenedTs || now;
    let lastOpened = prev?.lastOpened || "";
    let lastOpenedTs = prev?.lastOpenedTs || 0;
    if (!lastOpened && firstOpened) {
      lastOpened = firstOpened;
      lastOpenedTs = firstOpenedTs;
    }
    if (!lastOpened) {
      lastOpened = nowStr;
      lastOpenedTs = now;
    }

    list[key] = {
      id: tab.id,
      windowId: tab.windowId,
      title: tab.title || "",
      url: tab.url || "",
      favIconUrl: tab.favIconUrl || prev?.favIconUrl || "",
      audible: !!tab.audible,
      discarded: !!tab.discarded,
      firstOpened,
      firstOpenedTs,
      lastOpened,
      lastOpenedTs,
    };
  }

  // Keep storage in sync for the background listeners (best effort)
  browser.storage.local.set({ tabInfoList: list }).catch(() => {});

  // Nudge background memory to match (ignore failures — popup already has data)
  browser.runtime.sendMessage({ type: "getTabInfo" }).catch(() => {});

  return {
    tabInfoList: list,
    meta: {
      openTabs: tabs.length,
      tracked: Object.keys(list).length,
      ms: Date.now() - started,
      source: "popup-direct",
    },
  };
}

document.addEventListener("DOMContentLoaded", function () {
  const tableBody = document.getElementById("table-body");
  const searchInput = document.getElementById("search-input");
  const tableHeaders = document.querySelectorAll("th[data-sort]");
  const audioFilterCheckbox = document.getElementById("audio-filter-checkbox");
  const emptyState = document.getElementById("empty-state");
  const debugPanel = document.getElementById("debug-panel");
  const debugModeCheckbox = document.getElementById("debug-mode-checkbox");
  const debugCopyBtn = document.getElementById("debug-copy-btn");
  const debugHideBtn = document.getElementById("debug-hide-btn");
  const debugStatus = document.getElementById("debug-status");
  const menuBtn = document.getElementById("menu-btn");
  const actionsMenu = document.getElementById("actions-menu");
  const memBar = document.getElementById("mem-bar");
  const memStatsEl = document.getElementById("mem-stats");
  const windowPicker = document.getElementById("window-picker");
  const windowPickerList = document.getElementById("window-picker-list");
  const windowPickerCancel = document.getElementById("window-picker-cancel");
  const dupesSummary = document.getElementById("dupes-summary");
  const closeDuplicatesBtn = document.getElementById("close-duplicates-btn");
  // Stats bar only when using the ☰ menu / after an unload (not on every open)
  let memBarPinned = false;
  let lastDupesAnalysis = { toCloseIds: [], count: 0, groups: 0 };

  const KOFI_URL = "https://ko-fi.com/gl00ten";

  // --- Unload / duplicate helpers (tabs.discard / remove) ---

  async function getTabLoadStats() {
    const tabs = await browser.tabs.query({});
    return Core.countTabLoadStats(tabs);
  }

  function setMemBarVisible(show) {
    if (!memBar) return;
    memBar.hidden = !show;
  }

  /** Tab load counts (Firefox does not expose process RAM to add-ons). */
  async function refreshMemBar(extra = null) {
    if (!memStatsEl) return;
    setMemBarVisible(true);
    try {
      const stats = await getTabLoadStats();
      while (memStatsEl.firstChild) {
        memStatsEl.removeChild(memStatsEl.firstChild);
      }

      const appendStrongPair = (label, value) => {
        memStatsEl.appendChild(document.createTextNode(label));
        const strong = document.createElement("strong");
        strong.textContent = String(value);
        memStatsEl.appendChild(strong);
      };

      appendStrongPair("In memory: ", stats.loaded);
      memStatsEl.appendChild(document.createTextNode(" · "));
      appendStrongPair("Sleeping: ", stats.discarded);
      memStatsEl.appendChild(document.createTextNode(" · "));
      appendStrongPair("Total: ", stats.total);

      if (extra && typeof extra.unloaded === "number") {
        memStatsEl.appendChild(document.createTextNode(" · "));
        const delta = document.createElement("span");
        delta.className = "mem-delta";
        delta.textContent = "just unloaded " + extra.unloaded + " from memory";
        memStatsEl.appendChild(delta);
        memBarPinned = true;
      }
    } catch (err) {
      memStatsEl.textContent = "Could not read tab stats";
    }
  }

  async function discardInChunks(tabIds, chunkSize = 80) {
    let discarded = 0;
    for (let i = 0; i < tabIds.length; i += chunkSize) {
      const chunk = tabIds.slice(i, i + chunkSize);
      try {
        await browser.tabs.discard(chunk);
        discarded += chunk.length;
      } catch (err) {
        // Some tabs cannot be discarded; try one-by-one for the chunk
        for (const id of chunk) {
          try {
            await browser.tabs.discard(id);
            discarded += 1;
          } catch (_) {
            // skip
          }
        }
      }
    }
    return discarded;
  }

  async function countUnloadAllOthers() {
    const [current] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!current) return { count: 0, ids: [], keptId: null };
    const tabs = await browser.tabs.query({});
    const ids = Core.selectUnloadAllOthersIds(tabs, current.id);
    return { count: ids.length, ids, keptId: current.id };
  }

  async function unloadAllOthers() {
    const { ids, keptId } = await countUnloadAllOthers();
    if (keptId == null) throw new Error("No active tab");
    const unloaded = await discardInChunks(ids);
    return { unloaded, keptId };
  }

  async function unloadInWindow(windowId) {
    const tabs = await browser.tabs.query({ windowId });
    const ids = Core.selectUnloadInWindowIds(tabs);
    const unloaded = await discardInChunks(ids);
    return { unloaded, windowId };
  }

  async function analyzeDuplicates() {
    const tabs = await browser.tabs.query({});
    return Core.analyzeDuplicates(tabs, tabInfoList);
  }

  async function updateUnloadMenuSummaries() {
    const unloadAllSummary = document.getElementById("unload-all-summary");
    if (!unloadAllSummary) return;
    try {
      unloadAllSummary.textContent = "Counting tabs…";
      const { count } = await countUnloadAllOthers();
      if (count === 0) {
        unloadAllSummary.textContent = "No other tabs to unload from memory";
      } else {
        unloadAllSummary.textContent =
          count +
          " tab" +
          (count === 1 ? "" : "s") +
          " will be unloaded from memory";
      }
    } catch (err) {
      unloadAllSummary.textContent = "Could not count tabs";
    }
  }

  async function updateDuplicatesMenu() {
    if (!dupesSummary && !closeDuplicatesBtn) return;
    try {
      if (dupesSummary) {
        dupesSummary.textContent = "Checking duplicates…";
        dupesSummary.classList.remove("has-dupes");
      }
      if (closeDuplicatesBtn) closeDuplicatesBtn.disabled = true;

      lastDupesAnalysis = await analyzeDuplicates();
      const { count, groups } = lastDupesAnalysis;

      if (dupesSummary) {
        if (count === 0) {
          dupesSummary.textContent = "No duplicate tabs found";
          dupesSummary.classList.remove("has-dupes");
        } else {
          dupesSummary.textContent =
            count +
            " duplicate tab" +
            (count === 1 ? "" : "s") +
            " can be closed (" +
            groups +
            " URL" +
            (groups === 1 ? "" : "s") +
            ")";
          dupesSummary.classList.add("has-dupes");
        }
      }
      if (closeDuplicatesBtn) {
        closeDuplicatesBtn.disabled = count === 0;
      }
    } catch (err) {
      console.error("Duplicate analysis failed:", err);
      lastDupesAnalysis = { toCloseIds: [], count: 0, groups: 0 };
      if (dupesSummary) {
        dupesSummary.textContent = "Could not check duplicates";
        dupesSummary.classList.remove("has-dupes");
      }
      if (closeDuplicatesBtn) closeDuplicatesBtn.disabled = true;
    }
  }

  async function closeDuplicateTabs() {
    // Re-analyze so the list is fresh (tabs may have changed)
    const analysis = await analyzeDuplicates();
    lastDupesAnalysis = analysis;
    if (!analysis.toCloseIds.length) {
      return { closed: 0 };
    }

    let closed = 0;
    const chunkSize = 50;
    for (let i = 0; i < analysis.toCloseIds.length; i += chunkSize) {
      const chunk = analysis.toCloseIds.slice(i, i + chunkSize);
      try {
        await browser.tabs.remove(chunk);
        closed += chunk.length;
      } catch (err) {
        for (const id of chunk) {
          try {
            await browser.tabs.remove(id);
            closed += 1;
          } catch (_) {
            // skip
          }
        }
      }
    }
    return { closed };
  }

  async function reloadTabListFromBrowser() {
    const direct = await loadTabsDirectly();
    tabInfoList = direct.tabInfoList || {};
    lastMeta = direct.meta || {};
    loadError = null;
    applyFilters();
    renderTable();
  }

  function setMenuOpen(open) {
    if (!actionsMenu || !menuBtn) return;
    actionsMenu.hidden = !open;
    menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      refreshMemBar();
      updateUnloadMenuSummaries();
      updateDuplicatesMenu();
    } else if (!memBarPinned) {
      setMemBarVisible(false);
    }
  }

  function setWindowPickerOpen(open) {
    if (!windowPicker) return;
    windowPicker.hidden = !open;
  }

  async function showWindowPicker() {
    if (!windowPickerList) return;
    setMenuOpen(false);

    while (windowPickerList.firstChild) {
      windowPickerList.removeChild(windowPickerList.firstChild);
    }

    const [currentWin, windows, allTabs] = await Promise.all([
      browser.windows.getCurrent(),
      browser.windows.getAll({ populate: true, windowTypes: ["normal"] }),
      browser.tabs.query({}),
    ]);

    const tabsByWindow = {};
    for (const tab of allTabs) {
      if (!tabsByWindow[tab.windowId]) tabsByWindow[tab.windowId] = [];
      tabsByWindow[tab.windowId].push(tab);
    }

    const rows = Core.buildWindowUnloadRows(
      windows,
      tabsByWindow,
      currentWin && currentWin.id
    );

    rows.forEach(({ win, tabs, active, loaded, unloadable, isCurrent, label }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "window-picker-item";
      if (isCurrent) {
        btn.classList.add("is-current");
      }

      const title = document.createElement("span");
      title.className = "window-picker-item-title";
      title.textContent = label;
      title.title = (win && win.title) || label;

      const meta = document.createElement("span");
      meta.className = "window-picker-item-meta";
      meta.textContent =
        unloadable +
        " tabs will be unloaded from memory · " +
        tabs.length +
        " tabs · " +
        loaded +
        " loaded";

      btn.appendChild(title);
      btn.appendChild(meta);

      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const result = await unloadInWindow(win.id);
          setWindowPickerOpen(false);
          await reloadTabListFromBrowser();
          await refreshMemBar({ unloaded: result.unloaded });
        } catch (err) {
          console.error("Unload window failed:", err);
          btn.disabled = false;
          if (memStatsEl) {
            memStatsEl.textContent = "Unload failed: " + err;
          }
        }
      });

      windowPickerList.appendChild(btn);
    });

    setWindowPickerOpen(true);
  }

  if (menuBtn && actionsMenu) {
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setMenuOpen(actionsMenu.hidden);
    });

    actionsMenu.addEventListener("click", async (e) => {
      const item = e.target.closest("[data-action]");
      if (!item) return;
      const action = item.getAttribute("data-action");

      if (action === "unload-window") {
        try {
          await showWindowPicker();
        } catch (err) {
          console.error(err);
          if (memStatsEl) memStatsEl.textContent = "Could not list windows";
        }
        return;
      }

      if (action === "unload-all-others") {
        item.disabled = true;
        setMenuOpen(false);
        try {
          const result = await unloadAllOthers();
          await reloadTabListFromBrowser();
          await refreshMemBar({ unloaded: result.unloaded });
        } catch (err) {
          console.error("Unload all others failed:", err);
          if (memStatsEl) {
            memStatsEl.textContent = "Unload failed: " + err;
          }
        } finally {
          item.disabled = false;
        }
        return;
      }

      if (action === "close-duplicates") {
        if (!lastDupesAnalysis.count) return;
        const n = lastDupesAnalysis.count;
        const ok = confirm(
          "Close " +
            n +
            " duplicate tab" +
            (n === 1 ? "" : "s") +
            "?\n\nKeeps the most recently used copy of each URL (by last opened). Older copies are closed. Pinned and active tabs are kept."
        );
        if (!ok) return;

        item.disabled = true;
        setMenuOpen(false);
        try {
          const result = await closeDuplicateTabs();
          await reloadTabListFromBrowser();
          setMemBarVisible(true);
          memBarPinned = true;
          if (memStatsEl) {
            memStatsEl.textContent =
              "Closed " + result.closed + " duplicate tab" + (result.closed === 1 ? "" : "s");
          }
          await refreshMemBar();
          if (memStatsEl && result.closed) {
            // refreshMemBar rebuilds stats; append close note
            memStatsEl.appendChild(document.createTextNode(" · "));
            const delta = document.createElement("span");
            delta.className = "mem-delta";
            delta.textContent = "closed " + result.closed + " duplicates";
            memStatsEl.appendChild(delta);
          }
        } catch (err) {
          console.error("Close duplicates failed:", err);
          if (memStatsEl) {
            setMemBarVisible(true);
            memStatsEl.textContent = "Close duplicates failed: " + err;
          }
        } finally {
          item.disabled = false;
        }
        return;
      }

      if (action === "donate") {
        setMenuOpen(false);
        browser.tabs.create({ url: KOFI_URL });
      }
    });

    document.addEventListener("click", (e) => {
      if (!actionsMenu.hidden) {
        const wrap = e.target.closest(".header-menu-wrap");
        if (!wrap) setMenuOpen(false);
      }
    });
  }

  if (windowPickerCancel) {
    windowPickerCancel.addEventListener("click", () => {
      setWindowPickerOpen(false);
    });
  }

  let tabInfoList = {};
  let filteredTabEntries = [];
  let sortField = null;
  let sortOrder = 1;
  let showOnlyAudible = false;
  let personalBest = 0;
  let loadError = null;
  let lastMeta = {};
  let debugMode = false;
  let debugPanelVisible = false;

  function showDebugPanel(show) {
    debugPanelVisible = !!show;
    updateDebugPanelVisibility();
    if (show) {
      setDebugStatus(
        "tracked=" +
          Object.keys(tabInfoList).length +
          (lastMeta.openTabs != null ? " open=" + lastMeta.openTabs : "") +
          (lastMeta.source ? " " + lastMeta.source : "")
      );
    }
  }

  // Hidden entry: four rapid clicks on the logo (left icon + title) toggles debug.
  // Manual counter — e.detail is unreliable for 4+ clicks in some browsers.
  const brandEl = document.querySelector(".brand");
  if (brandEl) {
    let brandClicks = 0;
    let brandClickTimer = null;
    const BRAND_CLICKS_NEEDED = 4;
    const BRAND_CLICK_WINDOW_MS = 1200;

    brandEl.addEventListener("click", (e) => {
      brandClicks += 1;
      if (brandClickTimer) clearTimeout(brandClickTimer);
      brandClickTimer = setTimeout(() => {
        brandClicks = 0;
      }, BRAND_CLICK_WINDOW_MS);

      if (brandClicks >= BRAND_CLICKS_NEEDED) {
        brandClicks = 0;
        clearTimeout(brandClickTimer);
        brandClickTimer = null;
        e.preventDefault();
        showDebugPanel(!debugPanelVisible);
      }
    });
  }

  if (debugModeCheckbox) {
    debugModeCheckbox.addEventListener("change", async () => {
      debugMode = debugModeCheckbox.checked;
      try {
        await browser.runtime.sendMessage({
          type: "setDebugMode",
          enabled: debugMode,
        });
        await browser.storage.local.set({ debugMode });
        setDebugStatus(debugMode ? "Debug on — leave on while reproducing issues" : "Debug off");
      } catch (err) {
        setDebugStatus("Failed to set debug: " + err);
      }
    });
  }

  if (debugCopyBtn) {
    debugCopyBtn.addEventListener("click", async () => {
      try {
        let reportPart = {};
        try {
          const report = await browser.runtime.sendMessage({ type: "getDebugReport" });
          reportPart = report && report.report ? report.report : report || {};
        } catch (bgErr) {
          reportPart = { backgroundError: String(bgErr) };
        }
        const payload = {
          ...reportPart,
          popup: {
            visibleCount: filteredTabEntries.length,
            trackedCount: Object.keys(tabInfoList).length,
            search: searchInput.value,
            showOnlyAudible,
            sortField,
            sortOrder,
            loadError,
            lastMeta,
          },
        };
        const text = JSON.stringify(payload, null, 2);
        await navigator.clipboard.writeText(text);
        setDebugStatus("Logs copied to clipboard");
      } catch (err) {
        setDebugStatus("Copy failed: " + err);
      }
    });
  }

  if (debugHideBtn) {
    debugHideBtn.addEventListener("click", () => {
      showDebugPanel(false);
    });
  }

  function updateDebugPanelVisibility() {
    if (!debugPanel) return;
    // Panel only opens via four logo clicks (or Hide). debugMode is logging only.
    debugPanel.hidden = !debugPanelVisible;
  }

  function setDebugStatus(text) {
    if (debugStatus) debugStatus.textContent = text || "";
  }

  // Restore previous search + audio filter + sort state
  (async () => {
    try {
      const result = await browser.storage.local.get([
        "popupSearch",
        "popupShowOnlyAudible",
        "popupSortField",
        "popupSortOrder",
        "debugMode",
      ]);

      if (result.popupSearch) {
        searchInput.value = result.popupSearch;
      }
      if (result.popupShowOnlyAudible) {
        showOnlyAudible = true;
        audioFilterCheckbox.checked = true;
      }
      if (result.popupSortField) {
        sortField = result.popupSortField;
        sortOrder = result.popupSortOrder || 1;
      }

      debugMode = !!result.debugMode;
      if (debugModeCheckbox) debugModeCheckbox.checked = debugMode;
      debugPanelVisible = false;
      updateDebugPanelVisibility();

      // Load personal best
      const bestResult = await browser.storage.local.get("personalBest");
      personalBest = bestResult.personalBest || 0;
      updatePersonalBestDisplay();

      // Primary path: query tabs in the popup (works even if background is stuck
      // after an extension reload — no Firefox restart needed).
      const direct = await loadTabsDirectly();
      tabInfoList = direct.tabInfoList || {};
      loadError = null;
      lastMeta = direct.meta || {};

      if (debugMode) {
        setDebugStatus(
          "ok tracked=" +
            Object.keys(tabInfoList).length +
            (lastMeta.openTabs != null ? " open=" + lastMeta.openTabs : "") +
            (lastMeta.ms != null ? " " + lastMeta.ms + "ms" : "") +
            " " +
            (lastMeta.source || "")
        );
      }

      applyFilters();
      renderTable();
      updateSortIndicators();

      // Focus and select the search input so the user can immediately replace previous text by typing
      // Defer focus slightly so stylesheets can settle (reduces FOUC/layout warnings).
      requestAnimationFrame(() => {
        searchInput.focus();
        searchInput.select();
      });
    } catch (err) {
      console.error("Popup init failed:", err);
      loadError = String(err && err.message ? err.message : err);
      tabInfoList = {};
      applyFilters();
      renderTable();
      if (debugMode) setDebugStatus("Popup init failed: " + loadError);
    }
  })();

  let searchDebounceTimer;
  searchInput.addEventListener("input", async () => {
    await browser.storage.local.set({ popupSearch: searchInput.value });

    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      applyFilters();
      renderTable();
    }, 120);
  });

  // Pressing Enter in the search box switches to the first result
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && filteredTabEntries.length > 0) {
      const [_, firstTab] = filteredTabEntries[0];
      switchToTab(firstTab);
    }
  });

  if (audioFilterCheckbox) {
    audioFilterCheckbox.addEventListener("change", async () => {
      showOnlyAudible = audioFilterCheckbox.checked;

      await browser.storage.local.set({ popupShowOnlyAudible: showOnlyAudible });
      applyFilters();
      renderTable();
    });
  }

  tableHeaders.forEach((header) => {
    header.style.cursor = "pointer";
    header.addEventListener("click", handleTableHeaderClick);
  });

  function createTabRow(tabKey, tabInfo) {
    const row = document.createElement("tr");

    // Whole row click to switch
    row.onclick = () => switchToTab(tabInfo);

    // Actions cell
    const actionsCell = document.createElement("td");

    const switchButton = document.createElement("button");
    switchButton.textContent = "↗ Switch";
    switchButton.classList.add("action-button");
    switchButton.onclick = (e) => {
      e.stopPropagation();
      switchToTab(tabInfo);
    };
    actionsCell.appendChild(switchButton);

    const closeButton = document.createElement("button");
    closeButton.textContent = "✕ Close";
    closeButton.classList.add("action-button");
    closeButton.onclick = async (e) => {
      e.stopPropagation();
      try {
        await browser.tabs.remove(tabInfo.id);
      } catch (err) {
        console.error("Failed to close tab:", err);
      }
      // Optimistically remove from our local snapshot and re-render immediately.
      // Background onTabRemoved will handle the real delete + storage (avoids race).
      delete tabInfoList[tabKey];
      applyFilters();
      renderTable();
    };
    actionsCell.appendChild(closeButton);
    row.appendChild(actionsCell);

    // Date cells (Last Opened first)
    const lastDate = document.createElement("td");
    lastDate.classList.add("col-date");
    lastDate.textContent = Core.formatShortDate(
      tabInfo.lastOpenedTs,
      tabInfo.lastOpened || ""
    );
    row.appendChild(lastDate);

    const firstDate = document.createElement("td");
    firstDate.classList.add("col-date");
    firstDate.textContent = Core.formatShortDate(
      tabInfo.firstOpenedTs,
      tabInfo.firstOpened || ""
    );
    row.appendChild(firstDate);

    // Tab info cell
    const tabCell = document.createElement("td");
    tabCell.classList.add("col-tab", "tab-cell");

    const titleDiv = document.createElement("div");
    titleDiv.classList.add("tab-title");

    if (tabInfo.favIconUrl) {
      const favicon = document.createElement("img");
      favicon.classList.add("tab-favicon");
      favicon.src = tabInfo.favIconUrl;
      favicon.alt = "";
      titleDiv.appendChild(favicon);
    }

    if (tabInfo.audible) {
      const audioIcon = document.createElement("span");
      audioIcon.classList.add("audio-indicator");
      audioIcon.textContent = "♪";
      audioIcon.title = "This tab is playing audio";
      titleDiv.appendChild(audioIcon);
    }

    if (tabInfo.discarded) {
      const sleepIcon = document.createElement("span");
      sleepIcon.classList.add("discarded-indicator");
      sleepIcon.textContent = "💤";
      sleepIcon.title = "Unloaded (sleeping — reloads when you open it)";
      titleDiv.appendChild(sleepIcon);
    }

    const titleText = document.createElement("span");
    titleText.classList.add("tab-title-text");
    titleText.textContent = tabInfo.title || "";
    titleDiv.appendChild(titleText);

    const urlDiv = document.createElement("div");
    urlDiv.classList.add("tab-url-inline");
    urlDiv.textContent = tabInfo.url || "";

    tabCell.appendChild(titleDiv);
    tabCell.appendChild(urlDiv);
    row.appendChild(tabCell);

    return row;
  }

  async function switchToTab(tabInfo) {
    try {
      await browser.tabs.update(tabInfo.id, { active: true });
      await browser.windows.update(tabInfo.windowId, { focused: true });
      window.close();
    } catch (err) {
      console.error("Failed to switch to tab:", err);
    }
  }

  function updateEmptyState() {
    if (!emptyState) return;

    const total = Object.keys(tabInfoList).length;
    const visible = filteredTabEntries.length;

    if (visible > 0) {
      emptyState.hidden = true;
      emptyState.textContent = "";
      emptyState.removeAttribute("data-kind");
      return;
    }

    emptyState.hidden = false;

    if (loadError) {
      emptyState.dataset.kind = "error";
      emptyState.textContent =
        "Could not load tabs (" + loadError + "). Try closing and reopening the popup.";
      return;
    }

    if (total > 0 && (searchInput.value || showOnlyAudible)) {
      emptyState.dataset.kind = "filter";
      emptyState.textContent = "";

      const msg = document.createElement("span");
      msg.textContent =
        "No tabs match your filters (" +
        total +
        " open). ";

      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "empty-clear-filters";
      clearBtn.textContent = "✕ Clear filters";
      clearBtn.addEventListener("click", async () => {
        searchInput.value = "";
        showOnlyAudible = false;
        if (audioFilterCheckbox) audioFilterCheckbox.checked = false;
        await browser.storage.local.set({
          popupSearch: "",
          popupShowOnlyAudible: false,
        });
        applyFilters();
        renderTable();
      });

      emptyState.appendChild(msg);
      emptyState.appendChild(clearBtn);
      return;
    }

    emptyState.dataset.kind = "empty";
    emptyState.textContent =
      "No tabs found. If you have tabs open, remove and re-load this temporary add-on (about:debugging), or restart Firefox once.";
  }

  function renderTable() {
    const countEl = document.getElementById("visible-tab-count");
    if (countEl) {
      const newCount = filteredTabEntries.length;
      const prev = countEl.textContent;
      if (prev != newCount) {
        countEl.textContent = newCount;
        // Defer animation so we don't force layout before stylesheets settle
        // (avoids "Layout was forced before the page was fully loaded" warnings).
        requestAnimationFrame(() => {
          countEl.style.transition = "none";
          countEl.style.transform = "scale(1.15)";
          requestAnimationFrame(() => {
            countEl.style.transition =
              "transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1)";
            countEl.style.transform = "scale(1)";
          });
        });
      }
    }

    // Check for new personal best based on actual open tabs (not filtered)
    checkForNewPersonalBest();

    // Safe clear (avoids any innerHTML usage/warnings)
    while (tableBody.firstChild) {
      tableBody.removeChild(tableBody.firstChild);
    }

    // Relative scale among currently open tabs: newest = no color → blue → orange
    let minTs = Infinity;
    let maxTs = 0;
    for (const key in tabInfoList) {
      const ts = tabInfoList[key].lastOpenedTs;
      if (ts) {
        if (ts < minTs) minTs = ts;
        if (ts > maxTs) maxTs = ts;
      }
    }

    const fragment = document.createDocumentFragment();
    filteredTabEntries.forEach(([tabKey, tabInfo]) => {
      const row = createTabRow(tabKey, tabInfo);

      const age = Core.getAgeColors(tabInfo.lastOpenedTs, minTs, maxTs);
      if (age) {
        row.style.backgroundColor = age.wash;
      }

      fragment.appendChild(row);
    });
    tableBody.appendChild(fragment);

    updateEmptyState();
  }

  function applyFilters() {
    const searchTerm = searchInput.value.toLowerCase();

    filteredTabEntries = Object.entries(tabInfoList).filter(function ([_, tabInfo]) {
      const title = (tabInfo.title || "").toLowerCase();
      const url = (tabInfo.url || "").toLowerCase();

      const matchesSearch =
        title.includes(searchTerm) || url.includes(searchTerm);

      const matchesAudio =
        !showOnlyAudible || tabInfo.audible === true;

      return matchesSearch && matchesAudio;
    });

    applyCurrentSort();
  }

  function handleTableHeaderClick(event) {
    let sortAttribute = event.currentTarget.getAttribute("data-sort");

    sortOrder = sortField === sortAttribute ? -sortOrder : 1;
    sortField = sortAttribute;

    // Persist sort state
    browser.storage.local.set({
      popupSortField: sortField,
      popupSortOrder: sortOrder
    });

    updateSortIndicators();
    applyCurrentSort();
    renderTable();
  }

  function applyCurrentSort() {
    if (!sortField) return;

    filteredTabEntries.sort(function (a, b) {
      let actualSortField = sortField;

      if (sortField === "firstOpened") {
        actualSortField = "firstOpenedTs";
      }

      if (sortField === "lastOpened") {
        actualSortField = "lastOpenedTs";
      }

      const valueA = a[1][actualSortField] ?? "";
      const valueB = b[1][actualSortField] ?? "";

      if (valueA > valueB) return sortOrder;
      if (valueA < valueB) return -sortOrder;
      return 0;
    });
  }

  function updateSortIndicators() {
    tableHeaders.forEach((header) => {
      const indicator = header.querySelector(".sort-indicator");
      const field = header.getAttribute("data-sort");

      if (!indicator) return;

      if (field === sortField) {
        indicator.textContent = sortOrder === 1 ? "▲" : "▼";
      } else {
        indicator.textContent = "";
      }
    });
  }

  function updatePersonalBestDisplay() {
    const bestContainer = document.getElementById("personal-best");
    const bestNumber = document.getElementById("personal-best-number");

    if (!bestContainer || !bestNumber) return;

    if (personalBest > 0) {
      bestNumber.textContent = personalBest;
      bestContainer.style.display = "flex";
    } else {
      bestContainer.style.display = "none";
    }
  }

  function checkForNewPersonalBest() {
    const currentTotal = Object.keys(tabInfoList).length;

    if (currentTotal > personalBest) {
      personalBest = currentTotal;

      browser.storage.local.set({ personalBest: personalBest }).catch(() => {});

      updatePersonalBestDisplay();
      showNewRecordCelebration(currentTotal);
    }
  }

  function showNewRecordCelebration(newBest) {
    const bestContainer = document.getElementById("personal-best");
    if (!bestContainer) return;

    // Clear existing content safely using DOM methods (avoids innerHTML warnings)
    while (bestContainer.firstChild) {
      bestContainer.removeChild(bestContainer.firstChild);
    }

    // Build the "New record!" message with createElement + textContent for safety
    const label = document.createElement("span");
    label.classList.add("label");
    label.style.color = "#ff6b00";
    label.style.fontWeight = "800";
    label.textContent = "New record!";

    const num = document.createElement("span");
    num.classList.add("number");
    num.style.color = "#ff6b00";
    num.textContent = newBest;

    const fire = document.createElement("span");
    fire.classList.add("fire");
    fire.textContent = "🔥";

    bestContainer.appendChild(label);
    bestContainer.appendChild(num);
    bestContainer.appendChild(fire);

    // Make sure the container is visible during the celebration
    bestContainer.style.display = "flex";

    // Pop animation on the container - gentler scale + slower timing
    // so the "brag moment" feels nice and friendly, not rushed.
    bestContainer.style.transition = "transform 0.32s ease";
    bestContainer.style.transform = "scale(1.18)";

    setTimeout(() => {
      bestContainer.style.transform = "scale(1)";
    }, 220);

    // Big sessions only — fireworks for records above 100 tabs
    if (newBest > 100) {
      launchFireworks();
    }

    // Revert after 5 seconds (gives people time to see + screenshot for bragging).
    // Clear and let updatePersonalBestDisplay() safely rebuild the normal "Best: N 🔥" content.
    setTimeout(() => {
      if (bestContainer) {
        while (bestContainer.firstChild) {
          bestContainer.removeChild(bestContainer.firstChild);
        }
        updatePersonalBestDisplay();
      }
    }, 5000);
  }

  function launchFireworks() {
    const root = document.createElement("div");
    root.className = "fireworks-layer";
    root.setAttribute("aria-hidden", "true");
    document.body.appendChild(root);

    const colors = [
      "#ff6b00",
      "#ff9f1c",
      "#148dff",
      "#35c7ff",
      "#ff6fb1",
      "#7c5cff",
      "#ffe566",
    ];

    // A few staggered bursts across the popup
    const bursts = [
      { x: 22, y: 28, delay: 0 },
      { x: 72, y: 22, delay: 180 },
      { x: 48, y: 38, delay: 360 },
      { x: 30, y: 55, delay: 520 },
      { x: 68, y: 50, delay: 680 },
    ];

    bursts.forEach((burst) => {
      setTimeout(() => {
        if (!root.isConnected) return;
        spawnFireworkBurst(root, burst.x, burst.y, colors);
      }, burst.delay);
    });

    setTimeout(() => {
      if (root.parentNode) root.parentNode.removeChild(root);
    }, 3200);
  }

  function spawnFireworkBurst(layer, originXPercent, originYPercent, colors) {
    const particleCount = 18;
    for (let i = 0; i < particleCount; i++) {
      const angle = (Math.PI * 2 * i) / particleCount + (Math.random() * 0.35);
      const dist = 48 + Math.random() * 72;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist;
      const size = 3 + Math.random() * 4;
      const color = colors[i % colors.length];
      const duration = 700 + Math.random() * 500;

      const p = document.createElement("span");
      p.className = "firework-particle";
      p.style.left = originXPercent + "%";
      p.style.top = originYPercent + "%";
      p.style.width = size + "px";
      p.style.height = size + "px";
      p.style.background = color;
      p.style.boxShadow = "0 0 6px " + color;
      p.style.setProperty("--fw-dx", dx + "px");
      p.style.setProperty("--fw-dy", dy + "px");
      p.style.animationDuration = duration + "ms";
      layer.appendChild(p);
    }

    // Soft flash at the burst center
    const flash = document.createElement("span");
    flash.className = "firework-flash";
    flash.style.left = originXPercent + "%";
    flash.style.top = originYPercent + "%";
    layer.appendChild(flash);
  }
});
