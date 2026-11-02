# Gym Plus — web version: deployment

The web version runs on **your own server with Docker**. People open it in a browser and can
add it to their home screen. Sign-in uses **passkeys** (Face ID / fingerprint) and data lives on
your server in `./data`.

> The Google Drive sync and the bring-your-own-key AI Coach are **only in the Android/iOS app**
> (see `GYMPLUS-ANDROID.md`). The web version has its own server-side Coach (`docs/AI_COACH.md`).

---

## 1. Software you need

| Software | Why |
|---|---|
| **Docker Desktop** (Windows/macOS, with WSL 2 on Windows) or **Docker Engine + Compose** (Linux server) | Builds and runs everything |
| **Git** | Gets and updates the code |
| A **domain name** + **HTTPS** (only for going online) | Passkeys only work over HTTPS on a fixed hostname |
| Node.js 20+ (optional) | Only for running tests or developing; Docker builds without it |

Check: `docker --version` and `docker compose version`.

---

## 2. Try it on your own computer

```powershell
cd D:\Learning\openGym\opengym
copy .env.example .env
notepad .env                      # change RP_NAME=openGym to RP_NAME=Gym Plus, then save
docker compose up -d --build
```

Open **http://localhost:8080** → **Create profile**. The first start downloads the exercise
images (~140 MB) into `./media` once.

> ⚠️ **Always use `--build`, never `docker compose pull`.** The compose file still names the
> upstream images (`ghcr.io/duartesantos8/opengym-*`), so pulling would download the original
> openGym, not Gym Plus.

What runs:

| Container | Job |
|---|---|
| `media` | Downloads exercise images/GIFs into `./media` once, then stops |
| `api` | Node server: passkeys, user data in `./data`, push notifications, server Coach |
| `web` | Builds the app and serves it with nginx on port 8080; forwards `/api` to `api` |

Stop it: `docker compose down`. Logs: `docker compose logs -f api`.

---

## 3. Put it online (your own domain)

1. **Server:** any VPS or home server with Docker. Point a DNS record (e.g. `gym.example.com`)
   at its IP.
2. **Code:** `git clone <your Gym Plus repo> gymplus && cd gymplus`
3. **Settings:** create `.env`:
   ```ini
   RP_ID=gym.example.com
   ORIGIN=https://gym.example.com
   WEB_PORT=8080
   RP_NAME=Gym Plus
   ```
4. **Start:** `docker compose up -d --build`
5. **HTTPS:** put a reverse proxy in front of port 8080. Easiest is **Caddy**, which gets the
   certificate automatically. `Caddyfile`:
   ```caddy
   gym.example.com {
       reverse_proxy localhost:8080
   }
   ```
   Other options: Cloudflare Tunnel (no open ports), Traefik, nginx. See `docs/SELF_HOSTING.md` §3.
6. Open `https://gym.example.com` and create your profile.

**Optional admin and invite-only signup:** register first, find your id in `data/db.json` →
`users[].id`, then add to `.env`:
```ini
ADMIN_UIDS=<your id>
INVITE_ONLY=1
```
and run `docker compose up -d`.

> Don't change `RP_ID` later: existing passkeys are tied to that hostname.

---

## 4. Update and back up

```powershell
git pull
docker compose up -d --build      # new code; ./data is kept
```

**Back up the `./data` folder**: users, passkeys and all training data. `./media` can be
downloaded again.

---

## 5. Optional: static demo (no server)

A browser-only demo with example data (no sign-in, no sync), for GitHub Pages, Netlify, etc.:

```powershell
cd D:\Learning\openGym\opengym\frontend
$env:VITE_DEMO='1'
$env:VITE_IMG_BASE='https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@7455efae41b330c265e7cd4b78dfa848e7ce5ebd/images/'
$env:VITE_GIF_BASE='https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@7455efae41b330c265e7cd4b78dfa848e7ce5ebd/videos/'
npm run build                     # upload the contents of frontend\dist
Remove-Item Env:VITE_DEMO, Env:VITE_IMG_BASE, Env:VITE_GIF_BASE
```

> If you just ran `npm run build:mobile`, `frontend\dist` holds the mobile build. Rebuild before
> uploading.

---

## 6. Problems

| What you see | Fix |
|---|---|
| Passkey "verification failed" | `RP_ID`/`ORIGIN` in `.env` must match the address bar exactly → fix → `docker compose up -d` |
| Page says openGym, not Gym Plus | You pulled upstream images → `docker compose up -d --build` |
| Port 8080 already used | `WEB_PORT=9090` in `.env` (and update `ORIGIN` when testing locally) |
| Passkeys don't work on the phone | Needs HTTPS on a real domain; `localhost` only works on the same computer |
