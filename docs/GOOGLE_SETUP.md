# Google sign-in and Drive sync: setup

This guide is for whoever builds and publishes the **Gym Plus** mobile app (package / bundle id
`com.gympulse.app`). Google sign-in is optional for users. Without it the app works fully offline.
When a user signs in, their data is kept in **their own** Google Drive, in a visible folder
`Gym Plus` that holds the file `gymplus-data.json`. There is no Gym Plus server.

You need a Google Cloud project with the Drive API enabled, an OAuth consent screen, and three
OAuth clients (Android, Web, iOS). Two of the client ids go into the build as Vite env vars.

| Value | Where it goes |
|---|---|
| Web client id | `VITE_GOOGLE_WEB_CLIENT_ID` (used by Android and by the web/dev build) |
| iOS client id | `VITE_GOOGLE_IOS_CLIENT_ID`, plus its *reversed* form as a URL scheme in `Info.plist` |
| Android client | Not referenced in code. Google matches it by package name and SHA-1 signing fingerprint. |

Client ids are public identifiers, not secrets. They are compiled into every app binary.
**No client secret is used anywhere.** Do not put one in the app.

---

## 1. Create the Google Cloud project

1. Open <https://console.cloud.google.com/> and create a project (for example `gym-plus`).
2. Go to **APIs & Services → Library**, search for **Google Drive API** and click **Enable**.
   If you skip this step, Drive calls fail with HTTP 403 `accessNotConfigured` and the app shows a sync error.

## 2. OAuth consent screen (Google Auth Platform)

In **APIs & Services → OAuth consent screen**. Newer consoles call this **Google Auth Platform**,
with Branding / Audience / Data access tabs.

1. **User type: External.**
2. **Branding:** app name `Gym Plus`, a support email, and the developer contact email. The logo is
   optional. Adding one triggers Google's brand verification before the logo is shown.
3. **Data access / Scopes:** add these scopes:
   - `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` (basic sign-in)
   - `https://www.googleapis.com/auth/drive.file` (*See, edit, create and delete only the
     specific Google Drive files you use with this app*)

   About `drive.file`: Google's Drive API scope documentation currently classifies it as a
   **recommended, non-sensitive** scope, because it only grants access to files the app created
   itself (or files the user explicitly opened with it). The app never sees the rest of the user's
   Drive. In practice this means publishing the app should **not** require the sensitive/restricted
   scope verification or a security assessment. Google can change these classifications, so check
   the label the console shows next to the scope when you add it. If the console marks it as
   sensitive, plan for verification before going to Production.
4. **Audience / Publishing status:**
   - **Testing:** only the Google accounts you add under **Test users** (up to 100) can sign in.
     Everyone else gets *"Access blocked: app has not completed the Google verification process"*.
     In Testing mode Google also lets users' grants expire after about 7 days, so testers may
     have to sign in again weekly. This is expected.
   - **In production:** any Google account can sign in. With only basic + non-sensitive scopes
     you can usually publish directly. Google may still ask you to verify the brand (app name,
     homepage, privacy policy link) before it shows your name and logo on the consent screen.
     You will need a public **privacy policy URL** and **homepage URL** for that. Stating that
     data stays in the user's own Drive is enough.

## 3. OAuth clients

Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**. Create all three
clients in the **same project**.

### 3a. Android client (one per signing key)

- Application type: **Android**
- Package name: `com.gympulse.app`
- SHA-1 certificate fingerprint of the key that signs the APK/AAB.

Debug key (used by `gradlew assembleDebug` and Android Studio "Run"), on Windows:

```powershell
keytool -list -v -keystore "$env:USERPROFILE\.android\debug.keystore" -alias androiddebugkey -storepass android -keypass android
```

(in `cmd.exe`: `keytool -list -v -keystore %USERPROFILE%\.android\debug.keystore -alias androiddebugkey -storepass android -keypass android`)

Release key: run the same command against your release keystore:

```powershell
keytool -list -v -keystore path\to\release.keystore -alias <your-alias>
```

Copy the `SHA1:` line. Create **one Android client per fingerprint**: one for debug, one for
release. If you publish through Google Play with **Play App Signing**, Google re-signs the app.
In that case also add the **App signing key** SHA-1 from Play Console → *Setup → App integrity*.
That key is the one installed users actually run. Also add the upload key SHA-1 if you test
upload-key-signed builds.

`keytool` ships with the JDK (for example `D:\Software\Java\jdk-21.0.9\bin\keytool.exe`).

### 3b. Web client

- Application type: **Web application**, name for example `Gym Plus (web / Android server id)`.
- You don't need any redirect URIs or JavaScript origins for the native apps. For browser testing
  of the mobile build with `npm run dev`, add `http://localhost:5173` as an authorised JavaScript
  origin and redirect URI.
- Its client id → **`VITE_GOOGLE_WEB_CLIENT_ID`**.

