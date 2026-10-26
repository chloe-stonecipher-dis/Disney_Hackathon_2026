// SAP Document Management Service (DMS), CMIS browser binding (Gap 4: file retention).
// Every uploaded journal file is stored in one folder of one repository.
//
// Settings (environment variables; on BTP from the app's user-provided variables,
// locally from the git-ignored .env file or, with --profile hybrid, read from the CF app):
//   DMS_BASE_URL, DMS_TOKEN_URL, DMS_CLIENT_ID, DMS_CLIENT_SECRET,
//   DMS_DEFAULT_REPOSITORY_ID, DMS_DEFAULT_FOLDER_PATH
import cds from '@sap/cds'
import { execFileSync } from 'node:child_process'

const LOG = cds.log('dms')
// Local development: settings from .env (never committed). On BTP the variables come from the environment.
try { process.loadEnvFile(cds.utils.path.join(cds.root, '.env')) } catch { /* no .env file */ }

// Hybrid: take the DMS_* user-provided variables of the deployed app (cds.zmaxx.dms.cfApp) through the cf CLI
const cfApp = cds.env.zmaxx?.dms?.cfApp
if (cfApp && !process.env.DMS_BASE_URL) {
  try {
    const cf = (...args) => execFileSync('cf', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const guid = cf('app', cfApp, '--guid')
    const vars = JSON.parse(cf('curl', `/v3/apps/${guid}/environment_variables`)).var ?? {}
    const names = Object.keys(vars).filter(k => k.startsWith('DMS_'))
    for (const k of names) process.env[k] ??= vars[k]
    LOG.info(`loaded ${names.length} DMS settings from Cloud Foundry app ${cfApp}`)
  } catch (e) {
    LOG.warn(`could not read DMS settings from Cloud Foundry app ${cfApp} (is "cf login" done?):`, e.message)
  }
}

let token = null
let tokenExpiresAt = 0
let folderReady = false

const cfg = () => {
  const e = process.env
  return {
    base: (e.DMS_BASE_URL || '').replace(/\/$/, ''),
    tokenUrl: e.DMS_TOKEN_URL,
    clientId: e.DMS_CLIENT_ID,
    secret: e.DMS_CLIENT_SECRET,
    repo: e.DMS_DEFAULT_REPOSITORY_ID,
    folder: (e.DMS_DEFAULT_FOLDER_PATH || 'Journal uploads').replace(/^\/+|\/+$/g, '')
  }
}

export const dmsConfigured = () => {
  const c = cfg()
  return Boolean(c.base && c.tokenUrl && c.clientId && c.secret && c.repo)
}

export class DmsError extends Error {}

async function accessToken() {
  if (token && Date.now() < tokenExpiresAt) return token
  const c = cfg()
  const res = await fetch(c.tokenUrl, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.access_token) throw new DmsError(`DMS login failed (${res.status}).`)
  token = body.access_token
  tokenExpiresAt = Date.now() + (Number(body.expires_in || 3600) - 60) * 1000
  return token
}

// One CMIS browser-binding call against the configured repository
async function call(path, { method = 'GET', body, raw = false } = {}) {
  const c = cfg()
  const res = await fetch(`${c.base}/browser/${encodeURIComponent(c.repo)}${path}`, {
    method, body, headers: { Authorization: `Bearer ${await accessToken()}` }
  })
  if (raw && res.ok) return res
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  if (!res.ok) {
    const reason = json?.message || json?.exception || text.slice(0, 200)
    const err = new DmsError(res.status === 404 && /repository/i.test(reason)
      ? `DMS repository ${c.repo} was not found. Check DMS_DEFAULT_REPOSITORY_ID.`
      : `DMS request failed (${res.status}): ${reason}`)
    err.status = res.status
    err.exception = json?.exception
    throw err
  }
  return json
}

const folderPath = () => `/root/${cfg().folder.split('/').map(encodeURIComponent).join('/')}`

// Create the folder (one level under root) the first time it is needed
async function ensureFolder() {
  if (folderReady) return
  try {
    await call(`${folderPath()}?cmisselector=object&succinct=true`)
  } catch (e) {
    if (e.exception !== 'objectNotFound') throw e
    const form = new URLSearchParams({
      cmisaction: 'createFolder',
      'propertyId[0]': 'cmis:name', 'propertyValue[0]': cfg().folder,
      'propertyId[1]': 'cmis:objectTypeId', 'propertyValue[1]': 'cmis:folder',
      succinct: 'true'
    })
    try {
      await call('/root', { method: 'POST', body: form })
    } catch (err) {
      // Even the repository root is not found: the repository ID is wrong for these credentials
      if (err.status === 404) throw new DmsError(`DMS repository ${cfg().repo} was not found with these credentials. Check DMS_DEFAULT_REPOSITORY_ID.`)
      throw err
    }
    LOG.info(`created DMS folder "${cfg().folder}"`)
  }
  folderReady = true
}

/**
 * Stores a file in the DMS folder. The name gets a time stamp so the same
 * file name can be uploaded again without a name clash.
 * @returns {Promise<{objectId: string, name: string, repository: string, folder: string}>}
 */
export async function storeFile({ fileName, mediaType, content }) {
  await ensureFolder()
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
  const name = `${stamp} ${fileName}`
  const form = new FormData()
  form.append('cmisaction', 'createDocument')
  form.append('propertyId[0]', 'cmis:name')
  form.append('propertyValue[0]', name)
  form.append('propertyId[1]', 'cmis:objectTypeId')
  form.append('propertyValue[1]', 'cmis:document')
  form.append('succinct', 'true')
  form.append('_charset_', 'UTF-8')
  form.append('media', new Blob([content], { type: mediaType }), name)
  const doc = await call(folderPath(), { method: 'POST', body: form })
  return { objectId: doc.succinctProperties['cmis:objectId'], name, repository: cfg().repo, folder: cfg().folder }
}

/** Files in the DMS folder, newest first */
export async function listFiles(max = 200) {
  await ensureFolder()
  const res = await call(`${folderPath()}?cmisselector=children&succinct=true&maxItems=${max}`)
  return (res.objects || [])
    .map(o => o.object.succinctProperties)
    .filter(p => p['cmis:baseTypeId'] === 'cmis:document')
    .map(p => ({
      objectId: p['cmis:objectId'],
      name: p['cmis:name'],
      createdAt: new Date(Number(p['cmis:creationDate'])).toISOString(),
      createdBy: p['cmis:createdBy'],
      size: Number(p['cmis:contentStreamLength'] || 0),
      mimeType: p['cmis:contentStreamMimeType']
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** The content of one stored file */
export async function readFile(objectId) {
  const res = await call(`/root?objectId=${encodeURIComponent(objectId)}&cmisselector=content`, { raw: true })
  return { content: Buffer.from(await res.arrayBuffer()), mediaType: res.headers.get('content-type') || 'application/octet-stream' }
}

/** Where files go, and whether DMS can be reached */
export async function dmsInfo() {
  const c = cfg()
  if (!dmsConfigured()) return { configured: false, reachable: false, repository: null, folder: c.folder, message: 'Document Management is not configured.' }
  try {
    await ensureFolder()
    return { configured: true, reachable: true, repository: c.repo, folder: c.folder, message: `Files are stored in DMS, folder "${c.folder}".` }
  } catch (e) {
    return { configured: true, reachable: false, repository: c.repo, folder: c.folder, message: e.message }
  }
}
