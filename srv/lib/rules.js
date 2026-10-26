// ZMAXX-specific business validations that SAP standard (and F2548) does not run.
// Ported from ZMAX_DOMESTIC_VALIDATION, ZMAX_3CURR_VALIDATION and Z_ZMAX_OB28_VALIDATION
// (Gap 7, Gap 9). Standard SAP checks run separately through BAPI_ACC_DOCUMENT_CHECK.

const REQUIRED = {
  companyCode: 'Company Code',
  documentType: 'Document Type',
  documentDate: 'Document Date',
  postingDate: 'Posting Date',
  businessArea: 'Business Area',
  glAccount: 'G/L Account',
  amountTC: 'Amount',
  currencyTC: 'Currency'
}

// GC may differ from TC x rate-table rate by this share before it is flagged (daily rate vs. table rate)
const FX_TOLERANCE = 0.02

const HEADER_FIELDS = ['companyCode', 'documentType', 'documentDate', 'postingDate', 'fiscalPeriod']

/**
 * @param {object[]} rows parsed template lines
 * @param {object} ctx
 * @param {'1'|'3'} ctx.format
 * @param {boolean} ctx.suppress 3-Currency suppress-validation (switch on the upload page)
 * @param {object[]} ctx.ttypeRules rows of zmaxx.TTypeRules
 * @param {Map<string, object>} ctx.glAccounts key `${companyCode}|${glAccount}`
 * @param {Map<string, object>} ctx.companyCodes key companyCode
 * @param {Map<string, number>} ctx.rates currency -> USD rate
 * @returns {object[]} messages
 */
export function validateZmaxx(rows, ctx) {
  const messages = []
  const err = (line, field, code, text, extra = {}) =>
    messages.push({ lineNo: line?.lineNo ?? null, docRef: line?.docRef ?? null, field, code, text, source: 'ZMAXX_RULE', severity_code: 'E', ...extra })
  const warn = (line, field, code, text) => err(line, field, code, text, { severity_code: 'W' })
  const threeCurr = ctx.format === '3'
  // A 1-Currency file uploaded as 3-Currency: one clear message instead of one per line
  const noLcGcAtAll = threeCurr && rows.length > 0 && rows.every(r => r.amountLC == null && r.amountGC == null)
  if (noLcGcAtAll) {
    err(rows[0], 'amountLC', 'ZMAXX_3CURR_NO_COLUMNS', 'You chose the 3-Currency format, but the file has no LC or GC amounts. Choose 1-Currency and upload again.')
  }

  // --- line level -----------------------------------------------------------
  for (const line of rows) {
    for (const [field, label] of Object.entries(REQUIRED)) {
      if (line[field] === null || line[field] === undefined || line[field] === '') {
        const why = field === 'businessArea' ? ' Without it, consolidation fails.' : ''
        err(line, field, 'ZMAXX_REQUIRED', `${label} is required.${why}`)
      }
    }
    if (line.amountTC === 0) err(line, 'amountTC', 'ZMAXX_ZERO_AMOUNT', 'Amount cannot be zero.')

    // Gap 7: Transaction Type required by G/L account
    const rule = ctx.ttypeRules.find(r => r.glAccount === line.glAccount && r.companyCode === line.companyCode) ||
      ctx.ttypeRules.find(r => r.glAccount === line.glAccount && r.companyCode === '*')
    if (rule) {
      if (!line.ttype) {
        err(line, 'ttype', 'ZMAXX_TTYPE_MISSING', `G/L account ${line.glAccount} requires a Transaction Type${rule.requiredTType !== '*' ? ` (${rule.requiredTType})` : ''}. ${rule.description || ''}`.trim())
      } else if (rule.requiredTType !== '*' && rule.requiredTType !== line.ttype) {
        err(line, 'ttype', 'ZMAXX_TTYPE_WRONG', `G/L account ${line.glAccount} must use Transaction Type ${rule.requiredTType}, not ${line.ttype}.`)
      }
    }

    // OB28-style rule (Z_ZMAX_OB28_VALIDATION); GLAccountType 'X' = balance sheet account in S/4
    const gl = ctx.glAccounts.get(`${line.companyCode}|${line.glAccount}`)
    if (gl && gl.accountType === 'X' && line.costCenter) {
      warn(line, 'costCenter', 'ZMAXX_OB28_BS_COST_CENTER', `Balance sheet account ${line.glAccount} does not take a Cost Center; it will be ignored.`)
    }

    // 1-Currency vs 3-Currency handling
    const cc = ctx.companyCodes.get(line.companyCode)
    if (threeCurr) {
      if (!noLcGcAtAll && (line.amountLC == null || line.amountGC == null)) {
        err(line, 'amountLC', 'ZMAXX_3CURR_AMOUNTS', '3-Currency format needs LC (type 10) and GC (type 30) amounts on every line.')
      }
      if (line.currencyGC && line.currencyGC !== 'USD') {
        err(line, 'currencyGC', 'ZMAXX_3CURR_GC_USD', `Group currency must be USD, not ${line.currencyGC}.`)
      }
      if (cc && line.currencyLC && line.currencyLC !== cc.currency) {
        err(line, 'currencyLC', 'ZMAXX_3CURR_LC', `Local currency for company code ${line.companyCode} is ${cc.currency}, not ${line.currencyLC}.`)
      }
      if (!ctx.suppress && line.amountGC != null && line.amountTC != null) {
        const rate = ctx.rates.get(line.currencyTC)
        const expected = rate ? line.amountTC * rate : null
        if (expected && Math.abs(line.amountGC - expected) > Math.max(0.02, Math.abs(expected) * FX_TOLERANCE)) {
          err(line, 'amountGC', 'ZMAXX_3CURR_FX', `GC amount ${line.amountGC} USD is more than 2% away from the expected ${expected.toFixed(2)} USD for ${line.amountTC} ${line.currencyTC}. Check the amounts, or use Suppress Validations if this is intended.`, { suppressible: true })
        }
      }
    } else if (line.amountLC != null || line.amountGC != null) {
      warn(line, 'amountLC', 'ZMAXX_1CURR_IGNORED', 'LC and GC amounts are ignored in the 1-Currency format; SAP calculates them.')
    }
  }

  // --- document level (lines grouped by Doc Ref) ---------------------------------
  for (const [docRef, lines] of groupBy(rows, r => r.docRef)) {
    const first = lines[0]
    for (const field of HEADER_FIELDS) {
      const values = new Set(lines.map(l => l[field] ?? null))
      if (values.size > 1) {
        const bad = lines.find(l => (l[field] ?? null) !== (first[field] ?? null))
        err(bad, field, 'ZMAXX_HEADER_MISMATCH', `${REQUIRED[field] || 'Period'} must be the same on every line of document ${docRef} (line ${first.lineNo} has "${first[field] ?? ''}").`)
      }
    }
    if (!threeCurr && new Set(lines.map(l => l.currencyTC)).size > 1) {
      err(first, 'currencyTC', 'ZMAXX_1CURR_MULTI', `Document ${docRef} has more than one currency. Use the 3-Currency format to split by currency.`)
    }
    // Each transaction currency must balance; it becomes its own journal (Multiple Currency Split)
    for (const [currency, cl] of groupBy(lines, l => l.currencyTC)) {
      const tc = sum(cl, 'amountTC')
      if (tc !== 0) err(cl[0], 'amountTC', 'ZMAXX_UNBALANCED', `Document ${docRef} does not balance in ${currency}: difference ${tc.toFixed(2)}.`)
      if (threeCurr && !ctx.suppress) {
        const lc = sum(cl, 'amountLC'), gc = sum(cl, 'amountGC')
        if (lc !== 0) err(cl[0], 'amountLC', 'ZMAXX_UNBALANCED_LC', `Document ${docRef} (${currency}) does not balance in local currency: difference ${lc.toFixed(2)}.`, { suppressible: true })
        if (gc !== 0) err(cl[0], 'amountGC', 'ZMAXX_UNBALANCED_GC', `Document ${docRef} (${currency}) does not balance in group currency: difference ${gc.toFixed(2)}.`, { suppressible: true })
      }
    }
  }
  return messages
}

