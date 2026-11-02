import { create } from 'zustand'
import { api } from '../lib/api.js'
import { localTZ } from '../lib/format.js'
import { registerCustom } from '../lib/exercises.js'
import { DEMO, DEMO_SEEDED } from '../lib/demo.js'
import { MOBILE, nativeLoad, nativeSave, syncReminder } from '../lib/mobile.js'
import { hasData, stampChanges } from '../lib/sync.js'

const KEY = 'gym_state_v1'
export const DEF = {
  unit: 'kg', restSec: 90, sound: true, keepAwake: true, lang: 'en',
  theme: 'dark', accent: 'lime', body: 'male', targetW: null,
  bodyweight: [], routines: [], week: {}, dayPlan: {},
  exWeights: {}, workouts: [], active: null, customEx: [], gifSize: 'full',
  // effort: which per-set effort scale is logged — 'none' | 'rir' | 'rpe'. null, not 'none', so
  // that a profile which never chose (loaded state is overlaid on DEF, on every path: local,
  // server pull, backup import) still falls back to the `showRir` boolean this replaced and
  // keeps the column it had. See effortOf.
  reminder: { on: false, time: '08:00', tz: null }, effort: null,
  // AI Coach (issue: AI enablement). null until the profile opts in — a null namespace is the
  // same app it was before the feature existed, which is what Epic F asks for. Shape and
  // bounds live in lib/coach.js.
  coach: null
}
const clone = o => JSON.parse(JSON.stringify(o))

function loadState() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return Object.assign(clone(DEF), JSON.parse(raw))
  } catch (e) { /* ignore */ }
  return clone(DEF)
}

const readJSON = k => { try { return JSON.parse(localStorage.getItem(k)) || null } catch { return null } }

