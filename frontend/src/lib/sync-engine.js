// Gym Plus cloud sync orchestration (mobile build only — the store loads this file through a
// dynamic import behind MOBILE, so it never ships in a web bundle).
//
// Local-first: the phone's copy is always the one the app works on; Google Drive is a mirror
// that is merged into (lib/sync.js) and written back. Everything that talks to Google or to the
// store is injected, so the whole flow is unit-tested with fakes (sync-engine.test.js).
//
//   signIn()            interactive sign-in, then the first sync:
//                         cloud empty → upload local · local empty → adopt cloud ·
//                         both have data → same account as last time ? merge silently
//                                                                     : ask (firstSync)
//   resolveFirstSync(c) 'merge' | 'cloud' | 'local'  (anything else = cancel → sign out, keep local)
//   notifyChange()      after every local edit: mark dirty, debounced sync
//   sync()              cloudVersion → (changed? read + merge + apply locally) → write if needed
//   flush()             run a pending debounced sync now (app → background)
//   signOut({keepLocal}) flush, sign out, forget account/meta, optionally wipe local
//   deleteCloudCopy()   delete the Drive file, then stop syncing (signed out, local data kept)
//
// Storage keys: 'gp_account' {email,name,photo} · 'gp_sync_meta' {fileId,version,email,lastAt}
// · 'gp_sync_dirty' '1' when local has edits the cloud has not seen.

import { mergeStates, hasData as defaultHasData } from './sync.js'

export const ACCOUNT_KEY = 'gp_account'
export const META_KEY = 'gp_sync_meta'
export const DIRTY_KEY = 'gp_sync_dirty'

const clone = o => (o == null ? o : JSON.parse(JSON.stringify(o)))

// Content comparison independent of key order, ignoring _ts and active.
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
  }
  return JSON.stringify(v)
}
const contentOf = s => {
  const { _ts, active, _del, ...rest } = s
  const del = {}
  for (const [k, v] of Object.entries(_del || {})) if (v && Object.keys(v).length) del[k] = v
  if (Object.keys(del).length) rest._del = del
  return stable(rest)
}
export const sameContent = (a, b) => (!a || !b ? a === b : contentOf(a) === contentOf(b))

