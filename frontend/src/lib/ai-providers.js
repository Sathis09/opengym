// Bring-your-own-key AI providers, for the mobile build's Coach.
//
// On the phone there is no server to run a CLI, so the Coach calls the user's own provider
// directly with the user's own key. Every provider is reduced to the same three calls —
// list models, test a key, complete one prompt — so nothing above this file branches on which
// provider someone picked.
//
// Plain fetch with a timeout. On device Capacitor's native HTTP (CapacitorHttp) patches fetch,
// so CORS never applies there. Keys and prompts are never logged — this file does not log at all.

export const PROVIDERS = [
  {
    id: 'openai', label: 'OpenAI', keyHint: 'sk-…', keyUrl: 'https://platform.openai.com/api-keys',
    fallbackModels: ['gpt-5-mini', 'gpt-5', 'gpt-4.1-mini']
  },
  {
    id: 'anthropic', label: 'Anthropic (Claude)', keyHint: 'sk-ant-…', keyUrl: 'https://console.anthropic.com/settings/keys',
    fallbackModels: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5']
  },
  {
    id: 'gemini', label: 'Google Gemini', keyHint: 'AIza…', keyUrl: 'https://aistudio.google.com/app/apikey',
    fallbackModels: ['gemini-2.5-flash', 'gemini-2.5-pro']
  },
  {
    id: 'groq', label: 'Groq', keyHint: 'gsk_…', keyUrl: 'https://console.groq.com/keys',
    fallbackModels: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b']
  },
  {
    id: 'openrouter', label: 'OpenRouter', keyHint: 'sk-or-…', keyUrl: 'https://openrouter.ai/keys',
    fallbackModels: ['openai/gpt-5-mini', 'anthropic/claude-sonnet-5-5', 'google/gemini-2.5-flash']
  }
]
export const providerById = id => PROVIDERS.find(p => p.id === id) || null

const OPENAI_COMPAT = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1'
}
const ANTHROPIC = 'https://api.anthropic.com/v1'
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta'

export const DEFAULT_TIMEOUT_MS = 3 * 60000
const LIST_TIMEOUT_MS = 20000

/* ------------------------------ errors ------------------------------ */

const MESSAGES = {
  key: 'The provider rejected the API key.',
  rate: 'The provider is rate-limiting this key — wait a moment and try again.',
  model: 'The provider does not offer that model to this key.',
  offline: 'Could not reach the provider — check your connection.',
  timeout: 'The provider took too long to answer.',
  failed: 'The provider could not complete the request.'
}

export class AIError extends Error {
  constructor(code, message, status) {
    super(message || MESSAGES[code] || MESSAGES.failed)
    this.code = code
    if (status) this.status = status
  }
}

/** Map an HTTP failure to one of the contract's codes, with a short human message. */
export function mapHttpError(status, body) {
  const text = String(
    body?.error?.message || body?.error?.type || body?.message || (typeof body?.error === 'string' ? body.error : '') || ''
  )
  const low = text.toLowerCase()
  if (status === 401 || status === 403) return new AIError('key', null, status)
  // Gemini answers a bad key with 400 "API key not valid".
  if (status === 400 && /api[ _-]?key/.test(low)) return new AIError('key', null, status)
  if (status === 429) return new AIError('rate', null, status)
  if (status === 404) return new AIError('model', null, status)
  if ((status === 400 || status === 422) && /model/.test(low) && /(not found|does not exist|not exist|invalid|unknown|not supported|decommissioned|no endpoints)/.test(low)) {
    return new AIError('model', null, status)
  }
  if (status === 402) return new AIError('failed', 'The provider refused the request — check the billing or credits on your account.', status)
  if (status >= 500) return new AIError('failed', 'The provider had a problem — try again shortly.', status)
  return new AIError('failed', null, status)
}

/* ------------------------------ transport ------------------------------ */

async function request(url, { method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
  let res
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    })
  } catch {
    clearTimeout(timer)
    throw timedOut ? new AIError('timeout') : new AIError('offline')
  }
  let data = null
  try {
    const raw = await res.text()
    data = raw ? JSON.parse(raw) : null
  } catch {
    if (timedOut) { clearTimeout(timer); throw new AIError('timeout') }
    data = null
  }
  clearTimeout(timer)
  if (!res.ok) throw mapHttpError(res.status, data)
  return data
}

const bearer = key => ({ authorization: 'Bearer ' + key })
const extraHeaders = provider => provider === 'openrouter'
  ? { 'HTTP-Referer': 'https://github.com/gympulse', 'X-Title': 'Gym Plus' }
  : {}
const anthropicHeaders = key => ({
  'x-api-key': key,
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true'
})

/* ------------------------------ models ------------------------------ */

