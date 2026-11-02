import { describe, it, expect, vi, afterEach } from 'vitest'
import { mergeStates, markDeleted, stampItem, stampChanges, hasData, itemVersion, COACH_LOG_MAX } from './sync.js'
import { LOG_MAX } from './coach.js'

const base = (over = {}) => ({
  unit: 'kg', restSec: 90, theme: 'dark', week: {}, dayPlan: {}, reminder: { on: false, time: '08:00', tz: null },
  targetW: null, bodyweight: [], routines: [], exWeights: {}, workouts: [], active: null, customEx: [],
  coach: null, _ts: 1000, ...over,
})
const W = (id, d, m, extra = {}) => ({ id, d, start: 1, end: 2, entries: [], _m: m, ...extra })
const R = (id, name, m) => ({ id, name, ex: [], _m: m })
const B = (d, w, t, m) => ({ d, w, t, ...(m !== undefined ? { _m: m } : {}) })
const ids = arr => arr.map(x => x.id ?? x.d).sort()
const strip = s => {
  const c = JSON.parse(JSON.stringify(s))
  c.routines.sort((a, b) => (a.id < b.id ? -1 : 1))
  c.customEx.sort((a, b) => (a.id < b.id ? -1 : 1))
  return c
}

afterEach(() => vi.useRealTimers())

describe('helpers', () => {
  it('COACH_LOG_MAX mirrors coach.js', () => expect(COACH_LOG_MAX).toBe(LOG_MAX))
  it('hasData', () => {
    expect(hasData(base())).toBe(false)
    expect(hasData(null)).toBe(false)
    expect(hasData(base({ workouts: [W('a', '2026-01-01', 1)] }))).toBe(true)
    expect(hasData(base({ bodyweight: [B('2026-01-01', 80, 1)] }))).toBe(true)
  })
  it('stampItem sets t and _m to now', () => {
    vi.useFakeTimers(); vi.setSystemTime(5000)
    const it = stampItem({ id: 'x' })
    expect(it.t).toBe(5000); expect(it._m).toBe(5000)
  })
  it('markDeleted writes a tombstone', () => {
    vi.useFakeTimers(); vi.setSystemTime(7000)
    const s = base()
    markDeleted(s, 'bodyweight', '2026-01-02')
    markDeleted(s, 'workouts', 'w1')
    expect(s._del).toEqual({ bodyweight: { '2026-01-02': 7000 }, workouts: { w1: 7000 } })
  })
  it('itemVersion fallbacks', () => {
    expect(itemVersion('workouts', { start: 3, end: 9 })).toBe(9)
    expect(itemVersion('workouts', { start: 3 })).toBe(3)
    expect(itemVersion('routines', { id: 'r' })).toBe(0)
    expect(itemVersion('bodyweight', { d: 'x', t: 4 })).toBe(4)
    expect(itemVersion('bodyweight', { d: 'x', t: 4, _m: 8 })).toBe(8)
  })
})

describe('stampChanges', () => {
  it('stamps added and edited items, leaves untouched ones, tombstones removed ones', () => {
    const prev = base({ workouts: [W('a', '2026-01-01', 1), W('b', '2026-01-02', 1)], routines: [R('r1', 'A', 1), R('r2', 'B', 1)] })
    const next = JSON.parse(JSON.stringify(prev))
    next.workouts = next.workouts.filter(w => w.id !== 'b')
    next.workouts.push(W('c', '2026-01-03', undefined))
    next.routines[0].name = 'A2'
    stampChanges(prev, next, 99)
    expect(next.workouts.find(w => w.id === 'a')._m).toBe(1)
    expect(next.workouts.find(w => w.id === 'c')._m).toBe(99)
    expect(next.routines[0]._m).toBe(99)
    expect(next.routines[1]._m).toBe(1)
    expect(next._del.workouts).toEqual({ b: 99 })
  })
  it('keys bodyweight by date and keeps the weigh-in time t', () => {
    const prev = base({ bodyweight: [B('2026-01-01', 80, 111, 111)] })
    const next = JSON.parse(JSON.stringify(prev))
    next.bodyweight.push(B('2025-06-01', 82, 50))   // imported, t in the past
    stampChanges(prev, next, 500)
    expect(next.bodyweight[1]).toEqual({ d: '2025-06-01', w: 82, t: 50, _m: 500 })
    next.bodyweight = []
    stampChanges(prev, next, 600)
    expect(next._del.bodyweight).toEqual({ '2026-01-01': 600 })
  })
  it('a wholesale replacement keeps earlier tombstones and tombstones everything removed', () => {
    const prev = base({ workouts: [W('a', '2026-01-01', 1)], _del: { routines: { r9: 3 } } })
    const next = base()
    stampChanges(prev, next, 50)
    expect(next._del.routines).toEqual({ r9: 3 })
    expect(next._del.workouts).toEqual({ a: 50 })
  })
  it('imported old-t entry for a previously deleted date survives a merge', () => {
    const prev = base({ _del: { bodyweight: { '2025-06-01': 400 } } })
    const next = JSON.parse(JSON.stringify(prev))
    next.bodyweight.push(B('2025-06-01', 82, 50))
    stampChanges(prev, next, 500)
    const m = mergeStates(next, base({ _del: { bodyweight: { '2025-06-01': 400 } } }))
    expect(m.bodyweight.map(b => b.d)).toEqual(['2025-06-01'])
  })
})

