# xNxP Tabs

Tab manager extension (ADHD-friendly) showing first opened + last active time.

## Usage

Open the popup by clicking the toolbar icon or with the keyboard shortcut.

- Default: **Ctrl+Shift+U** (Windows/Linux) or **Cmd+Shift+U** (Mac)
- Search is automatically focused and selected when it opens.

Customize the shortcut in your browser:

- **Chrome/Edge**: `chrome://extensions/shortcuts`
- **Firefox**: `about:addons` → click the extension → Manage Extension Shortcuts

## Loading the Extension

### Chrome / Edge / Brave

1. Go to `chrome://extensions`
2. Turn on "Developer mode"
3. Click "Load unpacked"
4. Select this folder.

## Notes

- This branch targets Chrome with **Manifest V3** (service worker background).
- The extension uses the `webextension-polyfill` so we can use the modern `browser.*` APIs.
- For the Firefox build, see the `firefox-extension` branch (Manifest V2).
- Large design source files (`ori_icon*.png`) are intentionally ignored via `.gitignore`.
