/**
 * Unit tests for xNxP Tabs pure logic.
 * Run: npm test
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const core = require("../lib/core.js");

describe("isDiscardableUrl", () => {
  it("rejects empty and internal schemes", () => {
    assert.equal(core.isDiscardableUrl(""), false);
    assert.equal(core.isDiscardableUrl(null), false);
    assert.equal(core.isDiscardableUrl("about:blank"), false);
    assert.equal(core.isDiscardableUrl("moz-extension://abc/x"), false);
    assert.equal(core.isDiscardableUrl("chrome://settings"), false);
  });

  it("accepts normal web urls", () => {
    assert.equal(core.isDiscardableUrl("https://example.com"), true);
  });
});

describe("mergeLiveTabsWithHistory", () => {
  const now = 1_000_000;

  it("never transfers history between two open tabs with the same URL (live mode)", () => {
    const live = [
      { id: 1, windowId: 1, title: "A", url: "https://dup.com", lastAccessed: 100 },
      { id: 2, windowId: 1, title: "B", url: "https://dup.com", lastAccessed: 200 },
    ];
    const stored = {
      "1": {
        id: 1,
        url: "https://dup.com",
        firstOpened: "old-A",
        firstOpenedTs: 10,
        lastOpened: "last-A",
        lastOpenedTs: 50,
      },
      // Orphan record that must NOT be stolen by tab 2 while tab 1 is open
      "99": {
        id: 99,
        url: "https://dup.com",
        firstOpened: "orphan",
        firstOpenedTs: 1,
        lastOpened: "orphan-last",
        lastOpenedTs: 2,
      },
    };

    const merged = core.mergeLiveTabsWithHistory(live, stored, {
      mode: "live",
      nowMs: now,
    });

    assert.equal(merged["1"].firstOpenedTs, 10);
    assert.equal(merged["1"].firstOpened, "old-A");
    // Tab 2 must not receive orphan history in live mode
    assert.notEqual(merged["2"].firstOpenedTs, 1);
    assert.equal(merged["2"].lastOpenedTs, 200); // lastAccessed
  });

  it("restores by URL only for unmatched tabs after id match (restore mode)", () => {
    const live = [
      { id: 10, windowId: 1, title: "NewId", url: "https://site.com", lastAccessed: 500 },
      { id: 11, windowId: 1, title: "Other", url: "https://other.com", lastAccessed: 600 },
    ];
    const stored = {
      "1": {
        id: 1,
        url: "https://site.com",
        firstOpened: "session-first",
        firstOpenedTs: 42,
        lastOpened: "session-last",
        lastOpenedTs: 99,
      },
      "2": {
        id: 2,
        url: "https://other.com",
        firstOpened: "other-first",
        firstOpenedTs: 7,
        lastOpened: "other-last",
        lastOpenedTs: 8,
      },
    };

    const merged = core.mergeLiveTabsWithHistory(live, stored, {
      mode: "restore",
      nowMs: now,
    });

    assert.equal(merged["10"].firstOpenedTs, 42);
    assert.equal(merged["10"].firstOpened, "session-first");
    assert.equal(merged["11"].firstOpenedTs, 7);
  });

  it("when every tab id changed, restores all by URL", () => {
    const live = [
      { id: 100, windowId: 1, title: "A", url: "https://a.com", lastAccessed: 10 },
      { id: 101, windowId: 1, title: "B", url: "https://b.com", lastAccessed: 20 },
    ];
    const stored = {
      "1": {
        url: "https://a.com",
        firstOpenedTs: 1,
        firstOpened: "a",
        lastOpenedTs: 2,
        lastOpened: "a2",
      },
      "2": {
        url: "https://b.com",
        firstOpenedTs: 3,
        firstOpened: "b",
        lastOpenedTs: 4,
        lastOpened: "b2",
      },
    };
    const merged = core.mergeLiveTabsWithHistory(live, stored, {
      mode: "restore",
      nowMs: now,
    });
    assert.equal(merged["100"].firstOpenedTs, 1);
    assert.equal(merged["101"].firstOpenedTs, 3);
  });

  it("empty storage uses tab.lastAccessed not identical now times", () => {
    const live = [
      { id: 1, windowId: 1, title: "A", url: "https://a.com", lastAccessed: 111 },
      { id: 2, windowId: 1, title: "B", url: "https://b.com", lastAccessed: 222 },
    ];
    const merged = core.mergeLiveTabsWithHistory(live, {}, {
      mode: "live",
      nowMs: now,
    });
    assert.equal(merged["1"].lastOpenedTs, 111);
    assert.equal(merged["2"].lastOpenedTs, 222);
    assert.notEqual(merged["1"].lastOpenedTs, merged["2"].lastOpenedTs);
  });

  it("restore: reused tab id with a different URL does not inherit history", () => {
    // Previous session: id 5 was Reddit. New session: id 5 is GitHub.
    const stored = {
      "5": {
        id: 5,
        url: "https://reddit.com",
        firstOpenedTs: 111,
        firstOpened: "reddit-first",
        lastOpenedTs: 222,
        lastOpened: "reddit-last",
      },
    };
    const live = [
      {
        id: 5,
        windowId: 1,
        title: "GitHub",
        url: "https://github.com",
        lastAccessed: 999,
      },
    ];
    const merged = core.mergeLiveTabsWithHistory(live, stored, {
      mode: "restore",
      nowMs: now,
    });
    assert.notEqual(merged["5"].firstOpenedTs, 111);
    assert.equal(merged["5"].lastOpenedTs, 999);
    assert.equal(merged["5"].url, "https://github.com");
  });

  it("restore: exact id and non-empty URL both matching keeps history", () => {
    const stored = {
      "5": {
        id: 5,
        url: "https://github.com",
        firstOpenedTs: 50,
        firstOpened: "gh-first",
        lastOpenedTs: 60,
        lastOpened: "gh-last",
      },
    };
    const live = [
      {
        id: 5,
        windowId: 1,
        title: "GitHub",
        url: "https://github.com",
        lastAccessed: 70,
      },
    ];
    const merged = core.mergeLiveTabsWithHistory(live, stored, {
      mode: "restore",
      nowMs: now,
    });
    assert.equal(merged["5"].firstOpenedTs, 50);
    assert.equal(merged["5"].firstOpened, "gh-first");
  });

  it("restore: empty URLs are never matched to each other", () => {
    const stored = {
      "1": {
        url: "",
        firstOpenedTs: 10,
        firstOpened: "blank-old",
        lastOpenedTs: 11,
        lastOpened: "blank-old-last",
      },
      "2": {
        url: "",
        firstOpenedTs: 20,
        firstOpened: "blank-old-2",
        lastOpenedTs: 21,
        lastOpened: "blank-old-2-last",
      },
    };
    const live = [
      { id: 10, windowId: 1, title: "A", url: "", lastAccessed: 100 },
      { id: 11, windowId: 1, title: "B", url: "", lastAccessed: 200 },
    ];
    const merged = core.mergeLiveTabsWithHistory(live, stored, {
      mode: "restore",
      nowMs: now,
    });
    // Fresh timestamps from lastAccessed — not stolen from empty-URL pool
    assert.equal(merged["10"].lastOpenedTs, 100);
    assert.equal(merged["11"].lastOpenedTs, 200);
    assert.notEqual(merged["10"].firstOpenedTs, 10);
    assert.notEqual(merged["11"].firstOpenedTs, 20);
  });

  it("live mode still trusts tab id when URL has navigated", () => {
    const stored = {
      "5": {
        id: 5,
        url: "https://old.com",
        firstOpenedTs: 1,
        firstOpened: "first",
        lastOpenedTs: 2,
        lastOpened: "last",
      },
    };
    const live = [
      {
        id: 5,
        windowId: 1,
        title: "New",
        url: "https://new.com",
        lastAccessed: 3,
      },
    ];
    const merged = core.mergeLiveTabsWithHistory(live, stored, {
      mode: "live",
      nowMs: now,
    });
    assert.equal(merged["5"].firstOpenedTs, 1);
    assert.equal(merged["5"].url, "https://new.com");
  });

  it("does not advance lastOpened from browser lastAccessed (passive)", () => {
    // Active tab in an unfocused window still gets a newer lastAccessed.
    // History "last opened" must stay put until forceLastOpened (user attention).
    const previous = {
      id: 5,
      url: "https://site.com",
      firstOpenedTs: 10,
      firstOpened: "first",
      lastOpenedTs: 20,
      lastOpened: "last",
    };
    const tab = {
      id: 5,
      windowId: 1,
      title: "Site",
      url: "https://site.com",
      lastAccessed: 999999,
    };
    const passive = core.buildTabRecordFromLive(tab, previous, {
      nowMs: now,
    });
    assert.equal(passive.lastOpenedTs, 20);
    assert.equal(passive.firstOpenedTs, 10);

    const attention = core.buildTabRecordFromLive(tab, previous, {
      nowMs: now,
      forceLastOpened: true,
    });
    assert.equal(attention.lastOpenedTs, now);
    assert.equal(attention.firstOpenedTs, 10);
  });

  it("restore: keeps unmatched stored history as pending for progressive restore", () => {
    const stored = {
      "1": {
        url: "https://early.com",
        firstOpenedTs: 10,
        firstOpened: "early-first",
        lastOpenedTs: 11,
        lastOpened: "early-last",
      },
      "2": {
        url: "https://late.com",
        firstOpenedTs: 20,
        firstOpened: "late-first",
        lastOpenedTs: 21,
        lastOpened: "late-last",
      },
    };
    // Chrome has only restored one tab so far
    const livePartial = [
      {
        id: 100,
        windowId: 1,
        title: "Early",
        url: "https://early.com",
        lastAccessed: 500,
      },
    ];
    const first = core.mergeLiveTabsWithHistory(livePartial, stored, {
      mode: "restore",
      nowMs: now,
    });
    assert.equal(first["100"].firstOpenedTs, 10);
    assert.equal(core.countPendingRestoreRecords(first), 1);
    const pendingKeys = Object.keys(first).filter((k) =>
      core.isPendingRestoreRecord(first[k])
    );
    assert.equal(pendingKeys.length, 1);
    assert.equal(first[pendingKeys[0]].url, "https://late.com");
    assert.equal(first[pendingKeys[0]].firstOpenedTs, 20);
    // Popup must not show placeholders
    assert.equal(
      Object.keys(core.stripPendingRestoreRecords(first)).length,
      1
    );

    // Later the second tab appears — full sync must retain original firstOpenedTs
    const liveFull = [
      {
        id: 100,
        windowId: 1,
        title: "Early",
        url: "https://early.com",
        lastAccessed: 500,
      },
      {
        id: 101,
        windowId: 1,
        title: "Late",
        url: "https://late.com",
        lastAccessed: 600,
      },
    ];
    const second = core.mergeLiveTabsWithHistory(liveFull, first, {
      mode: "restore",
      nowMs: now + 1,
    });
    assert.equal(second["100"].firstOpenedTs, 10);
    assert.equal(second["101"].firstOpenedTs, 20);
    assert.equal(core.countPendingRestoreRecords(second), 0);
  });

  it("restore: pending key does not collide when live reuses stored id for a different URL", () => {
    const stored = {
      "5": {
        id: 5,
        url: "https://reddit.com",
        firstOpenedTs: 111,
        firstOpened: "reddit-first",
        lastOpenedTs: 222,
        lastOpened: "reddit-last",
      },
    };
    const live = [
      {
        id: 5,
        windowId: 1,
        title: "GitHub",
        url: "https://github.com",
        lastAccessed: 999,
      },
    ];
    const merged = core.mergeLiveTabsWithHistory(live, stored, {
      mode: "restore",
      nowMs: now,
    });
    assert.equal(merged["5"].url, "https://github.com");
    assert.notEqual(merged["5"].firstOpenedTs, 111);
    assert.equal(core.countPendingRestoreRecords(merged), 1);
    const pending = Object.values(merged).find((r) =>
      core.isPendingRestoreRecord(r)
    );
    assert.equal(pending.url, "https://reddit.com");
    assert.equal(pending.firstOpenedTs, 111);
  });
});

describe("session-lifetime restore (SW restarts)", () => {
  const now = 1_000_000;

  it("getHistoryMergeMode is restore only before session flag is set", () => {
    assert.equal(core.getHistoryMergeMode(false), "restore");
    assert.equal(core.getHistoryMergeMode(true), "live");
  });

  it("worker restarting twice in the same session does not re-run URL restoration", () => {
    // storage.session survives SW restarts; in-memory does not.
    const sessionState = { restoreCompleted: false };
    const preRestoreStored = {
      "1": {
        url: "https://dup.com",
        firstOpenedTs: 10,
        firstOpened: "old-first",
        lastOpenedTs: 20,
        lastOpened: "old-last",
      },
    };

    // --- SW lifetime 1: browser just started ---
    const live1 = [
      { id: 10, windowId: 1, title: "Restored", url: "https://dup.com", lastAccessed: 100 },
    ];
    const first = core.runSessionAwareSync(live1, preRestoreStored, sessionState, {
      nowMs: now,
    });
    assert.equal(first.mode, "restore");
    assert.equal(sessionState.restoreCompleted, true);
    assert.equal(first.list["10"].firstOpenedTs, 10);

    // --- SW lifetime 2: idle kill; session flag still true; memory empty ---
    // User opens a second tab with the same URL (genuine duplicate).
    const live2 = [
      { id: 10, windowId: 1, title: "Restored", url: "https://dup.com", lastAccessed: 100 },
      { id: 11, windowId: 1, title: "New dup", url: "https://dup.com", lastAccessed: 500 },
    ];
    const second = core.runSessionAwareSync(live2, first.list, sessionState, {
      nowMs: now + 1,
    });
    assert.equal(second.mode, "live");
    assert.equal(second.list["10"].firstOpenedTs, 10);
    // New tab must not inherit restored history via URL match
    assert.notEqual(second.list["11"].firstOpenedTs, 10);
    assert.equal(second.list["11"].lastOpenedTs, 500);
  });

  it("popup-facing sync returns fully remapped records after startup", () => {
    const sessionState = { restoreCompleted: false };
    const preRestoreStored = {
      "1": {
        url: "https://a.com",
        firstOpenedTs: 42,
        firstOpened: "session-first",
        lastOpenedTs: 99,
        lastOpened: "session-last",
      },
      "2": {
        url: "https://b.com",
        firstOpenedTs: 7,
        firstOpened: "b-first",
        lastOpenedTs: 8,
        lastOpened: "b-last",
      },
    };
    const live = [
      { id: 100, windowId: 1, title: "A", url: "https://a.com", lastAccessed: 10 },
      { id: 101, windowId: 1, title: "B", url: "https://b.com", lastAccessed: 20 },
    ];

    // What the background returns after syncAndGetTabInfo
    const synced = core.runSessionAwareSync(live, preRestoreStored, sessionState, {
      nowMs: now,
    });
    assert.equal(synced.mode, "restore");
    assert.equal(synced.list["100"].firstOpenedTs, 42);
    assert.equal(synced.list["101"].firstOpenedTs, 7);

    // Wrong popup path: live-merge against pre-restore storage loses history
    const premature = core.mergeLiveTabsWithHistory(live, preRestoreStored, {
      mode: "live",
      nowMs: now,
    });
    assert.notEqual(premature["100"].firstOpenedTs, 42);

    // Correct popup path: use only background-returned records
    assert.equal(synced.list["100"].firstOpenedTs, 42);
    assert.equal(synced.list["101"].firstOpenedTs, 7);
  });

  it("genuinely new duplicate after startup does not inherit another tab’s history", () => {
    const sessionState = { restoreCompleted: true }; // already past startup
    const stored = {
      "5": {
        id: 5,
        url: "https://dup.com",
        firstOpenedTs: 1,
        firstOpened: "keeper",
        lastOpenedTs: 2,
        lastOpened: "keeper-last",
      },
    };
    const live = [
      { id: 5, windowId: 1, title: "Keeper", url: "https://dup.com", lastAccessed: 2 },
      { id: 6, windowId: 1, title: "New", url: "https://dup.com", lastAccessed: 900 },
    ];
    const result = core.runSessionAwareSync(live, stored, sessionState, {
      nowMs: now,
    });
    assert.equal(result.mode, "live");
    assert.equal(result.list["5"].firstOpenedTs, 1);
    assert.notEqual(result.list["6"].firstOpenedTs, 1);
    assert.equal(result.list["6"].lastOpenedTs, 900);
  });

  it("progressive restore does not mark session complete while pending history remains", () => {
    const sessionState = { restoreCompleted: false };
    const stored = {
      "1": {
        url: "https://a.com",
        firstOpenedTs: 42,
        firstOpened: "a-first",
        lastOpenedTs: 43,
        lastOpened: "a-last",
      },
      "2": {
        url: "https://b.com",
        firstOpenedTs: 7,
        firstOpened: "b-first",
        lastOpenedTs: 8,
        lastOpened: "b-last",
      },
    };
    const livePartial = [
      { id: 100, windowId: 1, title: "A", url: "https://a.com", lastAccessed: 10 },
    ];
    const first = core.runSessionAwareSync(livePartial, stored, sessionState, {
      nowMs: now,
    });
    assert.equal(first.mode, "restore");
    assert.equal(sessionState.restoreCompleted, false);
    assert.equal(first.pendingRestore, 1);
    assert.equal(first.list["100"].firstOpenedTs, 42);

    const liveFull = [
      { id: 100, windowId: 1, title: "A", url: "https://a.com", lastAccessed: 10 },
      { id: 101, windowId: 1, title: "B", url: "https://b.com", lastAccessed: 20 },
    ];
    const second = core.runSessionAwareSync(liveFull, first.list, sessionState, {
      nowMs: now + 1,
    });
    assert.equal(second.mode, "restore");
    assert.equal(sessionState.restoreCompleted, true);
    assert.equal(second.pendingRestore, 0);
    assert.equal(second.list["100"].firstOpenedTs, 42);
    assert.equal(second.list["101"].firstOpenedTs, 7);
  });

  it("forceCompleteRestore strips remaining pending and marks session done", () => {
    const sessionState = { restoreCompleted: false };
    const stored = {
      "1": {
        url: "https://a.com",
        firstOpenedTs: 1,
        firstOpened: "a",
        lastOpenedTs: 2,
        lastOpened: "a2",
      },
      "2": {
        url: "https://gone.com",
        firstOpenedTs: 3,
        firstOpened: "gone",
        lastOpenedTs: 4,
        lastOpened: "gone2",
      },
    };
    const live = [
      { id: 10, windowId: 1, title: "A", url: "https://a.com", lastAccessed: 9 },
    ];
    const result = core.runSessionAwareSync(live, stored, sessionState, {
      nowMs: now,
      forceCompleteRestore: true,
    });
    assert.equal(sessionState.restoreCompleted, true);
    assert.equal(result.pendingRestore, 0);
    assert.equal(result.list["10"].firstOpenedTs, 1);
    assert.equal(core.countPendingRestoreRecords(result.list), 0);
    assert.ok(!Object.values(result.list).some((r) => r.url === "https://gone.com"));
  });

  it("claimPendingRestoreForTab binds a late tab to pending history by URL", () => {
    const list = {
      "100": {
        id: 100,
        url: "https://a.com",
        firstOpenedTs: 10,
        firstOpened: "a",
        lastOpenedTs: 11,
        lastOpened: "a2",
      },
      "2": {
        id: 2,
        url: "https://b.com",
        firstOpenedTs: 20,
        firstOpened: "b",
        lastOpenedTs: 21,
        lastOpened: "b2",
        pendingRestore: true,
      },
    };
    const tab = {
      id: 101,
      windowId: 1,
      title: "B",
      url: "https://b.com",
      lastAccessed: 50,
    };
    const claimed = core.claimPendingRestoreForTab(list, tab, { nowMs: now });
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.list["101"].firstOpenedTs, 20);
    assert.equal(claimed.list["101"].url, "https://b.com");
    assert.equal(core.countPendingRestoreRecords(claimed.list), 0);
    assert.equal(claimed.list["2"], undefined);
  });
});

describe("selectUnloadListedIds", () => {
  it("never unloads any active tab across windows", () => {
    const tabs = [
      { id: 1, url: "https://a.com", active: true, windowId: 1, pinned: false, discarded: false },
      { id: 2, url: "https://b.com", active: true, windowId: 2, pinned: false, discarded: false },
      { id: 3, url: "https://c.com", active: false, windowId: 1, pinned: false, discarded: false },
      { id: 4, url: "https://d.com", active: false, windowId: 2, pinned: false, discarded: false },
    ];
    const ids = core.selectUnloadListedIds(tabs, [1, 2, 3, 4]);
    assert.deepEqual(ids.sort((a, b) => a - b), [3, 4]);
    assert.ok(!ids.includes(1));
    assert.ok(!ids.includes(2));
  });

  it("only unloads ids present in the list", () => {
    const tabs = [
      { id: 1, url: "https://a.com", active: false, pinned: false, discarded: false },
      { id: 2, url: "https://b.com", active: false, pinned: false, discarded: false },
      { id: 3, url: "https://c.com", active: false, pinned: false, discarded: false },
    ];
    const ids = core.selectUnloadListedIds(tabs, [1, 2]);
    assert.deepEqual(ids.sort((a, b) => a - b), [1, 2]);
  });
});

describe("selectUnloadInWindowIds", () => {
  it("keeps the active tab in the window", () => {
    const tabs = [
      { id: 10, url: "https://a.com", active: true, pinned: false, discarded: false },
      { id: 11, url: "https://b.com", active: false, pinned: false, discarded: false },
      { id: 12, url: "https://c.com", active: false, pinned: false, discarded: false },
    ];
    const ids = core.selectUnloadInWindowIds(tabs);
    assert.deepEqual(ids.sort((a, b) => a - b), [11, 12]);
  });
});

describe("analyzeDuplicates", () => {
  it("keeps most recently accessed when storage is empty", () => {
    const tabs = [
      { id: 1, url: "https://dup.com", active: false, pinned: false, lastAccessed: 100 },
      { id: 2, url: "https://dup.com", active: false, pinned: false, lastAccessed: 300 },
      { id: 3, url: "https://dup.com", active: false, pinned: false, lastAccessed: 200 },
    ];
    const result = core.analyzeDuplicates(tabs, {});
    assert.equal(result.count, 2);
    assert.ok(!result.toCloseIds.includes(2));
    assert.ok(result.toCloseIds.includes(1));
    assert.ok(result.toCloseIds.includes(3));
  });

  it("keeps the active tab in the protected window even if older", () => {
    const tabs = [
      { id: 1, windowId: 1, url: "https://dup.com", active: true, pinned: false, lastAccessed: 100 },
      { id: 2, windowId: 1, url: "https://dup.com", active: false, pinned: false, lastAccessed: 500 },
      { id: 3, windowId: 1, url: "https://dup.com", active: false, pinned: false, lastAccessed: 200 },
    ];
    const result = core.analyzeDuplicates(tabs, {}, 1);
    assert.deepEqual(result.toCloseIds.sort((a, b) => a - b), [3]);
  });

  it("closes an active duplicate in another window", () => {
    const tabs = [
      { id: 1, windowId: 1, url: "https://dup.com", active: true, pinned: false, lastAccessed: 500 },
      { id: 2, windowId: 2, url: "https://dup.com", active: true, pinned: false, lastAccessed: 100 },
    ];
    const result = core.analyzeDuplicates(tabs, {}, 1);
    assert.equal(result.groups, 1);
    assert.deepEqual(result.toCloseIds, [2]);
  });

  it("skips pinned tabs", () => {
    const tabs = [
      { id: 1, url: "https://dup.com", active: false, pinned: true, lastAccessed: 100 },
      { id: 2, url: "https://dup.com", active: false, pinned: false, lastAccessed: 200 },
    ];
    assert.equal(core.analyzeDuplicates(tabs, {}).count, 0);
  });
});

describe("shouldDiscardOneByOne", () => {
  it("is true for Chrome/Edge and false for Firefox", () => {
    assert.equal(
      core.shouldDiscardOneByOne(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
      ),
      true
    );
    assert.equal(
      core.shouldDiscardOneByOne(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"
      ),
      true
    );
    assert.equal(
      core.shouldDiscardOneByOne(
        "Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0"
      ),
      false
    );
  });
});

describe("countTabLoadStats", () => {
  it("counts loaded vs discarded", () => {
    assert.deepEqual(
      core.countTabLoadStats([
        { discarded: false },
        { discarded: true },
        { discarded: false },
      ]),
      { total: 3, loaded: 2, discarded: 1 }
    );
  });
});

describe("formatWindowLabel", () => {
  it("prefers window title and strips Firefox suffix", () => {
    assert.equal(
      core.formatWindowLabel({ title: "Work - Mozilla Firefox" }, null),
      "Work"
    );
  });
});

describe("formatDateParts", () => {
  it("splits date and time", () => {
    const parts = core.formatDateParts(new Date(2020, 0, 15, 10, 5).getTime());
    assert.equal(parts.date, "20.01.15");
    assert.equal(parts.time, "10:05");
  });
});

describe("getAgeColors", () => {
  const minTs = 1000;
  const maxTs = 2000;

  it("returns null for newest", () => {
    assert.equal(core.getAgeColors(maxTs, minTs, maxTs), null);
  });

  it("returns wash for older", () => {
    const old = core.getAgeColors(minTs, minTs, maxTs);
    assert.ok(old);
    assert.match(old.wash, /^hsl\(/);
  });
});

describe("buildWindowUnloadRows", () => {
  it("sorts by unloadable descending and excludes active tabs", () => {
    const windows = [
      {
        id: 1,
        tabs: [
          { id: 1, active: true, url: "https://a.com", pinned: false, discarded: false },
          { id: 2, active: false, url: "https://b.com", pinned: false, discarded: false },
        ],
      },
      {
        id: 2,
        tabs: [
          { id: 3, active: true, url: "https://c.com", pinned: false, discarded: false },
          { id: 4, active: false, url: "https://d.com", pinned: false, discarded: false },
          { id: 5, active: false, url: "https://e.com", pinned: false, discarded: false },
        ],
      },
    ];
    const rows = core.buildWindowUnloadRows(windows, 1);
    assert.equal(rows[0].win.id, 2);
    assert.equal(rows[0].unloadable, 2);
    assert.equal(rows[1].unloadable, 1);
  });
});

describe("Chrome discard calls (tabs.discard)", () => {
  it("calls discard once per id, never with an array, skips active tabs", async () => {
    const calls = [];
    const discardFn = (arg) => {
      calls.push(arg);
      return Promise.resolve();
    };

    const liveTabs = [
      { id: 100, url: "https://active.com", active: true, pinned: false, discarded: false },
      { id: 101, url: "https://a.com", active: false, pinned: false, discarded: false },
      { id: 102, url: "https://b.com", active: false, pinned: false, discarded: false },
      { id: 103, url: "https://c.com", active: false, pinned: false, discarded: false },
    ];
    const listedIds = [100, 101, 102, 103];

    // Same composition as the popup: selectUnloadListedIds + discardTabIds one-by-one
    const ids = core.selectUnloadListedIds(liveTabs, listedIds);
    const n = await core.discardTabIds(ids, discardFn, { oneByOne: true });
    assert.equal(n, 3);
    assert.deepEqual(calls, [101, 102, 103]);
    for (const arg of calls) {
      assert.equal(Array.isArray(arg), false);
      assert.equal(typeof arg, "number");
    }
    assert.ok(!calls.includes(100));
    assert.ok(!calls.some((a) => Array.isArray(a)));
  });
});

describe("failed tab closing (tabs.remove)", () => {
  it("keeps the record when remove rejects (no unhandled rejection)", async () => {
    const tabInfoList = {
      "42": {
        id: 42,
        title: "Stay",
        url: "https://stay.com",
        firstOpenedTs: 1,
        lastOpenedTs: 2,
      },
    };
    const removeFn = () => Promise.reject(new Error("Cannot close tab"));

    const result = await core.tryCloseTabRecord(tabInfoList, "42", removeFn);
    assert.equal(result.ok, false);
    assert.equal(result.error.message, "Cannot close tab");
    // Still in popup state / stored record not deleted
    assert.ok(tabInfoList["42"]);
    assert.equal(tabInfoList["42"].id, 42);
    // Visible row would still exist while key is present
    assert.equal(Object.keys(tabInfoList).length, 1);
  });

  it("removes the record only after remove succeeds", async () => {
    const tabInfoList = {
      "7": {
        id: 7,
        title: "Go",
        url: "https://go.com",
        firstOpenedTs: 1,
        lastOpenedTs: 2,
      },
    };
    const removeFn = (id) => {
      assert.equal(id, 7);
      return Promise.resolve();
    };

    const result = await core.tryCloseTabRecord(tabInfoList, "7", removeFn);
    assert.equal(result.ok, true);
    assert.equal(tabInfoList["7"], undefined);
    assert.equal(Object.keys(tabInfoList).length, 0);
  });
});
