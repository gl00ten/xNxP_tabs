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

### Firefox

1. Go to `about:debugging#/runtime/this-firefox`
2. Click **"Load Temporary Add-on..."**
3. Select `manifest.json`
4. Click Open.

### Chrome / Edge / Brave

1. Go to `chrome://extensions`
2. Turn on "Developer mode"
3. Click "Load unpacked"
4. Select this folder.

## Notes

- The extension uses the `webextension-polyfill` so we can use the modern `browser.*` APIs in both Firefox and Chrome.
- Manifest V2 is used for maximum compatibility right now. (You may see deprecation warnings in recent Firefox when loading as a temporary add-on because Firefox prefers Manifest V3; the extension still works fine on V2.)
- Large design source files (`ori_icon*.png`) are intentionally ignored via `.gitignore`.
