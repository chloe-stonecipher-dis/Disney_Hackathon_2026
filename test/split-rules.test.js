import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitDocuments } from '../srv/lib/split.js'
import { validateZmaxx, sum } from '../srv/lib/rules.js'
import { decideRouting } from '../srv/lib/routing.js'

const config = { maxLines: 950, maxLinesTax: 300, approvalUSD: 1000000, clearingAccount: '0000199999', clearingBusArea: '9999' }
const bands = [
  { code: 'UNDER_1', lowUSD: 0, highUSD: 1, seq: 1 },
  { code: '1_TO_100', lowUSD: 1, highUSD: 100, seq: 2 },
  { code: 'OVER_100', lowUSD: 100, highUSD: null, seq: 3 }
]
const rates = new Map([['USD', 1], ['EUR', 1.08]])

let n = 0
const line = (amountTC, extra = {}) => ({
  lineNo: ++n, docRef: 'D1', companyCode: '1000', documentType: 'SA', documentDate: '2026-10-14', postingDate: '2026-10-15',
  businessArea: '1100', glAccount: '0000400000', ttype: '310', amountTC, currencyTC: 'USD', ...extra
})
const pairs = (count, amount, extra) => Array.from({ length: count }, () => [line(amount, extra), line(-amount, extra)]).flat()
const allLines = d => (d.clearingLine ? [...d.lines, d.clearingLine] : d.lines)

test('splits at 950 lines and keeps every sub-document balanced', () => {
  const rows = pairs(1000, 50) // 2,000 lines
  const { documents, messages } = splitDocuments(rows, { config, bands, sortAndSplit: false, rates })
  assert.equal(messages.length, 0)
  assert.equal(documents.length, 3)
  for (const d of documents) {
    assert.ok(allLines(d).length <= 950)
    assert.equal(sum(allLines(d), 'amountTC'), 0)
    assert.match(d.splitReason, /LINE_LIMIT/)
  }
  assert.equal(documents.reduce((s, d) => s + d.lines.length, 0), 2000)
})

test('uses the 300-line limit when tax codes are present (Gap 5)', () => {
  const rows = pairs(475, 500, { taxCode: 'V1' }) // 950 lines with tax
  const { documents } = splitDocuments(rows, { config, bands, sortAndSplit: false, rates })
  assert.equal(documents.length, 4)
  for (const d of documents) assert.ok(allLines(d).length <= 300)
  assert.ok(documents.every(d => d.splitReason.includes('TAX_LIMIT')))
})

test('Sort & Split puts lines into amount bands (Gap 1)', () => {
  const rows = [...pairs(3, 0.5), ...pairs(3, 50), ...pairs(3, 5000)]
  const { documents } = splitDocuments(rows, { config, bands, sortAndSplit: true, rates })
  assert.deepEqual(documents.map(d => d.amountBand).sort(), ['1_TO_100', 'OVER_100', 'UNDER_1'])
  for (const d of documents) assert.equal(sum(allLines(d), 'amountTC'), 0)
})

test('clearing lines across sub-documents net to zero', () => {
  const rows = [line(0.5), line(150), line(-150.5)]
  const { documents } = splitDocuments(rows, { config, bands, sortAndSplit: true, rates })
  const clearing = documents.filter(d => d.clearingLine).map(d => d.clearingLine)
  assert.ok(clearing.length >= 2)
  assert.equal(sum(clearing, 'amountTC'), 0)
})

test('TTYPE rule flags a missing Transaction Type (Gap 7)', () => {
  const rows = [line(10, { glAccount: '0000160000', ttype: '' }), line(-10)]
  const msgs = validateZmaxx(rows, { format: '1', suppress: false, ttypeRules: [{ glAccount: '0000160000', companyCode: '*', requiredTType: '*' }], glAccounts: new Map(), companyCodes: new Map(), rates })
  assert.ok(msgs.some(m => m.code === 'ZMAXX_TTYPE_MISSING' && m.lineNo === rows[0].lineNo))
})

test('3-Currency FX check can be suppressed (Gap 9)', () => {
  const rows = [line(100, { currencyTC: 'EUR', amountLC: 100, currencyLC: 'EUR', amountGC: 100, currencyGC: 'USD' }),
    line(-100, { currencyTC: 'EUR', amountLC: -100, currencyLC: 'EUR', amountGC: -100, currencyGC: 'USD' })]
  const ctx = { format: '3', ttypeRules: [], glAccounts: new Map(), companyCodes: new Map(), rates }
  assert.ok(validateZmaxx(rows, { ...ctx, suppress: false }).some(m => m.code === 'ZMAXX_3CURR_FX'))
  assert.ok(!validateZmaxx(rows, { ...ctx, suppress: true }).some(m => m.code === 'ZMAXX_3CURR_FX'))
})

test('routing follows the $1M matrix (Gap 3)', () => {
  const small = { currencyTC: 'USD', lines: [line(500), line(-500)] }
  const big = { currencyTC: 'USD', lines: [line(1500000), line(-1500000)] }
  const opts = { approvalUSD: 1000000, rates }
  assert.equal(decideRouting(small, { ...opts, requestedMode: 'POST' }).postingMode, 'POST')
  assert.equal(decideRouting(big, { ...opts, requestedMode: 'POST' }).needsApproval, true)
  assert.equal(decideRouting(small, { ...opts, requestedMode: 'PARK' }).needsApproval, true)
})
