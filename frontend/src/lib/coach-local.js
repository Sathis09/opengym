// The Coach, in the mobile build.
//
// There is no server on the phone, so this module does what api/coach/jobs.js does there:
// build the bounded, pseudonymised payload (coach-core/payload.js), assemble the prompt from
// the same prompt files, call the user's own provider with the user's own key
// (ai-providers.js), validate the answer through the same closed gate (coach-core/validate.js)
// with one repair round, and hold the result as a pending proposal in exactly the shape the
// server returns — so CoachProposal and the apply code in coach.js run unchanged.
//
// Same exported surface as coach-demo.js. The pending proposal and the job live in
// localStorage ('gp_coach_pending'), not in S: like the server's copy, it must not be erased
// or duplicated by a whole-state sync. A job the app was killed during cannot come back, and
// is reported as 'restart' rather than left spinning.
//
// Only reached behind MOBILE (coach-api.js imports it dynamically).

import { complete, providerById } from './ai-providers.js'
import { useAI, getAIKey } from '../store/useAI.js'
import { build, CONTRACT, DATA_CATEGORIES } from './coach-core/payload.js'
import { extractJSON, validatePlan, validateReview, contractOK } from './coach-core/validate.js'
import { buildPrompt } from './coach-core/prompt.js'
import { MOBILE_JOB_ERRORS, PROVIDER_TO_JOB } from './coach-core/errors.js'
import { planHash, hasConsent, reviewDue } from './coach.js'
import { t } from './i18n.js'

export { reviewDue }

const STORE_KEY = 'gp_coach_pending'
const ID_KEY = 'gp_coach_id'
const PENDING_DAYS = 14                       // FR-33, as on the server
export const TIMEOUT_MS = 5 * 60000           // as on the server
const SYSTEM = 'You are the training coach inside a strength-training app. Answer with one JSON object and nothing else.'

/* ---------------- persistence ---------------- */

const ls = () => { try { return globalThis.localStorage || null } catch { return null } }
const EMPTY = () => ({ job: null, pending: null, error: null, notice: null })
let rec = null

/** Lazily read the persisted record. A job found on disk here predates this process. */
function R() {
  if (rec) return rec
  let stored = null
  try { stored = JSON.parse(ls()?.getItem(STORE_KEY) || 'null') } catch { stored = null }
  rec = { ...EMPTY(), ...(stored && typeof stored === 'object' ? stored : {}) }
  if (rec.job) {
    rec = { ...rec, job: null, error: { code: 'restart', kind: rec.job.kind, at: Date.now() } }
    save()
  }
  return rec
}
function save() {
  try { ls()?.setItem(STORE_KEY, JSON.stringify(rec)) } catch { /* full or blocked — memory copy still works */ }
}
function patch(p) { rec = { ...R(), ...p }; save(); return rec }

const randomId = () => {
  const b = new Uint8Array(8)
  globalThis.crypto.getRandomValues(b)
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('')
}
/** Per-install id, used only to derive the payload's opaque pseudonym. */
function installId() {
  let id = null
  try { id = ls()?.getItem(ID_KEY) } catch { /* ignore */ }
  if (!id) { id = randomId(); try { ls()?.setItem(ID_KEY, id) } catch { /* ignore */ } }
  return id
}

const fail = (code, status) => Object.assign(new Error(t(MOBILE_JOB_ERRORS[code] || MOBILE_JOB_ERRORS.internal)), { code, status })

/* ---------------- status ---------------- */

export function localStatus() {
  const r = R()
  if (r.pending?.expiresAt && r.pending.expiresAt < Date.now()) patch({ pending: null })
  const { job, pending, error, notice } = R()
  return { job, pending, cap: { used: 0, limit: 0 }, error, notice }
}

/* ---------------- running a job ---------------- */

async function start(kind, S, opts) {
  if (R().job) throw fail('busy', 409)
  if (!hasConsent(S)) throw fail('consent', 403)
  await useAI.getState().load()
  const { provider, model } = useAI.getState()
  if (!providerById(provider) || !model || !(await getAIKey(provider))) throw fail('off', 503)

  const job = { id: randomId(), kind, state: 'running', startedAt: Date.now() }
  patch({ job, error: null, notice: null })
  // Not awaited: the caller gets the job back at once, like the server's 202, and polls.
  run(job, S, opts).catch(() => finish(job, { error: 'internal' }))
  return { job }
}

