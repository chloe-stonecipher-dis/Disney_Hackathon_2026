using zmaxx as db from '../db/schema';

/**
 * Main service behind the upload page and the results app.
 * Covers Gaps 1-10 together with the libraries in srv/lib.
 */
@requires: 'authenticated-user'
service ZmaxxService @(path: '/odata/v4/zmaxx') {

  // Every logged-in user sees all uploads
  @readonly
  entity Uploads      as projection on db.Uploads excluding { fileHash }
    actions {
      // Split the validated file and park/post it in S/4HANA (Gap 1, 3, 4, 5)
      action submit() returns Uploads;
      // One downloadable report with every message and line number (Gap 6)
      function errorReport() returns ReportFile;
      // Held-back journals in the uploaded layout, error lines marked, to correct and upload again
      function errorLinesFile() returns ReportFile;
    };

  @readonly entity UploadLines  as projection on db.UploadLines;
  @readonly entity SubDocuments as projection on db.SubDocuments;
  @readonly entity StatusSteps  as projection on db.StatusSteps;

  @readonly
  entity Messages     as projection on db.Messages
    actions {
      // Plain-language explanation and suggested fix (Gap 6, AI option)
      action explain() returns Messages;
    };

  @readonly entity UploadStatus as projection on db.UploadStatus;
  @readonly entity Severities   as projection on db.Severities;

  // Entry point for the upload page and the Excel add-in (Gap 2).
  // content = the .xlsx or .csv file, base64 encoded.
  action upload(fileName : String,
                content : LargeString,
                format : String,               // '1' or '3'
                mode : String,                 // 'PARK' or 'POST'
                sortAndSplit : Boolean,
                suppressValidations : Boolean,
                dateFormat : String,           // 'MMDDYYYY' (default) or 'DDMMYYYY', as in SU3
                validateOnly : Boolean         // true = stop after validation, like ZMAXX "Run upfront validations"
  ) returns UploadResult;

  // Whether journals can be sent to S/4 (cds.zmaxx.s43.allowPosting)
  function postingEnabled() returns Boolean;

  // Valid Transaction Types from S/4 (value help for the TTYPE rules)
  function transactionTypes() returns array of {
    code : String;
    text : String;
  };

  // Document Management: where upload files are kept (Gap 4)
  function dmsInfo() returns DmsInfo;
  function dmsFiles() returns array of DmsFile;
  function dmsDownload(objectId : String) returns ReportFile;

  type DmsInfo {
    configured : Boolean;
    reachable  : Boolean;
    repository : String;
    folder     : String;
    message    : String;
  }

  type DmsFile {
    objectId     : String;
    name         : String;
    createdAt    : Timestamp;
    createdBy    : String;
    size         : Integer;
    mimeType     : String;
    uploadID     : UUID;     // the upload this file belongs to, if any
    uploadStatus : String;
    uploadStatusName : String;
    uploadCriticality : Integer;
  }

  type UploadResult {
    ID          : UUID;
    status      : String;
    duplicateOf : UUID;
    message     : String;
  }

  type ReportFile {
    fileName  : String;
    mediaType : String;
    content   : LargeString; // base64
  }
}

/**
 * Rules maintained by Finance (Gap 7, 1, 3, 5)
 */
@requires: 'authenticated-user'
service AdminService @(path: '/odata/v4/admin', impl: 'srv/admin-service.js') {
  entity TTypeRules    as projection on db.TTypeRules;
  entity AmountBands   as projection on db.AmountBands;
  entity SplitConfig   as projection on db.SplitConfig;
  entity ExchangeRates as projection on db.ExchangeRates;
}
