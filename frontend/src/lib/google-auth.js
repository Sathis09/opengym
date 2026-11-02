// Google sign-in for the mobile build (Gym Plus), via @capgo/capacitor-social-login in
// 'online' mode: the device itself gets an OAuth access token and talks to the Drive REST API
// with it (lib/gdrive.js). There is no backend and no refresh token on our side.
//
// Token lifecycle, per what the plugin actually implements (7.20.x):
//   - login()                 interactive. Android: Credential Manager account sheet, then the
//                             Authorization API consent screen (skipped once scopes are granted).
//                             iOS: GoogleSignIn (restores a previous sign-in unless forcePrompt).
//   - getAuthorizationCode()  silent. iOS: GoogleSignIn refreshTokensIfNeeded → always a fresh
//                             token. Android: returns the last token if Google's tokeninfo still
//                             accepts it; once it has expired (~1 h) the plugin clears its state
//                             and rejects — Android then needs a (one-tap) interactive login.
//   - refresh()               not implemented on Android/web — not used.
// The access token is cached in memory only, with its real expiry read from Google's tokeninfo
// endpoint (neither platform reports expires_in). Tokens are never logged or persisted here.
//
// The plugin is only ever loaded through dynamic import(), so web bundles never need it.
import {
  GOOGLE_WEB_CLIENT_ID, GOOGLE_IOS_CLIENT_ID, GOOGLE_SCOPES, DRIVE_SCOPE,
  googleConfigured, missingConfigMessage,
} from './google-config.js'
import { resetDriveCache } from './gdrive.js'

const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo'
const SKEW_MS = 2 * 60 * 1000          // treat a token as expired this long before it really is
const UNKNOWN_TTL_MS = 5 * 60 * 1000   // tokeninfo unreachable → trust the token only briefly

export class GoogleAuthError extends Error {
  constructor(code, message, reason) {
    super(message || code)
    this.name = 'GoogleAuthError'
    this.code = code          // 'cancelled' | 'config' | 'network' | 'failed' | 'auth'
    if (reason) this.reason = reason
  }
}
const fail = (code, message, reason) => new GoogleAuthError(code, message, reason)

let initP = null      // initialize() promise (idempotent)
let cache = null      // { token, expiresAt }
let silentP = null    // single-flight silent refresh
let interactiveP = null

async function plugin() {
  try {
    const { SocialLogin } = await import('@capgo/capacitor-social-login')
    return SocialLogin
  } catch (e) {
    throw fail('config', 'Google sign-in is not available in this build.')
  }
}

// Plugin rejections are plain strings/Errors from native code; classify them by message.
// Android:  "Google Sign-In failed: activity is cancelled by the user." (Credential Manager)
//           "... Cannot get getAuthorizationResultFromIntent" (consent screen dismissed)
//           "[28444] Developer console is not set up correctly." / DEVELOPER_ERROR (SHA-1 / package)
// iOS:      "The user canceled the sign-in flow." (GIDSignInError -5)
// Web:      "Popup closed", "access_denied", "OAuth timeout"
export function mapAuthError(e, fallback = 'failed') {
  if (e instanceof GoogleAuthError) return e
  const msg = String((e && (e.message || e.errorMessage)) || e || '')
  const code = String((e && e.code) ?? '')
  if (/cancel|getAuthorizationResultFromIntent|popup closed|user closed|access_denied/i.test(msg) || code === '-5' || code === '12501') {
    return fail('cancelled', 'Sign-in was cancelled.')
  }
  if (/developer console|developer_error|\[10\]|\b10:|client ?id|not initialized|main activity|provider is disabled|invalid_client|unauthorized_client|redirect_uri_mismatch|not configured|No presenting view controller/i.test(msg) || code === '10') {
    return fail('config', `Google sign-in is misconfigured (${msg || 'unknown error'}). See docs/GOOGLE_SETUP.md — on Android this usually means the SHA-1 or package name of the Android OAuth client does not match this build.`)
  }
  if (/network|offline|internet|unable to resolve host|unknownhost|timed? ?out|timeout|connection|socket|\b7:/i.test(msg) || code === '7') {
    return fail('network', 'No connection to Google. Check your internet connection and try again.')
  }
  if (/no credentials available|no google accounts?/i.test(msg)) {
    return fail(fallback, 'No Google account is available on this device. Add one in the system settings, then try again.')
  }
  return fail(fallback, msg ? `Google sign-in failed: ${msg}` : 'Google sign-in failed.')
}

// Idempotent. Resolves false when this build has no client id for the platform (Google
// features stay hidden/disabled), true once the plugin is initialised.
export async function initGoogleAuth() {
  if (!googleConfigured()) return false
  if (!initP) {
    initP = (async () => {
      const SocialLogin = await plugin()
      const google = { mode: 'online' }
      if (GOOGLE_WEB_CLIENT_ID) google.webClientId = GOOGLE_WEB_CLIENT_ID   // Android + web
      if (GOOGLE_IOS_CLIENT_ID) google.iOSClientId = GOOGLE_IOS_CLIENT_ID   // iOS
      await SocialLogin.initialize({ google })
      return true
    })().catch(e => { initP = null; throw mapAuthError(e, 'config') })
  }
  return initP
}

// What Google says about a token: remaining lifetime and granted scopes. Sent as a POST form
// body so the token never ends up in a URL (CapacitorHttp logs request URLs).
async function inspectToken(token) {
  let r
  try {
    r = await fetch(TOKENINFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'access_token=' + encodeURIComponent(token),
    })
  } catch {
    return { valid: true, ttlMs: UNKNOWN_TTL_MS, scopes: null }   // offline: Drive calls will say so
  }
  if (r.ok) {
    let j = {}
    try { j = await r.json() } catch { /* keep defaults */ }
    const exp = Number(j.expires_in)
    return {
      valid: !(exp <= 0),
      ttlMs: exp > 0 ? exp * 1000 : UNKNOWN_TTL_MS,
      scopes: typeof j.scope === 'string' ? j.scope.split(/\s+/) : null,
    }
  }
  if (r.status === 400 || r.status === 401) return { valid: false }
  return { valid: true, ttlMs: UNKNOWN_TTL_MS, scopes: null }
}