/**
 * Checks every line against the real S/4 master data read from S43 (see s4-client getMasterData).
 * @returns {object[]} messages
 */
export function validateMasterData(rows, master) {
  const messages = []
  const err = (line, field, code, text) =>
    messages.push({ lineNo: line.lineNo, docRef: line.docRef, field, code, text, source: 'SAP_MASTER', severity_code: 'E' })
  for (const line of rows) {
    const cc = master.companyCodes.get(line.companyCode)
    if (line.companyCode && !cc) err(line, 'companyCode', 'SAP_COMPANY_CODE', `Company code ${line.companyCode} does not exist in S/4.`)
    if (line.businessArea && !master.businessAreas.has(line.businessArea)) err(line, 'businessArea', 'SAP_BUSINESS_AREA', `Business area ${line.businessArea} does not exist in S/4.`)
    if (line.documentType && !master.documentTypes.has(line.documentType)) err(line, 'documentType', 'SAP_DOCUMENT_TYPE', `Document type ${line.documentType} does not exist in S/4.`)
    for (const f of ['currencyTC', 'currencyLC', 'currencyGC']) {
      if (line[f] && !master.currencies.has(line[f])) err(line, f, 'SAP_CURRENCY', `Currency ${line[f]} does not exist in S/4.`)
    }
    if (cc && line.glAccount && !master.glAccounts.has(`${line.companyCode}|${line.glAccount}`)) {
      err(line, 'glAccount', 'SAP_GL_NOT_FOUND', `G/L account ${line.glAccount} is not created in company code ${line.companyCode} (check FS00).`)
    }
    if (cc && line.taxCode && !master.taxCodes.has(`${line.companyCode}|${line.taxCode}`)) err(line, 'taxCode', 'SAP_TAX_CODE', `Tax code ${line.taxCode} is not defined for company code ${line.companyCode}.`)
    if (line.ttype && !master.transactionTypes.has(line.ttype)) err(line, 'ttype', 'SAP_TTYPE', `Transaction Type ${line.ttype} does not exist in S/4.`)
    if (cc && line.costCenter) {
      const center = master.costCenters.get(`${cc.controllingArea}|${line.costCenter}`)
      if (!center) err(line, 'costCenter', 'SAP_COST_CENTER', `Cost center ${line.costCenter} does not exist in controlling area ${cc.controllingArea}.`)
      else if (line.postingDate && ((center.validFrom && line.postingDate < center.validFrom) || (center.validTo && line.postingDate > center.validTo))) {
        err(line, 'costCenter', 'SAP_COST_CENTER_VALIDITY', `Cost center ${line.costCenter} is not valid on ${line.postingDate}.`)
      }
    }
  }
  return messages
}

export function groupBy(items, keyFn) {
  const map = new Map()
  for (const item of items) {
    const key = keyFn(item)
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(item)
  }
  return map
}

// Sum in cents to avoid floating point drift
export function sum(lines, field) {
  return lines.reduce((s, l) => s + Math.round((l[field] || 0) * 100), 0) / 100
}