async function run(job, S, opts) {
  const { provider, model } = useAI.getState()
  const key = await getAIKey(provider)
  if (!key || !model) return finish(job, { error: 'off' })

  const previousCreate = opts.refine ? R().pending : null
  const payload = build(S, installId(), {
    kind: job.kind,
    intake: opts.intake || null,
    note: opts.note || null,
    refine: opts.refine || null,
    previous: previousCreate?.bundle || null
  })
  const instructions = typeof S.coach?.instructions === 'string' ? S.coach.instructions.slice(0, 1000) : ''
  const call = { provider, model, key, payload, kind: job.kind, instructions }

  let attempt = await invoke(call, null)
  if (!attempt.ok && attempt.repairable) {
    // One repair round, then done (FR-48) — a retry loop against the user's paid API is a
    // bad way to discover that a model cannot follow the schema.
    attempt = await invoke(call, { previous: attempt.raw, errors: attempt.errors })
  }
  if (!attempt.ok) return finish(job, { error: attempt.errorClass })
  if (attempt.nochange) {
    // A review that found nothing still counts as a review: without this the cadence would
    // keep offering one that has already been done.
    if (job.kind === 'review' && opts.onReviewed) { try { opts.onReviewed() } catch { /* not worth failing over */ } }
    return finish(job, { pending: null, notice: { kind: 'nochange', jobKind: job.kind, reading: attempt.reading || '' } })
  }

  const now = Date.now()
  return finish(job, {
    pending: {
      id: job.id,
      kind: job.kind,
      createdAt: now,
      expiresAt: now + PENDING_DAYS * 86400000,
      planHash: planHash(S),
      iteration: opts.refine ? (previousCreate?.iteration || 1) + 1 : 1,
      ...attempt.result
    }
  })
}

async function invoke({ provider, model, key, payload, kind, instructions }, repair) {
  let text
  try {
    text = await complete({
      provider, model, key, system: SYSTEM, json: true, timeoutMs: TIMEOUT_MS,
      prompt: buildPrompt(kind, payload, repair, { instructions })
    })
  } catch (e) {
    return { ok: false, errorClass: PROVIDER_TO_JOB[e?.code] || 'provider' }
  }
  const parsed = extractJSON(text)
  if (parsed.error) return { ok: false, repairable: !repair, errors: [parsed.error], raw: text, errorClass: 'unusable' }
  if (!contractOK(parsed.value)) {
    return { ok: false, repairable: !repair, errors: [`coach_contract must be ${CONTRACT}`], raw: text, errorClass: 'unusable' }
  }
  const v = kind === 'review'
    ? validateReview(parsed.value, payload.plan)
    : validatePlan(parsed.value, { workingWeights: payload.history?.workingWeights, daysPerWeek: payload.coachProfile?.daysPerWeek })
  if (!v.ok) return { ok: false, repairable: !repair, errors: v.errors, raw: text, errorClass: 'unusable' }
  if (v.nochange) return { ok: true, nochange: true, reading: v.reading }
  return { ok: true, result: v.proposal ? v.proposal : { bundle: v.bundle, summary: v.bundle.summary } }
}

/** Record a job's outcome — unless it was abandoned (turned off, forgotten) while it ran. */
function finish(job, { pending, error, notice }) {
  if (R().job?.id !== job.id) return
  patch({
    job: null,
    ...(pending !== undefined ? { pending } : {}),
    error: error ? { code: error, kind: job.kind, at: Date.now() } : null,
    notice: notice || null
  })
}

/* ---------------- the API surface (mirrors coach-demo.js) ---------------- */

/** `onReviewed` runs when a review finds nothing to change (the caller stamps S.coach.lastReview). */
export const localReview = (S, note, { onReviewed } = {}) => start('review', S, { note: note ? String(note).slice(0, 1000) : null, onReviewed })
export const localPlan = (S, intake) => start('create', S, { intake: intake || null })
export const localRefine = (S, text) => start('create', S, { refine: String(text || '').slice(0, 1000) })
export const localResolve = () => { patch({ pending: null }); return { ok: true } }
/** Consent withdrawn / Coach turned off: drop everything held for it on this phone. */
export const localForget = () => { rec = EMPTY(); save(); return { ok: true } }
/** The user has read the error or the "nothing to change" note. */
export const localDismiss = () => { patch({ error: null, notice: null }); return { ok: true } }
export const localDisclosure = () => {
  const p = providerById(useAI.getState().provider)
  return { provider: p?.id || null, providerLabel: p?.label || t('your AI provider'), categories: DATA_CATEGORIES, version: 1 }
}

/** Tests only: drop the in-memory record so the next call re-reads storage (a "restart"). */
export function __reloadForTests() { rec = null }
