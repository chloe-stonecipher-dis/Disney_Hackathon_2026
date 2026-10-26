// One downloadable report with every message for every line (Gap 6),
// the replacement for ZMAXX's single "Validation Error Message" column.
import ExcelJS from 'exceljs'

export async function buildErrorReport(upload, messages) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'ZMAXX F2548 extension'

  const summary = wb.addWorksheet('Summary')
  summary.columns = [{ width: 24 }, { width: 60 }]
  summary.addRows([
    ['File', upload.fileName],
    ['Upload ID', upload.ID],
    ['Format', upload.format === '3' ? '3-Currency' : '1-Currency'],
    ['Status', upload.status_code],
    ['Lines', upload.totalLines],
    ['Errors', upload.errorCount],
    ['Warnings', upload.warningCount],
    ['Created', upload.createdAt]
  ])
  summary.getColumn(1).font = { bold: true }

  const sheet = wb.addWorksheet('Messages', { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = [
    { header: 'Line', key: 'lineNo', width: 8 },
    { header: 'Doc Ref', key: 'docRef', width: 10 },
    { header: 'Severity', key: 'severity', width: 10 },
    { header: 'Source', key: 'source', width: 12 },
    { header: 'Field', key: 'field', width: 16 },
    { header: 'Code', key: 'code', width: 26 },
    { header: 'Message', key: 'text', width: 80 },
    { header: 'How to fix', key: 'aiExplanation', width: 80 }
  ]
  sheet.getRow(1).font = { bold: true }
  sheet.autoFilter = { from: 'A1', to: 'H1' }
  const sorted = [...messages].sort((a, b) => (a.lineNo ?? 0) - (b.lineNo ?? 0))
  for (const m of sorted) {
    sheet.addRow({ ...m, severity: { E: 'Error', W: 'Warning', I: 'Info' }[m.severity_code] ?? m.severity_code })
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/**
 * The journals that were not sent, in the layout of the uploaded file: the same header
 * rows and columns, then every line of each held-back journal exactly as uploaded.
 * Lines with errors are marked red and their messages are in one extra column at the
 * end, which the upload ignores, so the file can be corrected and uploaded again.
 * @param {{table: any[][], start: number, width: number}} file from readJournalTable
 * @param {Set<string>} docRefs journals to include
 * @param {Map<number, object>} rows UploadLines by line number (for each line's journal)
 * @param {Map<number, string[]>} errors message texts by line number
 */
export async function buildErrorLinesFile(file, docRefs, rows, errors) {
  if (file.sectioned) return buildSectionedErrorLines(file, docRefs, rows, errors)
  const { table, start, width } = file
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Journal Upload'
  const sheet = wb.addWorksheet('Data Input')
  const errorCol = width + 1 // 1-based column after the template's last column

  for (let i = 0; i < start; i++) sheet.addRow(table[i] ?? [])
  const head = sheet.getRow(start)
  head.getCell(errorCol).value = 'Errors (ignored by the upload)'
  head.getCell(errorCol).font = { bold: true, color: { argb: 'FFAA0808' } }

  let lines = 0
  for (let i = start; i < table.length; i++) {
    const row = rows.get(i + 1)
    if (!row || !docRefs.has(row.docRef)) continue
    const out = sheet.addRow((table[i] ?? []).slice(0, width))
    lines++
    const texts = errors.get(i + 1)
    if (!texts) continue
    out.eachCell({ includeEmpty: true }, cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEBEE' } } })
    const cell = out.getCell(errorCol)
    cell.value = `Line ${i + 1}: ${texts.join(' | ')}`
    cell.font = { color: { argb: 'FFAA0808' } }
  }
  sheet.getColumn(errorCol).width = 90
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), lines }
}

// ZMAXX layout (Header and Line Items sections): laid out like the upload template, with ONE
// Header section and ONE Line Items section. The header is the first held-back journal's;
// the lines of every held-back journal follow under the single Line Items section, so the
// corrected file uploads again as one journal. Colours follow the template.
const BLUE = 'FF8EA9DB', LIGHT = 'FFDDEBF7', YELLOW = 'FFFFC000', ERROR_FILL = 'FFFFEBEE'
const solid = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } })

