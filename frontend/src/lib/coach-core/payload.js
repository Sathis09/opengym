/* Browser port of api/coach/payload.js — what leaves the phone when the mobile Coach runs.
 *
 * Same allowlist, same bounds, same output: every field copied in by name, nothing spread,
 * nothing passed through. coach-core.test.js runs this and the server's original over the same
 * states and asserts identical output (the pseudonym aside), so the two cannot drift.
 *
 * Differences from the server copy, all forced by the runtime:
 *   - the exercise library comes from EXDB (the same data api/coach/library.json is generated
 *     from), reduced to the same five fields;
 *   - the pseudonym is a small deterministic hash of a per-install id instead of an HMAC over
 *     the server secret. It is still never the account id and never reversible in practice.
 */
import { EXDB } from '../exercises.js'

// Exactly the fields scripts/build-coach-library.mjs keeps. Built from EXDB, not EXIDX: EXIDX
// also holds the user's custom exercises, and the library must be the catalogue alone.
const LIBRARY = EXDB.map(e => ({ id: e.id, n: e.n, bp: e.bp, tg: e.tg, eq: e.eq }))
const LIB_BY_ID = new Map(LIBRARY.map(e => [e.id, e]))

export const CONTRACT = 1
export const MAX_WEEKS = 12
export const MAX_SESSIONS = 60

export const DATA_CATEGORIES = ['plan', 'training', 'bodyweight', 'profile', 'prefs']

/** Stable pseudonym for an install id: two FNV-style 32-bit lanes, 16 hex chars. */
export function handle(id) {
  const s = 'coach-handle:' + String(id || '')
  let h1 = 0x811c9dc5, h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ ((c << 3) | i & 7), 0x85ebca6b) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

/* ---------- reading a session the way the engine reads it ---------- */
const modeOf = (cfg, ex) => {
  const m = cfg && cfg.mode
  if (m === 'reps' || m === 'time' || m === 'cardio') return m
  return ex && ex.bp === 'cardio' ? 'cardio' : 'reps'
}
function readSession(entry, fallback) {
  const target = (entry && entry.target) || fallback || {}
  const mode = modeOf(target, LIB_BY_ID.get(entry?.id))
  const sets = (entry && entry.sets) || []
  const planned = target.sets || sets.length
  const enough = sets.length >= planned
  if (mode === 'time') {
    const goal = target.sec || 0
    const held = sets.map(s => (s.done ? (s.sec || 0) : 0))
    return { mode, goal, ok: goal > 0 && enough && held.length > 0 && held.every(h => h >= goal) }
  }
  const goal = target.reps || 0
  const reps = sets.map(s => (s.done ? (s.r || 0) : 0))
  return { mode, goal, ok: goal > 0 && enough && reps.length > 0 && reps.every(r => r >= goal) }
}
export function stallCount(sessions) {
  let n = 0
  for (let i = sessions.length - 1; i >= 0; i--) { if (sessions[i].ok) break; n++ }
  return n
}

/* ---------- plan cleaning ---------- */
function cleanEx(e) {
  const o = { id: e.id, name: LIB_BY_ID.get(e.id)?.n || null, sets: e.sets }
  const mode = modeOf(e, LIB_BY_ID.get(e.id))
  o.mode = mode
  if (mode === 'cardio') { if (e.min != null) o.min = e.min; if (e.speed != null) o.speed = e.speed }
  else if (mode === 'time') { if (e.sec != null) o.sec = e.sec; if (e.weight) o.weight = e.weight }
  else { if (e.reps != null) o.reps = e.reps; if (e.weight) o.weight = e.weight }
  if (e.prog) o.prog = e.prog
  if (e.inc > 0) o.inc = e.inc
  if (e.repsMin != null) o.repsMin = e.repsMin
  if (e.sg) o.sg = e.sg
  return o
}

