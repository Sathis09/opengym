import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  readCloudState, writeCloudState, cloudVersion, deleteCloudState, resetDriveCache,
  multipartBody, FOLDER_NAME, FILE_NAME,
} from './gdrive.js'

const TOKEN = 'tok-123'
const FOLDER_MIME = 'application/vnd.google-apps.folder'

const jsonRes = (status, body, headers = {}) =>
  new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

// Minimal in-memory Drive v3: enough of files.list / get / create / update / delete for gdrive.js.
function fakeDrive() {
  const files = new Map()   // id → { id, name, mimeType, parents, trashed, version, modifiedTime, content }
  const calls = []
  let seq = 0
  let clock = Date.UTC(2026, 9, 31, 12, 0, 0)
  const stamp = f => { f.version = String(Number(f.version || 0) + 1); clock += 1000; f.modifiedTime = new Date(clock).toISOString() }
  const add = (props) => {
    const f = { id: 'id' + (++seq), parents: [], trashed: false, ...props }
    stamp(f)
    files.set(f.id, f)
    return f
  }
  const pick = (f, fields) => {
    const keys = fields.replace(/^files\(|\)$/g, '').split(',')
    return Object.fromEntries(keys.map(k => [k, f[k]]))
  }
  const matches = (f, q) => {
    let m
    if ((m = q.match(/mimeType='([^']+)'/)) && f.mimeType !== m[1]) return false
    if ((m = q.match(/name='([^']+)'/)) && f.name !== m[1]) return false
    if ((m = q.match(/'([^']+)' in parents/)) && !f.parents.includes(m[1])) return false
    if (/trashed=false/.test(q) && f.trashed) return false
    return true
  }

  const handler = vi.fn(async (url, init = {}) => {
    const u = new URL(url)
    const method = init.method || 'GET'
    calls.push({ url: u, method, headers: init.headers || {}, body: init.body })
    if ((init.headers || {}).Authorization !== `Bearer ${TOKEN}`) {
      return jsonRes(401, { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } })
    }
    const p = u.pathname
    if (p === '/drive/v3/files' && method === 'GET') {
      const q = u.searchParams.get('q')
      const list = [...files.values()].filter(f => matches(f, q))
        .sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime))
      return jsonRes(200, { files: list.map(f => pick(f, u.searchParams.get('fields'))) })
    }
    if (p === '/drive/v3/files' && method === 'POST') {
      const m = JSON.parse(init.body)
      const f = add({ name: m.name, mimeType: m.mimeType, parents: m.parents || ['root'] })
      return jsonRes(200, pick(f, u.searchParams.get('fields')))
    }
    let m
    if ((m = p.match(/^\/drive\/v3\/files\/([^/]+)$/))) {
      const f = files.get(m[1])
      if (!f) return jsonRes(404, { error: { code: 404, message: 'File not found', errors: [{ reason: 'notFound' }] } })
      if (method === 'DELETE') { files.delete(f.id); return new Response(null, { status: 204 }) }
      if (u.searchParams.get('alt') === 'media') return new Response(f.content, { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (p === '/upload/drive/v3/files' && method === 'POST') {
      const boundary = init.headers['Content-Type'].match(/boundary=(.+)$/)[1]
      const parts = init.body.split(`--${boundary}`).slice(1, -1).map(s => s.replace(/^\r\n/, '').replace(/\r\n$/, ''))
      const [, metaJson] = parts[0].split('\r\n\r\n')
      const content = parts[1].split('\r\n\r\n').slice(1).join('\r\n\r\n')
      const md = JSON.parse(metaJson)
      if (md.parents && md.parents.some(id => !files.has(id))) return jsonRes(404, { error: { code: 404, message: 'File not found', errors: [{ reason: 'notFound' }] } })
      const f = add({ name: md.name, mimeType: md.mimeType, parents: md.parents, content })
      return jsonRes(200, pick(f, u.searchParams.get('fields')))
    }
    if ((m = p.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/)) && method === 'PATCH') {
      const f = files.get(m[1])
      if (!f) return jsonRes(404, { error: { code: 404, message: 'File not found', errors: [{ reason: 'notFound' }] } })
      f.content = init.body
      stamp(f)
      return jsonRes(200, pick(f, u.searchParams.get('fields')))
    }
    return jsonRes(400, { error: { code: 400, message: `unexpected ${method} ${p}` } })
  })
  return { files, calls, handler, add }
}

let drive
beforeEach(() => {
  resetDriveCache()
  drive = fakeDrive()
  vi.stubGlobal('fetch', drive.handler)
})
afterEach(() => { vi.unstubAllGlobals() })

const folders = () => [...drive.files.values()].filter(f => f.mimeType === FOLDER_MIME)
const dataFiles = () => [...drive.files.values()].filter(f => f.name === FILE_NAME)

describe('writeCloudState', () => {
  it('first write creates the visible folder and the file via multipart upload', async () => {
    const S = { workouts: [{ id: 'w1', t: 5 }], _ts: 10 }
    const r = await writeCloudState(TOKEN, S)

    expect(folders()).toHaveLength(1)
    expect(folders()[0].name).toBe(FOLDER_NAME)
    expect(dataFiles()).toHaveLength(1)
    const file = dataFiles()[0]
    expect(file.parents).toEqual([folders()[0].id])
    expect(file.mimeType).toBe('application/json')
    expect(JSON.parse(file.content)).toEqual(S)
    expect(r).toEqual({ fileId: file.id, version: 1, modifiedTime: file.modifiedTime })

    const folderCreate = drive.calls.find(c => c.method === 'POST' && c.url.pathname === '/drive/v3/files')
    expect(JSON.parse(folderCreate.body)).toEqual({ name: 'Gym Plus', mimeType: FOLDER_MIME })

    const upload = drive.calls.find(c => c.url.pathname === '/upload/drive/v3/files')
    expect(upload.method).toBe('POST')
    expect(upload.url.searchParams.get('uploadType')).toBe('multipart')
    expect(upload.url.searchParams.get('fields')).toBe('id,version,modifiedTime')
    expect(upload.headers['Content-Type']).toMatch(/^multipart\/related; boundary=/)
    expect(upload.headers.Authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('builds a well-formed multipart/related body', () => {
    const body = multipartBody({ name: 'x.json', mimeType: 'application/json', parents: ['F'] }, '{"a":1}', 'BOUND')
    expect(body).toBe(
      '--BOUND\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
      '{"name":"x.json","mimeType":"application/json","parents":["F"]}\r\n' +
      '--BOUND\r\nContent-Type: application/json\r\n\r\n{"a":1}\r\n--BOUND--')
  })

  it('uses a boundary that does not occur in the content', async () => {
    await writeCloudState(TOKEN, { note: '--gymplus-' })
    const upload = drive.calls.find(c => c.url.pathname === '/upload/drive/v3/files')
    const boundary = upload.headers['Content-Type'].split('boundary=')[1]
    expect(JSON.parse(dataFiles()[0].content)).toEqual({ note: '--gymplus-' })
    expect(upload.body.split(`--${boundary}`)).toHaveLength(4)   // open, part 1, part 2, close
  })

  it('reuses an existing folder instead of creating a second one', async () => {
    const f = drive.add({ name: FOLDER_NAME, mimeType: FOLDER_MIME, parents: ['root'] })
    await writeCloudState(TOKEN, { a: 1 })
    expect(folders()).toHaveLength(1)
    expect(dataFiles()[0].parents).toEqual([f.id])
    const list = drive.calls.find(c => c.method === 'GET')
    expect(list.url.searchParams.get('q')).toBe(`mimeType='${FOLDER_MIME}' and name='Gym Plus' and trashed=false`)
  })

  it('ignores a trashed folder and creates a fresh one', async () => {
    drive.add({ name: FOLDER_NAME, mimeType: FOLDER_MIME, parents: ['root'], trashed: true })
    await writeCloudState(TOKEN, { a: 1 })
    const live = folders().filter(f => !f.trashed)
    expect(live).toHaveLength(1)
    expect(dataFiles()[0].parents).toEqual([live[0].id])
  })

  it('updates the existing file (PATCH uploadType=media) when no fileId is given', async () => {
    const first = await writeCloudState(TOKEN, { a: 1 })
    resetDriveCache()
    const second = await writeCloudState(TOKEN, { a: 2 })
    expect(dataFiles()).toHaveLength(1)
    expect(second.fileId).toBe(first.fileId)
    expect(second.version).toBe(2)
    expect(JSON.parse(dataFiles()[0].content)).toEqual({ a: 2 })
    const patch = drive.calls.find(c => c.method === 'PATCH')
    expect(patch.url.pathname).toBe(`/upload/drive/v3/files/${first.fileId}`)
    expect(patch.url.searchParams.get('uploadType')).toBe('media')
    expect(patch.url.searchParams.get('fields')).toBe('id,version,modifiedTime')
    expect(patch.headers['Content-Type']).toMatch(/^application\/json/)
  })

  it('with a known fileId does a single PATCH and nothing else', async () => {
    const first = await writeCloudState(TOKEN, { a: 1 })
    drive.calls.length = 0
    const r = await writeCloudState(TOKEN, { a: 3 }, { fileId: first.fileId })
    expect(drive.calls).toHaveLength(1)
    expect(drive.calls[0].method).toBe('PATCH')
    expect(r.version).toBe(2)
    expect(typeof r.modifiedTime).toBe('string')
  })

  it('recreates the file when the known fileId was deleted from Drive', async () => {
    const first = await writeCloudState(TOKEN, { a: 1 })
    drive.files.delete(first.fileId)
    const r = await writeCloudState(TOKEN, { a: 4 }, { fileId: first.fileId })
    expect(r.fileId).not.toBe(first.fileId)
    expect(dataFiles()).toHaveLength(1)
    expect(JSON.parse(dataFiles()[0].content)).toEqual({ a: 4 })
    expect(folders()).toHaveLength(1)
  })

  it('recreates the folder when the cached folder was deleted', async () => {
    const first = await writeCloudState(TOKEN, { a: 1 })
    const oldFolder = folders()[0].id
    drive.files.delete(first.fileId)
    drive.files.delete(oldFolder)
    const r = await writeCloudState(TOKEN, { a: 5 })
    expect(folders()).toHaveLength(1)
    expect(folders()[0].id).not.toBe(oldFolder)
    expect(drive.files.get(r.fileId).parents).toEqual([folders()[0].id])
  })

  it('never uploads the in-progress workout (`active`) and keeps everything else', async () => {
    const S = { active: { exercises: [1, 2] }, workouts: [{ id: 'w' }], coach: { instructions: 'x' }, _ts: 1 }
    await writeCloudState(TOKEN, S)
    const stored = JSON.parse(dataFiles()[0].content)
    expect(stored).not.toHaveProperty('active')
    expect(stored).toEqual({ workouts: [{ id: 'w' }], coach: { instructions: 'x' }, _ts: 1 })
    expect(S.active).toEqual({ exercises: [1, 2] })   // caller's object untouched

    await writeCloudState(TOKEN, S, { fileId: dataFiles()[0].id })
    expect(JSON.parse(dataFiles()[0].content)).not.toHaveProperty('active')
  })
})

describe('readCloudState / cloudVersion', () => {
  it('returns null when there is no folder or no file, without creating anything', async () => {
    expect(await readCloudState(TOKEN)).toBeNull()
    expect(await cloudVersion(TOKEN)).toBeNull()
    drive.add({ name: FOLDER_NAME, mimeType: FOLDER_MIME, parents: ['root'] })
    resetDriveCache()
    expect(await readCloudState(TOKEN)).toBeNull()
    expect(drive.calls.every(c => c.method === 'GET')).toBe(true)
    expect(drive.files.size).toBe(1)
  })

  it('reads back what was written, with version metadata', async () => {
    const S = { workouts: [{ id: 'w1' }], unicode: 'Übung – 💪', _ts: 7 }
    const w = await writeCloudState(TOKEN, S)
    resetDriveCache()
    const r = await readCloudState(TOKEN)
    expect(r).toEqual({ state: S, fileId: w.fileId, version: 1, modifiedTime: w.modifiedTime })
    const media = drive.calls.find(c => c.url.searchParams.get('alt') === 'media')
    expect(media.url.pathname).toBe(`/drive/v3/files/${w.fileId}`)
  })

  it('cloudVersion is metadata only (no download) and tracks updates', async () => {
    const w = await writeCloudState(TOKEN, { a: 1 })
    drive.calls.length = 0
    expect(await cloudVersion(TOKEN)).toEqual({ fileId: w.fileId, version: 1, modifiedTime: w.modifiedTime })
    expect(drive.calls.some(c => c.url.searchParams.get('alt') === 'media')).toBe(false)
    expect(drive.calls.find(c => c.url.searchParams.has('q')).url.searchParams.get('fields')).toBe('files(id,version,modifiedTime)')
    await writeCloudState(TOKEN, { a: 2 }, { fileId: w.fileId })
    expect((await cloudVersion(TOKEN)).version).toBe(2)
  })

  it('caches the folder id between calls', async () => {
    await writeCloudState(TOKEN, { a: 1 })
    drive.calls.length = 0
    await cloudVersion(TOKEN)
    await cloudVersion(TOKEN)
    const folderLookups = drive.calls.filter(c => (c.url.searchParams.get('q') || '').includes(FOLDER_MIME))
    expect(folderLookups).toHaveLength(0)
  })

  it('re-resolves the folder when the cached one no longer holds the file', async () => {
    await writeCloudState(TOKEN, { a: 1 })
    // User trashes the folder (children are trashed with it); another device recreates both.
    for (const f of drive.files.values()) f.trashed = true
    const nf = drive.add({ name: FOLDER_NAME, mimeType: FOLDER_MIME, parents: ['root'] })
    drive.add({ name: FILE_NAME, mimeType: 'application/json', parents: [nf.id], content: '{"b":2}' })
    const r = await readCloudState(TOKEN)
    expect(r.state).toEqual({ b: 2 })
  })

  it('throws failed/parse on a corrupt file', async () => {
    const nf = drive.add({ name: FOLDER_NAME, mimeType: FOLDER_MIME, parents: ['root'] })
    drive.add({ name: FILE_NAME, mimeType: 'application/json', parents: [nf.id], content: '{not json' })
    await expect(readCloudState(TOKEN)).rejects.toMatchObject({ code: 'failed', reason: 'parse' })
  })
})

describe('deleteCloudState', () => {
  it('deletes the file but leaves the folder', async () => {
    await writeCloudState(TOKEN, { a: 1 })
    await deleteCloudState(TOKEN)
    expect(dataFiles()).toHaveLength(0)
    expect(folders()).toHaveLength(1)
    expect(await readCloudState(TOKEN)).toBeNull()
  })

  it('is a no-op when nothing exists', async () => {
    await expect(deleteCloudState(TOKEN)).resolves.toBeUndefined()
    expect(drive.calls.every(c => c.method === 'GET')).toBe(true)
  })
})

describe('error mapping', () => {
  const stub = (res) => vi.stubGlobal('fetch', vi.fn(async () => (typeof res === 'function' ? res() : res)))

  it('401 → auth', async () => {
    await expect(readCloudState('wrong-token')).rejects.toMatchObject({ code: 'auth', status: 401 })
  })

  it('403 with an auth reason → auth', async () => {
    stub(() => jsonRes(403, { error: { code: 403, message: 'Insufficient Permission', errors: [{ reason: 'insufficientPermissions' }] } }))
    await expect(cloudVersion(TOKEN)).rejects.toMatchObject({ code: 'auth', status: 403 })
  })

  it('403 with ACCESS_TOKEN_SCOPE_INSUFFICIENT detail → auth', async () => {
    stub(() => jsonRes(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'scopes', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }))
    await expect(cloudVersion(TOKEN)).rejects.toMatchObject({ code: 'auth' })
  })

  it('403 insufficient_scope in WWW-Authenticate → auth', async () => {
    stub(() => jsonRes(403, null, { 'WWW-Authenticate': 'Bearer error="insufficient_scope"' }))
    await expect(cloudVersion(TOKEN)).rejects.toMatchObject({ code: 'auth' })
  })

  it('403 rate limit / quota / API disabled → failed with status + reason', async () => {
    stub(() => jsonRes(403, { error: { code: 403, message: 'Rate', errors: [{ reason: 'userRateLimitExceeded' }] } }))
    await expect(cloudVersion(TOKEN)).rejects.toMatchObject({ code: 'failed', status: 403, reason: 'userRateLimitExceeded' })
    stub(() => jsonRes(403, { error: { code: 403, message: 'Drive API has not been used', errors: [{ reason: 'accessNotConfigured' }] } }))
    await expect(writeCloudState(TOKEN, { a: 1 })).rejects.toMatchObject({ code: 'failed', reason: 'accessNotConfigured' })
  })

  it('5xx and non-JSON errors → failed with status', async () => {
    stub(() => new Response('oops', { status: 503 }))
    await expect(readCloudState(TOKEN)).rejects.toMatchObject({ code: 'failed', status: 503 })
  })

  it('network failure (fetch rejects) → offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(readCloudState(TOKEN)).rejects.toMatchObject({ code: 'offline' })
    await expect(writeCloudState(TOKEN, { a: 1 }, { fileId: 'x' })).rejects.toMatchObject({ code: 'offline' })
    await expect(cloudVersion(TOKEN)).rejects.toMatchObject({ code: 'offline' })
    await expect(deleteCloudState(TOKEN)).rejects.toMatchObject({ code: 'offline' })
  })

  it('a non-TypeError rejection from native fetch is also offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unable to resolve host "www.googleapis.com"') }))
    await expect(cloudVersion(TOKEN)).rejects.toMatchObject({ code: 'offline' })
  })

  it('error messages never contain the state', async () => {
    stub(() => jsonRes(500, { error: { code: 500, message: 'Backend Error' } }))
    const secret = 'very-private-note'
    const e = await writeCloudState(TOKEN, { note: secret }, { fileId: 'f' }).catch(x => x)
    expect(e.code).toBe('failed')
    expect(JSON.stringify({ m: e.message, ...e })).not.toContain(secret)
  })
})
