let maxTextLength = 200;

function renderTableCell(row, content) {
  const cell = document.createElement("td");
  cell.textContent = content;
  row.appendChild(cell);
}

function getAgeClass(timestamp) {
  if (!timestamp) return "";

  const ageMs = Date.now() - timestamp;
  const hours = ageMs / (1000 * 60 * 60);

  if (hours > 72) return "age-very-old";
  if (hours > 24) return "age-old";
  if (hours > 6)  return "age-today";
  if (hours > 1)  return "age-recent";
  return "";
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

  let tabInfoList = {};
  let filteredTabEntries = [];
  let sortField = null;
  let sortOrder = 1;
  let showOnlyAudible = false;
  let personalBest = 0;

  // Restore previous search + audio filter + sort state
  (async () => {
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

    checkForNewPersonalBest();

    applyFilters();
    renderTable();
    updateSortIndicators();

    // Focus and select the search input so the user can immediately replace previous text by typing
    searchInput.focus();
    searchInput.select();
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

    // Age visualization
    const ageClass = getAgeClass(tabInfo.lastOpenedTs);
    if (ageClass) row.classList.add(ageClass);

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
        delete tabInfoList[tabKey];
        applyFilters();
        await browser.storage.local.set({ tabInfoList: tabInfoList });
        renderTable();
      } catch (err) {}
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
        // Fun pop animation
        countEl.style.transition = 'none';
        countEl.style.transform = 'scale(1.4)';
        
        // Force reflow
        void countEl.offsetWidth;
        
        countEl.textContent = newCount;
        countEl.style.transition = 'transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1)';
        countEl.style.transform = 'scale(1)';
      }
    }

    tableBody.innerHTML = "";

    const fragment = document.createDocumentFragment();
    filteredTabEntries.forEach(([tabKey, tabInfo]) => {
      const row = createTabRow(tabKey, tabInfo);
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

      browser.storage.local.set({ personalBest: personalBest });

      updatePersonalBestDisplay();
      showNewRecordCelebration(currentTotal, oldBest);
    }
  }

  function showNewRecordCelebration(newBest, oldBest) {
    const bestContainer = document.getElementById("personal-best");
    if (!bestContainer) return;

    const originalText = bestContainer.innerHTML;

    bestContainer.innerHTML = `
      <span class="label" style="color:#ff6b00; font-weight:800;">New record!</span>
      <span class="number" style="color:#ff6b00;">${newBest}</span>
      <span class="fire">🔥</span>
    `;

    // Pop animation on the container
    bestContainer.style.transition = "transform 0.2s ease";
    bestContainer.style.transform = "scale(1.15)";

    setTimeout(() => {
      bestContainer.style.transform = "scale(1)";
    }, 150);

    // Revert after a few seconds
    setTimeout(() => {
      if (bestContainer) {
        bestContainer.innerHTML = originalText;
        updatePersonalBestDisplay();
      }
    }, 4200);
  }
});