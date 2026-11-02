import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const DRIVE = 'https://www.googleapis.com/auth/drive.file'
const plugin = {
  initialize: vi.fn(async () => {}),
  login: vi.fn(),
  logout: vi.fn(async () => {}),
  getAuthorizationCode: vi.fn(),
}
vi.mock('@capgo/capacitor-social-login', () => ({ SocialLogin: plugin }))

const okInfo = (expires = 3600, scope = `openid email profile ${DRIVE}`) =>
  new Response(JSON.stringify({ expires_in: String(expires), scope }), { status: 200, headers: { 'Content-Type': 'application/json' } })
const loginResult = (token = 'at-1', profile = {}) => ({
  provider: 'google',
  result: {
    responseType: 'online', accessToken: { token }, idToken: 'id',
    profile: { email: 'a@b.c', name: 'Ann', givenName: 'Ann', familyName: null, id: '1', imageUrl: 'https://x/p.png', ...profile },
  },
})

let auth, fetchMock
async function load({ web = 'web-id.apps.googleusercontent.com', ios = '' } = {}) {
  vi.resetModules()
  vi.stubEnv('VITE_GOOGLE_WEB_CLIENT_ID', web)
  vi.stubEnv('VITE_GOOGLE_IOS_CLIENT_ID', ios)
  auth = await import('./google-auth.js')
}

beforeEach(async () => {
  for (const f of Object.values(plugin)) f.mockReset()
  plugin.initialize.mockResolvedValue()
  plugin.logout.mockResolvedValue()
  fetchMock = vi.fn(async () => okInfo())
  vi.stubGlobal('fetch', fetchMock)
  await load()
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers() })

describe('config', () => {
  it('without client ids: not configured, sign-in throws config, init resolves false', async () => {
    await load({ web: '' })
    const cfg = await import('./google-config.js')
    expect(cfg.googleConfigured()).toBe(false)
    expect(await auth.initGoogleAuth()).toBe(false)
    await expect(auth.googleSignIn()).rejects.toMatchObject({ code: 'config' })
    await expect(auth.googleSignIn()).rejects.toThrow(/VITE_GOOGLE_WEB_CLIENT_ID/)
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: 'auth' })
    expect(plugin.initialize).not.toHaveBeenCalled()
  })

  it('initialises once in online mode with the web client id', async () => {
    await auth.initGoogleAuth()
    await auth.initGoogleAuth()
    expect(plugin.initialize).toHaveBeenCalledTimes(1)
    expect(plugin.initialize).toHaveBeenCalledWith({ google: { mode: 'online', webClientId: 'web-id.apps.googleusercontent.com' } })
  })
})

describe('googleSignIn', () => {
  it('requests the Drive scope and returns the profile', async () => {
    plugin.login.mockResolvedValue(loginResult())
    expect(await auth.googleSignIn()).toEqual({ email: 'a@b.c', name: 'Ann', photo: 'https://x/p.png' })
    const opts = plugin.login.mock.calls[0][0]
    expect(opts.provider).toBe('google')
    expect(opts.options.scopes).toEqual(['openid', 'email', 'profile', DRIVE])
    // token is cached: no plugin call needed
    expect(await auth.getAccessToken()).toBe('at-1')
    expect(plugin.getAuthorizationCode).not.toHaveBeenCalled()
  })

  it('checks the token via POST so it never appears in a URL', async () => {
    plugin.login.mockResolvedValue(loginResult('secret-token'))
    await auth.googleSignIn()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).not.toContain('secret-token')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('access_token=secret-token')
  })

  it('maps plugin errors', async () => {
    const cases = [
      ['Google Sign-In failed: activity is cancelled by the user.', 'cancelled'],
      ['Error retrieving access token: java.lang.RuntimeException: Cannot get getAuthorizationResultFromIntent', 'cancelled'],
      ['The user canceled the sign-in flow.', 'cancelled'],
      ['Google Sign-In failed: [28444] Developer console is not set up correctly.', 'config'],
      ['You CANNOT use scopes without modifying the main activity. Please follow the docs!', 'config'],
      ['Google Sign-In failed: Unable to resolve host "oauth2.googleapis.com"', 'network'],
      ['Something odd', 'failed'],
    ]
    for (const [msg, code] of cases) {
      plugin.login.mockRejectedValueOnce(new Error(msg))
      await expect(auth.googleSignIn()).rejects.toMatchObject({ code })
    }
  })

  it('fails (and signs out) when the user unticked Drive access', async () => {
    fetchMock.mockImplementation(async () => okInfo(3600, 'openid email profile'))
    plugin.login.mockResolvedValue(loginResult())
    await expect(auth.googleSignIn()).rejects.toMatchObject({ code: 'failed', reason: 'scope' })
    expect(plugin.logout).toHaveBeenCalled()
  })
})

