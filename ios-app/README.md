# CallPilot iPhone app

The same CallPilot Mobile page (`../index.html`, `../app.js`) wrapped as a native iPhone app with Capacitor, plus CallPilot's own native code in `native/`:

- **CPListener**: the iPhone's speech recognition, on the phone, straight from the microphone. No bips, no restarts, and it keeps listening with the phone locked (the app has the `audio` background mode).
- **CPNotify**: native notifications for notes. Time Sensitive (gets through Focus), banners while the app is open, optional auto-clear, and Lock Screen buttons (Note now, Bookmark, Replay).
- **CPApp**: keeps the page working while the app is in the background (a "pump" that calls `window.__cpPump`), keeps the app awake with silence when only the desktop link is on, and keeps the screen on when asked.

`app.js` detects the app (`window.Capacitor.isNativePlatform()`) and uses these; on the web nothing changes.

## Building

GitHub builds it on a Mac and uploads it to TestFlight (`.github/workflows/ios.yml`), the same way as Squiggle. It needs:

1. Repository secrets `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (the App Store Connect API key, same as Squiggle's). Without them each run only checks that the app compiles.
2. An app in App Store Connect with the bundle ID `com.jarredsmith.callpilot`.

Locally: `npm ci && npm run sync`, then open `ios/App/App.xcodeproj` in Xcode.

Never edit `www/` or `ios/App/App/public/`; they're copies of the web app made by `scripts/copy-web.mjs`.