// OpenAI's /models lists everything the key can touch: embeddings, audio, images. None of
// those can write a training plan, so they stay out of the picker.
const NOT_CHAT = /(embed|whisper|tts|dall-e|moderation|audio|realtime|transcribe|image|davinci|babbage|guard|search|sora)/i

/** Model ids the key can use, sorted. Throws AIError. */
export async function listModels(provider, key) {
  if (!providerById(provider)) throw new AIError('failed', 'Unknown provider.')
  if (provider === 'anthropic') {
    const d = await request(ANTHROPIC + '/models?limit=1000', { headers: anthropicHeaders(key), timeoutMs: LIST_TIMEOUT_MS })
    return uniqSorted((d?.data || []).map(m => m.id))
  }
  if (provider === 'gemini') {
    const out = []
    let page = ''
    for (let i = 0; i < 5; i++) {
      const d = await request(GEMINI + '/models?pageSize=1000' + (page ? '&pageToken=' + encodeURIComponent(page) : ''),
        { headers: { 'x-goog-api-key': key }, timeoutMs: LIST_TIMEOUT_MS })
      ;(d?.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent') && !NOT_CHAT.test(m.name || ''))
        .forEach(m => out.push(String(m.name).replace(/^models\//, '')))
      page = d?.nextPageToken
      if (!page) break
    }
    return uniqSorted(out)
  }
  const d = await request(OPENAI_COMPAT[provider] + '/models', {
    headers: { ...bearer(key), ...extraHeaders(provider) }, timeoutMs: LIST_TIMEOUT_MS
  })
  const ids = (d?.data || []).map(m => m.id)
  return uniqSorted(provider === 'openrouter' ? ids : ids.filter(id => !NOT_CHAT.test(id)))
}
const uniqSorted = ids => [...new Set(ids.filter(x => typeof x === 'string' && x))].sort()

/* ------------------------------ completion ------------------------------ */

/**
 * One prompt in, the model's text out. Throws AIError.
 * `json` asks for JSON mode where the provider has one; the caller still parses defensively.
 */
export async function complete({ provider, model, key, system, prompt, json = true, timeoutMs = DEFAULT_TIMEOUT_MS, maxTokens = 16000 }) {
  if (!providerById(provider)) throw new AIError('failed', 'Unknown provider.')
  if (!key) throw new AIError('key', 'No API key is set.')
  if (!model) throw new AIError('model', 'No model is selected.')

  if (provider === 'anthropic') {
    const d = await request(ANTHROPIC + '/messages', {
      method: 'POST', headers: anthropicHeaders(key), timeoutMs,
      body: {
        model, max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: prompt }]
      }
    })
    return (d?.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
  }

  if (provider === 'gemini') {
    const d = await request(GEMINI + '/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST', headers: { 'x-goog-api-key': key }, timeoutMs,
      body: {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        ...(json ? { generationConfig: { responseMimeType: 'application/json' } } : {})
      }
    })
    if (d?.promptFeedback?.blockReason) throw new AIError('failed', 'The provider blocked the request.')
    return (d?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('')
  }

  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }]
  // OpenRouter routes to many backends and not all accept response_format; the caller's
  // JSON extraction copes either way, so it is only asked for where it is dependable.
  const d = await request(OPENAI_COMPAT[provider] + '/chat/completions', {
    method: 'POST', headers: { ...bearer(key), ...extraHeaders(provider) }, timeoutMs,
    body: { model, messages, ...(json && provider !== 'openrouter' ? { response_format: { type: 'json_object' } } : {}) }
  })
  // OpenRouter can report an upstream failure inside a 200.
  if (d?.error) throw mapHttpError(typeof d.error.code === 'number' ? d.error.code : 500, d)
  const content = d?.choices?.[0]?.message?.content
  return Array.isArray(content) ? content.map(c => c?.text || '').join('') : String(content || '')
}

/**
 * Check a key (and, given one, a model) with a trivial round-trip that carries no user data.
 * → { ok:true } | { ok:false, code, error }   (error is a short human message)
 */
export async function testConnection(provider, key, model) {
  try {
    if (!model) { await listModels(provider, key); return { ok: true } }
    const text = await complete({
      provider, model, key, json: true, timeoutMs: 60000, maxTokens: 64,
      system: 'Reply with JSON only.',
      prompt: 'Reply with exactly this JSON object and nothing else: {"ok":true}'
    })
    if (!/"ok"\s*:\s*true/.test(text)) return { ok: false, code: 'failed', error: 'The provider answered, but not in the expected shape.' }
    return { ok: true }
  } catch (e) {
    return { ok: false, code: e.code || 'failed', error: e.code ? e.message : MESSAGES.failed }
  }
}