On Android, sign-in uses this **web** client id as the "server client id". It does **not** use the
Android client's id. The Android client only has to exist in the same project with the right
package name and SHA-1.

### 3c. iOS client

- Application type: **iOS**, Bundle ID `com.gympulse.app`.
- Its client id (`1234-abcd.apps.googleusercontent.com`) → **`VITE_GOOGLE_IOS_CLIENT_ID`**.
- The console also shows the **iOS URL scheme**: the reversed client id,
  `com.googleusercontent.apps.1234-abcd`. You need it for `Info.plist` (below).

---

## 4. Build configuration

Create `frontend/.env.mobile`:

```dotenv
VITE_GOOGLE_WEB_CLIENT_ID=1234-web.apps.googleusercontent.com
VITE_GOOGLE_IOS_CLIENT_ID=1234-ios.apps.googleusercontent.com
```

Vite only loads `.env.mobile` when it builds with `--mode mobile` (see the `build:mobile` note
under *Native changes* below). As an alternative, set the variables in the shell before building:

```powershell
$env:VITE_GOOGLE_WEB_CLIENT_ID = '1234-web.apps.googleusercontent.com'
$env:VITE_GOOGLE_IOS_CLIENT_ID = '1234-ios.apps.googleusercontent.com'
npm run build:mobile
```

If an id is missing, the build still works. Google sign-in then reports
"Google sign-in is not configured in this build" and the app stays local-only.
`googleConfigured()` in `src/lib/google-config.js` is false in that case.

Then build:

```powershell
cd frontend
npm run build:mobile      # vite build (mobile flavour) + cap sync
cd android; .\gradlew assembleDebug
```

For iOS (on a Mac): `npm run build:mobile`, then `cd ios/App && pod install`, then open
`App.xcworkspace` in Xcode.

---

## Native changes (applied by orchestrator)

The plugin is `@capgo/capacitor-social-login` 7.20.x, initialised in `online` mode.
`capacitor.config.json` already enables only the Google provider. The edits below come from the
plugin's README and from its native source code.

### Android 1: `MainActivity` (required)

The app requests the extra Drive scope. The plugin's `GoogleProvider.login()` **rejects any custom
`scopes`** ("You CANNOT use scopes without modifying the main activity") unless `MainActivity`
implements `ModifiedMainActivityForSocialLoginPlugin`. The Drive consent screen also returns its
result through `onActivityResult`, and `SocialLoginPlugin.handleOnActivityResult` does **not**
forward that result for Google. `MainActivity` has to pass it on itself.

Replace `frontend/android/app/src/main/java/com/gympulse/app/MainActivity.java` with:

```java
package com.gympulse.app;

import android.content.Intent;
import android.util.Log;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginHandle;
import ee.forgr.capacitor.social.login.GoogleProvider;
import ee.forgr.capacitor.social.login.ModifiedMainActivityForSocialLoginPlugin;
import ee.forgr.capacitor.social.login.SocialLoginPlugin;

public class MainActivity extends BridgeActivity implements ModifiedMainActivityForSocialLoginPlugin {

    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode >= GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MIN && requestCode < GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MAX) {
            PluginHandle pluginHandle = getBridge().getPlugin("SocialLogin");
            if (pluginHandle == null) {
                Log.i("Google Activity Result", "SocialLogin login handle is null");
                return;
            }
            Plugin plugin = pluginHandle.getInstance();
            if (!(plugin instanceof SocialLoginPlugin)) {
                Log.i("Google Activity Result", "SocialLogin plugin instance is not SocialLoginPlugin");
                return;
            }
            ((SocialLoginPlugin) plugin).handleGoogleLoginIntent(requestCode, data);
        }
    }

    // Marker required by the plugin to allow custom scopes.
    public void IHaveModifiedTheMainActivityForTheUseWithSocialLoginPlugin() {}
}
```

### Android 2: strings / gradle / google-services

- **No** `google-services.json`, no Firebase, and no changes to `strings.xml` or `build.gradle`.
  The plugin brings its own Credential Manager / Play Services Auth dependencies, and the client id
  is passed at runtime from JS.
- `minSdkVersion` must be at least 23. That is the Capacitor 7 default, so nothing changes.
- *Optional, recommended for Play:* only Google is enabled, but the plugin still compiles against
  the Facebook SDK, and that SDK adds `com.google.android.gms.permission.AD_ID`. To keep the
  Play "advertising ID" declaration simple, add this to `android/app/src/main/AndroidManifest.xml`
  (declare `xmlns:tools="http://schemas.android.com/tools"` on `<manifest>`):
  ```xml
  <uses-permission android:name="com.google.android.gms.permission.AD_ID" tools:node="remove" />
  ```

### iOS 1: `Info.plist` URL type (required)

Add the **reversed iOS client id** as a URL scheme in `frontend/ios/App/App/Info.plist`, inside the
top-level `<dict>`. If a `CFBundleURLTypes` array already exists, add only the inner `<dict>` to it:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLName</key>
    <string>google</string>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>com.googleusercontent.apps.REPLACE-WITH-IOS-CLIENT-ID-PREFIX</string>
    </array>
  </dict>
