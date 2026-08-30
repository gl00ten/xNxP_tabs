# xNxP Tabs

ADHD friendly tab manager for when you have *way* too many tabs open.

Shows first opened and last active time, search, unload (free memory without closing), close duplicates, and more. Default shortcut: **Ctrl+Shift+U** (Windows/Linux) or **Cmd+Shift+U** (Mac). **Pin the extension** so the toolbar icon stays visible.

## Usage

1. **Pin the extension** so it stays on the toolbar.
2. Open with the icon or **Ctrl+Shift+U** / **Cmd+Shift+U**.
3. Search is focused when the popup opens — type and press Enter to jump to the first match.
4. Use the **☰** menu for:
   - **Unload listed tabs** (uses current search/filters; empty search = all)
   - **Unload tabs in one window…**
   - **Close duplicate tabs** (keeps the copy you used most recently)
   - **Support on Ko-fi**

Customize the shortcut:

- **Firefox**: `about:addons` → extension → Manage Extension Shortcuts  
- **Chrome/Edge**: `chrome://extensions/shortcuts`

## Loading (development)

### Firefox (`firefox_extension` branch)

1. `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…**
3. Select `manifest.json`

### Chrome / Edge / Brave (`main` branch)

1. `chrome://extensions`
2. Developer mode → **Load unpacked**
3. Select this folder

## Notes

- **`firefox_extension`**: Firefox Manifest V3 (AMO). Background uses `scripts` (Firefox event page); Chrome uses a service worker.
- **`main`**: Chrome Manifest V3.
- Uses `webextension-polyfill` for `browser.*` APIs.
- Large design sources (`ori_icon*.png`) are gitignored.

## Development

```bash
npm test
# or: node --test test/core.test.js
```
