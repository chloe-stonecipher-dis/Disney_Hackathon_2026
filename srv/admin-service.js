import cds from '@sap/cds'
import { getS4Client } from './lib/s4-client.js'

/**
 * Rules maintained by Finance. TTYPE rules (Gap 7) are checked against S/4 before they are saved,
 * so the upload check never runs on a G/L account or Transaction Type that does not exist.
 */
export default class AdminService extends cds.ApplicationService {
  init() {
    const { TTypeRules } = this.entities

    this.before(['CREATE', 'UPDATE'], TTypeRules, async req => {
      const d = req.data
      // Same format as the upload check: numeric G/L accounts padded to 10 digits
      if (d.glAccount !== undefined) {
        d.glAccount = String(d.glAccount ?? '').trim()
        if (/^\d+$/.test(d.glAccount)) d.glAccount = d.glAccount.padStart(10, '0')
        if (!d.glAccount) return req.reject(400, 'Enter a G/L account.', 'glAccount')
      }
      if (d.companyCode !== undefined) {
        d.companyCode = String(d.companyCode ?? '').trim().toUpperCase() || '*'
      }
      if (d.requiredTType !== undefined) {
        d.requiredTType = String(d.requiredTType ?? '').trim().toUpperCase() || '*'
      }

      const current = req.event === 'UPDATE' ? await SELECT.one.from(TTypeRules).where(req.params.at(-1) ?? {}) : {}
      const rule = { ...current, ...d }
      const master = await getS4Client().getMasterData({
        companyCodes: rule.companyCode && rule.companyCode !== '*' ? [rule.companyCode] : [],
        glAccounts: rule.companyCode && rule.companyCode !== '*' ? [[rule.companyCode, rule.glAccount]] : [],
        costCenters: []
      })
      if (rule.companyCode !== '*') {
        if (!master.companyCodes.has(rule.companyCode)) return req.reject(400, `Company code ${rule.companyCode} does not exist in S/4.`, 'companyCode')
        if (!master.glAccounts.has(`${rule.companyCode}|${rule.glAccount}`)) {
          return req.reject(400, `G/L account ${rule.glAccount} is not created in company code ${rule.companyCode}.`, 'glAccount')
        }
      }
      if (rule.requiredTType !== '*' && !master.transactionTypes.has(rule.requiredTType)) {
        return req.reject(400, `Transaction Type ${rule.requiredTType} does not exist in S/4.`, 'requiredTType')
      }
    })

    return super.init()
  }
}
