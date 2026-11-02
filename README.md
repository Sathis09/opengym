<div align="center">

<img src="assets/gymplus-wordmark.svg" alt="Gym Plus" width="420">

<br>

**A mobile gym & body-weight tracker you actually own.**

Plan your week, run guided workouts, track every set and your body weight over time —
on your phone, fully offline. Optionally sync through **your own Google Drive** and get an
**AI coach that runs on your own API key** (OpenAI, Claude, Gemini, Groq or OpenRouter).
No account on someone else's server, no subscription, no ads.

<br>

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-a3e635?style=flat-square)](LICENSE)
![Android](https://img.shields.io/badge/Android-Capacitor-3ddc84?style=flat-square)
![iOS](https://img.shields.io/badge/iOS-Capacitor-60a5fa?style=flat-square)
![React](https://img.shields.io/badge/React-19-38bdf8?style=flat-square&logo=react&logoColor=white)
![No tracking](https://img.shields.io/badge/telemetry-none-f472b6?style=flat-square)

</div>

<br>

> ### Gym Plus is based on openGym
>
> **Gym Plus is based on [openGym](https://github.com/DuarteSantos8/openGym) by Duarte Santos (AGPL-3.0).**
> It keeps openGym's tracker (and this repo's optional self-hosted AI Coach) and adds a
> mobile-first app — package / bundle id `com.gympulse.app` — with:
>
> - **Optional Google sign-in + Drive sync** — local-first; your log is stored as
>   `gymplus-data.json` in a visible **Gym Plus** folder in *your own* Google Drive
>   (`drive.file` scope only). Without sign-in the app works fully offline, exactly as before.
> - **Bring-your-own-key AI coach** — pick OpenAI, Anthropic (Claude), Google Gemini, Groq or
>   OpenRouter and a model; the key stays in the phone's Keychain / Keystore, never synced.
>
> Mobile build: **[docs/MOBILE.md](docs/MOBILE.md)** · Google sign-in setup:
> **[docs/GOOGLE_SETUP.md](docs/GOOGLE_SETUP.md)** · self-hosted AI Coach:
> **[docs/AI_COACH.md](docs/AI_COACH.md)** ([Claude setup](Claude-setup-instructions.md) ·
> [ChatGPT / Codex setup](ChatGPT-setup-instructions.md) · [design deck (PDF)](openGym_AI_Strategy.pdf))

<br>

<div align="center">
<table>
<tr>
<td align="center"><img src="assets/screenshots/home.png" alt="Home" width="230"><br><sub><b>Home</b> — today's workout & weight</sub></td>
<td align="center"><img src="assets/screenshots/workout.png" alt="Workout" width="230"><br><sub><b>Guided workout</b> — animated demos & sets</sub></td>
<td align="center"><img src="assets/screenshots/stats.png" alt="Stats" width="230"><br><sub><b>Stats</b> — heatmap, charts & PRs</sub></td>
</tr>
</table>
<sub>Screenshots are from upstream openGym; the Gym Plus training screens are the same.</sub>
</div>

<div align="center">

### Upstream openGym: [🌐 opengym.duarte-santos.ch](https://opengym.duarte-santos.ch) · [▶ live demo](https://duartesantos8.github.io/openGym/)

The upstream demo runs entirely in your browser on example data (it is openGym, not Gym Plus —
no Drive sync or bring-your-own-key coach).

</div>

## Why

Most workout apps lock your data behind a login on their servers, nag you to upgrade, or
disappear when the startup does. Gym Plus (like openGym before it) is the opposite: **your data
stays on your phone, in your own Google Drive, or on a box you run — and it's yours to fork.**
It still feels modern — native app, offline support, optional sync, and an AI coach that
answers to your own API key instead of a subscription.

## Features

- ☁️ **Google Drive sync (optional, mobile)** — sign in with Google and your log syncs, local-first, to a **Gym Plus** folder in your own Drive; changes are pushed automatically and pulled on launch/resume. Skip sign-in and nothing leaves the phone
- 🧠 **Bring-your-own-key AI coach (mobile)** — the Coach talks directly to OpenAI, Anthropic (Claude), Google Gemini, Groq or OpenRouter with your key and the model you pick, plus your own standing instructions. The key lives only in the phone's secure storage
- ⚖️ **Body-weight tracking** — interactive chart with a goal line you set, gains/losses colored by whether they move toward it
- 🏋️ **Weekly plan** — a routine per weekday, over a library of **1,324 exercises** (searchable, with animated demos)
- 🗓️ **Reschedule any day** — sick, missed a session, or fewer gym days this week? Move a workout to another day without touching your weekly plan
- ▶️ **Guided workouts** — it knows what day it is and starts today's session; asks your body weight first, pre-fills your weights from last time, rest timer, PR detection, per-exercise weight tracking
- ☀️ **The screen stays awake while you train** — no unlocking the phone and finding your place again between every set. On for as long as a workout is running, released the moment you finish it, and switchable off in Settings
- 🔗 **Supersets** — build them, and log them back-to-back with a rest only after the pair
- ⏱️ **Timed exercises** — planks, hangs, wall sits and loaded carries are logged by time, not reps, with a work timer that counts the set itself (separate from the rest timer) and logs the time you actually held. They can carry weight too
- 📈 **Progression that follows a rule** — pick one per routine, override it per exercise: linear, **Greyskull LP** (AMRAP top set, double jumps, 10 % resets), double progression through a rep range, or adding time. Your weights are already right when the session opens, and every target says *why* it's that number. Missed reps never advance the load, stalls trigger a deload, and bodyweight exercises progress in reps instead
- 💪 **Estimated 1RM** — per exercise, from your best eligible set (it names which one), with its own progress curve and a calculator for sets you haven't done. Won't guess above 12 reps
- 🎯 **Effort per set, in your scale** — an optional third column rating how hard a set was, as **RIR** (reps left in the tank) or **RPE** (the same judgement on a 10-point scale). Off by default; each set keeps the scale it was logged with, and nothing else reads the value — your progression and 1RM are unaffected
- 🏃 **Cardio** — log time + speed, not just weight × reps
- 📤 **Share a plan** — send someone your routines and week schedule as a small file (no workouts, no weigh-ins), or print it as a clean PDF. Importing merges, so their plan is never overwritten
- 🔧 **Filter by equipment** — narrow the library to what you actually own; the options adapt to what you've picked, so every combination on screen has results behind it
- ✨ **Your own exercises** — a name and a body part is enough; they behave like built-in ones everywhere, with an optional description instead of an animation
- 🟩 **Activity heatmap** — a GitHub-style year view, shaded by time spent training
- 💪 **Muscle map** — a front-and-back body diagram shaded by how much work each muscle got, over a week, a month or all time. It names the muscles you *haven't* trained in that period, previews what a routine hits while you build it, and shows what you just trained when you finish. Male or female figure, your pick
- 🔔 **Push notifications** — rest-timer alerts even with the app closed, plus an optional reminder on days you have a workout planned but haven't logged one. Opt in per profile; keys are generated on first run, nothing to configure
- 🤖 **AI Coach** (optional) — an AI that *designs* your plan and adjusts it from what you actually log. A short intake produces a complete weekly plan you can refine in plain language; on demand or on a schedule it reads your stalls, effort ratings, adherence and body-weight trend and proposes **discrete, explained changes** you accept one by one. Choose the official Claude Agent SDK or the bundled OpenAI Codex CLI with ChatGPT device-code sign-in; it is off until the instance owner enables it, needs each profile's separate consent, and never changes anything without your approval — every change-set is snapshotted and revertible. The progression engine still owns your session-to-session weights. **[Full guide →](docs/AI_COACH.md)**
- 🔑 **Passkeys, not passwords** — Face ID / Touch ID / fingerprint login; each profile keeps its own data, synced across devices
- 🛠️ **Admin dashboard** (optional) — for whoever runs the instance: who's training right now, per-user history, disable accounts, and invite-only signup. Off by default, so a fresh instance stays open with no admin
- 🎨 **Designed, not assembled** — light/dark themes and 8 accent colors saved to your profile, over a hand-drawn icon set instead of emoji, so it looks the same on every phone
- 🌍 **12 languages** — full UI translation (EN, DE, ES, FR, IT, PT, PL, TR, RU, ZH, KO, HI); exercise instructions localized in 10 of them, loaded on demand so the app stays fast
- 📥 **Bring your history with you** — import from **FitNotes** (Android and iOS), **Strong** and **Hevy**, or body weight straight out of an **Apple Health** export. Exercise names are matched against the library and anything unrecognised becomes one of your own exercises, so nothing in the file is dropped
- 📦 **Yours to keep** — one-tap JSON export/import, guest mode, **no telemetry**
- 📱 **Native Android & iOS app** — the whole tracker as a Capacitor app (`com.gympulse.app`): no account required, data on the phone, native workout reminders — see [docs/MOBILE.md](docs/MOBILE.md)

## Quick start (self-host)

You need [Docker](https://docs.docker.com/get-docker/) with Compose.

From a checkout of this repository (the clone below is the **upstream openGym** repo — use
the Gym Plus repository URL instead if you want the Gym Plus additions):

```bash
git clone https://github.com/DuarteSantos8/openGym   # upstream openGym
cd openGym
cp .env.example .env
docker compose pull   # grab prebuilt images (amd64 + arm64) — skip to build from source instead
docker compose up -d
```

Open **http://localhost:8080**, tap **Create profile**, and you're in. First launch downloads
the exercise media (~140 MB) once. Prefer building the images yourself instead of pulling from
`ghcr.io`? Drop the `pull` step and run `docker compose up -d --build` — you don't need Node or
a build step locally either way.

> Want it reachable from your phone over the internet with passkeys? You'll need an HTTPS
> domain — a two-line change in `.env`. See **[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)**.

## Mobile app (no server at all)

The same codebase builds **Gym Plus**, a standalone mobile app (Capacitor, app id
`com.gympulse.app`): no backend — everything stays on the phone, with native workout-day
reminders and share-sheet backups. On top of that, two optional extras that only exist in
the mobile build: **Google sign-in with Drive sync** and the **bring-your-own-key AI coach**.
Self-hosting gets you passkey profiles for friends & family and the server-side AI Coach.

- **Android:** build the APK yourself — **[docs/MOBILE.md](docs/MOBILE.md)**. (The APK on the
  upstream site, opengym.duarte-santos.ch, is the original **openGym** app, not Gym Plus.)
- **iPhone:** build the native app onto your own device from Xcode — see
  **[docs/MOBILE.md](docs/MOBILE.md)** — or self-host and add it to your home screen from Safari.
- **Google sign-in:** needs your own OAuth client ids — **[docs/GOOGLE_SETUP.md](docs/GOOGLE_SETUP.md)**.

## How it works

```
┌─────────────┐        ┌──────────────────────────────┐
│  Your phone │──HTTPS─▶│  web  (nginx)                │
│  / laptop   │        │   ├─ serves the built app    │
└─────────────┘        │   └─ proxies /api ──────────┐│
                       └──────────────────────────────┘│
                                                        ▼
                                        ┌──────────────────────────┐
                                        │  api  (Node + WebAuthn)  │
                                        │   └─ ./data (JSON files) │
                                        └──────────────────────────┘
```

- **frontend/** — React + Vite (React Router + Zustand), built to static files **inside Docker**
- **api/** — Node with no framework, one dependency (`@simplewebauthn/server`), storing everything as plain JSON files under `./data`
- **web/** — a multi-stage image that builds the frontend and serves it with nginx, proxying `/api` to the backend so it's all on **one origin** (passkeys require this)

## Your data

Lives in `./data` on your host: `db.json` (profiles + public passkeys), `state-<user>.json`
(each user's plan, workouts, body weight, settings), and `secret` (the session-cookie key).
**Back up `./data` and you've backed up everything.** Passkey private keys never touch the
server — they stay in your phone's secure hardware / your password manager.

## Configuration

All via `.env` (see `.env.example`):

| Variable      | What it is                                           | Default                 |
|---------------|------------------------------------------------------|-------------------------|
| `RP_ID`       | Hostname passkeys are bound to                       | `localhost`             |
| `ORIGIN`      | Full URL the app is served from                      | `http://localhost:8080` |
| `WEB_PORT`    | Host port for the web UI                             | `8080`                  |
| `RP_NAME`     | Name shown in the passkey prompt                     | `openGym`               |
| `ADMIN_UIDS`  | User ids that get the admin dashboard (comma-separated) | *(none)*             |
| `INVITE_ONLY` | Require an invite code to create a profile           | *(off)*                 |
| `COACH_DISABLED` | Force the AI Coach off, whatever the admin dashboard says | *(unset)*        |

Push notification keys are generated on first run and saved to `./data/vapid.json` — nothing to set.

The **AI Coach** needs no `.env` at all: Claude's Agent SDK and a pinned OpenAI Codex CLI ship
inside the api image. An admin can add a Claude Code setup token or complete Codex's ChatGPT
device-code sign-in in the dashboard. See [the AI Coach guide](docs/AI_COACH.md),
[the self-hosting guide](docs/SELF_HOSTING.md#8-the-ai-coach-optional), and the setup
walkthroughs for [Claude](Claude-setup-instructions.md) and [ChatGPT/Codex](ChatGPT-setup-instructions.md).

## Roadmap

Rough, community-driven — ideas and PRs welcome:

- [x] Standalone mobile app — Android & iOS (Capacitor), built from source ([docs/MOBILE.md](docs/MOBILE.md))
- [x] Optional Google sign-in with sync to your own Google Drive (mobile)
- [x] Bring-your-own-key AI coach: OpenAI, Claude, Gemini, Groq, OpenRouter (mobile)
- [x] Automatic progression programs (linear, Greyskull LP, double progression) with stalls and deloads
- [x] Estimated 1RM per exercise
- [ ] Percentage / training-max programming (5/3/1-style) on top of the progression engine
- [x] AI Coach — plan design and feedback-driven plan reviews, from a CLI agent running on your own server
- [ ] More starter plans (upper/lower, full-body, 5×5)
- [x] Importers from FitNotes / Strong / Hevy (including the RPE they record), and body weight from Apple Health
- [x] Effort per set — RIR or RPE, whichever scale you think in
- [ ] Body measurements (waist, arms…) alongside weight
- [ ] Per-exercise notes & plate calculator
- [ ] Exercise instructions in German & Portuguese (UI is translated; upstream dataset doesn't ship these yet)

## Tech

React 19 + Vite (React Router, Zustand) · Node (no framework) · nginx · Docker Compose ·
WebAuthn · exercise data from [hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset).
No database server, no cloud dependencies — the frontend builds inside Docker, so self-hosting
stays a one-command `docker compose up`.

The training logic — progression rules, 1RM estimation, how a logged session is read back —
lives in pure functions under `frontend/src/lib/` with tests next to them: `npm test` in
`frontend/`. Vitest is a dev dependency; the app itself ships no runtime dependencies beyond
React, the router and Zustand.

## Community (upstream openGym)

These links go to the **upstream openGym** project by Duarte Santos — use them for questions
about the shared tracker core, not for Gym Plus-specific features (Drive sync, BYOK coach).

- **[Q&A](https://github.com/DuarteSantos8/openGym/discussions/categories/q-a)** — self-hosting
  help, passkey/login trouble, "how do I…". Most login problems turn out to be an `RP_ID`/`ORIGIN`
  mismatch.
- **[Ideas](https://github.com/DuarteSantos8/openGym/discussions/categories/ideas)** — features
  worth talking through before anyone writes code.
- **[Show and tell](https://github.com/DuarteSantos8/openGym/discussions/categories/show-and-tell)**
  — your setup, your plan templates, whatever you built on top.
- **[Issues](https://github.com/DuarteSantos8/openGym/issues)** — bugs, and work that's already
  been agreed on.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Good first issues: more starter
plans, exercise-data languages, import from other trackers. **A ⭐ helps more people find it.**

Gym Plus, like openGym, is free and stays free: AGPL, no subscription, no paid tier. If it
replaced a paid tracker for you, consider supporting the upstream
[openGym](https://github.com/DuarteSantos8/openGym) project it is built on — a star, a bug report
or a PR there is worth a lot.

## License

[GNU AGPL v3.0](LICENSE) — free and open source. You can self-host, use, modify and share it;
if you run a modified version as a network service, you must offer that version's source under
the same license. Nobody can turn Gym Plus (or openGym) into a closed, proprietary product.

**Gym Plus is based on openGym by Duarte Santos (AGPL-3.0)** —
<https://github.com/DuarteSantos8/openGym>. Original copyright notices are kept in the source;
the Gym Plus logo is original artwork for this fork.

Exercise images/GIFs are fetched from the upstream dataset and keep their own terms — see [NOTICE.md](NOTICE.md).
