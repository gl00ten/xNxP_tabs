# xNxP Tabs

ADHD friendly tab manager for when you have *way* too many tabs open.

Shows first opened and last active time, search, unload (free memory without closing), close duplicates, and more. Default shortcut: **Ctrl+Shift+U** (Windows/Linux) or **Cmd+Shift+U** (Mac). **Pin the extension** so the toolbar icon stays visible.

This branch is the **Chrome / Edge / Brave** build (**Manifest V3**). For Firefox, see **`firefox_extension`**.

## Usage

1. **Pin the extension** — puzzle-piece menu → pin xNxP Tabs.
2. Open with the icon or **Ctrl+Shift+U** / **Cmd+Shift+U**.
3. Search is focused when the popup opens — type and press Enter to jump to the first match.
4. Use the **☰** menu for:
   - **Unload listed tabs** (uses current search/filters; empty search = all)
   - **Unload tabs in one window…**
   - **Close duplicate tabs** (keeps the copy you used most recently)
   - **Support on Ko-fi**

Customize the shortcut at `chrome://extensions/shortcuts`.

## Loading (Chrome / Edge / Brave)

1. Go to `chrome://extensions`
2. Turn on "Developer mode"
3. Click **Load unpacked**
4. Select this folder

## Notes

- **`main`**: Chrome Manifest V3 (service worker).
- **`firefox_extension`**: Firefox Manifest V2 (AMO).
- Uses `webextension-polyfill` for `browser.*` APIs.
- Chrome Web Store caps the short description at 132 characters; put longer store text in the dashboard detailed description.
- Large design sources (`ori_icon*.png`) are gitignored.

## Development

```bash
npm test
# or: node --test test/core.test.js
```
