// Coach job failures in the mobile build's voice. Same codes as JOB_ERRORS in coach-api.js
// where they mean the same thing, plus the ones only a direct provider call can produce.
// There is no instance and no owner on the phone: the person reading this is the one who
// holds the key, so every message says what *they* can do about it.
export const MOBILE_JOB_ERRORS = {
  off: 'Set up the AI Coach first — add your API key and pick a model in Profile → AI Coach.',
  busy: 'The Coach is already thinking about your training.',
  consent: 'The Coach needs your go-ahead first.',
  auth: 'Your API key was rejected — check it in Profile → AI Coach.',
  rate: 'Your AI provider is rate-limiting this key or it is out of credit — try again later.',
  model: 'Your AI provider doesn’t offer the selected model — pick another in Profile → AI Coach.',
  offline: 'Couldn’t reach your AI provider — check your connection and try again.',
  timeout: 'Your AI provider took too long and the Coach gave up — try again, or pick a faster model.',
  provider: 'Your AI provider couldn’t complete the request — try again shortly.',
  unusable: 'The model answered with something the app couldn’t use — try again, or pick a stronger model.',
  restart: 'The app was closed while the Coach was thinking — ask again.',
  internal: 'Something went wrong on this phone.'
}

/** ai-providers error codes → job error codes. */
export const PROVIDER_TO_JOB = { key: 'auth', rate: 'rate', model: 'model', offline: 'offline', timeout: 'timeout', failed: 'provider' }
