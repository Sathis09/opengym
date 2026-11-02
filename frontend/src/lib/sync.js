// Gym Plus cloud sync — merging two copies of the whole state `S` (this phone ⇄ the copy in the
// user's Google Drive). Pure functions only; the orchestration lives in lib/sync-engine.js.
//
// The self-hosted web sync stays whole-blob/newest-`_ts`-wins (store pullState/pushState). A
// phone, though, is edited offline for days and then meets a Drive copy that another phone has
// been editing too — whole-blob there would silently throw one side's workouts away. So:
//
//  - the four collections (workouts, routines, customEx, bodyweight) merge item by item, the
//    item with the newer version winning;
//  - deletions are tombstones in `S._del[kind][key] = ts`, unioned on merge; a tombstone beats
//    every version of the item that is not newer than it (edit-after-delete survives);
//  - exWeights merge per exercise (later date wins);
//  - everything else (settings, weekly plan, …) is taken whole from the side with newer `_ts`;
//  - the Coach namespace takes its scalars from the newer side but unions its log;
//  - `active` (the workout in progress) never travels: the local one is always kept.
//
// Item version. Every item edit is stamped with `_m` (modified-at, ms) by stampChanges() in
// the store's update(), which diffs the collections — so every create/edit/delete path in the
// app is covered, including ones in lib/ and in Coach code, without each having to remember.
// `t` is NOT used as the version when `_m` exists, because on body-weight entries `t` is the
// time of the weigh-in (Stats/Home plot it) and imports set it to the past.
// Version = _m ?? t ?? (workouts: end || start) ?? 0.

// Mirror of LOG_MAX in lib/coach.js (not imported: the store imports this file, and coach.js
// drags in the exercise library). sync.test.js checks the two agree.
export const COACH_LOG_MAX = 50

export const KINDS = ['workouts', 'routines', 'customEx', 'bodyweight']
const KEYF = { workouts: 'id', routines: 'id', customEx: 'id', bodyweight: 'd' }
const SPECIAL = new Set([...KINDS, '_del', '_ts', 'exWeights', 'coach', 'active'])

const clone = o => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)))
const keyOf = (kind, item) => (item ? item[KEYF[kind]] : undefined)

export function itemVersion(kind, item) {
  if (!item) return 0
  if (typeof item._m === 'number') return item._m
  if (typeof item.t === 'number') return item.t
  if (kind === 'workouts') return item.end || item.start || 0
  return 0
}

export const hasData = st => !!st && !!((st.workouts || []).length || (st.routines || []).length || (st.bodyweight || []).length)

/** Stamp an item as created/edited now. */
export function stampItem(item) {
  const now = Date.now()
  item.t = now
  item._m = now
  return item
}

/** Record a deletion. kind: 'workouts'|'routines'|'customEx'|'bodyweight' (id = date for bodyweight). */
export function markDeleted(s, kind, id) {
  if (id === undefined || id === null) return s
  s._del = s._del || {}
  s._del[kind] = s._del[kind] || {}
  s._del[kind][id] = Date.now()
  return s
}

// Per-state memo of { kind → Map(key → JSON of the item without _m) }. States are replaced,
// never mutated, after persist(), so keying by the object is safe and makes each update cost
// one stringify of the collections.
const fpCache = new WeakMap()
function fingerprints(S) {
  let fp = fpCache.get(S)
  if (fp) return fp
  fp = {}
  for (const kind of KINDS) {
    const m = new Map()
    for (const it of S[kind] || []) {
      const k = keyOf(kind, it)
      if (k === undefined || k === null) continue
      const { _m, ...rest } = it
      m.set(k, JSON.stringify(rest))
    }
    fp[kind] = m
  }
  fpCache.set(S, fp)
  return fp
}

/**
 * Diff `prev` → `next` (next is a draft that will be persisted): stamp `_m` on every item
 * that was added or changed, and tombstone every key that disappeared. Mutates and returns next.
 */
export function stampChanges(prev, next, now = Date.now()) {
  if (!prev || !next) return next
  // A wholesale replacement (backup import, "reset everything") must not forget older deletions.
  if (prev._del) next._del = mergeDel(prev._del, next._del)
  const before = fingerprints(prev)
  for (const kind of KINDS) {
    const old = before[kind]
    const seen = new Set()
    for (const it of next[kind] || []) {
      const k = keyOf(kind, it)
      if (k === undefined || k === null) continue
      seen.add(k)
      const { _m, ...rest } = it
      const was = old.get(k)
      if (was === undefined || was !== JSON.stringify(rest)) it._m = now
    }
    for (const k of old.keys()) {
      if (!seen.has(k)) {
        next._del = next._del || {}
        next._del[kind] = next._del[kind] || {}
        next._del[kind][k] = now
      }
    }
  }
  // exWeights is a map (exId → {w,d}), not a list, but needs the same treatment: without
  // tombstones "Reset everything" would get every remembered weight back from Drive.
  const pw = prev.exWeights || {}, nw = next.exWeights || {}
  for (const [k, v] of Object.entries(nw)) {
    if (!v || typeof v !== 'object') continue
    const { _m, ...rest } = v
    const was = pw[k]
    if (!was) { v._m = now; continue }
    const { _m: _pm, ...prevRest } = was
    if (JSON.stringify(prevRest) !== JSON.stringify(rest)) v._m = now
  }
  for (const k of Object.keys(pw)) {
    if (!(k in nw)) {
      next._del = next._del || {}
      next._del.exWeights = next._del.exWeights || {}
      next._del.exWeights[k] = now
    }
  }
  return next
}