describe('mergeStates', () => {
  it('identical inputs → same data', () => {
    const a = base({ workouts: [W('a', '2026-01-01', 5)], routines: [R('r', 'X', 5)], exWeights: { bp: { w: 60, d: '2026-01-01' } } })
    const m = mergeStates(a, JSON.parse(JSON.stringify(a)))
    expect(m.workouts).toEqual(a.workouts)
    expect(m.routines).toEqual(a.routines)
    expect(m.exWeights).toEqual(a.exWeights)
    expect(m._ts).toBe(1000)
  })

  it('disjoint data → union, sorted', () => {
    const a = base({ workouts: [W('b', '2026-01-05', 5)], bodyweight: [B('2026-01-05', 80, 5)], customEx: [{ id: 'c1', n: 'X', _m: 1 }] })
    const b = base({ workouts: [W('a', '2026-01-01', 5)], bodyweight: [B('2026-01-01', 81, 5)], routines: [R('r', 'R', 1)], customEx: [{ id: 'c2', n: 'Y', _m: 1 }] })
    const m = mergeStates(a, b)
    expect(m.workouts.map(w => w.id)).toEqual(['a', 'b'])
    expect(m.bodyweight.map(x => x.d)).toEqual(['2026-01-01', '2026-01-05'])
    expect(ids(m.routines)).toEqual(['r'])
    expect(ids(m.customEx)).toEqual(['c1', 'c2'])
  })

  it('edit vs edit: newer version wins either way round; tie prefers local', () => {
    const a = base({ routines: [R('r', 'local', 10)] })
    const b = base({ routines: [R('r', 'remote', 20)] })
    expect(mergeStates(a, b).routines[0].name).toBe('remote')
    expect(mergeStates(b, a).routines[0].name).toBe('remote')
    const c = base({ routines: [R('r', 'other', 10)] })
    expect(mergeStates(a, c).routines[0].name).toBe('local')
  })

  it('workouts without stamps fall back to end/start', () => {
    const a = base({ workouts: [{ id: 'w', d: '2026-01-01', start: 1, end: 50, name: 'old' }] })
    const b = base({ workouts: [{ id: 'w', d: '2026-01-01', start: 1, end: 50, name: 'edited', _m: 60 }] })
    expect(mergeStates(a, b).workouts[0].name).toBe('edited')
  })

  it('delete beats an older edit (both directions)', () => {
    const a = base({ workouts: [], _del: { workouts: { w: 100 } } })
    const b = base({ workouts: [W('w', '2026-01-01', 50)] })
    expect(mergeStates(a, b).workouts).toEqual([])
    expect(mergeStates(b, a).workouts).toEqual([])
    expect(mergeStates(b, a)._del.workouts).toEqual({ w: 100 })
  })

  it('edit after delete survives', () => {
    const a = base({ routines: [], _del: { routines: { r: 100 } } })
    const b = base({ routines: [R('r', 'revived', 150)] })
    expect(mergeStates(a, b).routines.map(r => r.name)).toEqual(['revived'])
    expect(mergeStates(b, a).routines.map(r => r.name)).toEqual(['revived'])
  })

  it('tombstones union with max ts', () => {
    const a = base({ _del: { workouts: { x: 5, y: 9 } } })
    const b = base({ _del: { workouts: { x: 7 }, customEx: { c: 3 } } })
    const m = mergeStates(a, b)
    expect(m._del.workouts).toEqual({ x: 7, y: 9 })
    expect(m._del.customEx).toEqual({ c: 3 })
  })

  it('bodyweight on the same date: newer stamp wins, deleted date drops', () => {
    const a = base({ bodyweight: [B('2026-01-01', 80, 100)] })
    const b = base({ bodyweight: [B('2026-01-01', 79, 200)] })
    expect(mergeStates(a, b).bodyweight).toEqual([B('2026-01-01', 79, 200)])
    const c = base({ bodyweight: [], _del: { bodyweight: { '2026-01-01': 150 } } })
    expect(mergeStates(a, c).bodyweight).toEqual([])
    expect(mergeStates(b, c).bodyweight).toHaveLength(1)
  })

  it('exWeights: later date wins, tie → higher weight', () => {
    const a = base({ exWeights: { bp: { w: 60, d: '2026-01-02' }, sq: { w: 100, d: '2026-01-01' }, dl: { w: 140, d: '2026-01-01' } } })
    const b = base({ exWeights: { bp: { w: 70, d: '2026-01-01' }, sq: { w: 105, d: '2026-01-01' }, ohp: { w: 40, d: '2026-01-01' } } })
    const m = mergeStates(a, b)
    expect(m.exWeights).toEqual({ bp: { w: 60, d: '2026-01-02' }, sq: { w: 105, d: '2026-01-01' }, dl: { w: 140, d: '2026-01-01' }, ohp: { w: 40, d: '2026-01-01' } })
    expect(mergeStates(b, a).exWeights).toEqual(m.exWeights)
  })

  it('settings come whole from the side with newer _ts', () => {
    const a = base({ unit: 'lb', theme: 'light', week: { 1: 'r' }, _ts: 2000 })
    const b = base({ unit: 'kg', theme: 'dark', week: {}, restSec: 120, _ts: 1000 })
    for (const m of [mergeStates(a, b), mergeStates(b, a)]) {
      expect(m.unit).toBe('lb'); expect(m.theme).toBe('light'); expect(m.week).toEqual({ 1: 'r' })
      expect(m.restSec).toBe(90)
      expect(m._ts).toBe(2000)
    }
  })

  it('active is never carried from remote', () => {
    const a = base({ active: null })
    const b = base({ active: { id: 'remote-run' }, _ts: 9999 })
    expect(mergeStates(a, b).active).toBe(null)
    const c = base({ active: { id: 'mine' } })
    expect(mergeStates(c, b).active).toEqual({ id: 'mine' })
  })

  it('does not mutate inputs', () => {
    const a = base({ workouts: [W('a', '2026-01-01', 1)] })
    const b = base({ workouts: [W('b', '2026-01-02', 1)], _del: { workouts: { a: 5 } } })
    const sa = JSON.stringify(a), sb = JSON.stringify(b)
    mergeStates(a, b)
    expect(JSON.stringify(a)).toBe(sa); expect(JSON.stringify(b)).toBe(sb)
  })

  it('coach: scalars from newer side, log unioned and trimmed, one-sided namespace kept', () => {
    const coachA = { consent: { agreedAt: 'x', version: 1 }, profile: { goal: 'a' }, instructions: 'A', log: [{ id: 'l1', at: 1 }, { id: 'l2', at: 3 }], snapshots: [{ id: 's-a' }] }
    const coachB = { consent: null, profile: { goal: 'b' }, instructions: 'B', log: [{ id: 'l1', at: 1 }, { id: 'l3', at: 2 }, { at: 4, type: 'x' }], snapshots: [{ id: 's-b' }] }
    const a = base({ coach: coachA, _ts: 2000 })
    const b = base({ coach: coachB, _ts: 1000 })
    const m = mergeStates(a, b)
    expect(m.coach.instructions).toBe('A')
    expect(m.coach.profile).toEqual({ goal: 'a' })
    expect(m.coach.snapshots).toEqual([{ id: 's-a' }])
    expect(m.coach.log.map(e => e.id ?? e.type)).toEqual(['l1', 'l3', 'l2', 'x'])
    expect(mergeStates(b, a).coach).toEqual(m.coach)
    expect(mergeStates(base(), b).coach).toEqual(coachB)
    expect(mergeStates(a, base({ _ts: 5000 })).coach).toEqual(coachA)

    const many = n => Array.from({ length: n }, (_, i) => ({ id: 'e' + i, at: i }))
    const big = mergeStates(base({ coach: { log: many(LOG_MAX) } }), base({ coach: { log: [{ id: 'z', at: 1e9 }] } }))
    expect(big.coach.log).toHaveLength(LOG_MAX)
    expect(big.coach.log.at(-1).id).toBe('z')
  })

  it('is idempotent: merge(merge(a,b),b) == merge(a,b)', () => {
    const a = base({
      workouts: [W('a', '2026-01-01', 10), W('c', '2026-01-03', 10)], routines: [R('r1', 'A', 10)],
      bodyweight: [B('2026-01-01', 80, 10)], _del: { workouts: { z: 30 } }, unit: 'lb', _ts: 3000,
      coach: { instructions: 'A', log: [{ id: '1', at: 1 }] }, active: { id: 'mine' },
    })
    const b = base({
      workouts: [W('a', '2026-01-01', 20, { name: 'b' }), W('z', '2026-01-09', 10)], routines: [R('r2', 'B', 10)],
      bodyweight: [B('2026-01-01', 79, 5), B('2026-01-02', 78, 5)], _del: { routines: { r1: 5 } }, _ts: 2000,
      coach: { instructions: 'B', log: [{ id: '2', at: 2 }] }, exWeights: { bp: { w: 50, d: '2026-01-01' } },
    })
    const m1 = mergeStates(a, b)
    expect(mergeStates(m1, b)).toEqual(m1)
    expect(mergeStates(m1, m1)).toEqual(m1)
    expect(m1.workouts.map(w => w.id)).toEqual(['a', 'c'])
    expect(m1.workouts[0].name).toBe('b')
    expect(ids(m1.routines)).toEqual(['r1', 'r2'])   // r1 edited (10) after its tombstone (5)
  })

  it('is commutative in its data content', () => {
    const a = base({
      workouts: [W('a', '2026-01-01', 10), W('c', '2026-01-03', 10)], routines: [R('r1', 'A', 10), R('r3', 'C', 1)],
      customEx: [{ id: 'x', n: 'X', _m: 4 }], bodyweight: [B('2026-01-01', 80, 10)], _del: { workouts: { z: 30 } }, _ts: 3000,
      exWeights: { bp: { w: 60, d: '2026-01-02' } },
    })
    const b = base({
      workouts: [W('a', '2026-01-01', 20, { name: 'b' }), W('z', '2026-01-09', 10)], routines: [R('r2', 'B', 10), R('r3', 'C2', 2)],
      customEx: [{ id: 'x', n: 'X2', _m: 2 }], bodyweight: [B('2026-01-01', 79, 15)], _del: { routines: { r1: 50 } }, _ts: 2000,
      exWeights: { bp: { w: 65, d: '2026-01-01' } },
    })
    expect(strip(mergeStates(a, b))).toEqual(strip(mergeStates(b, a)))
  })
})

