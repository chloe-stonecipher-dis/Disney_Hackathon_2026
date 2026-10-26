// HTTP access to the S/4HANA system behind BTP destination S43.
//
//   deployed on BTP          -> destination 'S43' (destination + connectivity service, Cloud Connector)
//   Business Application Studio -> http://S43.dest through the BAS proxy (cds.zmaxx.s43.devProxy)
//
// One S43Session keeps the CSRF token and session cookies across calls. F2548's posting
// engine (FAC_GL_DOCUMENT_POST_SRV) holds the temporary journal in the S/4 session, so a
// journal's create, check and post calls must use the same session.
import cds from '@sap/cds'
import { executeHttpRequest } from '@sap-cloud-sdk/http-client'

export const F2548 = '/sap/opu/odata/sap/FAC_GL_DOCUMENT_POST_SRV'
export const ATTACHMENTS = '/sap/opu/odata/sap/API_CV_ATTACHMENT_SRV'

function destination() {
  const { destination: name, devProxy } = cds.env.zmaxx.s43
  if (!devProxy) return { destinationName: name }
  const [host, port] = devProxy.split(':')
  return { url: `http://${name}.dest`, proxyType: 'Internet', proxyConfiguration: { host, port: Number(port), protocol: 'http' } }
}

export class S43Session {
  #csrf = null
  #cookies = new Map()

  async get(path, params) {
    const res = await this.request('get', path, { params: { $format: 'json', ...params } })
    return res.data?.d?.results ?? res.data?.d
  }

  // GET a collection in pages of `top` rows
  async getAll(path, params = {}, top = 5000) {
    const rows = []
    for (let skip = 0; ; skip += top) {
      const page = await this.get(path, { ...params, $top: top, $skip: skip })
      rows.push(...page)
      if (page.length < top) return rows
    }
  }

  async request(method, path, { data, params, headers = {} } = {}) {
    if (method !== 'get' && !this.#csrf) await this.#fetchCsrf()
    const query = Object.entries(params ?? {}).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    // Reads are safe to repeat: retry them when S43 times out or answers with a server error
    const attempts = method === 'get' ? 3 : 1
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await executeHttpRequest(destination(), {
          method, url: query ? `${path}?${query}` : path, data,
          headers: {
            Accept: 'application/json',
            ...(method !== 'get' && { 'x-csrf-token': this.#csrf }),
            ...(this.#cookies.size && { cookie: [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ') }),
            ...headers
          }
        }, { fetchCsrfToken: false })
        this.#keepCookies(res.headers)
        return res
      } catch (e) {
        const err = new S43Error(e)
        if (attempt < attempts && (!err.status || err.status >= 500)) {
          await new Promise(r => setTimeout(r, 1500 * attempt))
          continue
        }
        throw err
      }
    }
  }

  async #fetchCsrf() {
    const res = await executeHttpRequest(destination(), { method: 'get', url: `${F2548}/`, headers: { 'x-csrf-token': 'Fetch', Accept: 'application/json' } }, { fetchCsrfToken: false })
    this.#csrf = res.headers['x-csrf-token']
    this.#keepCookies(res.headers)
  }

  #keepCookies(headers) {
    for (const c of [].concat(headers?.['set-cookie'] ?? [])) {
      const [pair] = c.split(';')
      const i = pair.indexOf('=')
      this.#cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1))
    }
  }
}

// Turns an SAP Gateway error response into readable messages
export class S43Error extends Error {
  constructor(e) {
    const res = e?.cause?.response ?? e?.response
    const body = res?.data?.error
    const details = (body?.innererror?.errordetails ?? []).filter(d => d.severity === 'error' || d.severity === 'abort')
    const messages = details.length
      ? details.map(d => ({ code: d.code, text: d.message, target: d.target }))
      : body ? [{ code: body.code, text: body.message?.value ?? String(body.message) }] : []
    super(messages.map(m => m.text).join(' ') || e?.message || 'S43 request failed')
    this.status = res?.status
    this.sapMessages = messages
  }
}

// OData V2 literals
export const v2Date = iso => (iso ? `/Date(${Date.parse(iso)})/` : null)
export const v2Str = s => `'${String(s).replace(/'/g, "''")}'`
