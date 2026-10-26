// Sort & Split engine (Gap 1) with tax-aware line limits (Gap 5).
//
// Order of splitting, as in ZMAXX:
//   1. Doc Ref (one journal per Copy Header block)
//   2. Transaction currency (3-Currency "Multiple Currency Split")
//   3. Amount band, when Sort & Split is on: under $1, $1-$100, over $100
//   4. Line limit: 300 when any line carries a tax code, otherwise 950
// A sub-document that no longer balances on its own gets one line on the
// clearing account; across all sub-documents of a Doc Ref these lines net to zero.
import { groupBy, sum } from './rules.js'

/**
 * @param {object[]} rows validated lines
 * @param {object} opts
 * @param {object} opts.config row of zmaxx.SplitConfig
 * @param {object[]} opts.bands rows of zmaxx.AmountBands
 * @param {boolean} opts.sortAndSplit
 * @param {Map<string, number>} opts.rates currency -> USD
 * @returns {{documents: object[], messages: object[]}}
 */
export function splitDocuments(rows, { config, bands, sortAndSplit, rates }) {
  const documents = []
  const messages = []
  const orderedBands = [...bands].sort((a, b) => a.seq - b.seq)

  for (const [docRef, docLines] of groupBy(rows, r => r.docRef)) {
    const byCurrency = groupBy(docLines, l => l.currencyTC)
    for (const [currencyTC, curLines] of byCurrency) {
      const groups = sortAndSplit
        ? groupBy(curLines, l => (l.amountBand = bandOf(l, orderedBands, rates)))
        : new Map([[null, curLines]])

      for (const [band, bandLines] of groups) {
        const hasTax = bandLines.some(l => l.taxCode)
        const limit = (hasTax ? config.maxLinesTax : config.maxLines) - 1 // keep room for a clearing line
        for (let i = 0; i < bandLines.length; i += limit) {
          const lines = bandLines.slice(i, i + limit)
          const reasons = [
            byCurrency.size > 1 && 'CURRENCY',
            groups.size > 1 && 'AMOUNT_BAND',
            bandLines.length > limit && (hasTax ? 'TAX_LIMIT' : 'LINE_LIMIT')
          ].filter(Boolean)
          documents.push({
            docRef,
            companyCode: lines[0].companyCode,
            currencyTC,
            amountBand: band,
            splitReason: reasons.join(',') || 'NONE',
            hasTax: lines.some(l => l.taxCode),
            lines
          })
        }
      }
    }
  }

  // Balance every sub-document that was cut out of a larger journal
  documents.forEach((doc, idx) => {
    doc.seq = idx + 1
    const tc = sum(doc.lines, 'amountTC'), lc = sum(doc.lines, 'amountLC'), gc = sum(doc.lines, 'amountGC')
    if (tc === 0 && lc === 0 && gc === 0) return
    if (!config.clearingAccount) {
      messages.push({ docRef: doc.docRef, lineNo: doc.lines[0].lineNo, source: 'SPLIT', severity_code: 'E', code: 'SPLIT_NO_CLEARING', text: `Journal ${doc.docRef} was split, and part ${doc.seq} does not balance on its own. A clearing account is needed to balance it (Admin service, SplitConfig).` })
      return
    }
    const first = doc.lines[0]
    doc.clearingLine = {
      glAccount: config.clearingAccount,
      businessArea: config.clearingBusArea || first.businessArea,
      ttype: config.clearingTType || null,
      itemText: `Split clearing ${doc.docRef}/${doc.seq}`,
      amountTC: -tc,
      currencyTC: doc.currencyTC,
      amountLC: first.amountLC == null ? null : -lc,
      currencyLC: first.currencyLC,
      amountGC: first.amountGC == null ? null : -gc,
      currencyGC: first.currencyGC
    }
  })
  return { documents, messages }
}

export function bandOf(line, bands, rates) {
  const usd = Math.abs(toUSD(line, rates))
  const band = bands.find(b => usd >= Number(b.lowUSD) && (b.highUSD == null || usd < Number(b.highUSD)))
  return band?.code ?? bands.at(-1)?.code ?? null
}

// USD value of a line: GC when given (3-Currency), else TC converted with the rate table
export function toUSD(line, rates) {
  if (line.amountGC != null) return Number(line.amountGC)
  const rate = rates.get(line.currencyTC) ?? 1
  return Number(line.amountTC || 0) * rate
}
