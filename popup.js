function getAgeBackground(timestamp, minTs, maxTs) {
  if (!timestamp || !isFinite(minTs) || !isFinite(maxTs) || minTs >= maxTs) return null;

  // === THE SCALE (this is the key part) ===
  // minTs = the OLDEST last-opened timestamp among your CURRENTLY open tabs
  // maxTs = the MOST RECENT last-opened timestamp among your CURRENTLY open tabs
  //
  // For any tab we compute a normalized position t:
  //   t = 0  → this is your most recently used tab right now  → coolest color
  //   t = 1  → this is your least recently used tab right now  → warmest color
  //
  // The formula (maxTs - timestamp) / (maxTs - minTs) makes larger timestamps (more recent)
  // produce smaller t values.
  const t = (maxTs - timestamp) / (maxTs - minTs);

  // 2. Apply non-linear curve so the visual change is more sensitive for recently-used tabs
  const u = Math.pow(t, 0.6);

  // 3. Map u into HSL color space (smooth interpolation, no discrete buckets)
  const hue   = 210 - (u * 175);   // blueish cool → orange warm
  const sat   = 12  + (u * 58);    // low saturation → richer warm color
  const light = 96  - (u * 10);    // very pale → a bit less pale

  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

function formatShortDate(timestamp, fallbackText = "") {
  if (!timestamp) return fallbackText;

  const date = new Date(timestamp);
  const year = String(date.getFullYear()).slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");

  return `${year}.${month}.${day} ${hour}:${minute}`;
}

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
  const kofiLink = document.getElementById("kofi-link");
  const emptyState = document.getElementById("empty-state");
  const debugPanel = document.getElementById("debug-panel");
  const debugModeCheckbox = document.getElementById("debug-mode-checkbox");
  const debugCopyBtn = document.getElementById("debug-copy-btn");
  const debugHideBtn = document.getElementById("debug-hide-btn");
  const debugStatus = document.getElementById("debug-status");

  if (kofiLink) {
    kofiLink.addEventListener("click", () => {
      browser.tabs.create({ url: "https://ko-fi.com/gl00ten" });
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

  // Hidden entry: Ctrl+Shift+D (Cmd+Shift+D on Mac) toggles the debug panel.
  // No UI affordance — intentional.
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      e.stopPropagation();
      showDebugPanel(!debugPanelVisible);
    }
  });

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
    // Panel only opens via the secret shortcut (or Hide button closes it).
    // debugMode controls logging only, not panel visibility.
    if (debugPanelVisible) {
      debugPanel.hidden = false;
      debugPanel.removeAttribute("hidden");
    } else {
      debugPanel.hidden = true;
      debugPanel.setAttribute("hidden", "");
    }
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
    switchButton.textContent = "Switch";
    switchButton.classList.add("action-button");
    switchButton.onclick = (e) => {
      e.stopPropagation();
      switchToTab(tabInfo);
    };
    actionsCell.appendChild(switchButton);

    const closeButton = document.createElement("button");
    closeButton.textContent = "Close";
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
    lastDate.textContent = formatShortDate(tabInfo.lastOpenedTs, tabInfo.lastOpened || "");
    row.appendChild(lastDate);

    const firstDate = document.createElement("td");
    firstDate.classList.add("col-date");
    firstDate.textContent = formatShortDate(tabInfo.firstOpenedTs, tabInfo.firstOpened || "");
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
      clearBtn.textContent = "Clear filters";
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

    // === DATA-DRIVEN SCALE ===
    let minTs = Infinity;
    let maxTs = 0;
    for (const key in tabInfoList) {
      const ts = tabInfoList[key].lastOpenedTs;
      if (ts) {
        if (ts < minTs) minTs = ts;
        if (ts > maxTs) maxTs = ts;
      }
    }

    // Safe clear (avoids any innerHTML usage/warnings)
    while (tableBody.firstChild) {
      tableBody.removeChild(tableBody.firstChild);
    }

    const fragment = document.createDocumentFragment();
    filteredTabEntries.forEach(([tabKey, tabInfo]) => {
      const row = createTabRow(tabKey, tabInfo);

      // Apply continuous age background using data-driven min/max
      const bg = getAgeBackground(tabInfo.lastOpenedTs, minTs, maxTs);
      if (bg) row.style.backgroundColor = bg;

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
      const oldBest = personalBest;
      personalBest = currentTotal;

      browser.storage.local.set({ personalBest: personalBest }).catch(() => {});

      updatePersonalBestDisplay();
      showNewRecordCelebration(currentTotal, oldBest);
    }
  }

  function showNewRecordCelebration(newBest, oldBest) {
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
});