async function buildSectionedErrorLines({ table, start, width, owner }, docRefs, rows, errors) {
  const text = (i, c) => String(table[i]?.[c] ?? '').trim()
  const isItem = i => rows.has(i + 1) && docRefs.has(rows.get(i + 1).docRef)
  const first = table.findIndex((r, i) => i >= start && text(i, 1) === 'Header' && docRefs.has(owner(i)))
  let end = first + 1 // the first journal's section rows, up to its first line item
  while (end < table.length && !rows.has(end + 1) && text(end, 1) !== 'Header') end++

  // Errors on header rows (e.g. a wrong date) go to the journal's first line item
  const firstItem = new Map()
  for (const [lineNo, r] of rows) if (!firstItem.has(r.docRef) || lineNo < firstItem.get(r.docRef)) firstItem.set(r.docRef, lineNo)
  const errorsByLine = new Map()
  for (const [lineNo, texts] of errors) {
    const target = rows.has(lineNo) ? lineNo : firstItem.get(owner(lineNo - 1))
    if (target) errorsByLine.set(target, [...(errorsByLine.get(target) ?? []), ...texts.map(t => (target === lineNo ? t : `Header (row ${lineNo}): ${t}`))])
  }

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Journal Upload'
  const sheet = wb.addWorksheet('Data Input')
  const errorCol = width + 1
  const band = (row, from, to, argb) => { for (let c = from; c <= to; c++) row.getCell(c).fill = solid(argb) }

  for (let i = 0; i < start; i++) {
    const out = sheet.addRow(table[i] ?? [])
    if (i === 0) out.getCell(1).font = { size: 24 }
    if (text(i, 0).startsWith('//')) out.getCell(1).font = { bold: true }
    if (text(i, 0) === 'Batch ID') band(out, 1, 2, YELLOW)
  }
  // Section rows: Header, its names and labels, header values, Line Items, caption, item names and labels
  let lightRows = 0 // names and labels rows still to colour after a section title
  for (let i = first; i < end; i++) {
    const out = sheet.addRow((table[i] ?? []).slice(0, width))
    const filled = (table[i] ?? []).some(v => String(v ?? '').trim())
    if (text(i, 1) === 'Header') {
      out.getCell(1).value = '1' // the corrected file is one journal
      band(out, 1, width, BLUE)
      out.getCell(1).font = out.getCell(2).font = { bold: true }
      lightRows = 2
    } else if (text(i, 1) === 'Line Items') {
      band(out, 2, 2, BLUE)
      out.getCell(2).font = { bold: true }
      lightRows = 2
    } else if (filled && lightRows === 2 && text(i, 1) === '' && !(table[i] ?? []).includes('HKONT')) {
      out.eachCell(c => { c.fill = solid(LIGHT) }) // "Transaction Currency" caption over Debit and Credit
    } else if (filled && lightRows > 0) {
      band(out, 2, width, LIGHT)
      lightRows--
    }
  }
  const labels = sheet.lastRow // the line item labels: the errors column gets its title here
  labels.getCell(errorCol).value = 'Errors (ignored by the upload)'
  labels.getCell(errorCol).font = { bold: true, color: { argb: 'FFAA0808' } }

  const buzei = (table.find(r => r?.includes('HKONT')) ?? []).indexOf('BUZEI') // line item number column
  let lines = 0
  for (let i = start; i < table.length; i++) {
    if (!isItem(i)) continue
    const out = sheet.addRow((table[i] ?? []).slice(0, width))
    lines++
    if (buzei >= 0) out.getCell(buzei + 1).value = String(lines).padStart(3, '0')
    const texts = errorsByLine.get(i + 1)
    if (!texts) continue
    for (let c = 1; c <= width; c++) out.getCell(c).fill = solid(ERROR_FILL)
    out.getCell(errorCol).value = `Row ${i + 1}: ${texts.join(' | ')}`
    out.getCell(errorCol).font = { color: { argb: 'FFAA0808' } }
  }
  sheet.getColumn(1).width = 12
  for (let c = 2; c <= width; c++) sheet.getColumn(c).width = 16
  sheet.getColumn(errorCol).width = 90
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), lines }
}
