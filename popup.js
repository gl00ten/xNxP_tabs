let maxTextLength = 200;

document.addEventListener("DOMContentLoaded", function () {
  const tableBody = document.getElementById("table-body");
  const searchInput = document.getElementById("search-input");
  const tableHeaders = document.querySelectorAll("th[data-sort]");
  const audioFilterButton = document.getElementById("audio-filter-button");

  let tabInfoList = {};
  let filteredTabEntries = [];
  let sortField = null;
  let sortOrder = 1;
  let showOnlyAudible = false;

  chrome.runtime.sendMessage("getTabInfo", function (responseTabInfoList) {
    tabInfoList = responseTabInfoList || {};
    applyFilters();
    renderTable();
  });

  searchInput.addEventListener("input", function () {
    applyFilters();
    renderTable();
  });

  if (audioFilterButton) {
    audioFilterButton.addEventListener("click", function () {
      showOnlyAudible = !showOnlyAudible;
      audioFilterButton.classList.toggle("active", showOnlyAudible);

      applyFilters();
      renderTable();
    });
  }

  tableHeaders.forEach((header) => {
    header.style.cursor = "pointer";
    header.addEventListener("click", handleTableHeaderClick);
  });

  function renderTable() {
    tableBody.innerHTML = "";

    filteredTabEntries.forEach(function ([tabKey, tabInfo]) {
      let row = document.createElement("tr");

      let actionsCell = document.createElement("td");

      let switchButton = document.createElement("button");
      switchButton.textContent = "Switch";
      switchButton.classList.add("action-button");
      switchButton.onclick = () => {
        chrome.tabs.update(tabInfo.id, { active: true }, function () {
          chrome.windows.update(
            tabInfo.windowId,
            { focused: true, state: "normal" },
            function () {
              window.close();
            }
          );
        });
      };
      actionsCell.appendChild(switchButton);

      let closeButton = document.createElement("button");
      closeButton.textContent = "Close";
      closeButton.classList.add("action-button");
      closeButton.onclick = () => {
        chrome.tabs.remove(tabInfo.id);

        delete tabInfoList[tabKey];

        applyFilters();
        chrome.storage.local.set({ tabInfoList: tabInfoList });
        renderTable();
      };
      actionsCell.appendChild(closeButton);

      row.appendChild(actionsCell);

      renderTableCell(
        row,
        formatShortDate(tabInfo.firstOpenedTs, tabInfo.firstOpened || "")
      );

      renderTableCell(
        row,
        formatShortDate(tabInfo.lastOpenedTs, tabInfo.lastOpened || "")
      );

      let tabCell = document.createElement("td");
      tabCell.classList.add("tab-cell");

      let titleDiv = document.createElement("div");
      titleDiv.classList.add("tab-title");

      if (tabInfo.favIconUrl) {
        let favicon = document.createElement("img");
        favicon.classList.add("tab-favicon");
        favicon.src = tabInfo.favIconUrl;
        favicon.alt = "";
        titleDiv.appendChild(favicon);
      }

      if (tabInfo.audible) {
        let audioIcon = document.createElement("span");
        audioIcon.classList.add("audio-indicator");
        audioIcon.textContent = "♪";
        audioIcon.title = "This tab is playing audio";
        titleDiv.appendChild(audioIcon);
      }

      let titleText = document.createElement("span");
      titleText.textContent = tabInfo.title || "";
      titleDiv.appendChild(titleText);

      let urlDiv = document.createElement("div");
      urlDiv.classList.add("tab-url-inline");
      urlDiv.textContent = tabInfo.url || "";

      tabCell.appendChild(titleDiv);
      tabCell.appendChild(urlDiv);
      row.appendChild(tabCell);

      renderTableCell(row, tabInfo.id || "");
      renderTableCell(row, tabInfo.windowId || "");

      tableBody.appendChild(row);
    });
  }

  function renderTableCell(row, content) {
    let cell = document.createElement("td");
    cell.textContent = content;
    row.appendChild(cell);
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