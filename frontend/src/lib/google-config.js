// Google OAuth client ids for the mobile build (Gym Plus). Set at build time through Vite env
// vars, e.g. in frontend/.env.mobile — see docs/GOOGLE_SETUP.md. Client ids are public
// identifiers (they ship inside every app binary), not secrets.
//
//   VITE_GOOGLE_WEB_CLIENT_ID  "Web application" client. Android signs in with it (Credential
//                              Manager's serverClientId); the Android client itself is matched
//                              by package name + SHA-1 and never appears in code.
//   VITE_GOOGLE_IOS_CLIENT_ID  "iOS" client. Required on iOS only.

const clean = v => (typeof v === 'string' ? v.trim() : '')

export const GOOGLE_WEB_CLIENT_ID = clean(import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID)
export const GOOGLE_IOS_CLIENT_ID = clean(import.meta.env.VITE_GOOGLE_IOS_CLIENT_ID)

// drive.file: per-file access — the app can only see files it created itself (the
// "Gym Plus" folder and its data file), never the rest of the user's Drive.
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const GOOGLE_SCOPES = ['openid', 'email', 'profile', DRIVE_SCOPE]

// 'android' | 'ios' | 'web'. Read from the Capacitor global the native shell injects, so this
// stays synchronous and the web bundle never has to import @capacitor/core for it.
export function googlePlatform() {
  try { return globalThis.Capacitor?.getPlatform?.() || 'web' } catch { return 'web' }
}

// True when the client id(s) the current platform needs were provided at build time.
export function googleConfigured(platform = googlePlatform()) {
  if (platform === 'ios') return !!GOOGLE_IOS_CLIENT_ID
  return !!GOOGLE_WEB_CLIENT_ID
}

export function missingConfigMessage(platform = googlePlatform()) {
  const v = platform === 'ios' ? 'VITE_GOOGLE_IOS_CLIENT_ID' : 'VITE_GOOGLE_WEB_CLIENT_ID'
  return `Google sign-in is not configured in this build: ${v} was empty at build time. ` +
    'Set it in frontend/.env.mobile (see docs/GOOGLE_SETUP.md) and rebuild.'
}
