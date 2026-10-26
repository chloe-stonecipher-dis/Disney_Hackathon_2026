// Reads the upload file (.xlsx or .csv) into flat line objects.
//
// The layout is one row per journal line, with the header fields repeated and a
// "Doc Ref" column that groups rows into one journal (what ZMAXX "Copy Header" does).
// Column names are matched case-insensitively against the aliases below, so the
// F2548 template and the ZMAXX 7.1 Data Input tab can both be mapped here.
// Check the aliases against the exact F2548 template version in your system.
import ExcelJS from 'exceljs'

const COLUMNS = {
  docRef: ['doc ref', 'document reference', 'batch id', 'journal id', 'doc no'],
  companyCode: ['company code', 'comp code', 'bukrs'],
  documentType: ['document type', 'doc type', 'blart'],
  documentDate: ['document date', 'doc date', 'bldat'],
  postingDate: ['posting date', 'budat'],
  fiscalPeriod: ['period', 'fiscal period', 'monat'],
  reference: ['reference', 'xblnr'],
  headerText: ['doc header text', 'document header text', 'header text', 'bktxt'],
  businessArea: ['business area', 'bus area', 'gsber'],
  glAccount: ['g/l account', 'gl account', 'account', 'hkont'],
  costCenter: ['cost center', 'kostl'],
  ttype: ['transaction type', 'ttype', 'trans type'],
  taxCode: ['tax code', 'mwskz'],
  itemText: ['item text', 'line text', 'sgtxt'],
  amountTC: ['amount', 'amount tc', 'amount in transaction currency', 'amount 00'],
  currencyTC: ['currency', 'currency tc', 'transaction currency', 'currency key 00'],
  amountLC: ['amount lc', 'amount in local currency', 'amount 10'],
  currencyLC: ['currency lc', 'local currency', 'currency key 10'],
  amountGC: ['amount gc', 'amount in group currency', 'amount 30'],
  currencyGC: ['currency gc', 'group currency', 'currency key 30']
}

const AMOUNT_FIELDS = ['amountTC', 'amountLC', 'amountGC']
const DATE_FIELDS = ['documentDate', 'postingDate']

/**
 * @param {Buffer} buffer file content
 * @param {string} fileName used to pick xlsx or csv
 * @param {{dateFormat?: string}} [opts]
 * @returns {Promise<{rows: object[], messages: object[]}>}
 */
export async function parseTemplate(buffer, fileName, opts = {}) {
  const messages = []
  if (!/\.csv$/i.test(fileName) && await isErrorReport(buffer)) {
    messages.push(msg(0, null, 'TEMPLATE_IS_ERROR_REPORT', 'This file is an error report downloaded from this app, not a journal file. Upload the journal file itself.'))
    return { rows: [], messages }
  }
  const table = /\.csv$/i.test(fileName) ? readCsv(buffer.toString('utf8')) : await readXlsx(buffer)
  // Newer template: a "Header" section and a "Line Items" section per journal
  if (isSectioned(table)) return parseSectioned(table, opts)
  // The standard F2548 "Upload General Journal Entry" template has a row of technical names
  const techIdx = table.findIndex(r => r?.some(c => cellText(c) === 'BUKRS') && r.some(c => cellText(c) === 'HKONT'))
  if (techIdx >= 0) return parseF2548(table, techIdx, opts)
  const headerIdx = table.findIndex(r => r.some(c => matchColumn(c) === 'glAccount'))
  if (headerIdx < 0) {
    messages.push(msg(0, null, 'TEMPLATE_NO_HEADER', 'No header row with a "G/L Account" column was found. Use the latest template.'))
    return { rows: [], messages }
  }
  const map = table[headerIdx].map(matchColumn)
  for (const required of ['companyCode', 'glAccount', 'amountTC', 'currencyTC']) {
    if (!map.includes(required)) messages.push(msg(0, required, 'TEMPLATE_MISSING_COLUMN', `The template has no "${COLUMNS[required][0]}" column.`))
  }
  if (messages.length) return { rows: [], messages }

  const rows = []
  for (let i = headerIdx + 1; i < table.length; i++) {
    const raw = table[i]
    if (!raw || raw.every(c => c === null || c === undefined || String(c).trim() === '')) continue
    const lineNo = i + 1 // spreadsheet row number, as the user sees it
    const row = { lineNo }
    map.forEach((field, col) => {
      if (field) row[field] = normalize(field, raw[col], lineNo, messages, opts)
    })
    // S/4 stores numeric G/L accounts and cost centers with leading zeros
    if (row.glAccount && /^\d+$/.test(row.glAccount)) row.glAccount = row.glAccount.padStart(10, '0')
    if (row.costCenter && /^\d+$/.test(row.costCenter)) row.costCenter = row.costCenter.padStart(10, '0')
    if (!row.docRef) row.docRef = '1'
    rows.push(row)
  }
  return { rows, messages }
}

