# xNxP Tabs

Tab manager extension (ADHD-friendly) showing first opened + last active time.

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
- Manifest V2 is used for maximum compatibility right now.
- Large design source files (`ori_icon*.png`) are intentionally ignored via `.gitignore`.
