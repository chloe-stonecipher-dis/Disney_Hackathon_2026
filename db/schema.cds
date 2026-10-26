namespace zmaxx;

using {
  cuid,
  managed,
  sap.common.CodeList
} from '@sap/cds/common';

// ---------------------------------------------------------------------------
// Code lists
// ---------------------------------------------------------------------------

entity UploadStatus : CodeList {
  key code        : String(20); // STARTED, VALIDATING, VALIDATED, HAS_ERRORS, SPLIT, POSTING, COMPLETED, FAILED
      criticality : Integer;    // 0 neutral, 1 error, 2 warning, 3 success
}

entity Severities : CodeList {
  key code        : String(1);  // E, W, I
      criticality : Integer;
}

type CurrencyFormat : String(1) enum {
  OneCurrency   = '1';
  ThreeCurrency = '3';
}

type PostingMode    : String(4) enum {
  Park = 'PARK';
  Post = 'POST';
}

// ---------------------------------------------------------------------------
// Upload staging (one row per file the user sends)
// ---------------------------------------------------------------------------

entity Uploads : cuid, managed {
  fileName            : String(255);
  fileHash            : String(64);                     // SHA-256 of the file, duplicate check (Gap 8)
  format              : CurrencyFormat default '1';     // 1-Currency or 3-Currency
  requestedMode       : PostingMode default 'PARK';     // what the user asked for
  suppressValidations : Boolean default false;          // 3-Currency only (Gap 9)
  sortAndSplit        : Boolean default false;          // amount-band split (Gap 1)
  status              : Association to UploadStatus default 'STARTED';
  progress            : Integer default 0;              // 0..100 for the tracker (Gap 8)
  totalLines          : Integer default 0;
  errorCount          : Integer default 0;
  warningCount        : Integer default 0;
  documentCount       : Integer default 0;              // sub-documents after split
  sourceFileId        : String(100);                    // local copy in SourceFiles
  dmsObjectId         : String(100);                    // the file in SAP Document Management Service (Gap 4)
  dmsFileName         : String(255);                    // its name in the DMS folder
  dmsStatus           : String(20);                     // STORED, FAILED, NOT_CONFIGURED
  lines               : Composition of many UploadLines
                          on lines.upload = $self;
  documents           : Composition of many SubDocuments
                          on documents.upload = $self;
  steps               : Composition of many StatusSteps
                          on steps.upload = $self;
  messages            : Association to many Messages
                          on messages.upload = $self;
}

// One row per spreadsheet line, kept with its original row number (Gap 6, 10)
entity UploadLines : cuid {
  upload        : Association to Uploads;
  lineNo        : Integer;           // row number in the source file
  docRef        : String(20);        // groups lines into one journal (ZMAXX "Copy Header")
  // header fields (repeated per line in the flat template)
  companyCode   : String(4);
  documentType  : String(2);
  documentDate  : Date;
  postingDate   : Date;
  fiscalPeriod  : Integer;
  reference     : String(16);
  headerText    : String(25);
  // line item fields
  businessArea  : String(4);
  glAccount     : String(10);
  costCenter    : String(10);
  ttype         : String(3);         // Transaction Type (Gap 7)
  taxCode       : String(2);
  itemText      : String(50);
  amountTC      : Decimal(23, 2);    // currency type 00
  currencyTC    : String(5);
  amountLC      : Decimal(23, 2);    // currency type 10 (3-Currency only)
  currencyLC    : String(5);
  amountGC      : Decimal(23, 2);    // currency type 30, USD (3-Currency only)
  currencyGC    : String(5);
  amountBand    : String(10);        // UNDER_1, 1_TO_100, OVER_100 (Gap 1)
  hasError      : Boolean default false;
  subDocument   : Association to SubDocuments;
  messages      : Composition of many Messages
                    on messages.line = $self;
}