// ---------------------------------------------------------------------------
// F2548 template: technical names in one row, a label row under it, then the data.
// A number in the first column starts a new journal; header fields are filled on that
// line only and apply to the journal's following lines. Debit (WRSOL) and Credit (WRHAB)
// are positive amounts. Business area (GSBER) and Transaction Type (RMVCT) are added
// as extra columns, as the template's own instructions describe.
// ---------------------------------------------------------------------------
const F2548_COLUMNS = {
  BUKRS: 'companyCode', BLART: 'documentType', BLDAT: 'documentDate', BUDAT: 'postingDate', MONAT: 'fiscalPeriod',
  BKTXT: 'headerText', WAERS: 'currencyTC', XBLNR: 'reference',
  TO_BUKRS: 'lineCompanyCode', HKONT: 'glAccount', SGTXT: 'itemText', WRSOL: 'debit', WRHAB: 'credit',
  DMBTR: 'amountLC', DMBE2: 'amountGC', MWSKZ: 'taxCode', KOSTL: 'costCenter', GSBER: 'businessArea', RMVCT: 'ttype'
}
const F2548_HEADER = ['companyCode', 'documentType', 'documentDate', 'postingDate', 'fiscalPeriod', 'headerText', 'currencyTC', 'reference']

// Debit/Credit -> signed amount (LC/LC2 amounts follow the same sign); S/4 number padding
function finishLine(row, lineNo, messages) {
  const debit = row.debit ?? 0, credit = row.credit ?? 0
  if (debit && credit) messages.push(msg(lineNo, 'amountTC', 'TEMPLATE_DEBIT_AND_CREDIT', 'Fill either Debit or Credit on a line, not both.'))
  row.amountTC = row.debit == null && row.credit == null ? null : Math.round((debit - credit) * 100) / 100
  const sign = row.amountTC < 0 ? -1 : 1
  if (row.amountLC != null) row.amountLC = sign * Math.abs(row.amountLC)
  if (row.amountGC != null) row.amountGC = sign * Math.abs(row.amountGC)
  delete row.debit
  delete row.credit
  if (row.glAccount && /^\d+$/.test(row.glAccount)) row.glAccount = row.glAccount.padStart(10, '0')
  if (row.costCenter && /^\d+$/.test(row.costCenter)) row.costCenter = row.costCenter.padStart(10, '0')
}