describe('exWeights deletions', () => {
  const base = (exWeights, extra = {}) => ({ _ts: 1, workouts: [], routines: [], customEx: [], bodyweight: [], exWeights, ...extra })

  it('stampChanges stamps changed entries and tombstones removed ones', () => {
    const prev = base({ a: { w: 50, d: '2026-10-01' }, b: { w: 20, d: '2026-10-01' } })
    const next = base({ a: { w: 55, d: '2026-10-02' } })
    stampChanges(prev, next, 1000)
    expect(next.exWeights.a._m).toBe(1000)
    expect(next._del.exWeights.b).toBe(1000)
  })

  it('"reset everything" does not get remembered weights back from Drive', () => {
    const prev = base({ a: { w: 50, d: '2026-10-01' } })
    const reset = base({}, { _ts: 5 })
    stampChanges(prev, reset, 2000)
    const remote = base({ a: { w: 50, d: '2026-10-01' } })
    expect(mergeStates(reset, remote).exWeights).toEqual({})
    expect(mergeStates(remote, reset).exWeights).toEqual({})
  })

  it('a weight logged after the deletion survives', () => {
    const local = base({}, { _del: { exWeights: { a: 2000 } } })
    const remote = base({ a: { w: 60, d: '2026-10-05', _m: 3000 } })
    expect(mergeStates(local, remote).exWeights.a.w).toBe(60)
  })
})
