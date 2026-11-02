import { describe, it, expect, beforeEach } from 'vitest'
import { createSyncEngine, sameContent, ACCOUNT_KEY, META_KEY, DIRTY_KEY } from './sync-engine.js'

const S = (over = {}) => ({ unit: 'kg', workouts: [], routines: [], customEx: [], bodyweight: [], exWeights: {}, active: null, coach: null, _ts: 1000, ...over })
const W = (id, m) => ({ id, d: '2026-01-0' + id.length, start: 1, end: 2, _m: m })

function memStorage(init = {}) {
  const m = new Map(Object.entries(init))
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m }
}

// A fake Drive holding one file, with a version counter like the real one.
function fakeDrive(initial = null) {
  const d = {
    file: initial ? { state: JSON.parse(JSON.stringify(initial)), fileId: 'f1', version: '1' } : null,
    offline: false, authFail: false, writes: 0, reads: 0, deleted: false,
    check() {
      if (d.offline) throw { code: 'offline' }
      if (d.authFail) throw { code: 'auth' }
    },
    async readCloudState() { d.check(); d.reads++; return d.file ? JSON.parse(JSON.stringify(d.file)) : null },
    async cloudVersion() { d.check(); return d.file ? { fileId: d.file.fileId, version: d.file.version } : null },
    async writeCloudState(token, state, { fileId } = {}) {
      d.check(); d.writes++
      const v = String(Number(d.file?.version || 0) + 1)
      d.file = { state: JSON.parse(JSON.stringify(state)), fileId: fileId || d.file?.fileId || 'f1', version: v }
      return { fileId: d.file.fileId, version: v }
    },
    async deleteCloudState() { d.check(); d.file = null; d.deleted = true },
    // another device writes
    external(state) { d.file = { state, fileId: d.file?.fileId || 'f1', version: String(Number(d.file?.version || 0) + 1) } },
  }
  return d
}

function fakeAuth(email = 'a@x.com') {
  const a = {
    email, signedOut: false, tokenFail: false,
    async googleSignIn() { a.signedOut = false; return { email: a.email, name: 'N', photo: '' } },
    async googleSignOut() { a.signedOut = true },
    async getAccessToken() { if (a.tokenFail) throw { code: 'auth' }; return 'tok' },
  }
  return a
}

function setup({ local = S(), cloud = null, storage = memStorage(), email } = {}) {
  const ctx = { state: local, sync: { state: 'off' }, firstSync: null, account: null, applied: 0, timers: [] }
  ctx.drive = fakeDrive(cloud)
  ctx.auth = fakeAuth(email)
  ctx.storage = storage
  ctx.online = true
  ctx.engine = createSyncEngine({
    auth: ctx.auth, drive: ctx.drive, storage,
    getState: () => ctx.state,
    applyState: s => { ctx.state = s; ctx.applied++ },
    resetLocal: () => { ctx.state = S({ _ts: 0 }) },
    setSync: p => { ctx.sync = { ...ctx.sync, ...p } },
    setAccount: a => { ctx.account = a },
    setFirstSync: f => { ctx.firstSync = f },
    isOnline: () => ctx.online,
    now: () => 4242,
    setTimer: (fn) => { ctx.timers.push(fn); return ctx.timers.length },
    clearTimer: id => { ctx.timers[id - 1] = null },
  })
  ctx.fire = async () => { const fns = ctx.timers.filter(Boolean); ctx.timers = []; for (const f of fns) await f(); await ctx.engine.flush() }
  // simulate a local edit (what store.update + persist do)
  ctx.edit = fn => { const s = JSON.parse(JSON.stringify(ctx.state)); fn(s); s._ts = (ctx.state._ts || 0) + 1; ctx.state = s; ctx.engine.notifyChange() }
  return ctx
}

