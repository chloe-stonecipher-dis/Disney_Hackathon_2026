// Task pane behind the "Upload to SAP" ribbon button (FR-02).
// Reads the open workbook with Office.js, sends it to the CAP upload action,
// shows the five-stage tracker, then links to the results.
/* global Office, Blob */
'use strict'

const SRV = '/odata/v4/zmaxx'
const STAGES = ['Upload Started', 'Validation Complete', 'Upload Complete', 'Journal Created', 'Workflow Created']
const FINAL = ['HAS_ERRORS', 'COMPLETED', 'FAILED', 'VALIDATED']
const $ = id => document.getElementById(id)
let csrf = null

Office.onReady(info => {
  if (info.host !== Office.HostType.Excel) {
    $('error').textContent = 'Open this add-in from Excel.'
    return
  }
  $('upload').disabled = false
  $('upload').onclick = upload
})

async function upload() {
  $('error').textContent = ''
  $('upload').disabled = true
  try {
    const content = await readWorkbook()
    const fileName = workbookName()
    show(fileName)
    const res = await request('POST', `${SRV}/upload`, {
      fileName, content,
      format: $('format').value, mode: $('mode').value, dateFormat: $('dateFormat').value,
      sortAndSplit: $('sortAndSplit').checked, validateOnly: $('validateOnly').checked, suppressValidations: false
    })
    if (res.status === 'DUPLICATE') {
      setResult('warn', res.message)
      setLinks(res.duplicateOf)
      return
    }
    await track(res.ID)
  } catch (e) {
    $('error').textContent = e.message
  } finally {
    $('upload').disabled = false
  }
}

// The whole workbook as .xlsx, read in slices (Office.FileType.Compressed)
function readWorkbook() {
  return new Promise((resolve, reject) => {
    Office.context.document.getFileAsync(Office.FileType.Compressed, { sliceSize: 4 * 1024 * 1024 }, result => {
      if (result.status !== Office.AsyncResultStatus.Succeeded) return reject(new Error(result.error.message))
      const file = result.value
      const parts = []
      const next = i => file.getSliceAsync(i, slice => {
        if (slice.status !== Office.AsyncResultStatus.Succeeded) {
          file.closeAsync()
          return reject(new Error(slice.error.message))
        }
        parts.push(new Uint8Array(slice.value.data))
        if (i + 1 < file.sliceCount) return next(i + 1)
        file.closeAsync()
        resolve(toBase64(parts))
      })
      next(0)
    })
  })
}

function toBase64(parts) {
  let binary = ''
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 0x8000) binary += String.fromCharCode.apply(null, part.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function workbookName() {
  const url = Office.context.document.url || ''
  const name = decodeURIComponent(url.split(/[\\/]/).pop() || '').replace(/\?.*$/, '') || 'journal-upload'
  return /\.xlsx$/i.test(name) ? name : `${name.replace(/\.\w+$/, '')}.xlsx`
}

// Poll until the upload reaches a final status (FR-08 tracker)
async function track(ID) {
  for (;;) {
    const u = await request('GET', `${SRV}/Uploads(${ID})?$expand=status,steps($orderby=seq)`)
    render(u)
    if (FINAL.includes(u.status_code)) {
      if (u.status_code === 'HAS_ERRORS') setResult('bad', `${u.errorCount} error(s) on ${u.totalLines} lines. Open the results to see and fix them.`)
      else if (u.status_code === 'VALIDATED') setResult('ok', `${u.totalLines} lines checked, no errors.${$('validateOnly').checked ? ' Nothing was sent to SAP (Validate only).' : ''}`)
      else if (u.status_code === 'COMPLETED') setResult('ok', `${u.documentCount} journal(s) created in SAP.`)
      else setResult('bad', 'Processing stopped. Open the results for details.')
      setLinks(ID, u.errorCount > 0)
      return
    }
    await new Promise(r => setTimeout(r, 1500))
  }
}

function show(fileName) {
  $('progress').hidden = false
  $('fileName').textContent = fileName
  $('result').textContent = ''
  $('links').innerHTML = ''
  render({ progress: 0, steps: [] })
}

function render(u) {
  $('bar').style.width = `${u.progress || 0}%`
  const done = Object.fromEntries((u.steps || []).map(s => [s.step, s]))
  const failed = (u.steps || []).find(s => /Failed$/.test(s.step))
  const items = STAGES.map(name => {
    const s = done[name]
    return `<li><span class="${s ? 's-ok' : 's-wait'}">${s ? '&#10003;' : '&#9675;'}</span> ${name}${s ? `<span class="d">${escapeHtml(s.detail || '')}</span>` : ''}</li>`
  })
  if (failed) items.push(`<li><span class="s-bad">&#10007;</span> ${escapeHtml(failed.step)}<span class="d">${escapeHtml(failed.detail || '')}</span></li>`)
  $('steps').innerHTML = items.join('')
}

function setResult(kind, text) {
  $('result').className = `msg ${kind}`
  $('result').textContent = text
}

// Deep links into the results views
function setLinks(ID, withReport) {
  // Relative to this page, so the links work locally (/excel-addin/) and on BTP (/app/excel-addin/)
  const results = new URL(`../upload/webapp/index.html?upload=${ID}`, window.location.href).href
  const history = new URL(`../results/webapp/index.html#/Uploads(${ID})`, window.location.href).href
  $('links').innerHTML = `
    <a href="${results}" target="_blank">Open results (errors, journals, line review)</a>
    <a href="${history}" target="_blank">Open in Upload History</a>
    ${withReport ? '<a href="#" id="report">Download error report</a>' : ''}`
  if (withReport) $('report').onclick = e => { e.preventDefault(); downloadReport(ID) }
}

async function downloadReport(ID) {
  const r = await request('GET', `${SRV}/Uploads(${ID})/ZmaxxService.errorReport()`)
  const bytes = Uint8Array.from(atob(r.content), c => c.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: r.mediaType }))
  Object.assign(document.createElement('a'), { href: url, download: r.fileName }).click()
  URL.revokeObjectURL(url)
}

async function request(method, url, body) {
  if (method !== 'GET' && !csrf) {
    const t = await fetch(`${SRV}/`, { method: 'HEAD', headers: { 'X-CSRF-Token': 'Fetch' }, credentials: 'include' })
    csrf = t.headers.get('X-CSRF-Token') || 'unsafe'
  }
  const res = await fetch(url, {
    method, credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(method !== 'GET' && { 'X-CSRF-Token': csrf }) },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    try { message = JSON.parse(text).error.message } catch { /* not JSON */ }
    if (res.status === 401) message = 'Not logged in. Open the upload page once in your browser and log in, then try again.'
    throw new Error(message)
  }
  try { return JSON.parse(text) } catch { return text }
}

const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
