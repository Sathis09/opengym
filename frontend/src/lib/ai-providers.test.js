import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PROVIDERS, listModels, complete, testConnection, mapHttpError, AIError } from './ai-providers.js'

/** A fetch mock that records calls and answers with the given (status, body). */
function mockFetch(...answers) {
  const calls = []
  const fn = vi.fn(async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined })
    const a = answers.length > 1 ? answers.shift() : answers[0]
    if (a instanceof Error) throw a
    const { status = 200, body = {} } = a
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }
  })
  globalThis.fetch = fn
  return calls
}

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch; vi.useRealTimers() })

describe('PROVIDERS', () => {
  it('lists the five providers with fallbacks', () => {
    expect(PROVIDERS.map(p => p.id)).toEqual(['openai', 'anthropic', 'gemini', 'groq', 'openrouter'])
    PROVIDERS.forEach(p => {
      expect(p.label).toBeTruthy(); expect(p.keyHint).toBeTruthy(); expect(p.keyUrl).toMatch(/^https:/)
      expect(p.fallbackModels.length).toBeGreaterThan(0)
    })
    expect(PROVIDERS.find(p => p.id === 'anthropic').fallbackModels).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'])
  })
})

describe('complete — request shape and text extraction', () => {
  const base = { model: 'm1', key: 'KEY', system: 'SYS', prompt: 'PROMPT' }

  it('openai', async () => {
    const calls = mockFetch({ body: { choices: [{ message: { content: '{"a":1}' } }] } })
    const text = await complete({ ...base, provider: 'openai' })
    expect(text).toBe('{"a":1}')
    const c = calls[0]
    expect(c.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(c.init.method).toBe('POST')
    expect(c.init.headers.authorization).toBe('Bearer KEY')
    expect(c.body).toEqual({
      model: 'm1', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'PROMPT' }],
      response_format: { type: 'json_object' }
    })
  })

  it('groq is OpenAI-compatible at its own base URL', async () => {
    const calls = mockFetch({ body: { choices: [{ message: { content: 'x' } }] } })
    await complete({ ...base, provider: 'groq' })
    expect(calls[0].url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(calls[0].init.headers.authorization).toBe('Bearer KEY')
    expect(calls[0].body.response_format).toEqual({ type: 'json_object' })
  })

  it('openrouter adds its attribution headers', async () => {
    const calls = mockFetch({ body: { choices: [{ message: { content: 'y' } }] } })
    expect(await complete({ ...base, provider: 'openrouter' })).toBe('y')
    const h = calls[0].init.headers
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(h.authorization).toBe('Bearer KEY')
    expect(h['HTTP-Referer']).toBe('https://github.com/gympulse')
    expect(h['X-Title']).toBe('Gym Plus')
  })

  it('anthropic', async () => {
    const calls = mockFetch({ body: { content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: '{"b"' }, { type: 'text', text: ':2}' }] } })
    expect(await complete({ ...base, provider: 'anthropic' })).toBe('{"b":2}')
    const c = calls[0]
    expect(c.url).toBe('https://api.anthropic.com/v1/messages')
    expect(c.init.headers['x-api-key']).toBe('KEY')
    expect(c.init.headers['anthropic-version']).toBe('2023-06-01')
    expect(c.init.headers['anthropic-dangerous-direct-browser-access']).toBe('true')
    expect(c.init.headers.authorization).toBeUndefined()
    expect(c.body.model).toBe('m1')
    expect(c.body.max_tokens).toBeGreaterThan(0)
    expect(c.body.system).toBe('SYS')
    expect(c.body.messages).toEqual([{ role: 'user', content: 'PROMPT' }])
  })

  it('gemini', async () => {
    const calls = mockFetch({ body: { candidates: [{ content: { parts: [{ text: '{"c":' }, { text: '3}' }] } }] } })
    expect(await complete({ ...base, provider: 'gemini', model: 'gemini-2.5-flash' })).toBe('{"c":3}')
    const c = calls[0]
    expect(c.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent')
    expect(c.init.headers['x-goog-api-key']).toBe('KEY')
    expect(c.url).not.toContain('KEY')
    expect(c.body).toEqual({
      systemInstruction: { parts: [{ text: 'SYS' }] },
      contents: [{ role: 'user', parts: [{ text: 'PROMPT' }] }],
      generationConfig: { responseMimeType: 'application/json' }
    })
  })

  it('refuses to call without a key or a model', async () => {
    mockFetch({ body: {} })
    await expect(complete({ ...base, provider: 'openai', key: '' })).rejects.toMatchObject({ code: 'key' })
    await expect(complete({ ...base, provider: 'openai', model: '' })).rejects.toMatchObject({ code: 'model' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('listModels', () => {
  it('openai: drops models that cannot chat', async () => {
    const calls = mockFetch({ body: { data: [{ id: 'gpt-5' }, { id: 'text-embedding-3-small' }, { id: 'whisper-1' }, { id: 'gpt-4.1-mini' }, { id: 'dall-e-3' }] } })
    expect(await listModels('openai', 'KEY')).toEqual(['gpt-4.1-mini', 'gpt-5'])
    expect(calls[0].url).toBe('https://api.openai.com/v1/models')
    expect(calls[0].init.headers.authorization).toBe('Bearer KEY')
  })

  it('anthropic', async () => {
    const calls = mockFetch({ body: { data: [{ id: 'claude-sonnet-5-5', display_name: 'Sonnet' }, { id: 'claude-haiku-5-5' }] } })
    expect(await listModels('anthropic', 'KEY')).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5'])
    expect(calls[0].url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/models/)
    expect(calls[0].init.headers['x-api-key']).toBe('KEY')
    expect(calls[0].init.headers['anthropic-version']).toBe('2023-06-01')
  })

  it('gemini: generateContent-capable only, prefix stripped, pages followed', async () => {
    const calls = mockFetch(
      { body: { models: [
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }
      ], nextPageToken: 'p2' } },
      { body: { models: [{ name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] }] } }
    )
    expect(await listModels('gemini', 'KEY')).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro'])
    expect(calls[0].url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\?/)
    expect(calls[0].init.headers['x-goog-api-key']).toBe('KEY')
    expect(calls[1].url).toContain('pageToken=p2')
  })

  it('groq and openrouter', async () => {
    let calls = mockFetch({ body: { data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'whisper-large-v3' }] } })
    expect(await listModels('groq', 'K')).toEqual(['llama-3.3-70b-versatile'])
    expect(calls[0].url).toBe('https://api.groq.com/openai/v1/models')
    calls = mockFetch({ body: { data: [{ id: 'openai/gpt-5' }, { id: 'anthropic/claude-sonnet-5-5' }] } })
    expect(await listModels('openrouter', 'K')).toEqual(['anthropic/claude-sonnet-5-5', 'openai/gpt-5'])
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/models')
    expect(calls[0].init.headers['X-Title']).toBe('Gym Plus')
  })
})

describe('error mapping', () => {
  it('maps HTTP status to the contract codes', () => {
    expect(mapHttpError(401).code).toBe('key')
    expect(mapHttpError(403).code).toBe('key')
    expect(mapHttpError(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }).code).toBe('key')
    expect(mapHttpError(429).code).toBe('rate')
    expect(mapHttpError(404).code).toBe('model')
    expect(mapHttpError(400, { error: { message: 'The model `nope` does not exist' } }).code).toBe('model')
    expect(mapHttpError(500).code).toBe('failed')
    expect(mapHttpError(400, { error: { message: 'bad request' } }).code).toBe('failed')
    for (const code of ['key', 'rate', 'model', 'failed']) expect(new AIError(code).message.length).toBeGreaterThan(5)
  })

  it('surfaces HTTP failures from complete', async () => {
    mockFetch({ status: 401, body: { error: { message: 'invalid x-api-key' } } })
    await expect(complete({ provider: 'anthropic', model: 'm', key: 'bad', prompt: 'p' })).rejects.toMatchObject({ code: 'key', status: 401 })
    mockFetch({ status: 429, body: {} })
    await expect(complete({ provider: 'openai', model: 'm', key: 'k', prompt: 'p' })).rejects.toMatchObject({ code: 'rate' })
    mockFetch({ status: 404, body: { error: { message: 'model not found' } } })
    await expect(complete({ provider: 'gemini', model: 'm', key: 'k', prompt: 'p' })).rejects.toMatchObject({ code: 'model' })
  })

  it('a network failure is offline', async () => {
    mockFetch(new TypeError('Failed to fetch'))
    await expect(complete({ provider: 'groq', model: 'm', key: 'k', prompt: 'p' })).rejects.toMatchObject({ code: 'offline' })
  })

  it('a slow provider times out', async () => {
    globalThis.fetch = vi.fn((url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }))
    await expect(complete({ provider: 'openai', model: 'm', key: 'k', prompt: 'p', timeoutMs: 20 })).rejects.toMatchObject({ code: 'timeout' })
  })

  it('never puts the key in an error message', async () => {
    mockFetch({ status: 401, body: { error: { message: 'Incorrect API key provided: sk-SECRET' } } })
    const e = await complete({ provider: 'openai', model: 'm', key: 'sk-SECRET', prompt: 'p' }).catch(x => x)
    expect(e.message).not.toContain('SECRET')
  })
})

describe('testConnection', () => {
  it('ok when the model echoes the probe', async () => {
    mockFetch({ body: { choices: [{ message: { content: '{"ok":true}' } }] } })
    expect(await testConnection('openai', 'k', 'gpt-5')).toEqual({ ok: true })
  })
  it('without a model, checks the key by listing models', async () => {
    const calls = mockFetch({ body: { data: [] } })
    expect(await testConnection('anthropic', 'k')).toEqual({ ok: true })
    expect(calls[0].url).toMatch(/\/v1\/models/)
  })
  it('reports a code and a message on failure', async () => {
    mockFetch({ status: 401, body: {} })
    const r = await testConnection('gemini', 'bad', 'gemini-2.5-flash')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('key')
    expect(typeof r.error).toBe('string')
  })
})
