let tabInfoList = {};

// Generate a stable key for each browser tab
function generateTabKey(tabId) {
  return String(tabId);
}

function generateRestoreKey(tab) {
  return tab.url || "";
}

function nowString() {
  return new Date().toLocaleString();
}

function nowTimestamp() {
  return Date.now();
}

function syncActiveTabs(callback) {
  chrome.tabs.query({}, function (tabs) {
    const oldTabInfoList = tabInfoList || {};
    const oldRecordsByRestoreKey = {};

    // Group old saved records by URL so restored tabs can inherit firstOpened
    for (let oldTabKey in oldTabInfoList) {
      const oldRecord = oldTabInfoList[oldTabKey];
      const restoreKey = oldRecord.url || "";

      if (!oldRecordsByRestoreKey[restoreKey]) {
        oldRecordsByRestoreKey[restoreKey] = [];
      }

      oldRecordsByRestoreKey[restoreKey].push(oldRecord);
    }

    const newTabInfoList = {};

    tabs.forEach(function (tab) {
      const tabKey = generateTabKey(tab.id);
      const restoreKey = generateRestoreKey(tab);
      const existingByTabId = oldTabInfoList[tabKey];

      let restoredRecord = null;

      if (oldRecordsByRestoreKey[restoreKey]?.length > 0) {
        restoredRecord = oldRecordsByRestoreKey[restoreKey].shift();
      }

      const previousRecord = existingByTabId || restoredRecord;
      const now = nowString();
      const nowTs = nowTimestamp();

      newTabInfoList[tabKey] = {
        id: tab.id,
        windowId: tab.windowId,
        title: tab.title || "",
        url: tab.url || "",
        favIconUrl: tab.favIconUrl || previousRecord?.favIconUrl || "",
        audible: !!tab.audible,

        firstOpened: previousRecord?.firstOpened || now,
        firstOpenedTs: previousRecord?.firstOpenedTs || nowTs,

        lastOpened: previousRecord?.lastOpened || (tab.active ? now : ""),
        lastOpenedTs: previousRecord?.lastOpenedTs || (tab.active ? nowTs : 0),
      };
    });

    tabInfoList = newTabInfoList;

    chrome.storage.local.set({ tabInfoList: tabInfoList }, function () {
      if (callback) callback();
    });
  });
}

// Update tab info when a tab changes or becomes active
function updateTabInfo(tabId, changeInfo, tab) {
  if (!tab) return;

  const shouldUpdate =
    changeInfo.status === "complete" ||
    changeInfo.title ||
    changeInfo.url ||
    changeInfo.active === true;

  if (!shouldUpdate) return;

  const tabKey = generateTabKey(tabId);
  let existingTabInfo = tabInfoList[tabKey];

  // If tab.id changed after browser restart, try to recover old record by URL
  if (!existingTabInfo && tab.url) {
    for (let oldTabKey in tabInfoList) {
      if (tabInfoList[oldTabKey].url === tab.url) {
        existingTabInfo = tabInfoList[oldTabKey];
        delete tabInfoList[oldTabKey];
        break;
      }
    }
  }

  const now = nowString();
  const nowTs = nowTimestamp();

  tabInfoList[tabKey] = {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title || "",
    url: tab.url || "",
    favIconUrl: tab.favIconUrl || existingTabInfo?.favIconUrl || "",
    audible: !!tab.audible,

    firstOpened: existingTabInfo?.firstOpened || now,
    firstOpenedTs: existingTabInfo?.firstOpenedTs || nowTs,

    lastOpened:
      changeInfo.active === true
        ? now
        : existingTabInfo?.lastOpened || "",
    lastOpenedTs:
      changeInfo.active === true
        ? nowTs
        : existingTabInfo?.lastOpenedTs || 0,
  };

  chrome.storage.local.set({ tabInfoList: tabInfoList });
}

// Listener for onActivated event
function onTabActivated(activeInfo) {
  chrome.tabs.get(activeInfo.tabId, function (tab) {
    if (chrome.runtime.lastError) return;
    updateTabInfo(activeInfo.tabId, { active: true }, tab);
  });
}

// Listener for onRemoved event
function onTabRemoved(tabId) {
  const tabKey = generateTabKey(tabId);

  if (tabInfoList[tabKey]) {
    delete tabInfoList[tabKey];
    chrome.storage.local.set({ tabInfoList: tabInfoList });
  }
}

// Load stored data, then sync with open tabs
chrome.storage.local.get("tabInfoList", function (result) {
  tabInfoList = result.tabInfoList || {};
  syncActiveTabs();
});

// Listener for messages from the popup
function onMessageReceived(request, sender, sendResponse) {
  if (request === "getTabInfo") {
    chrome.storage.local.get("tabInfoList", function (result) {
      tabInfoList = result.tabInfoList || {};

      syncActiveTabs(function () {
        sendResponse(tabInfoList);
      });
    });

    return true;
  }
}

// Add event listeners
chrome.tabs.onUpdated.addListener(updateTabInfo);
chrome.tabs.onActivated.addListener(onTabActivated);
chrome.tabs.onRemoved.addListener(onTabRemoved);
chrome.runtime.onMessage.addListener(onMessageReceived);