/** Mirror of api canonicalPlan — note the client's planHash (lib/coach.js) is what proposals carry. */
export function canonicalPlan(S) {
  const custom = new Map((S.customEx || []).map(c => [c.id, c]))
  const exOf = id => LIB_BY_ID.get(id) || custom.get(id)
  return {
    routines: (S.routines || []).map(r => ({
      id: r.id, name: r.name || '', prog: r.prog || '',
      ex: (r.ex || []).map(e => {
        const mode = modeOf(e, exOf(e.id))
        return {
          id: e.id, mode, sets: e.sets || 0,
          reps: mode === 'reps' ? (e.reps || 0) : 0,
          sec: mode === 'time' ? (e.sec || 0) : 0,
          min: mode === 'cardio' ? (e.min || 0) : 0,
          speed: mode === 'cardio' ? (e.speed || 0) : 0,
          weight: mode === 'cardio' ? 0 : (e.weight || 0),
          prog: e.prog || '', inc: e.inc || 0, repsMin: e.repsMin || 0, sg: e.sg || ''
        }
      })
    })),
    week: Object.fromEntries([1, 2, 3, 4, 5, 6, 0].filter(d => S.week?.[d]).map(d => [d, S.week[d]]))
  }
}

export function cleanPlan(S) {
  const routines = (S.routines || []).map(r => ({
    id: r.id, name: r.name, emoji: r.emoji, ...(r.prog ? { prog: r.prog } : {}), ex: (r.ex || []).map(cleanEx)
  }))
  const week = {}
  ;[1, 2, 3, 4, 5, 6, 0].forEach(d => { if (S.week?.[d]) week[d] = S.week[d] })
  return { routines, week }
}

/* ---------- the library slice the model gets to choose from ---------- */
export function librarySlice(S, equipment) {
  const wanted = (equipment || []).map(x => String(x).toLowerCase())
  const customs = (S.customEx || []).map(c => ({ id: c.id, n: c.n, bp: c.bp, tg: null, eq: 'custom', custom: true }))
  const base = wanted.length ? LIBRARY.filter(e => wanted.includes((e.eq || '').toLowerCase())) : LIBRARY
  return [...customs, ...(base.length ? base : LIBRARY)]
}
export const libraryHas = id => LIB_BY_ID.has(id)
export const libraryName = id => LIB_BY_ID.get(id)?.n || null
export { LIBRARY }

/* ---------- effort scale ---------- */
const effortOf = S => {
  const e = S && S.effort
  return e === 'none' || e === 'rir' || e === 'rpe' ? e : (S && S.showRir ? 'rir' : 'none')
}

/* ---------- window + aggregates ---------- */
const iso = d => d.toISOString().slice(0, 10)

export function reviewWindow(S, since) {
  const all = (S.workouts || []).filter(w => w && w.d)
  const cutoffDate = new Date(); cutoffDate.setDate(cutoffDate.getDate() - MAX_WEEKS * 7)
  const cutoff = iso(cutoffDate)
  const from = since && since > cutoff ? since : cutoff
  return all.filter(w => w.d >= from).slice(-MAX_SESSIONS)
}

function aggregates(S, workouts) {
  const byEx = new Map()
  const planCfg = new Map()
  ;(S.routines || []).forEach(r => (r.ex || []).forEach(e => planCfg.set(e.id, e)))
  ;(S.workouts || []).forEach(w => (w.entries || []).forEach(en => {
    if (!en.sets?.some(s => s.done)) return
    if (!byEx.has(en.id)) byEx.set(en.id, [])
    byEx.get(en.id).push(readSession(en, planCfg.get(en.id)))
  }))
  const exercises = []
  for (const [id, sessions] of byEx) {
    const stalls = stallCount(sessions)
    if (stalls > 0 || sessions.length >= 3) {
      exercises.push({ id, name: libraryName(id), sessions: sessions.length, stalls, lastOk: !!sessions[sessions.length - 1]?.ok })
    }
  }

  const trained = new Set(workouts.map(w => w.d))
  const plannedDays = Object.keys(S.week || {}).filter(k => S.week[k]).length
  const reschedules = Object.entries(S.dayPlan || {}).filter(([d]) => workouts.some(w => w.d === d) || d >= (workouts[0]?.d || '')).length

  const hit = {}
  workouts.forEach(w => (w.entries || []).forEach(en => {
    if (!en.sets?.some(s => s.done)) return
    const bp = LIB_BY_ID.get(en.id)?.bp
    if (bp) hit[bp] = (hit[bp] || 0) + en.sets.filter(s => s.done).length
  }))

  const durations = workouts.map(w => (w.end && w.start ? Math.round((w.end - w.start) / 60000) : null)).filter(Boolean)
  return {
    exercises,
    adherence: { plannedPerWeek: plannedDays, sessionsInWindow: workouts.length, distinctDays: trained.size, dayOverrides: reschedules },
    setsByBodyPart: hit,
    sessionMinutes: durations.length
      ? { median: durations.slice().sort((a, b) => a - b)[Math.floor(durations.length / 2)], min: Math.min(...durations), max: Math.max(...durations) }
      : null
  }
}

