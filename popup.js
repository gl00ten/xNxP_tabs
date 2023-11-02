let maxTextLength = 50;

document.addEventListener("DOMContentLoaded", function () {
  const tableBody = document.getElementById("table-body");
  const searchInput = document.getElementById("search-input");
  const tableHeaders = document.querySelectorAll("th[data-sort]");

  let tabInfoList = {};
  let filteredTabInfoList = {};
  let sortField = null;
  let sortOrder = 1;

  // Request tabInfoList from the background script
  chrome.runtime.sendMessage("getTabInfo", function (responseTabInfoList) {
    tabInfoList = responseTabInfoList;
    filteredTabInfoList = { ...tabInfoList };
    renderTable();
  });

  // Add event listeners for search input
  searchInput.addEventListener("input", handleSearch);

  // Add event listeners for table headers
  tableHeaders.forEach((header) =>
    header.addEventListener("click", handleTableHeaderClick)
  );

  function renderTable() {
    tableBody.innerHTML = "";

    for (let tabKey in filteredTabInfoList) {
      let tabInfo = filteredTabInfoList[tabKey];

      // Create a new table row
      let row = document.createElement("tr");



      // Render table cells
      renderTableCell(row, tabInfo.firstOpened);
      renderTableCell(row, tabInfo.lastOpened);
      renderTableCell(row, tabInfo.title.slice(0,maxTextLength));
      renderTableCell(row, tabInfo.url.slice(0,maxTextLength));
      renderTableCell(row, tabInfo.id);
      renderTableCell(row, tabInfo.windowId);

      // Render actions cell
      let actionsCell = document.createElement("td");

      // Switch button
      let switchButton = document.createElement("button");
      switchButton.textContent = "Switch";
      switchButton.classList.add("action-button");
      switchButton.onclick = () => {
        chrome.windows.update(tabInfo.windowId, { focused: true });
        chrome.tabs.update(tabInfo.id, { active: true });
        //window.close();
      };
      actionsCell.appendChild(switchButton);

      // Close button
      let closeButton = document.createElement("button");
      closeButton.textContent = "Close";
      closeButton.classList.add("action-button");
      closeButton.onclick = () => {
        chrome.tabs.remove(tabInfo.id);
        delete tabInfoList[tabKey];
        delete filteredTabInfoList[tabKey];
        chrome.storage.local.set({ tabInfoList: tabInfoList });
        renderTable();
      };
      actionsCell.appendChild(closeButton);

      // Append the actions cell to the beginning of the row
      row.insertBefore(actionsCell, row.firstChild);

      // Append the row to the table body
      tableBody.appendChild(row);
    }
  }

  function renderTableCell(row, content) {
    let cell = document.createElement("td");
    cell.textContent = content;
    row.appendChild(cell);
  }

  function handleSearch(event) {
    let searchTerm = event.target.value.toLowerCase();
    filteredTabInfoList = {};

    for (let tabKey in tabInfoList) {
      let tabInfo = tabInfoList[tabKey];
      if (
        tabInfo.title.toLowerCase().includes(searchTerm) ||
        tabInfo.url.toLowerCase().includes(searchTerm)
      ) {
        filteredTabInfoList[tabKey] = tabInfo;
      }
    }

    renderTable();
  }

  function handleTableHeaderClick(event) {
    let sortAttribute = event.target.getAttribute("data-sort");
    sortOrder = sortField === sortAttribute ? -sortOrder : 1;
    sortField = sortAttribute;

    filteredTabInfoList = Object.fromEntries(
      Object.entries(filteredTabInfoList).sort((a, b) =>
        a[1][sortField] > b[1][sortField]
          ? sortOrder
          : a[1][sortField] < b[1][sortField]
          ? -sortOrder
          : 0
      )
    );

    renderTable();
  }
});