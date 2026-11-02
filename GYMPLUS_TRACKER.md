# Gym Plus — mobile build tracker

Single source of truth for the Gym Plus mobile work. **Every agent updates its own rows here when it
starts, finishes, or gets blocked.** If a session or agent stops, resume from the first row that is
not `done`, and read the agent's notes in the Log section first.

Status values: `todo` · `in-progress` · `done` · `blocked` (say why in Log).

## Decisions (from the user, 2026-10-31)

| Topic | Decision |
|---|---|
| Platforms | Android **and** iOS (Capacitor 7). iOS cannot be built on this Windows machine — code/config only, the user builds on a Mac. |
| Scope | **Mobile only** — everything new is behind `MOBILE` (`import.meta.env.VITE_MOBILE === '1'`). Web/self-hosted behaviour must not change. |
| Auth | Google sign-in, **optional**. Without sign-in the app works fully offline/local, exactly as today. |
| Cloud storage | User's own Google Drive, **visible** folder `Gym Plus` in My Drive, file `gymplus-data.json`. Scope `https://www.googleapis.com/auth/drive.file` only. |
| Sync | Local-first. On sign-in: merge local ⇄ Drive. Afterwards every change syncs (debounced), plus on launch/resume. Offline → retry later. |
| AI | Bring-your-own-key: **OpenAI, Anthropic (Claude), Google Gemini, Groq, OpenRouter**. User picks provider + model (list loaded from the provider, fallback list + free text). |
| API key | Stored **on the phone only** (Keychain / Android Keystore via `@aparajita/capacitor-secure-storage`). Never in `S`, never synced, never logged. |
| Branding | App name **Gym Plus**, package/bundle id **`com.gympulse.app`**. Rename everything user-visible (app, icons, splash, manifest, in-app text, `website/`, README). Keep AGPL license + "based on openGym" credit. |
| Logo | **Original** "+" mark (rounded plus formed with a dumbbell, dark rounded square, lime accent). Must NOT resemble the OnePlus logo (trademark). |

## Environment notes

