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

  searchInput.focus();

  let tabInfoList = {};
  let filteredTabEntries = [];
  let sortField = null;
  let sortOrder = 1;
  let showOnlyAudible = false;

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

    const responseTabInfoList = await browser.runtime.sendMessage("getTabInfo");
    tabInfoList = responseTabInfoList || {};
    applyFilters();
    renderTable();
    updateSortIndicators();
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

    // Date cells
    renderTableCell(row, formatShortDate(tabInfo.firstOpenedTs, tabInfo.firstOpened || ""));
    renderTableCell(row, formatShortDate(tabInfo.lastOpenedTs, tabInfo.lastOpened || ""));

    // Tab info cell
    const tabCell = document.createElement("td");
    tabCell.classList.add("tab-cell");

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

    // ID and Window ID
    renderTableCell(row, tabInfo.id || "");
    renderTableCell(row, tabInfo.windowId || "");

    return row;
  }

  async function switchToTab(tabInfo) {
    try {
      await browser.tabs.update(tabInfo.id, { active: true });
      await browser.windows.update(tabInfo.windowId, {
        focused: true,
        state: "normal",
      });
      window.close();
    } catch (err) {
      // Tab or window may no longer exist
    }
  }

  function renderTable() {
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
});