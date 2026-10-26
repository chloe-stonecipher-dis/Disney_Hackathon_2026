// ZMAXX park/post and approval routing (Gap 3), by value only (no uploader roles):
//
//   Action   Value (USD)  Result
//   Upload   under $1M    Post
//   Upload   over $1M*    Park + approval workflow
//   Park     any          Park + approval workflow
//   * 3-Currency: workflow if the TC, LC or GC amount is over $1M USD
import { toUSD } from './split.js'

/**
 * @param {object} doc sub-document from splitDocuments
 * @param {object} opts
 * @param {'PARK'|'POST'} opts.requestedMode
 * @param {number} opts.approvalUSD threshold, 1,000,000
 * @param {Map<string, number>} opts.rates
 * @returns {{postingMode: 'PARK'|'POST', needsApproval: boolean, approvalReason: string|null, totalDebitUSD: number}}
 */
export function decideRouting(doc, { requestedMode, approvalUSD, rates }) {
  const lines = doc.clearingLine ? [...doc.lines, doc.clearingLine] : doc.lines
  const debit = f => lines.reduce((s, l) => s + Math.max(0, Number(l[f] || 0)), 0)

  const tcUSD = debit('amountTC') * (rates.get(doc.currencyTC) ?? 1)
  const lcCurrency = lines[0].currencyLC
  const lcUSD = lines[0].amountLC == null ? 0 : debit('amountLC') * (rates.get(lcCurrency) ?? 1)
  const gcUSD = lines[0].amountGC == null ? 0 : debit('amountGC')
  const totalDebitUSD = Math.round(Math.max(tcUSD, lcUSD, gcUSD, lines.reduce((s, l) => s + Math.max(0, toUSD(l, rates)), 0)) * 100) / 100

  if (requestedMode === 'PARK') return { postingMode: 'PARK', needsApproval: true, approvalReason: 'Parked on request', totalDebitUSD }
  if (totalDebitUSD > approvalUSD) {
    return { postingMode: 'PARK', needsApproval: true, approvalReason: `Over ${approvalUSD.toLocaleString('en-US')} USD`, totalDebitUSD }
  }
  return { postingMode: 'POST', needsApproval: false, approvalReason: null, totalDebitUSD }
}