function cleanWorkout(w) {
  return {
    d: w.d,
    name: w.name || null,
    minutes: w.end && w.start ? Math.round((w.end - w.start) / 60000) : null,
    ...(w.rating ? { rating: w.rating } : {}),
    ...(w.note ? { note: String(w.note).slice(0, 300) } : {}),
    prs: (w.prs || []).length,
    entries: (w.entries || []).map(en => ({
      id: en.id,
      name: libraryName(en.id),
      target: en.target ? { sets: en.target.sets, reps: en.target.reps, sec: en.target.sec, weight: en.target.weight } : null,
      sets: (en.sets || []).map(s => {
        const o = { done: !!s.done }
        if (s.w != null) o.w = s.w
        if (s.r != null) o.r = s.r
        if (s.sec != null) o.sec = s.sec
        if (s.min != null) o.min = s.min
        if (s.speed != null) o.speed = s.speed
        if (s.rir != null) o.rir = s.rir
        if (s.rpe != null) o.rpe = s.rpe
        return o
      })
    }))
  }
}

/**
 * Build a job payload — same shape as the server's.
 *
 * @param {object} S      the profile's state
 * @param {string} id     per-install id, used only to derive the opaque handle
 * @param {object} opts   { kind, intake?, note?, refine?, previous? }
 */
export function build(S, id, opts = {}) {
  const coach = S.coach || {}
  const profile = opts.intake || coach.profile || null
  const p = {
    coach_contract: CONTRACT,
    task: opts.kind === 'review' ? 'review' : 'create',
    meta: {
      profile: handle(id),
      lang: S.lang || 'en',
      unit: S.unit || 'kg',
      effortScale: effortOf(S),
      today: iso(new Date())
    },
    coachProfile: profile ? {
      goal: profile.goal || null,
      experience: profile.experience || null,
      daysPerWeek: profile.daysPerWeek || null,
      preferredDays: profile.preferredDays || [],
      sessionMin: profile.sessionMin || null,
      equipment: profile.equipment || [],
      limitations: profile.limitations || '',
      likes: profile.likes || '',
      dislikes: profile.dislikes || '',
      notes: profile.notes || ''
    } : null,
    plan: cleanPlan(S)
  }

  const declined = (coach.log || [])
    .flatMap(e => (e.decisions || []).filter(d => d.status === 'rejected').map(d => ({ type: d.type, why: d.why })))
    .slice(-15)
  if (declined.length) p.previouslyDeclined = declined

  if (opts.kind === 'review') {
    const workouts = reviewWindow(S, coach.lastReview?.at ? String(coach.lastReview.at).slice(0, 10) : null)
    p.window = {
      from: workouts[0]?.d || null,
      to: workouts[workouts.length - 1]?.d || null,
      workouts: workouts.map(cleanWorkout)
    }
    p.aggregates = aggregates(S, workouts)
    p.bodyweight = {
      goal: S.targetW ?? null,
      series: (S.bodyweight || []).filter(b => !p.window.from || b.d >= p.window.from).map(b => ({ d: b.d, w: b.w }))
    }
    if (opts.note) p.userNote = String(opts.note).slice(0, 1000)
    p.library = librarySlice(S, profile?.equipment)
  } else {
    p.library = librarySlice(S, profile?.equipment)
    const best = {}
    ;(S.workouts || []).forEach(w => (w.entries || []).forEach(en => en.sets?.forEach(s => {
      if (s.done && s.w > 0) best[en.id] = Math.max(best[en.id] || 0, s.w)
    })))
    if (Object.keys(best).length) {
      p.history = {
        sessions: (S.workouts || []).length,
        since: (S.workouts || [])[0]?.d || null,
        workingWeights: Object.entries(best).map(([id, w]) => ({ id, name: libraryName(id), best: w }))
      }
    }
    if (opts.refine) {
      p.refine = { text: String(opts.refine).slice(0, 1000), previous: opts.previous || null }
    }
  }
  return p
}