describe('sameContent', () => {
  it('ignores key order, _ts and active', () => {
    expect(sameContent({ a: 1, b: { c: 2, d: 3 }, _ts: 1, active: { x: 1 } }, { b: { d: 3, c: 2 }, a: 1, _ts: 9 })).toBe(true)
    expect(sameContent({ a: 1 }, { a: 2 })).toBe(false)
  })
})

describe('first sign-in', () => {
  it('cloud empty → uploads local', async () => {
    const c = setup({ local: S({ workouts: [W('a', 1)] }) })
    expect(await c.engine.signIn()).toBe('uploaded')
    expect(c.drive.file.state.workouts.map(w => w.id)).toEqual(['a'])
    expect(c.sync.state).toBe('synced')
    expect(c.sync.lastAt).toBe(4242)
    expect(JSON.parse(c.storage.getItem(ACCOUNT_KEY)).email).toBe('a@x.com')
    expect(JSON.parse(c.storage.getItem(META_KEY))).toMatchObject({ fileId: 'f1', version: '1', email: 'a@x.com' })
    expect(c.account.email).toBe('a@x.com')
  })

  it('local empty → adopts cloud, keeps local active', async () => {
    const c = setup({ local: S({ active: { id: 'run' } }), cloud: S({ workouts: [W('b', 1)], unit: 'lb', active: { id: 'other' } }) })
    expect(await c.engine.signIn()).toBe('adopted')
    expect(c.state.workouts.map(w => w.id)).toEqual(['b'])
    expect(c.state.unit).toBe('lb')
    expect(c.state.active).toEqual({ id: 'run' })
    expect(c.drive.writes).toBe(0)
    expect(c.sync.state).toBe('synced')
  })

  it('both have data → asks, then merge / cloud / local', async () => {
    for (const choice of ['merge', 'cloud', 'local']) {
      const c = setup({ local: S({ workouts: [W('a', 1)] }), cloud: S({ workouts: [W('bb', 1)] }) })
      expect(await c.engine.signIn()).toBe('choose')
      expect(c.storage.getItem(ACCOUNT_KEY)).toBe(null)   // killed now → no silent merge on next launch
      expect(c.firstSync.local.workouts.map(w => w.id)).toEqual(['a'])
      expect(c.firstSync.remote.workouts.map(w => w.id)).toEqual(['bb'])
      // edits while the choice is open do not push
      c.engine.notifyChange()
      expect(c.timers).toHaveLength(0)
      expect(await c.engine.resolveFirstSync(choice)).toBe(choice)
      expect(c.firstSync).toBe(null)
      const want = { merge: ['a', 'bb'], cloud: ['bb'], local: ['a'] }[choice]
      expect(c.state.workouts.map(w => w.id)).toEqual(want)
      expect(c.drive.file.state.workouts.map(w => w.id)).toEqual(want)
      expect(c.sync.state).toBe('synced')
      expect(c.storage.getItem(DIRTY_KEY)).toBe(null)
      expect(JSON.parse(c.storage.getItem(ACCOUNT_KEY)).email).toBe('a@x.com')
    }
  })

  it('cancelling the choice signs out and changes nothing', async () => {
    const c = setup({ local: S({ workouts: [W('a', 1)] }), cloud: S({ workouts: [W('bb', 1)] }) })
    await c.engine.signIn()
    expect(await c.engine.resolveFirstSync(null)).toBe('cancelled')
    expect(c.account).toBe(null)
    expect(c.auth.signedOut).toBe(true)
    expect(c.drive.writes).toBe(0)
    expect(c.state.workouts.map(w => w.id)).toEqual(['a'])
  })

  it('a failed first sign-in does not leave a half-signed-in account', async () => {
    const c = setup({ local: S({ workouts: [W('a', 1)] }) })
    c.drive.offline = true
    await expect(c.engine.signIn()).rejects.toMatchObject({ code: 'offline' })
    expect(c.account).toBe(null)
    expect(c.storage.getItem(ACCOUNT_KEY)).toBe(null)
  })
})

