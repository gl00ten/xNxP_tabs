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
  // Example: suppose right now you have tabs with these lastOpenedTs values:
  //   Tab A (most recent): 1000
  //   Tab B:                850
  //   Tab C (oldest):       600
  //
  // Then minTs=600, maxTs=1000
  //
  // For Tab B: t = (1000 - 850) / (1000 - 600) = 150 / 400 = 0.375
  //
  // The formula (maxTs - timestamp) / (maxTs - minTs) makes larger timestamps (more recent)
  // produce smaller t values.
  const t = (maxTs - timestamp) / (maxTs - minTs);

  // 2. Apply non-linear curve so the visual change is more sensitive for recently-used tabs
  //    (small age differences early on matter more than huge differences on very old tabs)
  const u = Math.pow(t, 0.6);

  // 3. Map u into HSL color space (smooth interpolation, no discrete buckets)
  const hue   = 210 - (u * 175);   // blueish cool → orange warm
  const sat   = 12  + (u * 58);    // low saturation → richer warm color
  const light = 96  - (u * 10);    // very pale → a bit less pale

  // === DEBUG: uncomment the two lines below to see the actual numbers in the console
  //            every time you open the popup or change filters.
  // console.log('Age scale this render → minTs:', minTs, 'maxTs:', maxTs);
  // console.log('  tab ts:', timestamp, '→ t=', t.toFixed(3), 'u=', u.toFixed(3), '→ color=', `hsl(${hue.toFixed(1)}, ${sat.toFixed(1)}%, ${light.toFixed(1)}%)`);

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

document.addEventListener("DOMContentLoaded", function () {
  const tableBody = document.getElementById("table-body");
  const searchInput = document.getElementById("search-input");
  const tableHeaders = document.querySelectorAll("th[data-sort]");
  const audioFilterCheckbox = document.getElementById("audio-filter-checkbox");
  const kofiLink = document.getElementById("kofi-link");

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

  // Restore previous search + audio filter + sort state
  (async () => {
    try {
      const result = await browser.storage.local.get([
        "popupSearch",
        "popupShowOnlyAudible",
        "popupSortField",
        "popupSortOrder",
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

      // Load personal best
      const bestResult = await browser.storage.local.get("personalBest");
      personalBest = bestResult.personalBest || 0;
      updatePersonalBestDisplay();

      const responseTabInfoList = await browser.runtime.sendMessage("getTabInfo");
      tabInfoList = responseTabInfoList || {};

      applyFilters();
      renderTable();
      updateSortIndicators();

      // Focus and select the search input so the user can immediately replace previous text by typing
      searchInput.focus();
      searchInput.select();
    } catch (err) {
      console.error("Popup init failed:", err);
      // Fallback so UI still appears (empty table is better than blank)
      applyFilters();
      renderTable();
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

  function renderTable() {
    const countEl = document.getElementById('visible-tab-count');
    if (countEl) {
      const newCount = filteredTabEntries.length;
      if (countEl.textContent != newCount) {
        // Fun pop animation - make the number "jump" bigger then settle.
        // We disable transition, force it big (scale 1.3), force browser to notice
        // the change (offsetWidth), swap the text, then re-enable the transition
        // and go back to normal. The bouncy cubic-bezier gives it a little spring.
        countEl.style.transition = 'none';
        countEl.style.transform = 'scale(1.3)';
        
        // Force reflow so the scale(1.3) is committed before we start the transition
        void countEl.offsetWidth;
        
        countEl.textContent = newCount;
        countEl.style.transition = 'transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1)';
        countEl.style.transform = 'scale(1)';
      }
    }

    // Check for new personal best based on actual open tabs (not filtered)
    checkForNewPersonalBest();

    // === DATA-DRIVEN SCALE ===
    // We scan ALL currently open tabs (tabInfoList) to find the real min and max
    // lastOpenedTs that exist right now. These two numbers define the entire color scale
    // for this render. No hard-coded "7 days" or similar.
    let minTs = Infinity;
    let maxTs = 0;
    for (const key in tabInfoList) {
      const ts = tabInfoList[key].lastOpenedTs;
      if (ts) {
        if (ts < minTs) minTs = ts;
        if (ts > maxTs) maxTs = ts;
      }
    }

    // === DEBUG (uncomment to see the actual numbers while the popup is open) ===
    // console.log('Age scale this render - minTs:', minTs, 'maxTs:', maxTs, 'rangeHours:', (maxTs-minTs)/3600000);

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