export const useStore = create((set, get) => {
  let pushTm = null
  let saveTm = null

  // Gym Plus Google Drive sync (mobile only). The engine and the Google/Drive modules are loaded
  // lazily behind MOBILE, so none of it reaches a web bundle. See lib/sync-engine.js.
  let engineP = null
  let engineRef = null
  const engine = () => {
    if (!MOBILE) return Promise.reject(new Error('sync is mobile-only'))
    if (!engineP) {
      engineP = Promise.all([
        import('../lib/sync-engine.js'), import('../lib/google-auth.js'), import('../lib/gdrive.js'),
      ]).then(([eng, auth, drive]) => {
        engineRef = eng.createSyncEngine({
          auth, drive,
          getState: () => get().S,
          applyState: S => persist(clone(S), false, true),
          resetLocal: () => persist(clone(DEF), false),
          normalize: s => Object.assign(clone(DEF), s),
          setSync: p => set({ sync: { ...get().sync, ...p } }),
          setAccount: account => set({ account }),
          setFirstSync: firstSync => set({ firstSync }),
        })
        return engineRef
      })
      engineP.catch(() => { engineP = null })
    }
    return engineP
  }

  // Mobile build: mirror the state into a file in the app's data directory (survives WebView
  // storage eviction) and keep the native reminder schedule in step with the weekly plan.
  const nativePersist = () => {
    clearTimeout(saveTm)
    saveTm = setTimeout(() => { saveTm = null; nativeSave(get().S); syncReminder(get().S) }, 800)
  }

  // keepTs: a merged cloud state is applied with its own _ts (the newer of both sides), so
  // applying it doesn't by itself make this phone's copy look newer than the cloud's.
  const persist = (S, push = true, keepTs = false) => {
    if (!keepTs || !S._ts) S._ts = Date.now()
    registerCustom(S.customEx)
    localStorage.setItem(KEY, JSON.stringify(S))
    set({ S })
    if (MOBILE) nativePersist()
    if (push && get().user) {
      clearTimeout(pushTm)
      pushTm = setTimeout(() => get().pushState(), 1500)
    }
    if (MOBILE && push && get().account) engine().then(e => e.notifyChange()).catch(() => {})
  }

  // A setting changed right before switching away/closing the tab must not get lost mid-debounce
  // (e.g. setting the reminder time then immediately backgrounding to test it). On mobile the
  // same applies to the file mirror — backgrounding is often the last thing before the OS
  // kills the app.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return
    if (MOBILE && saveTm) {
      clearTimeout(saveTm)
      saveTm = null
      nativeSave(get().S)
    }
    if (pushTm) {
      clearTimeout(pushTm)
      pushTm = null
      get().pushState()
    }
    if (MOBILE && engineRef) engineRef.flush().catch(() => {})
  })

  // Mobile boot: pull+merge in the background if a Google account is connected, sync again
  // whenever the app comes back to the foreground, flush when it goes to the background, and
  // retry when the network returns. Listeners are attached once, even when signed out, so a
  // later sign-in is covered too (each handler is a no-op without an account).
  let lifecycle = false
  const startCloudSync = () => {
    if (!MOBILE || lifecycle) return
    lifecycle = true
    window.addEventListener('online', () => {
      if (get().account) engine().then(e => e.onOnline()).catch(() => {})
    })
    import('@capacitor/app').then(({ App }) => App.addListener('appStateChange', ({ isActive }) => {
      if (!get().account) return
      engine().then(e => (isActive ? e.sync() : e.flush())).catch(() => {})
    })).catch(() => {})
    if (get().account) engine().then(e => e.start()).catch(() => {})
  }

  // Everything a sign-out leaves behind on this device, whichever way it was triggered.
  const clearLocalSession = () => {
    get().setUser(null)
    localStorage.removeItem('gym_guest')
    localStorage.removeItem('gym_dirty')
    localStorage.removeItem(KEY)
    persist(clone(DEF), false)
  }

  return {
    S: (() => { const s = loadState(); registerCustom(s.customEx); return s })(),
    user: (() => { try { return JSON.parse(localStorage.getItem('gym_user')) || null } catch { return null } })(),
    ready: false,
    // Instance capabilities from GET /api/config. `config.coach` is present only when the
    // owner has both enabled the Coach and connected a provider — every Coach entry point in
    // the app hangs off it, so an unconfigured instance renders exactly what it always did.
    config: null,

    // Gym Plus (mobile) Google account + Drive sync. Contract: GYMPLUS_TRACKER.md "Store additions".
    account: MOBILE ? readJSON('gp_account') : null,
    sync: MOBILE && readJSON('gp_account')
      ? { state: 'synced', lastAt: readJSON('gp_sync_meta')?.lastAt ?? null, error: null }
      : { state: 'off', lastAt: null, error: null },
    firstSync: null,

    // Mutate a draft of S via producer fn, then persist + schedule sync.
    // Mobile: every add/edit/delete in the four synced collections is stamped/tombstoned here
    // (lib/sync.js stampChanges), so the Drive merge can tell edits and deletions apart.
    update(mut, push = true) {
      const S = clone(get().S)
      mut(S)
      if (MOBILE) stampChanges(get().S, S)
      persist(S, push)
    },
    replaceState(S, push = false) {
      const next = clone(S)
      // push=true means a user action (backup import, "reset everything") — record it as edits
      // and deletions so the next Drive merge doesn't bring the old data back.
      if (MOBILE && push) stampChanges(get().S, next)
      persist(next, push)
    },

    async googleSignIn() { if (MOBILE) return (await engine()).signIn() },
    async googleSignOut({ keepLocal = true } = {}) { if (MOBILE) return (await engine()).signOut({ keepLocal }) },
    async syncNow() { if (MOBILE && get().account) return (await engine()).sync() },
    async resolveFirstSync(choice) { if (MOBILE) return (await engine()).resolveFirstSync(choice) },
    async deleteCloudCopy() { if (MOBILE) return (await engine()).deleteCloudCopy() },

    isGuest: () => localStorage.getItem('gym_guest') === '1',
    setGuest(v) { if (v) localStorage.setItem('gym_guest', '1'); else localStorage.removeItem('gym_guest'); set({}) },

    setUser(u) {
      if (u) { localStorage.setItem('gym_user', JSON.stringify(u)); localStorage.removeItem('gym_guest') }
      else localStorage.removeItem('gym_user')
      set({ user: u })
    },

    async pushState() {
      if (!get().user) return
      clearTimeout(pushTm)
      try { await api('/api/data', { method: 'PUT', body: JSON.stringify({ state: get().S }) }); localStorage.removeItem('gym_dirty') }
      catch (e) { localStorage.setItem('gym_dirty', '1') }
    },
    async pullState() {
      try {
        const { state } = await api('/api/data')
        const S = get().S
        const dirty = localStorage.getItem('gym_dirty') === '1'
        if (state && (!hasData(S) || ((state._ts || 0) >= (S._ts || 0) && !dirty))) {
          const active = S.active
          const next = Object.assign(clone(DEF), state)
          if (active) next.active = active
          persist(next, false)
        } else if (hasData(S)) { await get().pushState() }
      } catch (e) { /* offline — keep local */ }
    },

    async signOut() {
      try { await get().pushState(); await api('/api/logout', { method: 'POST', body: '{}' }) } catch (e) { /* */ }
      clearLocalSession()
    },

    // "Sign out everywhere": the server bumps this profile's session version, which kills every
    // session it has on any device — this browser included, so the app has to end up exactly
    // where a normal signOut leaves it. Unlike signOut the request is NOT swallowed: if it fails
    // the sessions elsewhere are all still valid, and wiping this device's copy of the data
    // would sign the user out of the one place the bump didn't reach. Caller reports the error.
    async signOutAll() {
      await get().pushState()   // never throws — stores gym_dirty and moves on when offline
      await api('/api/logout/all', { method: 'POST', body: '{}' })
      clearLocalSession()
    },

    // Demo build only: drop the seeded example profile back in (Settings → "Reset demo data").
    // Dynamic import so the generator never ships in a self-hosted bundle.
    async resetDemo() {
      const { buildDemoState } = await import('../lib/demoSeed.js')
      localStorage.removeItem('gym_dirty')
      persist(Object.assign(clone(DEF), buildDemoState()), false)
    },

    // Boot: ask the server who we are, then pull.
    async boot() {
      // Mobile build: no backend either — restore from the file mirror (the durable copy;
      // localStorage may have been evicted since the last run) and go straight in.
      if (MOBILE) {
        const saved = await nativeLoad()
        const S = get().S
        if (saved && (!hasData(S) || (saved._ts || 0) >= (S._ts || 0))) {
          // keepTs: restoring the file mirror is not an edit — a fresh _ts would make this
          // phone's settings look newer than the Drive copy's on every launch.
          persist(Object.assign(clone(DEF), saved), false, true)
        } else if (hasData(S)) {
          nativeSave(S)   // first run after an update from a file-less version: seed the mirror
        }
        get().setGuest(true)
        syncReminder(get().S)
        set({ ready: true })
        startCloudSync()   // not awaited — the app opens instantly, offline or not
        return
      }
      // Demo build (GitHub Pages): no backend at all — seed once, stay in guest mode.
      if (DEMO) {
        if (!localStorage.getItem(DEMO_SEEDED)) {
          localStorage.setItem(DEMO_SEEDED, '1')
          await get().resetDemo()
        }
        get().setGuest(true)
        set({ ready: true })
        return
      }
      // Instance capabilities are public and needed whether or not anyone is signed in.
      try { set({ config: await api('/api/config') }) } catch (e) { /* offline — assume nothing extra */ }
      try {
        const me = await api('/api/me')
        get().setUser(me.user)
        await get().pullState()
        // Re-stamp the reminder's timezone on every load — keeps it correct if you're travelling,
        // without needing to revisit Settings.
        const tz = localTZ()
        if (get().S.reminder?.on && get().S.reminder.tz !== tz) {
          get().update(s => { s.reminder = { ...s.reminder, tz } })
        }
      } catch (e) {
        if (e.status === 401) get().setUser(null)
      }
      set({ ready: true })
    }
  }
})

export { hasData }
