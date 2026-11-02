import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./ai-providers.js', async importOriginal => ({ ...(await importOriginal()), complete: vi.fn() }))

import { complete, AIError } from './ai-providers.js'
import { useAI, __setKeyBackend, __resetAILoad } from '../store/useAI.js'
import {
  localStatus, localReview, localPlan, localRefine, localResolve, localForget, localDismiss,
  localDisclosure, __reloadForTests
} from './coach-local.js'
import { MOBILE_JOB_ERRORS } from './coach-core/errors.js'
import { planHash, coachAvailable, reviewDue, CONSENT_VERSION, applyChangeSet, applyCreatedPlan, markStale } from './coach.js'

function memStorage() {
  const m = new Map()
  return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }
}

const state = (over = {}) => ({
  unit: 'kg', lang: 'en', effort: 'rpe', customEx: [], bodyweight: [], exWeights: {}, dayPlan: {},
  routines: [{
    id: 'r1', name: 'Full body A', emoji: '💪', prog: 'linear',
    ex: [{ id: '0001', sets: 3, reps: 10, mode: 'reps', weight: 20 }, { id: '0007', sets: 3, sec: 45, mode: 'time' }]
  }],
  week: { 1: 'r1', 3: 'r1', 5: 'r1' },
  workouts: [{ id: 'w1', d: new Date().toISOString().slice(0, 10), start: 1, end: 1 + 40 * 60000, entries: [
    { id: '0001', target: { sets: 3, reps: 10, weight: 20 }, sets: [{ w: 20, r: 10, done: true, rpe: 9.5 }, { w: 20, r: 8, done: true }, { w: 20, r: 7, done: true }] }
  ] }],
  coach: {
    consent: { agreedAt: '2026-07-01T00:00:00Z', version: CONSENT_VERSION }, cadence: 'off', log: [], snapshots: [],
    profile: { goal: 'muscle', daysPerWeek: 3, equipment: [] },
    instructions: 'Keep sessions under 45 minutes.'
  },
  ...over
})

const REVIEW = {
  coach_contract: 1, summary: 'Bench stalled.', evidence: { from: '2026-10-01', to: '2026-10-30', sessions: 4 },
  changes: [{ type: 'sets', target: { routineId: 'r1', exId: '0001' }, before: 3, after: 4, why: 'Missed reps three times' }],
  notes: ['Sleep more']
}
const PLAN = {
  coach_contract: 1, name: 'Coach plan', summary: 'Three days.', basedOn: 'history',
  routines: [{ id: 'a', name: 'A', prog: 'linear', ex: [{ id: '0001', sets: 3, reps: 8, why: 'core' }] }],
  week: { 1: 'a', 3: 'a', 5: 'a' }
}

let store
const settle = () => vi.waitFor(() => expect(localStatus().job).toBeNull())