// Balanced journal produced by the split engine; carries the S/4 key once created (Gap 1, 3, 5)
entity SubDocuments : cuid {
  upload           : Association to Uploads;
  seq              : Integer;
  docRef           : String(20);
  companyCode      : String(4);
  currencyTC       : String(5);
  amountBand       : String(10);
  splitReason      : String(60);    // NONE, or a comma list of CURRENCY, AMOUNT_BAND, TAX_LIMIT, LINE_LIMIT
  lineCount        : Integer;
  hasTax           : Boolean default false;
  totalDebitUSD    : Decimal(23, 2);
  needsApproval    : Boolean default false;
  approvalReason   : String(100);
  postingMode      : PostingMode;
  // key of the journal in S/4 (BKPF for posted, VBKPF for parked)
  s4CompanyCode    : String(4);
  s4DocumentNumber : String(10);
  s4FiscalYear     : String(4);
  s4Status         : String(20);    // PARKED, POSTED, FAILED
  attachmentId     : String(100);   // link to the source file on the journal (Gap 4)
  workflowId       : String(40);    // ZMAXNETWFH or Build Process Automation instance (Gap 3)
  workflowStatus   : String(20);
  lines            : Association to many UploadLines
                       on lines.subDocument = $self;
}

// Every message for every line in one place (Gap 6)
entity Messages : cuid, managed {
  upload        : Association to Uploads;
  line          : Association to UploadLines;
  lineNo        : Integer;
  docRef        : String(20);
  source        : String(12);       // TEMPLATE, ZMAXX_RULE, SAP_CHECK, SPLIT, POSTING
  severity      : Association to Severities;
  code          : String(30);
  field         : String(30);
  text          : String(500);
  aiExplanation : String(2000);     // filled on demand (Gap 6, AI option)
}

// Progress tracker: Upload Started -> Validation Complete -> Upload Complete -> Journal Created -> Workflow Created (Gap 8)
entity StatusSteps : cuid {
  upload : Association to Uploads;
  seq    : Integer;
  step   : String(30);
  at     : Timestamp;
  detail : String(255);
}

// ---------------------------------------------------------------------------
// Configurable rules, maintained by Finance in the Admin service
// ---------------------------------------------------------------------------

// G/L account -> required Transaction Type (Gap 7). companyCode '*' = all company codes.
entity TTypeRules {
  key glAccount     : String(10);
  key companyCode   : String(4);
      requiredTType : String(3);    // a specific TTYPE, or '*' for "any non-empty value"
      description   : String(100);
}

// Amount bands for Sort & Split (Gap 1)
entity AmountBands {
  key code    : String(10);
      lowUSD  : Decimal(23, 2);
      highUSD : Decimal(23, 2);     // null = no upper limit
      seq     : Integer;
}

// Global split and routing settings (Gap 1, 3, 5)
entity SplitConfig {
  key id               : String(10);
      maxLines         : Integer;          // 950
      maxLinesTax      : Integer;          // 300
      approvalUSD      : Decimal(23, 2);   // 1,000,000
      clearingAccount  : String(10);       // balances split sub-documents
      clearingBusArea  : String(4);
      clearingTType    : String(3);
}

// Simple FX table used for the $1M threshold when amounts are not in USD
entity ExchangeRates {
  key currency : String(5);
      toUSD    : Decimal(15, 6);
}

// Metadata of the original upload file (Gap 4). The content itself is kept only in
// SAP Document Management Service; it is read from there when it is attached to
// every S/4 journal created from it through API_CV_ATTACHMENT_SRV.
entity SourceFiles : cuid, managed {
  fileName      : String(255);
  mediaType     : String(100);
  size          : Integer;
  fileHash      : String(64);                     // SHA-256 of the content
  dmsRepository : String(100);                    // DMS repository ID
  dmsFolder     : String(255);                    // folder path in that repository
  dmsObjectId   : String(100);                    // CMIS object ID of the document
  dmsFileName   : String(255);                    // its name in the DMS folder
  dmsStatus     : String(20);                     // STORED, FAILED, NOT_CONFIGURED
}
