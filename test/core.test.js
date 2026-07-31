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
    assert.equal(core.isDiscardableUrl("about:newtab"), false);
    assert.equal(core.isDiscardableUrl("moz-extension://abc/x"), false);
    assert.equal(core.isDiscardableUrl("chrome://settings"), false);
    assert.equal(core.isDiscardableUrl("chrome-extension://x"), false);
    assert.equal(core.isDiscardableUrl("edge://newtab"), false);
  });

  it("accepts normal web urls", () => {
    assert.equal(core.isDiscardableUrl("https://example.com"), true);
    assert.equal(core.isDiscardableUrl("http://example.com/path"), true);
    assert.equal(core.isDiscardableUrl("https://example.com/a?b=1#c"), true);
  });
});

describe("selectUnloadAllOthersIds", () => {
  const tabs = [
    { id: 1, url: "https://a.com", active: true, pinned: false, discarded: false },
    { id: 2, url: "https://b.com", active: false, pinned: false, discarded: false },
    { id: 3, url: "https://c.com", active: false, pinned: true, discarded: false },
    { id: 4, url: "https://d.com", active: false, pinned: false, discarded: true },
    { id: 5, url: "about:blank", active: false, pinned: false, discarded: false },
    { id: 6, url: "https://e.com", active: false, pinned: false, discarded: false },
  ];

  it("keeps the specified tab and skips pinned/discarded/internal", () => {
    const ids = core.selectUnloadAllOthersIds(tabs, 1);
    assert.deepEqual(ids.sort((a, b) => a - b), [2, 6]);
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
  it("closes older lastOpened copies and keeps newest", () => {
    const tabs = [
      { id: 1, url: "https://dup.com", active: false, pinned: false, lastAccessed: 100 },
      { id: 2, url: "https://dup.com", active: false, pinned: false, lastAccessed: 300 },
      { id: 3, url: "https://dup.com", active: false, pinned: false, lastAccessed: 200 },
      { id: 4, url: "https://unique.com", active: false, pinned: false, lastAccessed: 50 },
    ];
    const info = {
      "1": { lastOpenedTs: 100 },
      "2": { lastOpenedTs: 300 },
      "3": { lastOpenedTs: 200 },
      "4": { lastOpenedTs: 50 },
    };
    const result = core.analyzeDuplicates(tabs, info);
    assert.equal(result.groups, 1);
    assert.equal(result.count, 2);
    assert.ok(result.toCloseIds.includes(1));
    assert.ok(result.toCloseIds.includes(3));
    assert.ok(!result.toCloseIds.includes(2));
    assert.ok(!result.toCloseIds.includes(4));
  });

  it("never closes active tabs even if older", () => {
    const tabs = [
      { id: 1, url: "https://dup.com", active: true, pinned: false, lastAccessed: 100 },
      { id: 2, url: "https://dup.com", active: false, pinned: false, lastAccessed: 500 },
      { id: 3, url: "https://dup.com", active: false, pinned: false, lastAccessed: 200 },
    ];
    const result = core.analyzeDuplicates(tabs, {});
    // keeps active (1) and newest (2); closes 3 only
    assert.deepEqual(result.toCloseIds.sort((a, b) => a - b), [3]);
  });

  it("skips pinned tabs", () => {
    const tabs = [
      { id: 1, url: "https://dup.com", active: false, pinned: true, lastAccessed: 100 },
      { id: 2, url: "https://dup.com", active: false, pinned: false, lastAccessed: 200 },
    ];
    const result = core.analyzeDuplicates(tabs, {});
    assert.equal(result.count, 0);
  });
});

describe("countTabLoadStats", () => {
  it("counts loaded vs discarded", () => {
    const stats = core.countTabLoadStats([
      { discarded: false },
      { discarded: true },
      { discarded: false },
    ]);
    assert.deepEqual(stats, { total: 3, loaded: 2, discarded: 1 });
  });
});

describe("formatWindowLabel", () => {
  it("prefers window title and strips Firefox suffix", () => {
    assert.equal(
      core.formatWindowLabel({ title: "Work - Mozilla Firefox" }, null),
      "Work"
    );
  });

  it("falls back to active tab title", () => {
    assert.equal(
      core.formatWindowLabel({ id: 9 }, { title: "Hello" }),
      "Hello"
    );
  });

  it("falls back to window id", () => {
    assert.equal(core.formatWindowLabel({ id: 42 }, null), "Window 42");
  });
});

describe("formatShortDate", () => {
  it("formats a known timestamp", () => {
    // 2020-01-15 10:05 local — only check shape YY.MM.DD HH:mm
    const s = core.formatShortDate(new Date(2020, 0, 15, 10, 5).getTime());
    assert.match(s, /^\d{2}\.\d{2}\.\d{2} \d{2}:\d{2}$/);
    assert.ok(s.startsWith("20.01.15"));
  });

  it("returns fallback when missing", () => {
    assert.equal(core.formatShortDate(0, "n/a"), "n/a");
    assert.equal(core.formatShortDate(null, ""), "");
  });
});

describe("getAgeScore / getAgeColors", () => {
  const now = Date.UTC(2026, 6, 31, 12, 0, 0);

  it("scores recent tabs near 0 and old tabs near 1", () => {
    const hour = 3600000;
    const day = 86400000;
    assert.ok(core.getAgeScore(now - 5 * 60 * 1000, now) < 0.12);
    assert.ok(core.getAgeScore(now - 12 * hour, now) > 0.15);
    assert.ok(core.getAgeScore(now - 3 * day, now) > 0.4);
    assert.ok(core.getAgeScore(now - 60 * day, now) > 0.85);
  });

  it("returns stripe + wash colors", () => {
    const colors = core.getAgeColors(now - 2 * 86400000, now);
    assert.ok(colors);
    assert.match(colors.stripe, /^hsl\(/);
    assert.match(colors.wash, /^hsl\(/);
    assert.ok(colors.t > 0.3 && colors.t < 0.75);
  });

  it("returns null without timestamp", () => {
    assert.equal(core.getAgeColors(0, now), null);
    assert.equal(core.getAgeColors(null, now), null);
  });
});

describe("buildWindowUnloadRows", () => {
  it("sorts by unloadable descending", () => {
    const windows = [{ id: 1 }, { id: 2 }];
    const tabsByWindow = {
      1: [
        { id: 1, active: true, url: "https://a.com", pinned: false, discarded: false },
        { id: 2, active: false, url: "https://b.com", pinned: false, discarded: false },
      ],
      2: [
        { id: 3, active: true, url: "https://c.com", pinned: false, discarded: false },
        { id: 4, active: false, url: "https://d.com", pinned: false, discarded: false },
        { id: 5, active: false, url: "https://e.com", pinned: false, discarded: false },
        { id: 6, active: false, url: "https://f.com", pinned: false, discarded: false },
      ],
    };
    const rows = core.buildWindowUnloadRows(windows, tabsByWindow, 1);
    assert.equal(rows[0].win.id, 2);
    assert.equal(rows[0].unloadable, 3);
    assert.equal(rows[1].win.id, 1);
    assert.equal(rows[1].unloadable, 1);
    assert.equal(rows[1].isCurrent, true);
  });
});

describe("chunkIds", () => {
  it("splits into chunks", () => {
    assert.deepEqual(core.chunkIds([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });
});