function parseF2548(table, techIdx, opts) {
  const messages = []
  const tech = table[techIdx].map(cellText)
  const map = tech.map(t => F2548_COLUMNS[t] ?? null)
  for (const required of ['BUKRS', 'HKONT', 'WRSOL', 'WRHAB', 'WAERS']) {
    if (!tech.includes(required)) messages.push(msg(0, required, 'TEMPLATE_MISSING_COLUMN', `The F2548 template has no ${required} column.`))
  }
  if (messages.length) return { rows: [], messages }

  // Skip the label row ("*Company Code (4)", …) under the technical names
  let start = techIdx + 1
  if (table[start]?.some(c => /\(\d+\)|^\*/.test(String(c ?? '')))) start++

  const ignored = new Set()
  const rows = []
  let header = null
  let docRef = null
  for (let i = start; i < table.length; i++) {
    const raw = table[i] ?? []
    if (raw.slice(1).every(c => cellText(c) === '')) continue
    const lineNo = i + 1
    const seq = cellText(raw[0])
    const row = { lineNo }
    map.forEach((field, col) => {
      if (col === 0) return
      if (!field) {
        if (cellText(raw[col]) !== '' && tech[col]) ignored.add(tech[col])
        return
      }
      if (field === 'debit' || field === 'credit' || field === 'amountLC' || field === 'amountGC') row[field] = normalize('amountTC', raw[col], lineNo, messages, opts)
      else row[field] = normalize(field === 'lineCompanyCode' ? 'companyCode' : field, raw[col], lineNo, messages, opts)
    })

    // New journal when the first column has a number, header values come from that line
    if (seq !== '' || !header) {
      docRef = seq || '1'
      header = Object.fromEntries(F2548_HEADER.map(f => [f, row[f] ?? null]))
    } else {
      for (const f of F2548_HEADER) if (row[f] == null) row[f] = header[f]
    }
    row.docRef = docRef
    if (row.lineCompanyCode) row.companyCode = row.lineCompanyCode
    delete row.lineCompanyCode

    finishLine(row, lineNo, messages)
    rows.push(row)
  }
  for (const col of ignored) {
    messages.push({ ...msg(0, col, 'TEMPLATE_COLUMN_NOT_USED', `Column ${col} has values, but this app does not pass it to SAP yet. Those values are ignored.`), severity_code: 'W' })
  }
  return { rows, messages }
}

// ---------------------------------------------------------------------------
// Sectioned template (Upload General Journal Entries with separate sections):
//   <journal no>,Header            <- starts a journal; the number groups it
//   ,WAERS,BLDAT,BLART,...         <- header technical names
//   ,Transaction Currency (5),...  <- labels
//   ,USD,4/15/2025,SA,...          <- the header values
//   ,Line Items
//   ,,,...,Transaction Currency    <- group captions (ignored)
//   ,BUZEI,BUKRS,GSBER,...,HKONT   <- line technical names
//   ,Line Item (3),...             <- labels
//   ,001,1005,101,...              <- one row per line item
// A further "<no>,Header" row starts the next journal.
// ---------------------------------------------------------------------------
const SECTION_IGNORED = new Set(['BUZEI']) // structure only, nothing to post

const isSectioned = table => table.some(r => cellText(r?.[1]) === 'Header') && table.some(r => cellText(r?.[1]) === 'Line Items')