describe('getAccessToken', () => {
  it('silently refreshes through getAuthorizationCode when the cache is expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    plugin.login.mockResolvedValue(loginResult('at-1'))
    fetchMock.mockImplementation(async () => okInfo(600))
    await auth.googleSignIn()
    vi.setSystemTime(Date.now() + 9 * 60 * 1000)   // inside the 2-minute skew
    plugin.getAuthorizationCode.mockResolvedValue({ accessToken: 'at-2', jwt: 'id' })
    expect(await auth.getAccessToken()).toBe('at-2')
    expect(plugin.login).toHaveBeenCalledTimes(1)
  })

  it('non-interactive: throws auth when the plugin has no valid session, never shows UI', async () => {
    plugin.getAuthorizationCode.mockRejectedValue(new Error('User is not logged in'))
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: 'auth' })
    expect(plugin.login).not.toHaveBeenCalled()
  })

  it('non-interactive: token rejected by tokeninfo → auth', async () => {
    plugin.getAuthorizationCode.mockResolvedValue({ accessToken: 'dead' })
    fetchMock.mockImplementation(async () => new Response('{"error":"invalid_token"}', { status: 400 }))
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: 'auth' })
  })

  it('network trouble during silent refresh → network, not auth', async () => {
    plugin.getAuthorizationCode.mockRejectedValue(new Error('Error validating tokens: java.util.concurrent.TimeoutException'))
    await expect(auth.getAccessToken({ interactive: true })).rejects.toMatchObject({ code: 'network' })
    expect(plugin.login).not.toHaveBeenCalled()
  })

  it('interactive: falls back to a one-tap login', async () => {
    plugin.getAuthorizationCode.mockRejectedValue(new Error('User is not logged in'))
    plugin.login.mockResolvedValue(loginResult('at-3'))
    expect(await auth.getAccessToken({ interactive: true })).toBe('at-3')
    const opts = plugin.login.mock.calls[0][0].options
    expect(opts).toMatchObject({ style: 'bottom', filterByAuthorizedAccounts: true, autoSelectEnabled: true })
  })

  it('concurrent callers share one refresh', async () => {
    plugin.getAuthorizationCode.mockResolvedValue({ accessToken: 'at-4' })
    const [a, b] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()])
    expect(a).toBe('at-4'); expect(b).toBe('at-4')
    expect(plugin.getAuthorizationCode).toHaveBeenCalledTimes(1)
  })

  it('offline tokeninfo: token is trusted briefly', async () => {
    plugin.getAuthorizationCode.mockResolvedValue({ accessToken: 'at-5' })
    fetchMock.mockImplementation(async () => { throw new TypeError('Failed to fetch') })
    expect(await auth.getAccessToken()).toBe('at-5')
  })

  it('invalidateAccessToken and googleSignOut drop the cache', async () => {
    plugin.login.mockResolvedValue(loginResult('at-1'))
    await auth.googleSignIn()
    auth.invalidateAccessToken()
    plugin.getAuthorizationCode.mockRejectedValue(new Error('User is not logged in'))
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: 'auth' })

    plugin.login.mockResolvedValue(loginResult('at-6'))
    await auth.googleSignIn()
    await auth.googleSignOut()
    expect(plugin.logout).toHaveBeenCalledWith({ provider: 'google' })
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: 'auth' })
  })
})