const DEL_KINDS = [...KINDS, 'exWeights']

function mergeDel(a = {}, b = {}) {
  const out = {}
  for (const kind of DEL_KINDS) {
    const m = {}
    for (const src of [a?.[kind], b?.[kind]]) {
      for (const [k, ts] of Object.entries(src || {})) {
        if (typeof ts === 'number' && !(m[k] >= ts)) m[k] = ts
      }
    }
    out[kind] = m
  }
  return out
}

function mergeCollection(kind, local = [], remote = [], del = {}) {
  const out = new Map()   // insertion order: local order, then remote-only items
  for (const it of local || []) {
    const k = keyOf(kind, it)
    out.set(k === undefined || k === null ? Symbol('nokey') : k, it)
  }
  for (const it of remote || []) {
    const k = keyOf(kind, it)
    if (k === undefined || k === null) { out.set(Symbol('nokey'), it); continue }
    const cur = out.get(k)
    if (!cur || itemVersion(kind, it) > itemVersion(kind, cur)) out.set(k, it)
  }
  const list = []
  for (const [k, it] of out) {
    if (typeof k !== 'symbol' && typeof del[k] === 'number' && del[k] >= itemVersion(kind, it)) continue
    list.push(clone(it))
  }
  if (kind === 'workouts') {
    list.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : (a.start || 0) - (b.start || 0)))
  } else if (kind === 'bodyweight') {
    list.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
  }
  return list
}

function mergeExWeights(a = {}, b = {}, del = {}) {
  const out = clone(a || {}) || {}
  for (const [k, v] of Object.entries(b || {})) {
    const cur = out[k]
    if (!cur) { out[k] = clone(v); continue }
    const cd = cur.d || '', vd = (v && v.d) || ''
    if (vd > cd || (vd === cd && (v?.w || 0) > (cur.w || 0))) out[k] = clone(v)
  }
  // A deletion beats every entry not modified after it (entries from before stamping existed
  // have no _m and count as version 0).
  for (const [k, ts] of Object.entries(del || {})) {
    if (out[k] && typeof ts === 'number' && ts >= (out[k]._m || 0)) delete out[k]
  }
  return out
}

function mergeCoach(local, remote, remoteNewer) {
  if (!local && !remote) return local === undefined && remote === undefined ? undefined : null
  if (!local) return clone(remote)
  if (!remote) return clone(local)
  const base = clone(remoteNewer ? remote : local)
  const seen = new Set()
  const log = []
  for (const e of [...(local.log || []), ...(remote.log || [])]) {
    if (!e) continue
    const k = e.id != null ? 'id:' + e.id : 'at:' + e.at + ':' + (e.type || e.kind || '')
    if (seen.has(k)) continue
    seen.add(k)
    log.push(clone(e))
  }
  log.sort((a, b) => (a.at || 0) - (b.at || 0))
  base.log = log.slice(-COACH_LOG_MAX)
  return base
}

/**
 * Merge two whole states. Neither input is mutated. The result keeps `local.active`, and its
 * `_ts` is the max of both. Ties (equal item versions, equal `_ts`) prefer local.
 */
export function mergeStates(local, remote) {
  if (!remote) return clone(local)
  if (!local) { const r = clone(remote); delete r.active; return r }
  const remoteNewer = (remote._ts || 0) > (local._ts || 0)
  const winner = remoteNewer ? remote : local
  const loser = remoteNewer ? local : remote
  const out = {}
  // scalars / settings / week / dayPlan / reminder …: whole from the newer side
  for (const k of new Set([...Object.keys(loser), ...Object.keys(winner)])) {
    if (SPECIAL.has(k)) continue
    out[k] = clone(k in winner ? winner[k] : loser[k])
  }
  const del = mergeDel(local._del, remote._del)
  for (const kind of KINDS) out[kind] = mergeCollection(kind, local[kind], remote[kind], del[kind])
  out._del = del
  out.exWeights = mergeExWeights(local.exWeights, remote.exWeights, del.exWeights)
  const coach = mergeCoach(local.coach, remote.coach, remoteNewer)
  if (coach !== undefined) out.coach = coach
  out.active = local.active === undefined ? null : clone(local.active)
  out._ts = Math.max(local._ts || 0, remote._ts || 0)
  return out
}