function parseSectioned(table, opts) {
  const messages = []
  const rows = []
  const ignored = new Set()
  const isLabelRow = r => r?.some(c => /\(\d+\)|^\*/.test(String(c ?? '')))
  let journal = 0, docRef = null, header = null, mode = null, tech = null

  for (let i = 0; i < table.length; i++) {
    const raw = table[i] ?? []
    const first = cellText(raw[0]), second = cellText(raw[1])
    if (second === 'Header') {
      docRef = first || String(++journal)
      if (first && Number(first) > journal) journal = Number(first)
      header = {}
      mode = 'headerTech'
      continue
    }
    if (second === 'Line Items') { mode = 'itemTech'; continue }
    if (raw.slice(1).every(c => cellText(c) === '')) continue
    const lineNo = i + 1

    if (mode === 'headerTech') {
      tech = raw.map(cellText)
      mode = 'headerValues'
      continue
    }
    if (mode === 'headerValues') {
      if (isLabelRow(raw)) continue
      // One row of header values for the journal; its format errors belong to this journal only
      const before = messages.length
      tech.forEach((t, col) => {
        if (!t) return
        const field = F2548_COLUMNS[t]
        if (!field || !F2548_HEADER.includes(field) && field !== 'companyCode') {
          if (cellText(raw[col]) !== '') ignored.add(t)
          return
        }
        header[field] = normalize(field, raw[col], lineNo, messages, opts)
      })
      for (const m of messages.slice(before)) m.docRef = docRef
      mode = 'waitItems'
      continue
    }
    if (mode === 'itemTech') {
      // Skip the caption row ("Transaction Currency") until the row with the technical names
      if (!raw.some(c => cellText(c) === 'HKONT')) continue
      tech = raw.map(cellText)
      for (const required of ['HKONT', 'WRSOL', 'WRHAB']) {
        if (!tech.includes(required)) messages.push(msg(0, required, 'TEMPLATE_MISSING_COLUMN', `The Line Items section has no ${required} column.`))
      }
      if (messages.some(m => m.code === 'TEMPLATE_MISSING_COLUMN')) return { rows: [], messages }
      mode = 'items'
      continue
    }
    if (mode !== 'items' || isLabelRow(raw)) continue

    // A line item: header values first, then the line's own columns
    const row = { lineNo, docRef, ...header }
    tech.forEach((t, col) => {
      if (!t || col === 0) return
      const field = F2548_COLUMNS[t]
      if (!field) {
        if (cellText(raw[col]) !== '' && !SECTION_IGNORED.has(t)) ignored.add(t)
        return
      }
      if (field === 'debit' || field === 'credit' || field === 'amountLC' || field === 'amountGC') row[field] = normalize('amountTC', raw[col], lineNo, messages, opts)
      else {
        const value = normalize(field === 'lineCompanyCode' ? 'companyCode' : field, raw[col], lineNo, messages, opts)
        if (value != null || !(field in row)) row[field] = value
      }
    })
    if (row.lineCompanyCode) row.companyCode = row.lineCompanyCode
    delete row.lineCompanyCode
    finishLine(row, lineNo, messages)
    rows.push(row)
  }
  if (!rows.length && !messages.length) messages.push(msg(0, null, 'TEMPLATE_NO_LINES', 'The file has a Header section but no line items.'))
  for (const col of ignored) {
    messages.push({ ...msg(0, col, 'TEMPLATE_COLUMN_NOT_USED', `Column ${col} has values, but this app does not pass it to SAP yet. Those values are ignored.`), severity_code: 'W' })
  }
  return { rows, messages }
}

const cellText = c => (c === null || c === undefined ? '' : String(c).trim())

function matchColumn(cell) {
  if (cell === null || cell === undefined) return null
  const label = String(cell).trim().toLowerCase().replace(/\s+/g, ' ').replace(/[*:]$/, '')
  for (const [field, aliases] of Object.entries(COLUMNS)) if (aliases.includes(label)) return field
  return null
}

function normalize(field, value, lineNo, messages, opts) {
  if (value === null || value === undefined || value === '') return null
  if (AMOUNT_FIELDS.includes(field)) return toAmount(value, field, lineNo, messages)
  if (DATE_FIELDS.includes(field)) return toDate(value, field, lineNo, messages, opts.dateFormat)
  if (field === 'fiscalPeriod') {
    const n = Number(value)
    if (!Number.isInteger(n) || n < 1 || n > 16) {
      messages.push(msg(lineNo, field, 'TEMPLATE_PERIOD', `Period "${value}" must be a number from 1 to 16 (1 = October).`))
      return null
    }
    return n
  }
  const text = String(value).trim()
  return ['currencyTC', 'currencyLC', 'currencyGC', 'taxCode', 'documentType'].includes(field) ? text.toUpperCase() : text
}

function toAmount(value, field, lineNo, messages) {
  if (typeof value === 'number') {
    if (Math.abs(Math.round(value * 100) - value * 100) > 1e-6) {
      messages.push(msg(lineNo, field, 'TEMPLATE_DECIMALS', `Amount ${value} has more than two decimal places.`))
    }
    return Math.round(value * 100) / 100
  }
  const text = String(value).trim()
  if (text.includes(',')) {
    messages.push(msg(lineNo, field, 'TEMPLATE_AMOUNT_COMMA', `Amount "${text}" contains a comma. Use number format with no thousands separators.`))
    return null
  }
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) {
    messages.push(msg(lineNo, field, 'TEMPLATE_AMOUNT', `Amount "${text}" is not a number with at most two decimal places.`))
    return null
  }
  return Number(text)
}