beforeEach(async () => {
  store = memStorage()
  vi.stubGlobal('localStorage', store)
  const keys = new Map([['gp_ai_key_anthropic', 'sk-ant-TEST']])
  __setKeyBackend({ get: async k => keys.get(k) ?? null, set: async (k, v) => keys.set(k, v), remove: async k => keys.delete(k) })
  __resetAILoad()
  store.setItem('gp_ai', JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-5-5' }))
  useAI.setState({ ready: false })
  await useAI.getState().load()
  __reloadForTests()
  complete.mockReset()
})

describe('coach-local — jobs', () => {
  it('review: runs, validates and holds a pending proposal in the server shape', async () => {
    complete.mockResolvedValueOnce(JSON.stringify(REVIEW))
    const S = state()
    const { job } = await localReview(S, 'shoulder is fine')
    expect(job).toMatchObject({ kind: 'review', state: 'running' })
    expect(localStatus().job.id).toBe(job.id)
    await settle()

    const { pending, error, cap } = localStatus()
    expect(error).toBeNull()
    expect(cap).toEqual({ used: 0, limit: 0 })
    expect(pending).toMatchObject({ id: job.id, kind: 'review', iteration: 1, planHash: planHash(S), summary: 'Bench stalled.', notes: ['Sleep more'] })
    expect(pending.expiresAt - pending.createdAt).toBe(14 * 86400000)
    expect(pending.changes[0]).toMatchObject({ id: 'c0', type: 'sets', target: { routineId: 'r1', exId: '0001' }, before: 3, after: 4 })

    const call = complete.mock.calls[0][0]
    expect(call).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5', key: 'sk-ant-TEST', json: true })
    expect(call.prompt).toContain('"task": "review"')
    expect(call.prompt).toContain('"userNote": "shoulder is fine"')
    expect(call.prompt).toContain('<<<USER_PREFERENCES\nKeep sessions under 45 minutes.\nUSER_PREFERENCES>>>')

    // ...and the existing apply path takes it unchanged.
    const s = JSON.parse(JSON.stringify(S))
    const marked = markStale(pending, s)
    expect(applyChangeSet(s, marked, ['c0']).applied).toBe(1)
    expect(s.routines[0].ex[0].sets).toBe(4)
  })

  it('create, then refine: bundle shape, iteration and previous plan carried', async () => {
    complete.mockResolvedValueOnce(JSON.stringify(PLAN))
    const S = state({ routines: [], week: {} })
    await localPlan(S, { goal: 'strength', daysPerWeek: 3, equipment: [] })
    await settle()
    const first = localStatus().pending
    expect(first).toMatchObject({ kind: 'create', iteration: 1, summary: 'Three days.' })
    expect(first.bundle).toMatchObject({ opengym_plan: 1, name: 'Coach plan', week: { 1: 'a', 3: 'a', 5: 'a' } })
    expect(complete.mock.calls[0][0].prompt).toContain('"goal": "strength"')

    complete.mockResolvedValueOnce(JSON.stringify({ ...PLAN, summary: 'Revised.' }))
    await localRefine(S, 'more arms')
    await settle()
    const second = localStatus().pending
    expect(second).toMatchObject({ iteration: 2, summary: 'Revised.' })
    const prompt = complete.mock.calls[1][0].prompt
    expect(prompt).toContain('"text": "more arms"')
    expect(prompt).toContain('"previous": {')

    const s = JSON.parse(JSON.stringify(S))
    applyCreatedPlan(s, second, { schedule: true })
    expect(s.routines).toHaveLength(1)
  })

  it('one repair round on an unusable answer', async () => {
    complete
      .mockResolvedValueOnce('Sure! Here are my thoughts, no JSON though.')
      .mockResolvedValueOnce(JSON.stringify(REVIEW))
    await localReview(state())
    await settle()
    expect(complete).toHaveBeenCalledTimes(2)
    const repairPrompt = complete.mock.calls[1][0].prompt
    expect(repairPrompt).toContain('# REPAIR REQUEST')
    expect(repairPrompt).toContain('Sure! Here are my thoughts')
    expect(repairPrompt).toContain('- the answer was not JSON')
    expect(localStatus().pending?.kind).toBe('review')
  })

  it('two unusable answers → error "unusable", no third call, earlier pending kept', async () => {
    complete.mockResolvedValueOnce(JSON.stringify(REVIEW))
    await localReview(state()); await settle()
    const kept = localStatus().pending

    complete.mockResolvedValue(JSON.stringify({ changes: [{ type: 'delete-everything', why: 'x' }] }))
    await localReview(state()); await settle()
    expect(complete).toHaveBeenCalledTimes(3)
    expect(localStatus().error).toMatchObject({ code: 'unusable', kind: 'review' })
    expect(localStatus().pending).toEqual(kept)
  })

  it('a rejected key maps to "auth" with mobile wording, and is not retried', async () => {
    complete.mockRejectedValue(new AIError('key'))
    await localReview(state()); await settle()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(localStatus().error.code).toBe('auth')
    expect(MOBILE_JOB_ERRORS.auth).toBe('Your API key was rejected — check it in Profile → AI Coach.')
    expect(Object.values(MOBILE_JOB_ERRORS).join(' ')).not.toMatch(/instance owner/i)
  })

  it('maps the other provider failures', async () => {
    for (const [code, job] of [['rate', 'rate'], ['model', 'model'], ['offline', 'offline'], ['timeout', 'timeout'], ['failed', 'provider']]) {
      complete.mockReset(); complete.mockRejectedValue(new AIError(code))
      await localReview(state()); await settle()
      expect(localStatus().error.code).toBe(job)
      expect(MOBILE_JOB_ERRORS[job]).toBeTruthy()
    }
  })

  it('a review with nothing to change leaves a notice and stamps the review', async () => {
    complete.mockResolvedValueOnce(JSON.stringify({ nochange: true, reading: 'All on track.' }))
    const onReviewed = vi.fn()
    await localReview(state(), '', { onReviewed }); await settle()
    expect(onReviewed).toHaveBeenCalledOnce()
    expect(localStatus()).toMatchObject({ pending: null, error: null, notice: { kind: 'nochange', reading: 'All on track.' } })
    localDismiss()
    expect(localStatus().notice).toBeNull()
  })

  it('refuses to start without consent, without a key/model, or while busy', async () => {
    await expect(localReview(state({ coach: { consent: null } }))).rejects.toMatchObject({ code: 'consent' })
    useAI.setState({ model: null })
    await expect(localReview(state())).rejects.toMatchObject({ code: 'off' })
    useAI.setState({ model: 'claude-sonnet-5-5' })
    complete.mockReturnValue(new Promise(() => {}))
    await localReview(state())
    await expect(localPlan(state(), {})).rejects.toMatchObject({ code: 'busy', status: 409 })
    expect(complete).toHaveBeenCalledTimes(1)
  })
})

describe('coach-local — persistence', () => {
  it('a pending proposal survives an app restart', async () => {
    complete.mockResolvedValueOnce(JSON.stringify(REVIEW))
    await localReview(state()); await settle()
    const before = localStatus().pending
    expect(JSON.parse(store.getItem('gp_coach_pending')).pending.id).toBe(before.id)
    __reloadForTests()
    expect(localStatus().pending).toEqual(before)
    localResolve()
    __reloadForTests()
    expect(localStatus().pending).toBeNull()
  })

  it('a job interrupted by a restart becomes an error "restart"', async () => {
    complete.mockReturnValue(new Promise(() => {}))
    await localReview(state())
    expect(localStatus().job).not.toBeNull()
    __reloadForTests()                       // the process died; storage still says "running"
    const s = localStatus()
    expect(s.job).toBeNull()
    expect(s.error).toMatchObject({ code: 'restart', kind: 'review' })
    expect(JSON.parse(store.getItem('gp_coach_pending')).job).toBeNull()
  })

  it('an expired proposal is dropped', async () => {
    complete.mockResolvedValueOnce(JSON.stringify(REVIEW))
    await localReview(state()); await settle()
    const rec = JSON.parse(store.getItem('gp_coach_pending'))
    rec.pending.expiresAt = Date.now() - 1
    store.setItem('gp_coach_pending', JSON.stringify(rec))
    __reloadForTests()
    expect(localStatus().pending).toBeNull()
  })

  it('forgetting while a job runs discards its result', async () => {
    let answer
    complete.mockReturnValue(new Promise(r => { answer = r }))
    await localReview(state())
    localForget()
    answer(JSON.stringify(REVIEW))
    await new Promise(r => setTimeout(r, 10))
    expect(localStatus()).toMatchObject({ job: null, pending: null, error: null })
  })

  it('never persists the key', async () => {
    complete.mockResolvedValueOnce(JSON.stringify(REVIEW))
    await localReview(state()); await settle()
    for (const v of store.m.values()) expect(v).not.toContain('sk-ant-TEST')
  })

  it('disclosure names the chosen provider', () => {
    expect(localDisclosure()).toMatchObject({ provider: 'anthropic', providerLabel: 'Anthropic (Claude)', version: 1 })
    expect(localDisclosure().categories).toEqual(['plan', 'training', 'bodyweight', 'profile', 'prefs'])
  })
})

describe('gating and scheduled reviews', () => {
  it('coachAvailable on mobile needs a key and a model', () => {
    expect(coachAvailable(null, null, { mobile: true })).toBe(false)
    expect(coachAvailable(null, null, { mobile: true, ai: { hasKey: true, model: null } })).toBe(false)
    expect(coachAvailable(null, null, { mobile: true, ai: { hasKey: false, model: 'm' } })).toBe(false)
    expect(coachAvailable(null, null, { mobile: true, ai: { hasKey: true, model: 'm' } })).toBe(true)
    // web and demo unchanged
    expect(coachAvailable({ coach: { enabled: true } }, { id: 'u' }, { ai: { hasKey: true, model: 'm' } })).toBe(true)
    expect(coachAvailable(null, null, { demo: true })).toBe(true)
  })

  it('reviewDue: weekly slot, every-N workouts, consent and new evidence', () => {
    // Sunday 2026-11-01 18:00 local is the slot; check just before and after.
    const wk = (lastAt, workouts) => state({
      workouts,
      coach: { ...state().coach, cadence: { weekly: { day: 0, time: '18:00' } }, lastReview: lastAt ? { at: lastAt } : null }
    })
    const w = d => ({ id: d, d, end: new Date(d + 'T12:00:00').getTime() })
    const before = new Date('2026-11-01T17:59:00'), after = new Date('2026-11-01T18:01:00'), later = new Date('2026-11-04T09:00:00')
    const lastWeek = new Date('2026-10-25T18:30:00').getTime()
    const S = wk(lastWeek, [w('2026-10-28')])
    expect(reviewDue(S, before)).toBe(false)
    expect(reviewDue(S, after)).toBe(true)
    expect(reviewDue(S, later)).toBe(true)                               // stays due until done
    expect(reviewDue(wk(new Date('2026-11-01T19:00:00').getTime(), [w('2026-10-28')]), later)).toBe(false)
    expect(reviewDue(wk(lastWeek, []), after)).toBe(false)               // nothing new to read
    expect(reviewDue({ ...S, coach: { ...S.coach, consent: null } }, after)).toBe(false)
    expect(reviewDue({ ...S, coach: { ...S.coach, cadence: 'off' } }, after)).toBe(false)

    const every = n => state({ workouts: Array.from({ length: n }, (_, i) => w('2026-10-2' + i)), coach: { ...state().coach, cadence: { everyWorkouts: 4 }, lastReview: null } })
    expect(reviewDue(every(3))).toBe(false)
    expect(reviewDue(every(4))).toBe(true)
  })
})
