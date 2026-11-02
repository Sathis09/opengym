// The mobile Coach's AI connection: which provider, which model, and whether a key is set.
//
// The key itself never enters this store, the synced state `S`, a backup or a log. It lives
// in the OS keystore (iOS Keychain / Android Keystore, via @aparajita/capacitor-secure-storage)
// and is read only at the moment a request is made — see getAIKey(). Provider and model are
// not secret and sit in localStorage under `gp_ai`.
//
// On the web build nothing here is used; if it is touched in a browser dev session the key
// falls back to memory only (lost on reload) with a console warning.
import { create } from 'zustand'
import { MOBILE } from '../lib/mobile.js'
import { PROVIDERS, providerById } from '../lib/ai-providers.js'

const LS_KEY = 'gp_ai'
export const keyName = provider => 'gp_ai_key_' + provider
const DEFAULT_PROVIDER = PROVIDERS[0].id

/* ---------- small storage helpers ---------- */

const ls = () => { try { return globalThis.localStorage || null } catch { return null } }
function readPrefs() {
  try { return JSON.parse(ls()?.getItem(LS_KEY) || 'null') || {} } catch { return {} }
}
function writePrefs(p) {
  try { ls()?.setItem(LS_KEY, JSON.stringify(p)) } catch { /* private mode etc. — keep in memory */ }
}

/* ---------- key storage backend ---------- */

let backend = null
let warned = false
function memoryBackend() {
  const mem = new Map()
  return {
    get: async k => (mem.has(k) ? mem.get(k) : null),
    set: async (k, v) => { mem.set(k, v) },
    remove: async k => { mem.delete(k) }
  }
}
async function keyStore() {
  if (backend) return backend
  if (MOBILE) {
    try {
      const { SecureStorage } = await import('@aparajita/capacitor-secure-storage')
      backend = {
        get: k => SecureStorage.getItem(k),
        set: (k, v) => SecureStorage.setItem(k, v),
        remove: k => SecureStorage.removeItem(k)
      }
      return backend
    } catch { /* fall through to memory */ }
  }
  if (!warned) { warned = true; console.warn('Gym Plus: no secure storage here — the AI key is kept in memory only.') }
  backend = memoryBackend()
  return backend
}
/** Tests only: swap the key backend. */
export function __setKeyBackend(b) { backend = b }

/** The key for a provider (default: the current one), or null. Never put it in state. */
export async function getAIKey(provider) {
  const p = provider || useAI.getState().provider
  if (!p) return null
  try {
    const v = await (await keyStore()).get(keyName(p))
    return typeof v === 'string' && v ? v : null
  } catch { return null }
}

/* ---------- the store ---------- */

const persist = (provider, model, models) => writePrefs({ provider, model, models })

let loading = null

export const useAI = create((set, get) => ({
  provider: DEFAULT_PROVIDER,
  model: null,
  models: {},          // last model chosen per provider, so switching back restores it
  hasKey: false,
  ready: false,

  /** Read prefs and whether a key exists. Idempotent — concurrent and repeated calls share one load. */
  load() {
    if (!loading) {
      loading = (async () => {
        const p = readPrefs()
        const provider = providerById(p.provider) ? p.provider : DEFAULT_PROVIDER
        const models = p.models && typeof p.models === 'object' ? p.models : {}
        const model = typeof p.model === 'string' && p.model ? p.model : (models[provider] || null)
        const hasKey = !!(await getAIKey(provider))
        set({ provider, model, models, hasKey, ready: true })
      })().catch(() => set({ ready: true }))
    }
    return loading
  },

  async setProvider(provider) {
    if (!providerById(provider)) return
    const { models } = get()
    const model = models[provider] || null
    set({ provider, model, hasKey: false })
    persist(provider, model, models)
    const hasKey = !!(await getAIKey(provider))
    if (get().provider === provider) set({ hasKey })
  },

  setModel(model) {
    const m = String(model || '').trim().slice(0, 120) || null
    const { provider, models } = get()
    const next = { ...models, [provider]: m }
    set({ model: m, models: next })
    persist(provider, m, next)
  },

  async saveKey(key) {
    const k = String(key || '').trim()
    if (!k) return get().removeKey()
    const { provider } = get()
    await (await keyStore()).set(keyName(provider), k)
    if (get().provider === provider) set({ hasKey: true })
  },

  async removeKey() {
    const { provider } = get()
    try { await (await keyStore()).remove(keyName(provider)) } catch { /* already gone */ }
    if (get().provider === provider) set({ hasKey: false })
  }
}))

/** Tests only: forget the memoised load so a fresh one can run. */
export function __resetAILoad() { loading = null }