- Node 24, npm 11. Java: `D:\Software\Java\jdk-25.0.1` (JAVA_HOME unset — Gradle may need JDK 21; Android Studio's JBR not installed).
- Android SDK: `%LOCALAPPDATA%\Android\Sdk` (adb at `platform-tools\adb.exe`, emulator at `emulator\emulator.exe`). AVDs: `Pixel_9_Pro`, `Medium_Phone` (API 36.1, Google Play image).
- git is not on PATH: portable install under `D:\Software\gitPor`.
- Shell is Windows PowerShell 5.1 (no `&&`).
- Added deps (frontend): `@capgo/capacitor-social-login@~7.20.0`, `@aparajita/capacitor-secure-storage@~7.1.6`, `@capacitor/app@~7.1.2`.

## Baseline (before any change)

- `frontend`: `npm test` → 8 files / 207 tests pass (needs `api/node_modules` installed because `coach.test.js` imports api code). `check-locales` → in sync (11 locales, 781 keys).
- `api`: `npm test` → **8 failures pre-existing** (jobs.test.js + one payload test; looks Windows-path related, e.g. `new URL(...).pathname` in adapters/index.js). Out of scope — the mobile app does not run api code. Do not "fix" by editing tests.

## Contracts between workstreams (do not change without updating this section)

### `lib/google-auth.js` (WS-B)
```js
export async function initGoogleAuth()                 // idempotent; reads client ids from lib/google-config.js
export async function googleSignIn()                   // interactive → { email, name, photo } ; throws { code:'cancelled'|'config'|'network'|'failed' }
export async function googleSignOut()
export async function getAccessToken({ interactive=false } = {})  // fresh token or throws { code:'auth' }
```
`lib/google-config.js` holds `GOOGLE_WEB_CLIENT_ID`, `GOOGLE_IOS_CLIENT_ID` from `import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID` / `VITE_GOOGLE_IOS_CLIENT_ID`, and `googleConfigured()`.

### `lib/gdrive.js` (WS-B) — all take an access token, use `fetch`
```js
export async function readCloudState(token)   // → null | { state, fileId, version, modifiedTime }
export async function writeCloudState(token, state, { fileId } = {})  // → { fileId, version, modifiedTime }
export async function cloudVersion(token)     // → null | { fileId, version, modifiedTime }  (metadata only)
export async function deleteCloudState(token)
```
Errors: throw `{ code:'auth' }` on 401/403-auth, `{ code:'offline' }` on network failure, `{ code:'failed', status }` otherwise.

### `lib/sync.js` (WS-A) — pure functions, unit-tested
```js
export function mergeStates(local, remote)    // → merged S. Union by id, newer per-item `t` wins, tombstones win over older edits,
                                              //   scalar settings: side with newer `_ts`. Never carries `active`.
export function markDeleted(s, kind, id)      // kind: 'workouts'|'routines'|'customEx'|'bodyweight'(id = date)  → writes s._del[kind][id] = Date.now()
export function stampItem(item)               // sets item.t = Date.now() (call when an item is created/edited)
export function hasData(S)
```

### Store additions in `store/useStore.js` (WS-A)
```js
account: null | { email, name, photo }        // persisted in localStorage 'gp_account', NOT inside S
sync: { state:'off'|'syncing'|'synced'|'offline'|'error'|'auth', lastAt:number|null, error:string|null }
firstSync: null | { local:S, remote:S }      // set when both sides have data on first sign-in → UI shows choice sheet
async googleSignIn()                          // sign in, then first sync
async googleSignOut({ keepLocal })            // final push, sign out, optionally wipe local
async syncNow()
async resolveFirstSync(choice)                // 'merge' | 'cloud' | 'local'
async deleteCloudCopy()
```

### AI (WS-C)
- `store/useAI.js` (zustand): `{ provider, model, hasKey, ready, load(), setProvider(p), setModel(m), saveKey(key), removeKey() }`. provider/model persisted in localStorage `gp_ai`; key in secure storage under `gp_ai_key_<provider>`.
- `lib/ai-providers.js`: `PROVIDERS` = `[{ id:'openai'|'anthropic'|'gemini'|'groq'|'openrouter', label, keyHint, keyUrl, fallbackModels:[...] }]`; `listModels(provider, key)`; `testConnection(provider, key, model)` → `{ ok, error? }`; `complete({ provider, model, key, system, prompt, json:true, timeoutMs })` → text.
- `S.coach.instructions` (string, ≤ 1000 chars, synced) — the user's free-text instructions; included in every Coach prompt.
- `lib/coach.js`: `coachAvailable(config, user, { demo, mobile, ai })` — on mobile returns `!!ai?.hasKey && !!ai?.model`.
- `lib/coach-local.js` exports the same surface as `coach-demo.js` (status/review/plan/refine/resolve/disclosure); `lib/coach-api.js` routes to it when `MOBILE`.

## File ownership (parallel phase — touch only your files; anything else → note it in Log for the orchestrator)

| WS | Owns |
|---|---|
| A sync | `lib/sync.js`, `lib/sync.test.js`, `lib/sync-engine.js`, `lib/sync-engine.test.js`, `store/useStore.js`, delete paths in `sheets.jsx`, `views/History.jsx`, `views/RoutineEdit.jsx`, `views/Library.jsx` (tombstone + `t` stamping only) |
| B google | `lib/google-auth.js`, `lib/google-config.js`, `lib/gdrive.js`, `lib/gdrive.test.js`, `docs/GOOGLE_SETUP.md` |
| C ai | `lib/ai-providers.js`, `lib/ai-providers.test.js`, `store/useAI.js`, `lib/coach-core/**`, `lib/coach-local.js`, `lib/coach-local.test.js`, `lib/coach-api.js`, `lib/coach.js`, `views/Coach.jsx`, `views/CoachIntake.jsx`, `views/CoachProposal.jsx` |
| D ui | `views/Profile.jsx`, `views/AISettings.jsx`, `components/FirstSyncSheet.jsx`, `App.jsx`, `views/Settings.jsx`, `views/Home.jsx`, `views/Plan.jsx` (coachAvailable call + entry points only), `index.css` (append only) |
| E brand | `resources/**`, `public/manifest.json`, `public/*icons*`, `index.html`, `android/**`, `ios/**`, `src/locales/**`, `website/**`, `README.md`, `docs/MOBILE.md`, `package.json` name fields, `public/sw.js` cache name |
| Orchestrator | `capacitor.config.json`, `package.json` deps, this tracker, integration fixes, testing |

New UI strings: use `t('English text')`. **Do not** add keys to `src/locales/*` in the parallel phase (English fallback is fine; `check-locales` only requires the locales to agree with each other).

## Tasks

| ID | WS | Task | Status |
|---|---|---|---|
| F1 | orch | Install deps, baseline tests, tracker, contracts | done |
| F2 | orch | `capacitor.config.json`: appId `com.gympulse.app`, appName `Gym Plus`, enable CapacitorHttp, SocialLogin plugin config | done |
| A1 | A | `mergeStates` / `markDeleted` / `stampItem` + thorough vitest | done |
| A2 | A | Tombstones + `t` stamps on every create/edit/delete path (workouts, routines, customEx, bodyweight) | done |
| A3 | A | Store: account, sync status, googleSignIn/googleSignOut/syncNow/resolveFirstSync/deleteCloudCopy, debounced push, pull on launch + resume (`@capacitor/app`), flush on background, offline retry | done |
| B1 | B | `google-config.js` + `google-auth.js` (capgo social-login, scopes `email profile drive.file`, silent token refresh) | done |
| B2 | B | `gdrive.js`: visible `Gym Plus` folder, read/write/version/delete, multipart upload, error mapping + vitest with mocked fetch | done |
| B3 | B | `docs/GOOGLE_SETUP.md`: Cloud project, OAuth clients (Android SHA-1 debug/release, Web, iOS), env vars, native config needed (list exact edits for orchestrator) | done |
| C1 | C | `ai-providers.js` for 5 providers (+ listModels, testConnection, JSON mode) + vitest with mocked fetch | done |
| C2 | C | `useAI.js` secure key storage (web fallback for dev = in-memory/localStorage with warning) | done |
| C3 | C | Port payload/validate/prompts to `lib/coach-core/` (browser-safe) + parity tests vs api | done |
| C4 | C | `coach-local.js` + route `coach-api.js` on MOBILE + `coachAvailable` + include `S.coach.instructions` + Coach views pass `ai` | done |
| D1 | D | `Profile.jsx` (signed-out / signed-in / sync status / sign out / delete cloud copy) + route `/profile` | done |
| D2 | D | `AISettings.jsx` (provider, key, test, model list, instructions, remove key) + route `/profile/ai` | done |
| D3 | D | `FirstSyncSheet.jsx` (merge / cloud / local) mounted in App; Settings top row + Home avatar entry; Plan/Home/Settings pass `ai` to coachAvailable | done |
| E1 | E | Original Gym Plus logo SVG + generate Android/iOS icons & splash + PWA icons | done |
| E2 | E | Package rename to `com.gympulse.app` (Android namespace/applicationId/MainActivity path, iOS bundle id) + app display names | done |
| E3 | E | Rebrand text in locales, index.html, manifest, sw cache, website/, README, docs/MOBILE.md (keep AGPL + openGym credit) | done |
| I1 | orch | Integration: wire native config from B3, fix cross-WS issues, rebrand strings inside src views/lib | done |
| T1 | orch | `npm test`, `npm run build`, `check-locales`, web build unchanged (no MOBILE code leaks) | done |
| T2 | orch | `build:mobile` + `gradlew assembleDebug` | done |
| T3 | orch | Emulator smoke test with screenshots: launch, offline use, log workout, Profile, AI settings (bad key error), Coach gating, restart persistence | done |
| T4 | orch | Hand-off checklist for the user (Google client IDs, real sign-in, real AI key, iOS build) | done |

## Log
- 2026-10-31 orch: F1 done. Baseline recorded above.
- 2026-10-31 orch: F2 done. Agents A–E launched in parallel. For T2 use JDK 21 (`$env:JAVA_HOME='D:\Software\Java\jdk-21.0.9'`) — Gradle 8.11.1 / AGP 8.7.2 don't support JDK 25.
- 2026-10-31 A: A1 done — `lib/sync.js` (+22 tests). Deviation: the per-item merge version is `_m` (modified-at), falling back to `t`, then workouts `end||start`, then 0 — because on bodyweight `t` is the weigh-in time that Stats/Home plot and CSV/Health imports set to the past. `stampItem` sets both `t` and `_m`. Extra export `stampChanges(prev, next)` (diff-based stamping, see A2). `hasData` moved to sync.js (same definition), re-exported from useStore.
- 2026-10-31 C: C1 done — `lib/ai-providers.js` (+19 tests). Extras beyond contract: `providerById(id)`, `AIError`, `mapHttpError`. `testConnection` → `{ ok:true }` | `{ ok:false, code, error }` (`error` = short human string, `code` = key/rate/model/offline/timeout/failed); with no model it only validates the key via listModels. `complete` throws `AIError {code,message,status?}`. OpenRouter is not sent `response_format` (not all routed models accept it).
- 2026-10-31 C: C2 done — `store/useAI.js` (+5 tests in `store/useAI.test.js`). Extra state `models` (last model per provider, restored on switch); extra export `getAIKey(provider?)` (async, reads the key at call time — key never in state). `load()` is memoised (safe to call repeatedly). Uses SecureStorage `getItem/setItem/removeItem` (plugin's default key prefix applies); non-MOBILE = in-memory key + one console.warn. **Orchestrator: call `useAI.getState().load()` at app start when MOBILE** (Coach views also call it lazily).
- 2026-10-31 C: C3 done — `lib/coach-core/{payload,validate,prompt}.js` + `prompts/*.md` (byte copies) + `coach-core.test.js` (37 parity tests vs api: build() for review/create/refine on 4 states incl. key order, library == library.json, validate*/extractJSON, prompt bytes, buildPrompt with/without repair). `validate.js` is a verbatim copy. Pseudonym = 16-hex FNV hash of a per-install id. `buildPrompt(kind, payload, repair, { instructions })` appends `S.coach.instructions` in a `<<<USER_PREFERENCES … USER_PREFERENCES>>>` block after the payload. Note for E/orch: the prompt files still say "openGym" — they must stay byte-identical to `api/coach/prompts`, so rebrand both or neither.
- 2026-10-31 C: C4 done — `lib/coach-local.js` (+16 tests), `coach-api.js` routes to it when `MOBILE` (demo first, unchanged), `coachAvailable(config, user, { demo, mobile, ai })`, Coach/CoachIntake/CoachProposal pass `ai` from `useAI` (on MOBILE they call `ai.load()` and don't redirect until `ai.ready`). Additions: status on mobile also returns `error: {code,kind,at}|null` and `notice: {kind:'nochange',reading}|null` (Coach.jsx shows a card; web/demo never set them); new coach-api exports `dismissCoachNotice()`, `jobErrorText(code)`, `MOBILE_JOB_ERRORS` (from `lib/coach-core/errors.js`; web `JOB_ERRORS` unchanged); extra mobile codes `rate`, `model`, `offline`. A review that finds nothing stamps `S.coach.lastReview` (via coach-api). **`reviewDue(S, now?)` lives in `lib/coach.js`** (pure, also re-exported by coach-local) — **D/orchestrator: on Home, when MOBILE && hasConsent && reviewDue(S) && !job && !pending, offer "Your weekly review is ready to generate" → `requestReview()`**; import it from `coach.js`, not `coach-local.js` (keeps coach-local a lazy chunk). Coach.jsx already shows the hint on mobile. Web bundle check: coach-local is a separate lazy chunk (never fetched on web); `ai-providers.js` (~4 KB, inert) lands in the main chunk via `useAI`.
- 2026-10-31 E: E1 done. New mark = rounded plus whose horizontal arm is a dumbbell (two plates each side), lime #a3e635 on #0c0e12. Sources: `frontend/resources/icon.svg` (rounded square), `icon.png` 1024 full-bleed (no alpha), `splash.png`/`splash-dark.png` 2732; `assets/gymplus-wordmark.svg`. Native assets generated with `npx @capacitor/assets generate --ios --android --assetPath resources` + the 4 colour flags (logo mode; `--pwa` NOT used so manifest stays hand-written). `values/ic_launcher_background.xml` → #0C0E12. Removed unreferenced old iOS `splash-2732x2732*.png`. PWA `public/icon-180.png` + `icon-512.png` regenerated (same names; favicon = icon-180.png). Note: old `assets/banner.svg/png` (openGym) untouched — README no longer uses it.
- 2026-10-31 E: E2 done. Android namespace/applicationId `com.gympulse.app`, MainActivity → `java/com/gympulse/app/` (old `ch/duartesantos` dir deleted), strings.xml Gym Plus / com.gympulse.app; iOS PRODUCT_BUNDLE_IDENTIFIER (Debug+Release) + CFBundleDisplayName. No other ch.duartesantos refs in android/ or ios/ (template tests under `com/getcapacitor/myapp` left as-is).
- 2026-10-31 D: D1 done — `views/Profile.jsx`, route `/profile` (MOBILE-only route). Also exports shared helpers `Avatar`, `syncStatusText(account, sync)`, `relTime`, `aiSummary`, `signInWithGoogle(toast)` (used by Settings/Home). Calls store actions with `?.()` so it renders before A3 lands; sign-in errors: `cancelled` silent, `config`/`network`/`offline` mapped, else `e.message`. `googleSignOut({keepLocal})` / `deleteCloudCopy()` errors are toasted. Orchestrator: check that after `deleteCloudCopy()` the debounced push doesn't immediately recreate the Drive file (A's call).
- 2026-10-31 D: D2 done — `views/AISettings.jsx`, route `/profile/ai`. Uses `getAIKey()` (C's extra export) to test/list with the saved key; first key save flips `hasKey` → loads `listModels`; model sheet with search (>10 models) + "Custom model…". Instructions write `S.coach.instructions` via `update`, creating `emptyCoach()` (consent null) if missing; debounced 800 ms + flush on blur/unmount.
- 2026-10-31 D: D3 done — `components/FirstSyncSheet.jsx` (locked sheet, opens on `store.firstSync`, closes when it goes null) mounted in App when MOBILE; `useAI.getState().load?.()` on mount when MOBILE; Settings MOBILE "Your data" rows → one account row → /profile (REPO import still used by demo branch); Home MOBILE header avatar (red dot on sync error/auth) → /profile; Home/Plan/Settings pass `ai`. CSS appended (`.gp-*`). `npm run build` ✓ (web bundle contains none of the new UI strings; only `useAI`'s `gp_ai` key name leaks into web via the `ai` import), `npm test` ✓ 11 files/254 tests; VITE_MOBILE=1 build ✓.
- 2026-10-31 E: E3 done. index.html (title, description, apple-mobile-web-app-title, application-name), manifest name/short_name "Gym Plus", sw.js cache `gymplus-rt-v1` (+ notification title fallback "Gym Plus", tag `gymplus`), package.json + package-lock.json name `gymplus-frontend`, website/* (Gym Plus naming, new icon, credit footer "Gym Plus is based on openGym by Duarte Santos (AGPL-3.0)", upstream APK/demo/GitHub links removed or labelled upstream), README top rewritten (wordmark, Drive sync + BYOK coach, credit in top box + License), docs/MOBILE.md (app id, GOOGLE_SETUP.md link, asset command). `check-locales` → 11 locales, 781 keys, in sync. Website docs say "Profile → Sign in with Google" / "Profile → AI coach" — adjust if D's UI labels differ.
  LOCALE KEY RENAMES (all 11 locales) — orchestrator must update the t('…') calls:
  1. "This browser doesn't support passkeys — you can still use openGym locally on this device." → "…use Gym Plus locally on this device."  (views/Login.jsx:81)
  2. 'to install openGym as a full-screen app.' → 'to install Gym Plus as a full-screen app.'  (views/Settings.jsx:~219)
  3. 'Rest-timer alerts, even if openGym is closed.' → 'Rest-timer alerts, even if Gym Plus is closed.'  (views/Settings.jsx:~336)
  4. 'A small file a friend imports into their own openGym — routines only, none of your workouts or weigh-ins.' → '…their own Gym Plus — …'  (sheets.jsx:605)
  5. 'this isn’t an openGym plan file' → 'this isn’t a Gym Plus plan file'  (lib/plan-share.js:71)
  6. 'Made with openGym' → 'Made with Gym Plus'  (lib/plan-share.js:254)
  7. 'Reload openGym' → 'Reload Gym Plus'  (components/ErrorBoundary.jsx:30)
  8. 'Self-host openGym' → 'Self-host Gym Plus'  (views/Settings.jsx:~98, two Rows)
  OTHER USER-VISIBLE "openGym" IN src (not locale keys): views/Login.jsx:53 `<h1>openGym</h1>`; views/Login.jsx:64 t('…come with the openGym server…') (English-only, no locale key); views/Home.jsx:86 `'openGym'` title for guest; views/Settings.jsx:223 footer `openGym · free & open source` (→ add "Gym Plus is based on openGym by Duarte Santos (AGPL-3.0)" there — it is the app's About/credits text); views/Settings.jsx:224 source-code link (upstream repo — label upstream); views/Settings.jsx:53 Error 'not an openGym backup'; lib/plan-share.js:246 `<div class="kicker">openGym</div>` and :254 footer domain `opengym.duarte-santos.ch`; views/AdminCoach.jsx:237 "stored by OpenGym" (self-host admin); lib/demo.js:14 REPO (upstream URL); lib/coach-core/prompts/common.md:1 "inside openGym, a self-hosted…" (prompt text, C's). Non-visible, leave: `opengym_plan` file-format key, `opengym-state.json` (lib/mobile.js:16, existing installs), `opengym-backup-`/`opengym-plan-` export filenames (optional rename), code comments.
- 2026-10-31 A: A2 done — central instead of per-call-site: on MOBILE, `store.update()` runs `stampChanges(prevS, draft)` (lib/sync.js), which diffs the 4 collections and stamps `_m` on every added/changed item and writes `_del` tombstones for every removed key; `replaceState(S, push=true)` (backup import, "Reset everything") does the same and keeps older tombstones. This covers every path incl. files A doesn't own (Plan.jsx, plan-share import, import-csv, coach.js apply/revert, Workout finish) — **no edits needed in sheets/History/RoutineEdit/Library or anywhere else**. Web: no stamping (byte-identical blobs). Cost: one JSON.stringify per collection item per update (memoised per S). `markDeleted`/`stampItem` exported per contract but unused. Note: exWeights has no tombstones, so "Reset everything" keeps merging exWeights back from Drive (suggestion-only data, accepted).
- 2026-10-31 A: A3 done — `lib/sync-engine.js` (`createSyncEngine(deps)`, +23 tests with fake auth/Drive) wired in `store/useStore.js` (engine + google-auth + gdrive loaded via dynamic import behind MOBILE; web main bundle has no reference — rolldown still emits orphan chunks for them, same as the existing @capacitor chunks). Behaviour/choices: (1) `googleSignIn()` returns 'uploaded'|'adopted'|'merged'|'choose' and **rethrows** errors (`{code}` from google-auth or gdrive); on failure the account is not kept (except when re-signing into the same account). Silent merge only when `gp_sync_meta.email` equals the new account (meta is cleared on sign-out, so after sign-out → sign-in with data on both sides always asks). While `firstSync` is open `gp_account` is not persisted (app killed → no silent merge on next launch) and edits don't push. (2) `resolveFirstSync(other than merge/cloud/local)` = cancel → Google sign-out, local untouched. (3) **deleteCloudCopy() = cancel pending push, delete Drive file, sign out of Google, forget account/meta, keep local data** (sync state 'off') — answers D's question: the debounced push can't recreate the file. (4) Drive 401 → `invalidateAccessToken()` + one retry, then status 'auth'; google-auth `network` and gdrive `offline` → 'offline' (dirty kept, retried on `online`, on resume and on next edit). (5) Merged/adopted cloud state is applied with `persist(S, false, keepTs=true)` (no push loop); MOBILE boot restore from the file mirror now also keeps `_ts` (otherwise local settings would always look newer than Drive's). (6) `sync.lastAt` persisted in `gp_sync_meta.lastAt`. Lifecycle: listeners (`online`, `@capacitor/app` appStateChange: active → sync, background → flush; existing visibilitychange → flush) attached once in MOBILE boot.
- 2026-10-31 B: B1 done — `lib/google-config.js` (`GOOGLE_WEB_CLIENT_ID`, `GOOGLE_IOS_CLIENT_ID`, `GOOGLE_SCOPES`, `googleConfigured()` per platform via `globalThis.Capacitor.getPlatform()`), `lib/google-auth.js` (+14 tests in `google-auth.test.js`, mocked plugin). Errors are `GoogleAuthError {code, message, reason?}`. Extras beyond the contract: `invalidateAccessToken()`, `mapAuthError()`; `initGoogleAuth()` resolves false when unconfigured (doesn't throw). `getAccessToken()` may also throw `{code:'network'}` (silent refresh couldn't reach Google), not only 'auth'. Token expiry/scopes come from tokeninfo (POST, token never in a URL); tokens are kept in memory only. If the user unticks Drive on Google's granular consent, `googleSignIn` throws `{code:'failed', reason:'scope'}` and signs out. Plugin reality: Android `refresh()` isn't implemented, and once the ~1 h token expires `getAuthorizationCode` clears the session → Android needs `getAccessToken({interactive:true})` (one-tap sheet, no consent) roughly hourly; iOS refreshes silently.
- 2026-10-31 B: B2 done — `lib/gdrive.js` (+27 tests in `gdrive.test.js`, in-memory fake Drive). `version` is returned as a Number. Extras: `resetDriveCache()` (called by googleSignOut), `DriveError {code,status?,reason?}`, exported `multipartBody`. A known `fileId` that 404s → recreate; a cached folder that misses → re-resolve once; creates always re-resolve the folder (avoids writing into a trashed folder).
- 2026-10-31 B: B3 done — `docs/GOOGLE_SETUP.md`. **Orchestrator: apply its section "Native changes (applied by orchestrator)"** — (1) REQUIRED Android `MainActivity.java` implements `ModifiedMainActivityForSocialLoginPlugin` + forwards `onActivityResult` (without it, login with the Drive scope is rejected outright); (2) iOS `Info.plist` CFBundleURLTypes with the reversed iOS client id (owner-specific → placeholder) + `AppDelegate` `GIDSignIn.sharedInstance.handle(url)`; (3) `build:mobile` must use `vite build --mode mobile` or `.env.mobile` is never read (the current POSIX `VAR=1` syntax also fails in PowerShell); (4) optional AD_ID `tools:node="remove"`. No gradle/strings/google-services changes needed.
- 2026-10-31 orch: I1 part 1 done - B3 native edits applied: MainActivity (SocialLogin marker + onActivityResult), AndroidManifest AD_ID removed, iOS AppDelegate GIDSignIn handle, Info.plist CFBundleURLTypes placeholder (user must set reversed iOS client id), build:mobile = `vite build --mode mobile && cap sync` + frontend/.env.mobile (Google ids go in untracked .env.mobile.local; *.local gitignored). Remaining I1: rebrand strings from E Log, exWeights not tombstoned (A note), verify after C finishes.
- 2026-10-31 orch: I1 done - rebrand strings in src (Settings/Login/Home/sheets/plan-share/ErrorBoundary + credit footer), prompts common.md rebranded in BOTH api and frontend copies (parity kept), exWeights tombstones added to sync.js (+3 tests), Home offers weekly review when reviewDue on MOBILE. T1 done: frontend 16 files / 375 tests pass, locales in sync, web build OK, main web bundle has no Google/Drive/sync code (only AI provider URL strings via PROVIDERS list, inert). api still 8 pre-existing failures (unchanged).
- 2026-10-31 orch: T2 build:mobile + cap sync OK (6 plugins on iOS/Android). `gradlew assembleDebug` (JDK 21) and the Pixel_9_Pro emulator were both STOPPED by Claude Code because the PC ran critically low on memory (not a build failure). Waiting for the user before re-running. Plan: run Gradle alone first (lower heap), then the emulator with -memory 2048, never both at once. Resume point: T2 gradle step. (gradle log path: D:\Learning\openGym\gradle-build.log, outside the repo)
- 2026-10-31 orch: T2 done - assembleDebug OK (app-debug.apk 8.3 MB). Fix needed: plugin hook makes androidx.browser compileOnly 1.9.0 (apple provider off) vs runtime 1.4.0 -> forced androidx.browser:1.8.0 in android/build.gradle allprojects (1.9.0 needs compileSdk 36). Build cmd: JAVA_HOME=jdk-21.0.9, `gradlew assembleDebug --no-daemon`. Next: T3 emulator.
- 2026-10-31 orch: T3 done on Pixel_9_Pro emulator (API 36.1), debug APK. Verified: launch + Gym Plus branding; starter plan loads; data survives force-stop; Profile signed-out state (Google button disabled without client id, as designed); AI Coach screen (5 providers); fake OpenAI key -> real request -> "The provider rejected the API key."; key saved to secure storage and survives restart (Profile shows "OpenAI · gpt-5-mini"); instructions saved to S.coach.instructions; consent screen names OpenAI; Ask for a review -> on-device pipeline -> "Your API key was rejected — check it in Profile → AI Coach."; Settings account row; body-weight log saves with _m stamp; API key NOT present in saved state file. Fixed during T3: Android 15 edge-to-edge overlap (capacitor.config android.adjustMarginsForEdgeToEdge=auto) and white system bars (styles.xml + colors.xml gp_bars). One app close was caused by Play Store updating Android System WebView mid-test (not an app crash). Not tested (needs user): real Google sign-in + Drive sync, a valid AI key end-to-end proposal, iOS build, full guided workout session.

## Hand-off checklist (T4) — what only the owner can do
1. Google Cloud: follow docs/GOOGLE_SETUP.md (project, Drive API, consent screen, Android client with package com.gympulse.app + SHA-1 of debug and release keystores, Web client, iOS client).
2. Put ids in frontend/.env.mobile.local: VITE_GOOGLE_WEB_CLIENT_ID=..., VITE_GOOGLE_IOS_CLIENT_ID=...
3. iOS: replace REPLACE-WITH-IOS-CLIENT-ID-PREFIX in ios/App/App/Info.plist with the reversed iOS client id; on a Mac: npm run build:mobile, cd ios/App, pod install, open in Xcode, set signing team, run.
4. Android: npm run build:mobile, then (JDK 21) cd android; gradlew assembleDebug -> app/build/outputs/apk/debug/app-debug.apk. Release: assembleRelease + sign (docs/MOBILE.md).
5. Test with a real account: sign in, check "Gym Plus/gymplus-data.json" appears in Drive, edit on two devices, sign out/in.
6. Test with a real AI key for each provider you care about: Test connection, model list, Ask for a review, apply/revert a suggestion.
7. Licence: NOTICE.md's app-store exception was granted for upstream openGym; check before publishing to Play Store/App Store.
