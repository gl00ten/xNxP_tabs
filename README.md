# xNxP Tabs

ADHD friendly tab manager showing first opened + last active time. Default shortcut: **Ctrl+Shift+U** (Windows/Linux) or **Cmd+Shift+U** (Mac). **Pin the extension** so the toolbar icon stays visible.

## Usage

1. **Pin the extension**: click the puzzle-piece icon in the toolbar, then pin xNxP Tabs so it is always shown.
2. Open the popup by clicking the pinned icon or with the keyboard shortcut (**Ctrl+Shift+U** / **Cmd+Shift+U**).
3. Search is automatically focused and selected when the popup opens.

Customize the shortcut at `chrome://extensions/shortcuts`.

## Loading the Extension

### Chrome / Edge / Brave

1. Go to `chrome://extensions`
2. Turn on "Developer mode"
3. Click "Load unpacked"
4. Select this folder.

## Notes

- This branch targets Chrome with **Manifest V3** (service worker background).
- The extension uses the `webextension-polyfill` so we can use the modern `browser.*` APIs.
- For the Firefox build, see the `firefox_extension` branch (Manifest V2).
- Large design source files (`ori_icon*.png`) are intentionally ignored via `.gitignore`.