</array>
```

This value depends on the iOS client id, which only the app owner has. Until it is known, keep the
placeholder, or leave the entry out. iOS sign-in then fails (Google refuses to redirect), but
nothing else is affected. GoogleSignIn takes the client id from `initialize()`, so a `GIDClientID`
plist key is **not** needed.

### iOS 2: `AppDelegate.swift` (recommended)

Let GoogleSignIn handle its redirect URL before Capacitor does. In
`frontend/ios/App/App/AppDelegate.swift`:

```swift
import UIKit
import Capacitor
import GoogleSignIn          // add
```

and replace the body of `application(_:open:options:)` with:

```swift
    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        if GIDSignIn.sharedInstance.handle(url) {
            return true
        }
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }
```

### iOS 3: privacy manifest (App Store)

The plugin README asks apps that use Google Sign-In to declare the collected data in
`ios/App/PrivacyInfo.xcprivacy` (EmailAddress, Name and UserID; linked, not tracking).

### Build script: `frontend/package.json` (needed for `.env.mobile`)

`build:mobile` currently runs `vite build`, which uses mode `production`, so Vite never reads
`.env.mobile`. The script also uses POSIX `VAR=1 cmd` syntax, which does not run in Windows
PowerShell. Suggested change:

```json
"build:mobile": "vite build --mode mobile && cap sync"
```

Then add the remaining variables to a committed `frontend/.env.mobile`, and put the Google ids in
an untracked `frontend/.env.mobile.local` (Vite loads both in mode `mobile`):

```dotenv
# frontend/.env.mobile
VITE_MOBILE=1
VITE_IMG_BASE=https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@7455efae41b330c265e7cd4b78dfa848e7ce5ebd/images/
VITE_GIF_BASE=https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@7455efae41b330c265e7cd4b78dfa848e7ce5ebd/videos/
```

Caution: other code may check `import.meta.env.MODE === 'production'` or `import.meta.env.PROD`.
`PROD` stays `true` with `--mode mobile`, because it is based on the build command, not on the mode.

### `capacitor.config.json`

Nothing more is needed. The existing `SocialLogin.providers` (google only) and
`CapacitorHttp.enabled: true` are correct. Drive uploads use `PATCH` and a `multipart/related`
string body. Both go through CapacitorHttp unchanged: the body is written raw, as UTF-8.

---

## How sign-in and token refresh behave

- **Sign in:** the user picks an account, then Google shows the consent screen for Drive. With
  granular consent the user can untick Drive. The app detects this (token without `drive.file`)
  and asks them to sign in again with the box ticked.
- **Tokens** are short-lived (about 1 h). They are kept **in memory only** and are never logged.
  - iOS refreshes silently in the background (GoogleSignIn holds a refresh token).
  - On Android the plugin can only return the last token while it is still valid. After about an
    hour, a background sync reports "sign in again". The next user-initiated sync calls
    `getAccessToken({ interactive: true })`, which shows a one-tap account sheet with no consent
    screen. This is a limitation of the plugin's online mode on Android, which has no refresh
    token.
- **Sign out** clears the Google session on the device. It does not touch the Drive file.
  "Delete cloud copy" deletes `gymplus-data.json` and leaves the empty `Gym Plus` folder.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Android: `DEVELOPER_ERROR`, `10:`, or `[28444] Developer console is not set up correctly` | The Android OAuth client's **package name or SHA-1 doesn't match the build**. Debug builds need the debug-keystore SHA-1. Play-installed builds need the **Play App Signing** SHA-1. Also check that `VITE_GOOGLE_WEB_CLIENT_ID` is the **Web** client id from the **same project**, not the Android one. Changes can take a few minutes to propagate. |
| Android: "You CANNOT use scopes without modifying the main activity" | The `MainActivity` change above was not applied. |
| Android: the consent screen closes and sign-in reports "cancelled" every time | `MainActivity.onActivityResult` is not forwarding to `handleGoogleLoginIntent` (see above). |
| Android: "No credentials available" | No Google account on the device or emulator. Add one in system settings (emulators need a Google Play image). |
| "Access blocked: … has not completed the Google verification process" | The consent screen is in **Testing** and this account is not a test user. Add it, or publish. |
| `Error 400: redirect_uri_mismatch` / `invalid_client` | Wrong client type for the platform, or (iOS) the URL scheme in `Info.plist` doesn't match the iOS client id. |
| Sync error `403 accessNotConfigured` | The Google Drive API is not enabled in the project. |
| Sign-in button says "not configured" | The client id env var was empty at build time. Fix `.env.mobile` or the shell env, then rebuild. |
| iOS: sign-in sheet opens, then nothing happens | The reversed-client-id URL scheme is missing or wrong in `Info.plist`, or the `AppDelegate` change is missing. |
