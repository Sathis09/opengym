# Building the mobile app — Gym Plus (iOS / Android)

Gym Plus is based on [openGym](https://github.com/DuarteSantos8/openGym) by Duarte Santos
(AGPL-3.0). The repo builds two flavors from the same codebase:

| | **Self-hosted** (web default) | **Mobile app — Gym Plus** (`VITE_MOBILE=1`) |
|---|---|---|
| App id | — | `com.gympulse.app` (Android `applicationId` / iOS bundle id), display name **Gym Plus** |
| Runs | in any browser, against your own server | natively on iPhone / Android (Capacitor shell) |
| Accounts | passkey sign-in, one profile per person | none required; **optional Google sign-in** |
| Data | synced to your server, readable on desktop | on the device; optionally synced to the user's own Google Drive (`Gym Plus/gymplus-data.json`, `drive.file` scope) |
| AI coach | server-side Coach (`docs/AI_COACH.md`) | **bring-your-own-key**: OpenAI, Anthropic, Gemini, Groq, OpenRouter — key kept in Keychain / Android Keystore, never synced |
| Reminders | Web Push from your server | native local notifications, no server involved |
| Exercise media | served by your server (`img/`, `gif/`) | loaded from the jsDelivr CDN |

The mobile flavor never talks to the self-hosted backend and has no telemetry. Without
Google sign-in it is fully offline/local. State is mirrored from `localStorage` into
`opengym-state.json` (file name kept for compatibility with existing installs) in the app's
private data directory on every change (iOS may evict WebView storage under pressure — the
file mirror is the durable copy and is restored on launch). Backups go out through the OS
share sheet instead of a browser download.

## Prerequisites

- Node 20+
- **Android:** Android Studio (bundles the SDK). **JDK 21** for Gradle (Gradle 8.11 / AGP 8.7
  do not run on JDK 25).
- **iOS:** a Mac with Xcode 15+ and CocoaPods (`brew install cocoapods`). A free Apple ID
  is enough to run the app on your own iPhone (see below); paid membership is only needed
  for App Store distribution.
- **Google sign-in (optional):** OAuth client ids from a Google Cloud project — Web client,
  Android client (package `com.gympulse.app` + your SHA-1) and iOS client (bundle id
  `com.gympulse.app`). Step by step, including the env vars and native config:
  **[docs/GOOGLE_SETUP.md](GOOGLE_SETUP.md)**. Without them the app still builds and runs;
  sign-in is simply unavailable.

## Build & run

```sh
cd frontend
npm install
npm run build:mobile        # VITE_MOBILE build + `cap sync` into android/ and ios/

npx cap open android        # opens Android Studio → run on emulator or device
npx cap open ios            # opens Xcode (Mac only) → set your signing team, then run
```

`npm run build:mobile` bakes the CDN media base (and the Google client ids, if set — see
GOOGLE_SETUP.md) into the bundle and copies the web build into both native projects —
re-run it after every web-code change before building natively.

> **Heads-up:** after `build:mobile`, `frontend/dist` contains the *mobile* bundle.
> Run a plain `npm run build` again before deploying `dist` to a server.

## App icons & splash screens

The Gym Plus mark is a rounded plus whose horizontal arm is a dumbbell, lime `#a3e635` on
`#0c0e12`. Sources in `frontend/resources/`:

- `icon.svg` — the mark on a rounded dark square (design source; also used for docs/web)
- `icon.png` — 1024×1024 full-bleed render, no transparency (platforms apply their own mask)
- `splash.png` / `splash-dark.png` — 2732×2732, mark centred small on `#0c0e12`

The wordmark for docs and the website is `assets/gymplus-wordmark.svg`. Regenerate all
native assets after changing the sources:

```sh
cd frontend
npx @capacitor/assets generate --ios --android --assetPath resources \
  --iconBackgroundColor "#0c0e12" --iconBackgroundColorDark "#0c0e12" \
  --splashBackgroundColor "#0c0e12" --splashBackgroundColorDark "#0c0e12"
```

Leave out `--pwa`: the PWA icons (`frontend/public/icon-180.png`, `icon-512.png`) and
`manifest.json` are maintained by hand, and the generator would rewrite the manifest.

## Distribution

Gym Plus release builds are not published yet. The APK on the upstream openGym site
(opengym.duarte-santos.ch) is the original **openGym** app, not Gym Plus — the two have
different package ids and can be installed side by side.

### Android — build and sign an APK

```sh
cd frontend && npm run build:mobile
cd android && ./gradlew assembleRelease            # → app/build/outputs/apk/release/app-release-unsigned.apk

# one-time: create a keystore. KEEP IT — updates must be signed with the same key,
# or Android refuses to install the new version over the old one. Its SHA-1 must also be
# registered on the Android OAuth client for Google sign-in (docs/GOOGLE_SETUP.md).
keytool -genkeypair -keystore my.keystore -alias gymplus -keyalg RSA -validity 10950

# align + sign (zipalign/apksigner ship with the Android SDK build-tools)
zipalign -f -p 4 app-release-unsigned.apk aligned.apk
apksigner sign --ks my.keystore --ks-key-alias gymplus --out GymPlus.apk aligned.apk
```

Installing outside the Play Store: Android asks to allow installs from the app you opened the
APK with the first time — that's standard for sideloading.

### iPhone — what's actually possible

Without an App Store / TestFlight release there is no `.ipa` that simply installs. Options:

- **Xcode free signing:** open `ios/` in Xcode with a free Apple ID as the team and run it
  onto your own iPhone. Apple expires the signature after 7 days; re-run from Xcode to renew.
  (Bundle id `com.gympulse.app` — change it if Xcode reports it as taken for your team, and
  update the iOS OAuth client to match.)
- **AltStore:** automates that 7-day re-signing over Wi-Fi via a Mac companion app.
- **Self-host + PWA:** open your instance in Safari → Share → *Add to Home Screen*.

### Release notes for maintainers

- Bump `versionName`/`versionCode` in `android/app/build.gradle` per release; keep them in
  step with `frontend/package.json`. `versionCode` must strictly increase or updates won't
  install over an existing APK.
- **License:** Gym Plus, like openGym, is AGPL-3.0, which by itself sits badly with
  app-store terms of service. `NOTICE.md` carries an app-store exception (an additional
  permission under AGPL §7) granted by the openGym copyright holder — check whether it covers
  this fork before any store distribution. Keep `LICENSE`, `NOTICE.md` and the
  "based on openGym by Duarte Santos" credit.
- The app requests notification permission only when the workout-day reminder is switched
  on, and (on Android) declares `SCHEDULE_EXACT_ALARM` so the reminder fires to the minute
  where the user allows it.
