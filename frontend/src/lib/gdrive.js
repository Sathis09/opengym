// Google Drive storage for the mobile build (Gym Plus): the whole synced state `S` as one JSON
// file, `Gym Plus/gymplus-data.json`, in a folder the user can see in My Drive. Plain fetch
// against the Drive v3 REST API (on device CapacitorHttp routes fetch through native code).
//
// Scope is drive.file, so Drive only ever shows this app the folder and file it created itself;
// every query below therefore only sees our own files.
//
// Every function takes an OAuth access token (lib/google-auth.js getAccessToken) and throws
//   { code:'auth' }            401, or 403 for an auth/scope reason → get a new token / sign in
//   { code:'offline' }         the request never reached Google
//   { code:'failed', status }  anything else (rate limit, quota, Drive API disabled, bad JSON…)
// State contents are never logged.

export const FOLDER_NAME = 'Gym Plus'
export const FILE_NAME = 'gymplus-data.json'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const FILE_MIME = 'application/json'
const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const FIELDS = 'id,version,modifiedTime'

export class DriveError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code)
    this.name = 'DriveError'
    this.code = code
    Object.assign(this, extra)
  }
}

// 403 reasons that mean "this token can't do it" rather than "try later" / "Drive is full".
const AUTH_REASONS = new Set([
  'authError', 'invalidCredentials', 'insufficientPermissions', 'insufficientScopes',
  'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'ACCESS_TOKEN_EXPIRED', 'CREDENTIALS_MISSING',
])

let folderId = null    // cached "Gym Plus" folder id (per signed-in account — reset on sign-out)
let folderP = null     // single-flight folder lookup/creation

export function resetDriveCache() {
  folderId = null
  folderP = null
}

async function errorFrom(res) {
  let body = null
  try { body = await res.json() } catch { /* non-JSON error body */ }
  const err = body && body.error
  const reasons = []
  if (err && Array.isArray(err.errors)) for (const x of err.errors) if (x && x.reason) reasons.push(x.reason)
  if (err && Array.isArray(err.details)) for (const d of err.details) if (d && d.reason) reasons.push(d.reason)
  const reason = reasons[0] || (err && err.status) || undefined
  const message = (err && err.message) || `Google Drive request failed (${res.status})`
  const wwwAuth = (res.headers && res.headers.get && res.headers.get('www-authenticate')) || ''
  if (res.status === 401) return new DriveError('auth', message, { status: 401, reason })
  if (res.status === 403 && (reasons.some(r => AUTH_REASONS.has(r)) || /insufficient_scope|invalid_token/i.test(wwwAuth))) {
    return new DriveError('auth', message, { status: 403, reason })
  }
  return new DriveError('failed', message, { status: res.status, reason })
}

// fetch + error mapping. Returns the Response for 2xx; 404 too when `allow404`.
async function call(token, url, { method = 'GET', headers = {}, body, allow404 = false } = {}) {
  let res
  try {
    res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body })
  } catch (e) {
    throw new DriveError('offline', 'No connection to Google Drive.')
  }
  if (res.ok || (allow404 && res.status === 404)) return res
  throw await errorFrom(res)
}

async function json(res) {
  try { return await res.json() } catch {
    throw new DriveError('failed', 'Google Drive returned an unreadable response.', { status: res.status, reason: 'parse' })
  }
}

// Drive query string literal: backslash and single quote must be escaped.
const lit = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

const meta = f => ({
  fileId: f.id,
  version: f.version == null ? null : Number(f.version),
  modifiedTime: f.modifiedTime || null,
})

async function list(token, q, fields) {
  const url = `${API}/files?` + new URLSearchParams({
    q, fields, spaces: 'drive', orderBy: 'modifiedTime desc', pageSize: '10',
  })
  const res = await call(token, url)
  const j = await json(res)
  return Array.isArray(j.files) ? j.files : []
}

async function findFolder(token) {
  const files = await list(token,
    `mimeType=${lit(FOLDER_MIME)} and name=${lit(FOLDER_NAME)} and trashed=false`, 'files(id)')
  return files[0] ? files[0].id : null
}