describe('account switch', () => {
  it('a different account with data on both sides goes through the choice', async () => {
    const storage = memStorage({ [META_KEY]: JSON.stringify({ fileId: 'old', version: '7', email: 'a@x.com' }), [ACCOUNT_KEY]: JSON.stringify({ email: 'a@x.com' }) })
    const c = setup({ local: S({ workouts: [W('a', 1)] }), cloud: S({ workouts: [W('bb', 1)] }), storage, email: 'b@x.com' })
    expect(await c.engine.signIn()).toBe('choose')
  })

  it('the same account again merges silently', async () => {
    const storage = memStorage({ [META_KEY]: JSON.stringify({ fileId: 'f1', version: '0', email: 'a@x.com' }) })
    const c = setup({ local: S({ workouts: [W('a', 1)] }), cloud: S({ workouts: [W('bb', 1)] }), storage })
    expect(await c.engine.signIn()).toBe('merged')
    expect(c.firstSync).toBe(null)
    expect(c.state.workouts.map(w => w.id)).toEqual(['a', 'bb'])
    expect(c.drive.file.state.workouts.map(w => w.id)).toEqual(['a', 'bb'])
  })
})

describe('ongoing sync', () => {
  async function signedIn(over) {
    const c = setup({ local: S({ workouts: [W('a', 1)] }), ...over })
    await c.engine.signIn()
    return c
  }

  it('debounced push after a local edit', async () => {
    const c = await signedIn()
    c.edit(s => s.workouts.push(W('cc', 5)))
    expect(c.storage.getItem(DIRTY_KEY)).toBe('1')
    expect(c.timers).toHaveLength(1)
    c.edit(s => s.unit = 'lb')
    await c.fire()
    expect(c.drive.writes).toBe(2)   // initial upload + one debounced push
    expect(c.drive.file.state.unit).toBe('lb')
    expect(c.storage.getItem(DIRTY_KEY)).toBe(null)
  })

  it('conflict: cloud changed since last sync → merge before write, applied locally', async () => {
    const c = await signedIn()
    c.drive.external(S({ workouts: [W('a', 1), W('zzz', 9)], _ts: 500 }))
    c.edit(s => s.workouts.push(W('cc', 5)))
    await c.fire()
    expect(c.state.workouts.map(w => w.id).sort()).toEqual(['a', 'cc', 'zzz'])
    expect(c.drive.file.state.workouts.map(w => w.id).sort()).toEqual(['a', 'cc', 'zzz'])
    expect(c.sync.state).toBe('synced')
  })

  it('pull on resume adopts remote changes without writing back an identical copy', async () => {
    const c = await signedIn()
    const writes = c.drive.writes
    c.drive.external(S({ workouts: [W('a', 1), W('zzz', 9)], _ts: 5000 }))
    await c.engine.sync()
    expect(c.state.workouts.map(w => w.id)).toEqual(['a', 'zzz'])
    expect(c.drive.writes).toBe(writes)
    // nothing changed anywhere → no read, no write
    const reads = c.drive.reads
    await c.engine.sync()
    expect(c.drive.reads).toBe(reads)
    expect(c.drive.writes).toBe(writes)
  })

  it('offline → dirty stays, retry on online', async () => {
    const c = await signedIn()
    c.drive.offline = true
    c.edit(s => s.workouts.push(W('cc', 5)))
    await c.fire()
    expect(c.sync.state).toBe('offline')
    expect(c.storage.getItem(DIRTY_KEY)).toBe('1')
    c.drive.offline = false
    await c.engine.onOnline()
    expect(c.sync.state).toBe('synced')
    expect(c.drive.file.state.workouts.map(w => w.id)).toEqual(['a', 'cc'])
    expect(c.storage.getItem(DIRTY_KEY)).toBe(null)
  })

  it('navigator offline short-circuits to offline status', async () => {
    const c = await signedIn()
    c.online = false
    c.edit(s => s.unit = 'lb')
    await c.fire()
    expect(c.sync.state).toBe('offline')
  })

  it('token refresh failure → auth status, data kept dirty', async () => {
    const c = await signedIn()
    c.auth.tokenFail = true
    c.edit(s => s.unit = 'lb')
    await c.fire()
    expect(c.sync.state).toBe('auth')
    expect(c.storage.getItem(DIRTY_KEY)).toBe('1')
  })

  it('a Drive auth error with a stale token is retried once after invalidating it', async () => {
    const c = await signedIn()
    let fails = 1
    c.auth.invalidateAccessToken = () => { c.invalidated = true }
    const orig = c.drive.cloudVersion
    c.drive.cloudVersion = async t => { if (fails-- > 0) throw { code: 'auth' }; return orig(t) }
    c.edit(s => s.unit = 'lb')
    await c.fire()
    expect(c.invalidated).toBe(true)
    expect(c.sync.state).toBe('synced')
    expect(c.drive.file.state.unit).toBe('lb')
  })

  it('network failure while refreshing the token → offline', async () => {
    const c = await signedIn()
    c.auth.getAccessToken = async () => { throw { code: 'network' } }
    c.edit(s => s.unit = 'lb')
    await c.fire()
    expect(c.sync.state).toBe('offline')
  })

  it('other errors → error status', async () => {
    const c = await signedIn()
    c.drive.writeCloudState = async () => { throw { code: 'failed', status: 500 } }
    c.edit(s => s.unit = 'lb')
    await c.fire()
    expect(c.sync.state).toBe('error')
  })

  it('flush runs a pending push immediately', async () => {
    const c = await signedIn()
    c.edit(s => s.unit = 'lb')
    await c.engine.flush()
    expect(c.drive.file.state.unit).toBe('lb')
  })

  it('start() after a restart restores the account and syncs', async () => {
    const c = await signedIn()
    const c2 = setup({ local: c.state, storage: c.storage })
    c2.drive.file = c.drive.file
    c2.drive.external(S({ workouts: [W('a', 1), W('q', 3)], _ts: 9000 }))
    await c2.engine.start()
    expect(c2.account.email).toBe('a@x.com')
    expect(c2.state.workouts.map(w => w.id)).toEqual(['a', 'q'])
  })

  it('not signed in → notifyChange and start do nothing', async () => {
    const c = setup()
    c.engine.notifyChange()
    expect(c.timers).toHaveLength(0)
    c.engine.start()
    expect(c.sync.state).toBe('off')
  })
})