// → { token, missingScope } | null (token rejected by Google). Caches usable tokens.
async function adopt(token) {
  const info = await inspectToken(token)
  if (!info.valid) return null
  if (info.scopes && !info.scopes.includes(DRIVE_SCOPE)) return { token, missingScope: true }
  cache = { token, expiresAt: Date.now() + info.ttlMs }
  return { token, missingScope: false }
}

const blank = v => (typeof v === 'string' && v.trim() ? v : null)

async function interactiveLogin({ reauth = false } = {}) {
  await initGoogleAuth()
  const SocialLogin = await plugin()
  const options = { scopes: GOOGLE_SCOPES }
  if (reauth) {
    // Android: the compact bottom sheet, pre-filtered to the account already used here; with a
    // single account it signs straight in (the plugin falls back to the full picker if needed).
    Object.assign(options, { style: 'bottom', filterByAuthorizedAccounts: true, autoSelectEnabled: true })
  } else {
    // iOS: always show Google's sheet for an explicit sign-in instead of silently restoring.
    options.forcePrompt = true
  }
  let res
  try {
    res = await SocialLogin.login({ provider: 'google', options })
  } catch (e) {
    throw mapAuthError(e)
  }
  const r = res && res.result
  const token = r && r.accessToken && r.accessToken.token
  if (!token) throw fail('failed', 'Google did not return an access token.')
  const adopted = await adopt(token)
  if (!adopted) throw fail('failed', 'Google returned an access token that is not valid. Please try again.')
  const p = r.profile || {}
  const name = blank(p.name) || [blank(p.givenName), blank(p.familyName)].filter(Boolean).join(' ') || null
  return {
    missingScope: adopted.missingScope,
    token,
    profile: { email: blank(p.email), name, photo: blank(p.imageUrl) },
  }
}

const SCOPE_MESSAGE = 'Gym Plus needs permission to keep its own file in your Google Drive. ' +
  'Please sign in again and leave the Google Drive option ticked.'

// Interactive sign-in → { email, name, photo }.
// Throws GoogleAuthError { code: 'cancelled' | 'config' | 'network' | 'failed' }.
export async function googleSignIn() {
  if (!googleConfigured()) throw fail('config', missingConfigMessage())
  cache = null
  const r = await interactiveLogin({ reauth: false })
  if (r.missingScope) {
    cache = null
    await googleSignOut().catch(() => {})
    throw fail('failed', SCOPE_MESSAGE, 'scope')
  }
  return r.profile
}

export async function googleSignOut() {
  cache = null
  resetDriveCache()
  if (!googleConfigured()) return
  try {
    await initGoogleAuth()
    const SocialLogin = await plugin()
    await SocialLogin.logout({ provider: 'google' })
  } catch { /* already signed out / offline — local state is cleared either way */ }
}

// Drop the cached token (call after Drive answered { code:'auth' } with it), so the next
// getAccessToken() asks the plugin again instead of returning the rejected token.
export function invalidateAccessToken() {
  cache = null
}

async function silentRefresh() {
  try { await initGoogleAuth() } catch (e) { throw fail('auth', e.message, 'config') }
  const SocialLogin = await plugin().catch(e => { throw fail('auth', e.message, 'config') })
  let res
  try {
    res = await SocialLogin.getAuthorizationCode({ provider: 'google' })
  } catch (e) {
    const m = mapAuthError(e)
    if (m.code === 'network') throw m
    throw fail('auth', 'Your Google session has expired. Sign in again to keep syncing.')
  }
  const token = res && res.accessToken
  if (!token) throw fail('auth', 'Your Google session has expired. Sign in again to keep syncing.')
  const adopted = await adopt(token)
  if (!adopted) throw fail('auth', 'Your Google session has expired. Sign in again to keep syncing.')
  if (adopted.missingScope) throw fail('auth', SCOPE_MESSAGE, 'scope')
  return token
}

// A token valid for at least the next ~2 minutes.
//   interactive=false: never shows UI. Throws { code:'auth' } when the user has to sign in
//                      again, { code:'network' } when Google could not be reached.
//   interactive=true:  falls back to a (one-tap) Google sheet; may also throw 'cancelled' /
//                      'config' / 'failed'.
export async function getAccessToken({ interactive = false } = {}) {
  if (cache && cache.expiresAt - SKEW_MS > Date.now()) return cache.token
  cache = null
  if (!googleConfigured()) throw fail('auth', missingConfigMessage(), 'config')

  try {
    if (!silentP) silentP = silentRefresh().finally(() => { silentP = null })
    return await silentP
  } catch (e) {
    if (!interactive || e.code === 'network') throw e
  }

  if (!interactiveP) {
    // reauth: Android → compact pre-filtered sheet; iOS → restores the previous sign-in
    // (no forcePrompt), which refreshes the token without UI when Google allows it.
    interactiveP = interactiveLogin({ reauth: true })
      .then(r => {
        if (r.missingScope) { cache = null; throw fail('auth', SCOPE_MESSAGE, 'scope') }
        return r.token
      })
      .finally(() => { interactiveP = null })
  }
  return interactiveP
}

// Test hook: forget all module state.
export function _resetGoogleAuthForTests() {
  initP = null; cache = null; silentP = null; interactiveP = null
}
