# Gym Plus website

Source of the project website — plain hand-written HTML/CSS/JS, no build step,
served by nginx.

Gym Plus is based on [openGym](https://github.com/DuarteSantos8/openGym) by Duarte Santos
(AGPL-3.0); this site was adapted from the openGym website. Links marked "upstream" point at
the original openGym project.

Not in this folder (added at deploy time):

- `img/` — the five screenshots from `../assets/screenshots/`
- `icon-180.png` / `icon-512.png` — copied from `../frontend/public/` (the same
  icons the PWA uses, so the browser tab, home screen and app all match)

No APK is linked yet — the download card points to the build guide until Gym Plus
release builds are published (see `../docs/MOBILE.md`).

`site.js` fetches the star/fork counts of the **upstream** openGym repository from the public
GitHub API at view time (labelled as upstream on the page).
