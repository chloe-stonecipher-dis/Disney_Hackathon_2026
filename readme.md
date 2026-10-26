# ZMAXX retirement: F2548 side-by-side extension (CAP)

A CAP application on SAP BTP / Business AI Platform that closes the 10 gaps between
ZMAXX and Fiori F2548 (Upload General Journal Entries), without changing F2548 or the S/4HANA core.
All S/4 data comes from the real system behind BTP destination **S43**. There is no mock data.

## Run it (SAP Business Application Studio)

```bash
npm install
npm run watch         # creates db.sqlite and starts http://localhost:4004
npm test              # unit tests for split, rules and routing
```

| Page | Path |
| --- | --- |
| Upload page | `/upload/webapp/index.html` |
| Upload history (Fiori Elements) | `/results/webapp/index.html` |

The local app needs no login (`dummy` auth in the development profile). On BTP every user who can
sign in to the subaccount (XSUAA) can use all functions; there are no roles.

In Business Application Studio the app reaches S43 through the studio's destination proxy
(`cds.zmaxx.s43.devProxy`). Deployed on BTP it uses destination S43 through the destination and
connectivity services.

## Switches (package.json, `cds.zmaxx.s43`)

| Setting | Default | Meaning |
| --- | --- | --- |
| `destination` | `S43` | BTP destination of the S/4 system |
| `sapCheck` | `true` | Run SAP's own check (`Simulate`) for each journal without errors during validation |
| `allowPosting` | `true` | Allow the app to post or park journals in S43. While false, validation runs fully but nothing is created in S/4 |

## How it reaches the F2548 tables

All S/4 access goes through the service of F2548 itself, `FAC_GL_DOCUMENT_POST_SRV`, so journals are
created by the same posting engine F2548 uses. Names below were checked against the S43 `$metadata`.

| Purpose | S43 entity set / function | Fields used |
| --- | --- | --- |
| Company codes | `I_CompanyCode` | `CompanyCode`, `Currency`, `ControllingArea` |
| Business areas | `I_BusinessAreaStdVH` | `BusinessArea` |
| G/L accounts | `I_GLAccountStdVH` | `GLAccount`, `CompanyCode`, `GLAccountType` |
| Cost centers | `I_CostCenterStdVH` | `ControllingArea`, `CostCenter`, `ValidityStartDate`, `ValidityEndDate` |
| Document types, currencies | `I_AccountingDocumentTypeStdVH`, `I_CurrencyStdVH` | `AccountingDocumentType`, `Currency` |
| Transaction Type (TTYPE) | `VL_SH_FAC_FIN_TRANSACTION_TYPE` | `TRTYP` |
| Journal header | `FinsPostingGLHeaders` | `CompanyCode`, `AccountingDocumentType`, `DocumentDate`, `PostingDate`, `FiscalPeriod`, `DocumentReferenceID`, `AccountingDocumentHeaderText`, `TransactionCurrency` |
| Journal lines | `FinsPostingGLHeaders(...)/Items` | `GLAccount`, `BusinessArea`, `CostCenter`, `FinancialTransactionType`, `TaxCode`, `DocumentItemText`, `DebitAmountInTransCrcy`, `CreditAmountInTransCrcy`, `AmountInCoCodeCrcy`, `AmountInLocalCurrencyN` (the one whose type is 30) |
| SAP check / post / park | `CheckAndDetermine`, `Post`, `ParkAsComplete` | `TmpId`, `TmpIdType` |
| Approval workflow active? | `IsWorkflowActive` | parked journals are approved in Verify General Journal Entries |
| Source file on the journal | `API_CV_ATTACHMENT_SRV/AttachmentContentSet` | object `BKPF`, key company code + document + year |

## Configuration Finance must maintain (Admin service, `/odata/v4/admin`)

| Table | Starts with | Needed for |
| --- | --- | --- |
| `TTypeRules` | empty | G/L accounts that require a Transaction Type (Gap 7) |
| `ExchangeRates` | USD = 1 only | the $1M approval rule for non-USD journals; uploads with a missing rate are rejected |
| `SplitConfig.clearingAccount` | empty | balancing sub-documents after Sort & Split; splits that need it fail until it is set |
| `AmountBands`, line limits, threshold | from the use-case document | Gaps 1, 3, 5 |

## Gaps and where they are closed

| Gap | Code |
| --- | --- |
| 1 Sort & Split | `srv/lib/split.js` |
| 2 Upload from template | `upload` action, upload page |
| 3 Workflow and routing | `srv/lib/routing.js`; parked journals go to Verify General Journal Entries |
| 4 File attachment | `SourceFiles` table + `attachFile` |
| 5 Large uploads with tax | `split.js`: 300-line limit with tax |
| 6 Consolidated errors | `Messages`, `errorReport`, `explain` |
| 7 TTYPE validation | `TTypeRules` + `rules.js`, values checked against S/4 |
| 8 Progress and duplicates | `StatusSteps`, file hash check |
| 9 ZMAXX validations | `rules.js` (`validateZmaxx`, `validateMasterData`) |
| 10 Page navigation | line review on the upload page, grid table in the history app |

## Deploy

```bash
mbt build && cf deploy mta_archives/zmaxx-f2548-ext_1.0.0.mtar
```

Then add both apps as tiles next to F2548.