function toDate(value, field, lineNo, messages, dateFormat = 'MMDDYYYY') {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'number') return new Date(Math.round((value - 25569) * 864e5)).toISOString().slice(0, 10) // Excel serial date
  const text = String(value).trim()
  let y, m, d
  let match
  if ((match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/))) [, y, m, d] = match
  else if ((match = text.match(/^(\d{2})[/.]?(\d{2})[/.]?(\d{4})$/)) || (match = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) {
    ;[, m, d, y] = match
    m = m.padStart(2, '0')
    d = d.padStart(2, '0')
    if (dateFormat === 'DDMMYYYY') [m, d] = [d, m]
  }
  let iso = y && `${y}-${m}-${d}`
  const valid = v => v && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v
  // also accept YYYYMMDD, as SAP writes dates internally
  if (!valid(iso) && (match = text.match(/^((?:19|20)\d{2})(\d{2})(\d{2})$/))) iso = `${match[1]}-${match[2]}-${match[3]}`
  if (!valid(iso)) {
    messages.push(msg(lineNo, field, 'TEMPLATE_DATE', `Date "${text}" does not match your SAP date format (${dateFormat}).`))
    return null
  }
  return iso
}

// Raw rows of a journal file and the index of its first data row, as parseTemplate
// reads them (row index i = spreadsheet line i + 1). Used for the "lines with errors" file.
export async function readJournalTable(buffer, fileName) {
  const table = /\.csv$/i.test(fileName) ? readCsv(buffer.toString('utf8')) : await readXlsx(buffer)
  if (isSectioned(table)) {
    // Every row from a "<no>,Header" row on belongs to that journal (section rows included)
    const start = table.findIndex(r => cellText(r?.[1]) === 'Header')
    const owners = []
    let journal = 0, docRef = null
    for (let i = start; i < table.length; i++) {
      if (cellText(table[i]?.[1]) === 'Header') {
        const first = cellText(table[i][0])
        docRef = first || String(++journal)
        if (first && Number(first) > journal) journal = Number(first)
      }
      owners[i] = docRef
    }
    return { table, start, width: Math.max(...table.map(r => r?.length ?? 0)), owner: i => owners[i], sectioned: true }
  }
  const techIdx = table.findIndex(r => r?.some(c => cellText(c) === 'BUKRS') && r.some(c => cellText(c) === 'HKONT'))
  if (techIdx >= 0) {
    const labels = table[techIdx + 1]?.some(c => /\(\d+\)|^\*/.test(String(c ?? '')))
    return { table, start: techIdx + (labels ? 2 : 1), width: table[techIdx].length }
  }
  const headerIdx = table.findIndex(r => r?.some(c => matchColumn(c) === 'glAccount'))
  return { table, start: headerIdx + 1, width: table[headerIdx]?.length ?? 0 }
}

// The error report (srv/lib/report.js) has exactly a Summary and a Messages sheet
async function isErrorReport(buffer) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  const names = wb.worksheets.map(w => w.name).sort().join('|')
  return names === 'Messages|Summary'
}

async function readXlsx(buffer) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  const sheet = wb.getWorksheet('Data Input') || wb.worksheets[0]
  const table = []
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const values = []
    row.eachCell({ includeEmpty: true }, (cell, col) => { values[col - 1] = cellValue(cell.value) })
    table[rowNumber - 1] = values
  })
  return table
}

function cellValue(v) {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) return v.result          // formula
    if ('richText' in v) return v.richText.map(t => t.text).join('')
    if ('text' in v) return v.text              // hyperlink
  }
  return v
}

function readCsv(text) {
  const delimiter = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ','
  const rows = []
  let row = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === delimiter) { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows
}

function msg(lineNo, field, code, text) {
  return { lineNo, field, code, text, source: 'TEMPLATE', severity_code: 'E' }
}
