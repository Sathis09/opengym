import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAI, getAIKey, keyName, __setKeyBackend, __resetAILoad } from './useAI.js'

function memStorage() {
  const m = new Map()
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear() }
}
function memKeys() {
  const m = new Map()
  return { m, get: async k => m.get(k) ?? null, set: async (k, v) => { m.set(k, v) }, remove: async k => { m.delete(k) } }
}

let keys
beforeEach(() => {
  vi.stubGlobal('localStorage', memStorage())
  keys = memKeys()
  __setKeyBackend(keys)
  __resetAILoad()
  useAI.setState({ provider: 'openai', model: null, models: {}, hasKey: false, ready: false })
})

describe('useAI', () => {
  it('loads prefs and key presence, and is safe to call twice', async () => {
    localStorage.setItem('gp_ai', JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-5-5', models: { anthropic: 'claude-sonnet-5-5' } }))
    keys.m.set('gp_ai_key_anthropic', 'sk-ant-x')
    const a = useAI.getState().load(), b = useAI.getState().load()
    expect(a).toBe(b)
    await a
    const s = useAI.getState()
    expect(s).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5', hasKey: true, ready: true })
  })

  it('stores the key under gp_ai_key_<provider>, never in state or localStorage', async () => {
    await useAI.getState().load()
    await useAI.getState().saveKey('  sk-SECRET  ')
    expect(keys.m.get(keyName('openai'))).toBe('sk-SECRET')
    expect(useAI.getState().hasKey).toBe(true)
    expect(JSON.stringify(useAI.getState())).not.toContain('SECRET')
    expect(localStorage.getItem('gp_ai') || '').not.toContain('SECRET')
    expect(await getAIKey()).toBe('sk-SECRET')
  })

  it('hasKey follows the current provider, and models are remembered per provider', async () => {
    await useAI.getState().load()
    await useAI.getState().saveKey('k1')
    useAI.getState().setModel('gpt-5-mini')
    await useAI.getState().setProvider('gemini')
    expect(useAI.getState()).toMatchObject({ provider: 'gemini', model: null, hasKey: false })
    await useAI.getState().setProvider('openai')
    expect(useAI.getState()).toMatchObject({ provider: 'openai', model: 'gpt-5-mini', hasKey: true })
    expect(JSON.parse(localStorage.getItem('gp_ai'))).toMatchObject({ provider: 'openai', model: 'gpt-5-mini' })
  })

  it('removeKey clears only the current provider', async () => {
    keys.m.set('gp_ai_key_groq', 'g')
    await useAI.getState().load()
    await useAI.getState().saveKey('o')
    await useAI.getState().removeKey()
    expect(useAI.getState().hasKey).toBe(false)
    expect(keys.m.has('gp_ai_key_openai')).toBe(false)
    expect(keys.m.get('gp_ai_key_groq')).toBe('g')
  })

  it('ignores an unknown provider', async () => {
    localStorage.setItem('gp_ai', JSON.stringify({ provider: 'nope' }))
    await useAI.getState().load()
    expect(useAI.getState().provider).toBe('openai')
    await useAI.getState().setProvider('nope')
    expect(useAI.getState().provider).toBe('openai')
  })
})