export function createSyncEngine(deps) {
  const {
    auth,                       // { googleSignIn, googleSignOut, getAccessToken }
    drive,                      // { readCloudState, writeCloudState, cloudVersion, deleteCloudState }
    storage = globalThis.localStorage,
    getState,                   // () => current S
    applyState,                 // (S) => persist locally, keeping S._ts, WITHOUT triggering a push
    resetLocal = () => {},      // () => wipe local S back to defaults (sign-out without keepLocal)
    normalize = s => s,         // overlay a loaded state on DEF
    setSync = () => {},         // (partial {state,lastAt,error}) => void
    setAccount = () => {},
    setFirstSync = () => {},
    hasData = defaultHasData,
    merge = mergeStates,
    now = () => Date.now(),
    isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
    debounceMs = 2000,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = id => clearTimeout(id),
  } = deps

  const read = k => { try { return JSON.parse(storage.getItem(k)) } catch { return null } }
  const write = (k, v) => { try { if (v == null) storage.removeItem(k); else storage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)) } catch { /* */ } }

  let account = read(ACCOUNT_KEY)
  let meta = read(META_KEY)
  let pendingCloud = null       // the cloud copy waiting on resolveFirstSync
  let timer = null
  let running = null            // the sync in flight
  let again = false
  let editSeq = 0

  const isDirty = () => { try { return storage.getItem(DIRTY_KEY) === '1' } catch { return false } }
  const setDirty = v => write(DIRTY_KEY, v ? '1' : null)
  const saveMeta = m => { meta = m; write(META_KEY, m) }
  const saveAccount = a => { account = a; write(ACCOUNT_KEY, a); setAccount(a) }

  const status = (state, extra = {}) => setSync({ state, error: null, ...extra })
  const fail = e => {
    const code = e?.code
    if (code === 'auth') status('auth', { error: 'auth' })
    else if (code === 'offline' || code === 'network') status('offline')
    else status('error', { error: String(e?.message || code || e) })
    return code || 'failed'
  }

  const remember = (res, email) => {
    const at = now()
    saveMeta({ fileId: res.fileId, version: res.version, email, lastAt: at })
    status('synced', { lastAt: at })
  }

  const adopt = remote => {
    const next = normalize(clone(remote))
    next.active = getState()?.active ?? null
    applyState(next)
  }

  async function upload(token, state, fileId) {
    const seq = editSeq
    const res = await drive.writeCloudState(token, state, { fileId })
    if (seq === editSeq) setDirty(false)
    remember(res, account?.email)
    return res
  }

  async function runSync() {
    if (!account || pendingCloud) return
    if (!isOnline()) { status('offline'); return }
    status('syncing', { lastAt: meta?.lastAt ?? null })
    const token = await auth.getAccessToken()
    const v = await drive.cloudVersion(token)
    const remoteChanged = !!v && (!meta || v.version !== meta.version || v.fileId !== meta.fileId)
    let needWrite = isDirty() || !v
    if (remoteChanged) {
      const cloud = await drive.readCloudState(token)
      if (cloud && cloud.state) {
        const local = getState()                       // no await between here and applyState
        const remote = normalize(clone(cloud.state))
        const merged = merge(local, remote)
        if (!sameContent(merged, local)) applyState(merged)
        if (!sameContent(merged, remote)) needWrite = true
        if (!needWrite) { remember(cloud, account.email); return }
        await upload(token, getState(), cloud.fileId)
        return
      }
      needWrite = true
    }
    if (needWrite) await upload(token, getState(), (v || meta)?.fileId)
    else remember(v, account.email)
  }

  function sync() {
    if (running) { again = true; return running }
    running = (async () => {
      try {
        do {
          again = false
          try { await runSync() } catch (e) {
            // Drive rejected the cached token (revoked/expired early): drop it and retry once
            // with a freshly refreshed one before telling the user to sign in again.
            if (e?.code !== 'auth' || typeof auth.invalidateAccessToken !== 'function') throw e
            auth.invalidateAccessToken()
            await runSync()
          }
        } while (again)
        return true
      } catch (e) { fail(e); return false }
      finally { running = null }
    })()
    return running
  }

  function notifyChange() {
    if (!account || pendingCloud) return
    editSeq++
    setDirty(true)
    if (timer) clearTimer(timer)
    timer = setTimer(() => { timer = null; sync() }, debounceMs)
  }

  async function flush() {
    if (timer) { clearTimer(timer); timer = null; return sync() }
    if (running) return running
    if (account && isDirty()) return sync()
  }

  async function signIn() {
    const profile = await auth.googleSignIn()
    const prevEmail = meta?.email || null
    saveAccount({ email: profile.email, name: profile.name || '', photo: profile.photo || '' })
    status('syncing')
    try {
      const token = await auth.getAccessToken()
      const cloud = await drive.readCloudState(token)
      const local = getState()
      if (!cloud || !cloud.state || !hasData(cloud.state)) {
        await upload(token, local, cloud?.fileId)
        return 'uploaded'
      }
      if (!hasData(local)) {
        adopt(cloud.state)
        setDirty(false)
        remember(cloud, profile.email)
        return 'adopted'
      }
      if (prevEmail && prevEmail === profile.email) {
        // Same Google account as last time on this phone (e.g. signing in again after the
        // token expired): just carry on syncing.
        saveMeta({ ...(meta || {}), fileId: meta?.fileId || cloud.fileId, email: profile.email })
        setDirty(true)
        await sync()
        return 'merged'
      }
      pendingCloud = cloud
      // Not persisted until the choice is made: if the app is killed meanwhile, the next launch
      // must not find an account and start merging without having asked.
      write(ACCOUNT_KEY, null)
      setFirstSync({ local: clone(local), remote: normalize(clone(cloud.state)) })
      status('syncing')
      return 'choose'
    } catch (e) {
      // The first sync never happened, so we can't know which side is which yet — don't stay
      // half signed in (a later background sync would merge without asking). Caller shows e.
      // Re-signing in to the account this phone already syncs with is the exception: stay.
      if (prevEmail && prevEmail === profile.email) fail(e)
      else forget()
      throw e
    }
  }

  async function resolveFirstSync(choice) {
    const cloud = pendingCloud
    if (!cloud) return
    pendingCloud = null
    setFirstSync(null)
    if (choice !== 'merge' && choice !== 'cloud' && choice !== 'local') {
      // Cancelled: nothing was merged — stay local-only, and don't push anything.
      try { await auth.googleSignOut() } catch { /* */ }
      forget()
      return 'cancelled'
    }
    saveAccount(account)
    try {
      if (choice === 'cloud') {
        adopt(cloud.state)
        setDirty(false)
        remember(cloud, account.email)
        return choice
      }
      if (choice === 'merge') applyState(merge(getState(), normalize(clone(cloud.state))))
      const token = await auth.getAccessToken()
      setDirty(true)
      await upload(token, getState(), cloud.fileId)
      return choice
    } catch (e) {
      // Local already holds the result; the next sync() writes it (dirty stays set). Remember
      // the version we decided against so that sync() doesn't merge the old cloud copy back in
      // after a 'local' choice.
      saveMeta({ fileId: cloud.fileId, version: cloud.version, email: account?.email, lastAt: meta?.lastAt ?? null })
      setDirty(true)
      fail(e)
      return choice
    }
  }

  function forget() {
    if (timer) { clearTimer(timer); timer = null }
    pendingCloud = null
    setFirstSync(null)
    saveAccount(null)
    saveMeta(null)
    setDirty(false)
    setSync({ state: 'off', lastAt: null, error: null })
  }

  async function signOut({ keepLocal = true } = {}) {
    if (account && !pendingCloud) { try { await flush() } catch { /* offline — nothing more to do */ } }
    try { await auth.googleSignOut() } catch { /* */ }
    forget()
    if (!keepLocal) resetLocal()
  }

  // Choice: deleting the cloud copy also stops syncing (signed out, local data kept). Staying
  // signed in would immediately upload the data again on the next edit, which is not what
  // "delete my cloud copy" means.
  async function deleteCloudCopy() {
    if (timer) { clearTimer(timer); timer = null }
    if (running) { try { await running } catch { /* */ } }
    const token = await auth.getAccessToken({ interactive: true })
    await drive.deleteCloudState(token)
    try { await auth.googleSignOut() } catch { /* */ }
    forget()
  }

  // Boot: restore status, then pull+merge in the background (never blocks the app opening).
  function start() {
    if (!account) { setSync({ state: 'off', lastAt: null, error: null }); return }
    setAccount(account)
    setSync({ state: 'synced', lastAt: meta?.lastAt ?? null, error: null })
    return sync()
  }

  function onOnline() {
    if (account && !pendingCloud) return sync()
  }

  return {
    start, signIn, resolveFirstSync, sync, notifyChange, flush, signOut, deleteCloudCopy, onOnline,
    get account() { return account },
    get meta() { return meta },
    get pending() { return !!pendingCloud },
    isDirty,
  }
}
