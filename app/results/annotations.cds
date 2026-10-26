using ZmaxxService as service from '../../srv/zmaxx-service';

// ---------------------------------------------------------------------------
// Upload history: List Report + Object Page (Gap 6, 8, 10)
// ---------------------------------------------------------------------------
annotate service.Uploads with @(
  UI.HeaderInfo      : {
    TypeName      : 'Upload',
    TypeNamePlural: 'Uploads',
    Title         : {Value: fileName},
    Description   : {Value: createdBy}
  },
  UI.SelectionFields : [createdBy, createdAt, status_code, format, requestedMode],
  UI.LineItem        : [
    {Value: fileName, Label: 'File'},
    {Value: createdAt, Label: 'Uploaded'},
    {Value: createdBy, Label: 'By'},
    {Value: status_code, Label: 'Status', Criticality: status.criticality},
    {$Type: 'UI.DataFieldForAnnotation', Target: '@UI.DataPoint#progress', Label: 'Progress'},
    {Value: totalLines, Label: 'Lines'},
    {Value: errorCount, Label: 'Errors'},
    {Value: documentCount, Label: 'Journals'},
    {Value: requestedMode, Label: 'Action'}
  ],
  UI.DataPoint #progress : {Value: progress, TargetValue: 100, Visualization: #Progress, Title: 'Progress'},
  UI.HeaderFacets    : [
    {$Type: 'UI.ReferenceFacet', Target: '@UI.DataPoint#progress'},
    {$Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Counts'}
  ],
  UI.FieldGroup #Counts : {Data: [
    {Value: status_code, Label: 'Status', Criticality: status.criticality},
    {Value: totalLines, Label: 'Lines'},
    {Value: errorCount, Label: 'Errors'},
    {Value: warningCount, Label: 'Warnings'},
    {Value: documentCount, Label: 'Journals'}
  ]},
  UI.FieldGroup #Settings : {Data: [
    {Value: format, Label: 'Format (1 or 3 currency)'},
    {Value: requestedMode, Label: 'Action'},
    {Value: sortAndSplit, Label: 'Sort & Split'},
    {Value: suppressValidations, Label: 'Suppress Validations'},
    {Value: sourceFileId, Label: 'Source file ID'}
  ]},
  UI.Facets          : [
    {$Type: 'UI.ReferenceFacet', ID: 'Steps', Label: 'Progress', Target: 'steps/@UI.LineItem'},
    {$Type: 'UI.ReferenceFacet', ID: 'Journals', Label: 'Journals', Target: 'documents/@UI.LineItem'},
    {$Type: 'UI.ReferenceFacet', ID: 'Messages', Label: 'Messages', Target: 'messages/@UI.LineItem'},
    {$Type: 'UI.ReferenceFacet', ID: 'Lines', Label: 'Lines', Target: 'lines/@UI.LineItem'},
    {$Type: 'UI.ReferenceFacet', ID: 'Settings', Label: 'Settings', Target: '@UI.FieldGroup#Settings'}
  ],
  UI.Identification  : [
    {$Type: 'UI.DataFieldForAction', Action: 'ZmaxxService.submit', Label: 'Split and send to SAP'}
  ]
);

annotate service.Uploads with {
  status @Common.Text: status.name @Common.TextArrangement: #TextOnly;
};

annotate service.StatusSteps with @(UI.LineItem: [
  {Value: seq, Label: '#'},
  {Value: step, Label: 'Step'},
  {Value: at, Label: 'Time'},
  {Value: detail, Label: 'Detail'}
]);

annotate service.SubDocuments with @(UI.LineItem: [
  {Value: seq, Label: '#'},
  {Value: docRef, Label: 'Doc Ref'},
  {Value: currencyTC, Label: 'Currency'},
  {Value: amountBand, Label: 'Amount band'},
  {Value: splitReason, Label: 'Split reason'},
  {Value: lineCount, Label: 'Lines'},
  {Value: totalDebitUSD, Label: 'Debit USD'},
  {Value: postingMode, Label: 'Mode'},
  {Value: s4CompanyCode, Label: 'Company code'},
  {Value: s4DocumentNumber, Label: 'S/4 document'},
  {Value: s4FiscalYear, Label: 'Year'},
  {Value: s4Status, Label: 'S/4 status'},
  {Value: workflowId, Label: 'Workflow'},
  {Value: workflowStatus, Label: 'Workflow status'},
  {Value: approvalReason, Label: 'Approval reason'}
]);

annotate service.Messages with @(UI.LineItem: [
  {Value: lineNo, Label: 'Line'},
  {Value: docRef, Label: 'Doc Ref'},
  {Value: severity_code, Label: 'Severity', Criticality: severity.criticality},
  {Value: source, Label: 'Source'},
  {Value: field, Label: 'Field'},
  {Value: code, Label: 'Code'},
  {Value: text, Label: 'Message'},
  {Value: aiExplanation, Label: 'How to fix'},
  {$Type: 'UI.DataFieldForAction', Action: 'ZmaxxService.explain', Label: 'Explain', Inline: true}
]);

annotate service.UploadLines with @(
  UI.LineItem: [
    {Value: lineNo, Label: 'Line'},
    {Value: docRef, Label: 'Doc Ref'},
    {Value: companyCode, Label: 'Co. code'},
    {Value: glAccount, Label: 'G/L account'},
    {Value: businessArea, Label: 'Bus. area'},
    {Value: costCenter, Label: 'Cost center'},
    {Value: ttype, Label: 'TTYPE'},
    {Value: taxCode, Label: 'Tax'},
    {Value: amountTC, Label: 'Amount TC'},
    {Value: currencyTC, Label: 'Cur.'},
    {Value: amountGC, Label: 'Amount GC'},
    {Value: amountBand, Label: 'Band'},
    {Value: hasError, Label: 'Error', Criticality: #Negative},
    {Value: subDocument.s4DocumentNumber, Label: 'Journal'}
  ],
  UI.SelectionFields: [lineNo, hasError, docRef, glAccount]
);
