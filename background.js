// Initialize and load tabInfoList from storage
chrome.storage.local.get("tabInfoList", function (result) {
  let tabInfoList = result.tabInfoList || {};

  // Remove inactive tabs and update tabInfoList with currently opened tabs
  syncActiveTabs();

  // Add event listeners
  chrome.tabs.onUpdated.addListener(updateTabInfo);
  chrome.tabs.onActivated.addListener(onTabActivated);
  chrome.tabs.onRemoved.addListener(onTabRemoved);
  chrome.runtime.onMessage.addListener(onMessageReceived);

  // Synchronize tabInfoList with active tabs
  function syncActiveTabs() {
    chrome.tabs.query({}, function (tabs) {
      let tabInfoListUpdated = false;

      // Remove inactive tabs
      for (let tabKey in tabInfoList) {
        let tabStillExists = tabs.some(
          (tab) => tabKey === generateTabKey(tab.url, tab.title)
        );
        if (!tabStillExists) {
          delete tabInfoList[tabKey];
          tabInfoListUpdated = true;
        }
      }

      // Update tabInfoList with opened tabs
      tabs.forEach(function (tab) {
        let tabKey = generateTabKey(tab.url, tab.title);
        let isNewTab = !tabInfoList.hasOwnProperty(tabKey);

        let tabInfo = tabInfoList[tabKey] || {
          id: tab.id,
          windowId: tab.windowId,
          title: tab.title,
          url: tab.url,
          firstOpened: new Date().toLocaleString(),
          lastOpened: new Date().toLocaleString(),
        };

        if (!isNewTab) {
          tabInfo.title = tab.title;
          tabInfo.id = tab.id;
          tabInfo.windowId = tab.windowId; // Update the windowId
          // Update the lastOpened property only when the tab is active
          if (tab.active) {
            tabInfo.lastOpened = new Date().toLocaleString();
          }
        }

        tabInfoList[tabKey] = tabInfo;
        tabInfoListUpdated = true;
      });

      if (tabInfoListUpdated) {
        chrome.storage.local.set({ tabInfoList: tabInfoList });
      }
    });
  }

  // Generate a unique key for the tab based on its URL and title
  function generateTabKey(url, title) {
    return `${url}_${title}`;
  }

  // Update tabInfo when the tab is updated or activated
  function updateTabInfo(tabId, changeInfo, tab) {
    if (changeInfo.status === "complete" || changeInfo.title || changeInfo.url || changeInfo.active === true) {
      let tabKey = generateTabKey(tab.url, tab.title);
      let tabInfo = tabInfoList[tabKey] || {};

      // Check if the tabKey has changed (e.g., due to a title or URL update)
      if (tabInfoList.hasOwnProperty(tabKey)) {
        tabInfo = tabInfoList[tabKey];
      } else {
        // Remove the old tabInfo entry if the tabKey has changed
        for (let oldTabKey in tabInfoList) {
          if (tabInfoList[oldTabKey].id === tabId) {
            delete tabInfoList[oldTabKey];
            break;
          }
        }
        tabInfo.firstOpened = new Date().toLocaleString();
      }

      tabInfo.id = tab.id;
      tabInfo.windowId = tab.windowId;
      tabInfo.title = tab.title;
      tabInfo.url = tab.url;
      tabInfo.lastOpened = new Date().toLocaleString();
      tabInfoList[tabKey] = tabInfo;
      chrome.storage.local.set({ tabInfoList: tabInfoList });
    }
  }

  // Listener for onActivated event
  function onTabActivated(activeInfo) {
    chrome.tabs.get(activeInfo.tabId, function (tab) {
      updateTabInfo(tab.id, { active: true }, tab);
    });
  }

  // Listener for onRemoved event
  function onTabRemoved(tabId, removeInfo) {
    for (let tabKey in tabInfoList) {
      if (tabInfoList[tabKey].id === tabId) {
        delete tabInfoList[tabKey];
        break;
        }
    }
    chrome.storage.local.set({ tabInfoList: tabInfoList });
  }

  // Listener for messages from the popup
  function onMessageReceived(request, sender, sendResponse) {
    if (request === "getTabInfo") {
      sendResponse(tabInfoList);
    }
  }
});