describe('sign out / delete cloud copy', () => {
  it('signOut flushes, forgets account and meta, keeps local when asked', async () => {
    const c = setup({ local: S({ workouts: [W('a', 1)] }) })
    await c.engine.signIn()
    c.edit(s => s.unit = 'lb')
    await c.engine.signOut({ keepLocal: true })
    expect(c.drive.file.state.unit).toBe('lb')
    expect(c.auth.signedOut).toBe(true)
    expect(c.storage.getItem(ACCOUNT_KEY)).toBe(null)
    expect(c.storage.getItem(META_KEY)).toBe(null)
    expect(c.sync.state).toBe('off')
    expect(c.state.workouts).toHaveLength(1)
  })

  it('signOut without keepLocal wipes local', async () => {
    const c = setup({ local: S({ workouts: [W('a', 1)] }) })
    await c.engine.signIn()
    await c.engine.signOut({ keepLocal: false })
    expect(c.state.workouts).toHaveLength(0)
  })

  it('deleteCloudCopy deletes the file, stops syncing, keeps local data', async () => {
    const c = setup({ local: S({ workouts: [W('a', 1)] }) })
    await c.engine.signIn()
    c.edit(s => s.unit = 'lb')   // pending push must NOT re-upload
    await c.engine.deleteCloudCopy()
    expect(c.drive.file).toBe(null)
    expect(c.account).toBe(null)
    expect(c.sync.state).toBe('off')
    expect(c.state.workouts).toHaveLength(1)
    await c.fire()
    expect(c.drive.file).toBe(null)
  })
})
