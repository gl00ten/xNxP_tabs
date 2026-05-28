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

// Shared helper to construct a tab record.
// Removes heavy duplication between onCreated, updateTabInfo, and syncActiveTabs
// while keeping the different "intent" cases explicit via options.
function buildTabRecord(tab, previousRecord = null, options = {}) {
  const {
    forceFirstOpened = false,
    forceLastOpened = false,
  } = options;

  const now = nowString();
  const nowTs = nowTimestamp();

  const firstOpened = forceFirstOpened || !previousRecord?.firstOpened
    ? now
    : previousRecord.firstOpened;

  const firstOpenedTs = forceFirstOpened || !previousRecord?.firstOpenedTs
    ? nowTs
    : previousRecord.firstOpenedTs;

  let lastOpened;
  let lastOpenedTs;

  if (forceLastOpened || (tab.active && !previousRecord?.lastOpened)) {
    lastOpened = now;
    lastOpenedTs = nowTs;
  } else if (previousRecord) {
    lastOpened = previousRecord.lastOpened || "";
    lastOpenedTs = previousRecord.lastOpenedTs || 0;
  } else {
    lastOpened = "";
    lastOpenedTs = 0;
  }

  // Fallback: if we have firstOpened but no lastOpened, use the firstOpened time.
  // This cleans up old data, restored tabs that were never activated,
  // and prevents blank "Last Opened" values in the UI.
  if (!lastOpened && firstOpened) {
    lastOpened = firstOpened;
    lastOpenedTs = firstOpenedTs;
  }

  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title || "",
    url: tab.url || "",
    favIconUrl: tab.favIconUrl || previousRecord?.favIconUrl || "",
    audible: !!tab.audible,
    firstOpened,
    firstOpenedTs,
    lastOpened,
    lastOpenedTs,
  };
}

async function syncActiveTabs() {
  const tabs = await browser.tabs.query({});

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

    // No force* flags → prefers previousRecord values when available
    // (this is how we preserve historical firstOpened across restarts)
    newTabInfoList[tabKey] = buildTabRecord(tab, previousRecord);
  });

  tabInfoList = newTabInfoList;

  await browser.storage.local.set({ tabInfoList: tabInfoList });
}

// Update tab info when a tab changes or becomes active
async function updateTabInfo(tabId, changeInfo, tab) {
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

  // forceLastOpened when this update represents an activation event
  tabInfoList[tabKey] = buildTabRecord(tab, existingTabInfo, {
    forceLastOpened: changeInfo.active === true,
  });

  await browser.storage.local.set({ tabInfoList: tabInfoList });
}

// Listener for onActivated event
async function onTabActivated(activeInfo) {
  try {
    const tab = await browser.tabs.get(activeInfo.tabId);
    await updateTabInfo(activeInfo.tabId, { active: true }, tab);
  } catch (err) {
    // Tab might have been closed
  }
}

// Listener for onRemoved event
async function onTabRemoved(tabId) {
  const tabKey = generateTabKey(tabId);

  if (tabInfoList[tabKey]) {
    delete tabInfoList[tabKey];
    await browser.storage.local.set({ tabInfoList: tabInfoList });
  }
}

// Listener for onCreated event.
// This is the correct place to record "firstOpened" for genuinely new tabs
// created by the user during a browsing session.
async function onTabCreated(tab) {
  const tabKey = generateTabKey(tab.id);

  // Defensive: shouldn't happen, but don't clobber existing data
  if (tabInfoList[tabKey]) {
    return;
  }

  // Key heuristic for session restore safety:
  // If the tab already has a real URL at the moment it is "created",
  // it is almost certainly a tab being restored by the browser after
  // startup / session restore. We must NOT stamp firstOpened = "now"
  // in this case, or we would destroy historical data.
  //
  // Normal user-created tabs (Ctrl+T, links with target="_blank", etc.)
  // usually arrive with empty url or an internal new-tab page.
  const url = tab.url || "";
  const isLikelyRestoredTab =
    url !== "" &&
    !url.startsWith("about:") &&
    !url.startsWith("chrome://newtab") &&
    !url.startsWith("edge://newtab");

  if (isLikelyRestoredTab) {
    return; // Let syncActiveTabs + updateTabInfo's URL recovery handle it
  }

  // For genuinely new tabs we force both firstOpened and lastOpened to now.
  // This prevents blank "Last Opened" values for tabs the user just created.
  // If the user later activates the tab, updateTabInfo will set the real time.
  tabInfoList[tabKey] = buildTabRecord(tab, null, {
    forceFirstOpened: true,
    forceLastOpened: true,
  });

  await browser.storage.local.set({ tabInfoList: tabInfoList });
}

// Load stored data, then sync with open tabs
(async () => {
  try {
    const result = await browser.storage.local.get("tabInfoList");
    tabInfoList = result.tabInfoList || {};
    await syncActiveTabs();
  } catch (err) {
    console.error("Background initial load failed:", err);
  }
})();

// Listener for messages from the popup
function onMessageReceived(request, sender, sendResponse) {
  if (request === "getTabInfo") {
    (async () => {
      const result = await browser.storage.local.get("tabInfoList");
      tabInfoList = result.tabInfoList || {};

      await syncActiveTabs();
      sendResponse(tabInfoList);
    })();

    return true; // Keep the message channel open for async response
  }
}

// Add event listeners
//
// Tab data can enter the system through three paths:
// 1. onCreated        → fresh tabs created during this session (best for "firstOpened")
// 2. onUpdated        → enriches records + catches restored tabs via URL recovery
// 3. syncActiveTabs() → full resync at startup + when popup requests data (handles session restore)
browser.tabs.onCreated.addListener(onTabCreated);
browser.tabs.onUpdated.addListener(updateTabInfo);
browser.tabs.onActivated.addListener(onTabActivated);
browser.tabs.onRemoved.addListener(onTabRemoved);
browser.runtime.onMessage.addListener(onMessageReceived);