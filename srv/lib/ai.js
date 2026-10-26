// Plain-language explanation and suggested fix for an error (Gap 6, AI option).
//
// With cds.env.zmaxx.ai.enabled and an SAP AI Core binding, the message is sent to
// Generative AI Hub through @sap-ai-sdk/orchestration (install it to use this path).
// Only the message text, code and field name are sent: no amounts, accounts or names.
// Without AI, a built-in explanation per message code is returned so the demo always works.
import cds from '@sap/cds'

const LOG = cds.log('zmaxx-ai')

const FIXES = {
  ZMAXX_TTYPE_MISSING: 'Finance needs a Transaction Type on this G/L account so the line can be classified for consolidation. Fill the Transaction Type column with the value named in the message (or any valid TTYPE if none is named) and upload again.',
  ZMAXX_TTYPE_WRONG: 'This G/L account only accepts one Transaction Type. Replace the value in the Transaction Type column with the one named in the message.',
  ZMAXX_REQUIRED: 'A mandatory column is empty on this line. Fill it in; Business Area in particular is needed or consolidation fails.',
  ZMAXX_UNBALANCED: 'Debits and credits of this journal do not add up to zero in this currency. Find the missing or mistyped line (often a sign error) and correct it so the difference is 0.00.',
  ZMAXX_UNBALANCED_LC: 'In 3-Currency format SAP does not recalculate local currency, so the LC amounts must also net to zero. Adjust the LC amounts, or ask a user with Suppress Validations if the difference is intended.',
  ZMAXX_UNBALANCED_GC: 'In 3-Currency format SAP does not recalculate group currency (USD), so the GC amounts must also net to zero. Adjust the GC amounts, or use Suppress Validations if the difference is intended.',
  ZMAXX_3CURR_FX: 'The USD amount does not match the transaction amount at today\'s rate. Check that the GC column holds the USD value of this line, not the TC amount copied over.',
  ZMAXX_3CURR_GC_USD: 'TWDC reports group currency in US dollars. Set the GC currency key to USD and enter the USD amount.',
  ZMAXX_3CURR_LC: 'The LC currency must be the company code\'s own currency. Change the LC currency key, and the LC amount, to that currency.',
  ZMAXX_3CURR_AMOUNTS: 'You chose the 3-Currency format, so every line needs LC (type 10) and GC (type 30) amounts. Fill them in, or switch to 1-Currency and let SAP calculate them.',
  ZMAXX_3CURR_NO_COLUMNS: 'The file only has transaction-currency amounts, which is the 1-Currency format. Select 1-Currency on the upload page and upload the same file again; SAP then calculates the local and group currency amounts.',
  ZMAXX_OB28_COST_CENTER: 'Expense accounts need a Cost Center so the cost lands on the right department. Add the Cost Center for this line.',
  ZMAXX_HEADER_MISMATCH: 'All lines of one journal share the same header values. Make this line match the first line of the document, or give it its own Doc Ref.',
  ZMAXX_1CURR_MULTI: 'A 1-Currency journal can only have one currency. Split the lines into separate Doc Refs per currency, or use the 3-Currency format.',
  ZMAXX_LC_ONLY: 'This account is managed in local currency only. Enter the line in the company code currency.',
  SAP_CHECK_UNAVAILABLE: 'The data in this journal may be fine: SAP could not be reached for its check. Upload the journal again in a few minutes. If it keeps happening, the connection to S43 (destination or Cloud Connector) needs checking.',
  SAP_GL_BLOCKED: 'The G/L account is blocked for posting in this company code. Use the replacement account (ask GL master data), or have the block removed in FS00.',
  SAP_GL_NOT_FOUND: 'The G/L account does not exist in this company code. Check for a typo, and check FS00 that the account is created for the company code.',
  SAP_PERIOD_CLOSED: 'The posting period for this date is closed. Change the Posting Date to an open period, or ask the close team to open it.',
  SAP_BUSINESS_AREA: 'The business area code is not valid. Pick one from the business area list.',
  SAP_COMPANY_CODE: 'The company code is not valid. Check for a typo.',
  TEMPLATE_DATE: 'Dates must follow the date format in your SAP user settings (SU3), for example MMDDYYYY. Re-enter the date in that format.',
  TEMPLATE_AMOUNT_COMMA: 'Amounts must be plain numbers with no thousands separator, for example 1234.56. Remove the commas.',
  TEMPLATE_AMOUNT: 'Amounts must be numbers with at most two decimal places. Correct the value.',
  TEMPLATE_DECIMALS: 'Amounts can have at most two decimal places. Round the value.'
}

export async function explain(message) {
  if (cds.env.zmaxx?.ai?.enabled) {
    try {
      return await explainWithGenAI(message)
    } catch (e) {
      LOG.warn('Generative AI Hub call failed, using built-in explanation:', e.message)
    }
  }
  return FIXES[message.code] ?? `What it means: ${message.text} How to fix it: correct the ${message.field || 'value'} on line ${message.lineNo} and upload the file again.`
}

async function explainWithGenAI(message) {
  const sdk = '@sap-ai-sdk/orchestration' // optional dependency
  const { OrchestrationClient } = await import(sdk)
  const client = new OrchestrationClient({
    llm: { model_name: cds.env.zmaxx.ai.model },
    templating: {
      template: [
        { role: 'system', content: 'You help finance users fix journal entry upload errors in SAP. Answer in two short sentences: what the error means, then exactly how to fix it in the spreadsheet. No jargon.' },
        { role: 'user', content: 'Error code: {{?code}}\nField: {{?field}}\nMessage: {{?text}}' }
      ]
    }
  })
  const res = await client.chatCompletion({ inputParams: { code: message.code ?? '', field: message.field ?? '', text: message.text ?? '' } })
  return res.getContent()
}
// 
