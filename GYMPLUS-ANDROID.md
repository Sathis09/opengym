# Gym Plus — Android app: step by step

Follow the parts **in order**. Each step says what to do and how to check that it worked.
Everything is written for **this Windows PC** and **PowerShell**.

| Part | What you do | How often |
|---|---|---|
| [A. Install software](#part-a--install-software-once) | Check the tools are installed | Once |
| [B. Google Cloud](#part-b--google-cloud-once) | Create the IDs that make "Sign in with Google" work | Once |
| [C. Connect the app to Google](#part-c--connect-the-app-to-google-once) | Put your Web client ID in one file | Once |
| [D. Build & install a test APK](#part-d--build--install-a-test-apk-every-time-you-change-something) | Build the APK and put it on a phone/emulator | Every change |
| [E. Test the app](#part-e--test-checklist) | Click through the checklist | Every build |
| [F. Release APK](#part-f--release-apk-to-give-to-other-people) | Signed APK to give to other people | Each release |
| [G. Problems](#part-g--if-something-goes-wrong) | Fixes for common errors | When needed |

> Without Part B/C the app still builds and works fully offline. Only the
> *Sign in with Google* button stays greyed out.

---

## Part A — Install software (once)

| Software | Why | On this PC |
|---|---|---|
| Node.js 20+ | Builds the app's code | ✅ installed (v24) |
| JDK **21** | Builds the Android APK (JDK 25 does **not** work) | ✅ `D:\Software\Java\jdk-21.0.9` |
| Android SDK (platform 35, build-tools 35.0.0, platform-tools) | Compiles, signs and installs the APK | ✅ `%LOCALAPPDATA%\Android\Sdk` |
| Android emulator *or* an Android phone with USB debugging | To run the app | ✅ emulator `Pixel_9_Pro` |

First time only, install the app's packages:

```powershell
cd D:\Learning\openGym\opengym\frontend
npm install
cd ..\api
npm install
```

✅ **Check:** both commands finish without `ERR!`.

---

## Part B — Google Cloud (once)

Go to **https://console.cloud.google.com** and sign in with the Google account that will own the app.

### B1. Create a project
1. Top bar → project picker → **New project** → name it `Gym Plus` → **Create**.
2. Make sure `Gym Plus` is selected in the top bar.

### B2. Turn on the Google Drive API
1. Menu **☰ → APIs & Services → Library**.
2. Search **Google Drive API** → open it → **Enable**.

### B3. Consent screen (what users see when they sign in)
Menu **☰ → APIs & Services → OAuth consent screen**. Newer consoles call it **Google Auth
Platform**, with tabs *Branding / Audience / Data access / Clients*.

1. **Branding:** App name `Gym Plus`, your support email, your developer email → Save.
2. **Audience:** User type **External**. While the status is **Testing**, add your own Gmail
   (and anyone else who will test) under **Test users**. Only test users can sign in, and
   Google asks testers to sign in again after about 7 days. That's normal.
3. **Data access → Add or remove scopes:** add
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
   - `openid`
   - `https://www.googleapis.com/auth/drive.file` (lets the app see **only the files it created**)

   → Update → Save.

### B4. Create the OAuth clients (the "keys")
Menu **APIs & Services → Credentials** (or the **Clients** tab) → **+ Create credentials →
OAuth client ID**. Create **two** clients:

**① Android client**

| Field | Value |
|---|---|
| Application type | **Android** |
| Name | `Gym Plus Android (debug)` |
| Package name | `com.gympulse.app` |
| SHA-1 certificate fingerprint | `DC:B1:C4:28:A0:3C:55:EA:7D:43:C0:BE:E3:F9:A4:2C:35:7F:0C:17` |

This SHA-1 belongs to **this PC's debug key**, which signs test APKs. For a release APK you
create a second Android client with the release key's SHA-1 (Part F).

To read the SHA-1 yourself:
```powershell
& 'D:\Software\Java\jdk-21.0.9\bin\keytool.exe' -list -v -keystore "$env:USERPROFILE\.android\debug.keystore" -alias androiddebugkey -storepass android -keypass android | Select-String SHA1
```

**② Web client**: the app needs this one's ID, even on Android.

| Field | Value |
|---|---|
| Application type | **Web application** |
| Name | `Gym Plus Web (for Android sign-in)` |
| Authorized origins / redirect URIs | leave empty |

After **Create**, copy the **Client ID**. It looks like
`123456789012-abcdefg123.apps.googleusercontent.com`.

> ⚠️ **What you need vs. what you don't**
> - ✅ **Web client ID** (`…apps.googleusercontent.com`) goes in the app (Part C).
> - ❌ **Client secret**: never put it in the app and never share it. The app doesn't use it.
> - ❌ **API key** (`AIza…`): not used by Gym Plus.
> - The Android client's ID is **not** put anywhere. It only has to exist.

✅ **Check:** Credentials shows **one Android** and **one Web application** OAuth client.

---

## Part C — Connect the app to Google (once)

Create this file (it is **not** committed to git):

`D:\Learning\openGym\opengym\frontend\.env.mobile.local`

with exactly one line, using **your Web client ID**:

```ini
VITE_GOOGLE_WEB_CLIENT_ID=123456789012-abcdefg123.apps.googleusercontent.com
```

Or create it from PowerShell:

```powershell
Set-Content -Path D:\Learning\openGym\opengym\frontend\.env.mobile.local -Encoding ascii -Value 'VITE_GOOGLE_WEB_CLIENT_ID=PASTE-YOUR-WEB-CLIENT-ID-HERE'
```

✅ **Check:** `Get-Content D:\Learning\openGym\opengym\frontend\.env.mobile.local` shows your ID.

---

## Part D — Build & install a test APK (every time you change something)

Open a **new PowerShell** window and run the blocks in order.

**D1. Tell this window where Java 21 and the Android SDK are**
```powershell
$env:JAVA_HOME    = 'D:\Software\Java\jdk-21.0.9'
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:Path         = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
```

**D2. Build the app code for mobile and copy it into the Android project**
```powershell
cd D:\Learning\openGym\opengym\frontend
npm run build:mobile
```
✅ **Check:** it ends with `Sync finished`.

> These two yellow lines are **normal on Windows**. They are about iOS (which needs a Mac) and do
> not affect the Android APK:
> ```
> [warn] Skipping pod install because CocoaPods is not installed
> [warn] Unable to find "xcodebuild". Skipping xcodebuild clean step...
> ```

**D3. Build the APK**
```powershell
cd android
.\gradlew.bat assembleDebug --no-daemon
```
✅ **Check:** `BUILD SUCCESSFUL`. The APK is at
`D:\Learning\openGym\opengym\frontend\android\app\build\outputs\apk\debug\app-debug.apk`.
The first build takes a few minutes; later builds take about 1 minute.

**D4. Start the emulator** (skip if you use a real phone)
```powershell
Start-Process "$env:ANDROID_HOME\emulator\emulator.exe" -ArgumentList '-avd','Pixel_9_Pro','-memory','2048'
adb wait-for-device
```
Real phone instead: *Settings → About phone →* tap **Build number** 7 times →
*Developer options →* **USB debugging** on → connect by USB → accept the prompt on the phone.

**D5. Install and open it**
```powershell
adb devices                                   # your emulator/phone must be listed
adb install -r app\build\outputs\apk\debug\app-debug.apk
adb shell monkey -p com.gympulse.app -c android.intent.category.LAUNCHER 1
```
✅ **Check:** **Gym Plus** opens on the emulator/phone.

> You can also copy `app-debug.apk` to a phone (USB, Drive, WhatsApp to yourself…) and tap it
> to install. Android asks once to allow installing from that app.

---

## Part E — Test checklist

- [ ] App opens, title **Gym Plus**, profile icon (top right) next to the gear.
- [ ] **Home → Load starter plan** works; close and reopen the app, and the plan is still there.
- [ ] **Profile → Sign in with Google** is **not** greyed out (if it is, see Part G).
- [ ] Sign in → pick your account → on the next screen **keep the Google Drive box ticked** → Allow.
- [ ] Profile shows your name/photo and **Synced**.
- [ ] Open **drive.google.com**: a **Gym Plus** folder with `gymplus-data.json` exists.
- [ ] Log a body weight → after a few seconds Profile still says **Synced**.
- [ ] **Profile → AI Coach**: choose a provider, paste your API key, **Test connection** shows ✓,
      pick a model, write your instructions.
- [ ] **Coach → Ask for a review** returns suggestions (needs a few logged workouts to be useful).
- [ ] **Profile → Sign out → Keep my data on this phone**: data stays; signing in again syncs.

---

## Part F — Release APK (to give to other people)

A debug APK is only for testing. For anyone else, build a **signed release APK**.

**F1. Create your release key, once, and keep it forever**
```powershell
cd D:\Learning\openGym
& "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -v -keystore gymplus-release.keystore -alias gymplus -keyalg RSA -keysize 2048 -validity 10950
```
- It asks for a password and your name/organisation. **Write the password down.**
- Keep `D:\Learning\openGym\gymplus-release.keystore` **outside the repo** and back it up (USB,
  password manager). If you lose it, you can never update the app on people's phones.

**F2. Register the release key with Google**
```powershell
& "$env:JAVA_HOME\bin\keytool.exe" -list -v -keystore D:\Learning\openGym\gymplus-release.keystore -alias gymplus | Select-String SHA1
```
In Google Cloud, create **another Android OAuth client**: package `com.gympulse.app`, this new
SHA-1, name `Gym Plus Android (release)`.

**F3. Raise the version number**
In `frontend\android\app\build.gradle`: increase `versionCode` by 1 (it is `4` now → `5`) and set
`versionName` (e.g. `"1.0.0"`). `versionCode` must go up on every release.

**F4. Build, align, sign**
```powershell
# (run D1 first in a new window)
cd D:\Learning\openGym\opengym\frontend
npm run build:mobile
cd android
.\gradlew.bat assembleRelease --no-daemon

$bt = "$env:ANDROID_HOME\build-tools\35.0.0"
& "$bt\zipalign.exe" -f -p 4 app\build\outputs\apk\release\app-release-unsigned.apk D:\Learning\openGym\GymPlus-aligned.apk
& "$bt\apksigner.bat" sign --ks D:\Learning\openGym\gymplus-release.keystore --ks-key-alias gymplus --out D:\Learning\openGym\GymPlus.apk D:\Learning\openGym\GymPlus-aligned.apk
& "$bt\apksigner.bat" verify --verbose D:\Learning\openGym\GymPlus.apk
```
✅ **Check:** `verify` prints `Verified using v2 scheme … true`. **`D:\Learning\openGym\GymPlus.apk`**
is the file you share. Install it on a real phone and run Part E once more.

> A release APK can't be installed over a debug APK (different signatures). Uninstall the debug
> app first: `adb uninstall com.gympulse.app` (this deletes the data on that device).

**F5. (Optional) Google Play**: Play wants an `.aab` instead of an APK:
```powershell
.\gradlew.bat bundleRelease --no-daemon
& "$env:JAVA_HOME\bin\jarsigner.exe" -keystore D:\Learning\openGym\gymplus-release.keystore app\build\outputs\bundle\release\app-release.aab gymplus
```
With Play App Signing, also add the SHA-1 from *Play Console → App integrity* as another Android
OAuth client. Before publishing, check `NOTICE.md`: its app-store permission was given to the
original openGym and may not cover this fork. Before letting the public sign in, publish the
OAuth consent screen (Audience → **Publish app**).

---

## Part G — If something goes wrong

| What you see | Why | Fix |
|---|---|---|
| *Sign in with Google* is greyed out: "isn't set up in this build" | No Web client ID in the build | Do Part C, then repeat **D2 → D5** |
| Sign-in error **DEVELOPER_ERROR** / **code 10** | Android client's package or SHA-1 doesn't match the key that signed this APK | Package must be `com.gympulse.app`; SHA-1 must be the debug one (test APK) or release one (release APK) |
| "Access blocked: app has not completed verification" | Your Gmail isn't a test user | B3 → Audience → add it under **Test users** |
| Signed in but Drive sync fails | Drive API off, or the Drive box was unticked | B2 enable API; sign out and in again, keep the Drive box ticked |
| `gradlew` fails right away, mentions Java/class version | Window is using JDK 25 | Run **D1** in that window |
| `Cannot find a version of 'androidx.browser:browser'` | The fix in `android\build.gradle` was removed | Keep the `resolutionStrategy.force 'androidx.browser:browser:1.8.0'` block |
| My code change isn't in the APK | Skipped D2 | Always run `npm run build:mobile` before `gradlew` |
| `adb: no devices` | Emulator not started / phone not authorised | D4; on a phone, accept the USB-debugging prompt |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | Installing release over debug (or the reverse) | `adb uninstall com.gympulse.app`, then install again |
| Build or emulator killed, PC very slow | Low memory | Close other apps; don't build while the emulator boots; `-memory 2048` |
| AI Coach: "Your API key was rejected" | Wrong key, or the key belongs to a different provider | Profile → AI Coach → choose the right provider → paste key → Test connection |

More detail: `docs/GOOGLE_SETUP.md` (Google), `docs/MOBILE.md` (mobile build, iOS).