async function createFolder(token) {
  const res = await call(token, `${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
  })
  const j = await json(res)
  return j.id
}

// The folder id, from cache or Drive. `create`: make the folder when it doesn't exist.
// `fresh`: ignore the cache (e.g. the user may have trashed the cached folder).
async function resolveFolder(token, { create = false, fresh = false } = {}) {
  if (fresh) resetDriveCache()
  if (folderId) return folderId
  if (folderP) {
    const id = await folderP
    if (id || !create) return id
  }
  folderP = (async () => {
    let id = await findFolder(token)
    if (!id && create) id = await createFolder(token)
    return id
  })()
  try {
    folderId = await folderP
    return folderId
  } finally {
    folderP = null
  }
}

async function findFileIn(token, parent) {
  const files = await list(token,
    `name=${lit(FILE_NAME)} and ${lit(parent)} in parents and trashed=false`,
    `files(${FIELDS})`)
  return files
}

// Metadata of the data file, or null. A miss with a cached folder id re-checks the folder once,
// in case the user trashed/deleted it and a new one exists.
async function findFile(token) {
  const cached = !!folderId
  let parent = await resolveFolder(token)
  if (!parent) return null
  let files = await findFileIn(token, parent)
  if (!files.length && cached) {
    parent = await resolveFolder(token, { fresh: true })
    if (!parent) return null
    files = await findFileIn(token, parent)
  }
  return files[0] || null
}

// → null | { fileId, version, modifiedTime }
export async function cloudVersion(token) {
  const f = await findFile(token)
  return f ? meta(f) : null
}

// → null | { state, fileId, version, modifiedTime }
// Metadata is read before the content, so a concurrent writer can only make `version` look
// older than the content — the next cloudVersion() check then just pulls once more.
export async function readCloudState(token) {
  const f = await findFile(token)
  if (!f) return null
  const res = await call(token, `${API}/files/${encodeURIComponent(f.id)}?alt=media`, { allow404: true })
  if (res.status === 404) { resetDriveCache(); return null }
  let text
  try { text = await res.text() } catch {
    throw new DriveError('offline', 'No connection to Google Drive.')
  }
  let state
  try { state = JSON.parse(text) } catch {
    throw new DriveError('failed', 'The Gym Plus file in Google Drive is not valid JSON.', { status: res.status, reason: 'parse' })
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new DriveError('failed', 'The Gym Plus file in Google Drive has an unexpected format.', { status: res.status, reason: 'parse' })
  }
  return { state, ...meta(f) }
}

function serialize(state) {
  // The in-progress workout stays on the device (same rule as the self-hosted server).
  const { active, ...rest } = state || {}
  return JSON.stringify(rest)
}

async function updateFile(token, id, body) {
  return call(token, `${UPLOAD}/files/${encodeURIComponent(id)}?` + new URLSearchParams({ uploadType: 'media', fields: FIELDS }), {
    method: 'PATCH',
    headers: { 'Content-Type': `${FILE_MIME}; charset=UTF-8` },
    body,
    allow404: true,
  })
}

function boundaryFor(body) {
  for (;;) {
    const b = 'gymplus-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
    if (!body.includes(b)) return b
  }
}

export function multipartBody(metadata, body, boundary) {
  return `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    `--${boundary}\r\n` +
    `Content-Type: ${FILE_MIME}\r\n\r\n` +
    body + '\r\n' +
    `--${boundary}--`
}

async function createFile(token, parent, body) {
  const boundary = boundaryFor(body)
  const res = await call(token, `${UPLOAD}/files?` + new URLSearchParams({ uploadType: 'multipart', fields: FIELDS }), {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipartBody({ name: FILE_NAME, mimeType: FILE_MIME, parents: [parent] }, body, boundary),
    allow404: true,   // parent folder vanished
  })
  return res
}

// Uploads `state` (minus `active`). With a known `fileId` this is a single PATCH; otherwise the
// file is looked up and updated, or created (folder too, if needed).
// → { fileId, version, modifiedTime }
export async function writeCloudState(token, state, { fileId } = {}) {
  const body = serialize(state)

  if (fileId) {
    const res = await updateFile(token, fileId, body)
    if (res.status !== 404) return meta(await json(res))
    // Deleted from Drive meanwhile → fall through and recreate.
  }

  const existing = await findFile(token)
  if (existing) {
    const res = await updateFile(token, existing.id, body)
    if (res.status !== 404) return meta(await json(res))
  }

  // Create. Re-resolve the folder (not cached): a trashed cached folder would swallow the file.
  let parent = await resolveFolder(token, { create: true, fresh: true })
  let res = await createFile(token, parent, body)
  if (res.status === 404) {
    parent = await resolveFolder(token, { create: true, fresh: true })
    res = await createFile(token, parent, body)
    if (res.status === 404) throw await errorFrom(res)
  }
  return meta(await json(res))
}

// Deletes the data file(s); the (then empty) "Gym Plus" folder is left in place.
export async function deleteCloudState(token) {
  const parent = await resolveFolder(token, { fresh: true })
  if (!parent) return
  const files = await findFileIn(token, parent)
  for (const f of files) {
    await call(token, `${API}/files/${encodeURIComponent(f.id)}`, { method: 'DELETE', allow404: true })
  }
}
