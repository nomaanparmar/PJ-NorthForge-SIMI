using InvoiceService as service from '../../srv/invoice-service';

annotate service.InvoiceExceptions with @(
  UI.HeaderInfo: {
    TypeName: 'Invoice Exception',
    TypeNamePlural: 'Invoice Exceptions',
    Title: { Value: invoiceNumber },
    Description: { Value: exceptionReasonText }
  },

  UI.SelectionFields: [ status, exceptionType_code, sourceChannel, vendor_ID ],

  UI.Identification: [
    { $Type: 'UI.DataFieldForAction', Action: 'InvoiceService.retriage',      Label: 'Retriage' },
    { $Type: 'UI.DataFieldForAction', Action: 'InvoiceService.approve',       Label: 'Approve' },
    { $Type: 'UI.DataFieldForAction', Action: 'InvoiceService.rejectInvoice', Label: 'Reject' },
    { $Type: 'UI.DataFieldForAction', Action: 'InvoiceService.edit',          Label: 'Edit Amounts' }
  ],

  UI.LineItem: [
    { Value: invoiceNumber, Label: 'Invoice #' },
    { Value: vendor.name,   Label: 'Vendor' },
    { Value: exceptionType.name, Label: 'Exception Type' },
    { Value: sourceChannel, Label: 'Channel' },
    { Value: grossAmount,   Label: 'Gross Amount' },
    { Value: currency },
    { Value: status,        Label: 'Status', Criticality: statusCriticality },
    { Value: confidenceScore, Label: 'AI Confidence' },
    { Value: slaDueAt,      Label: 'SLA Due' }
  ],

  UI.Facets: [
    {
      $Type: 'UI.ReferenceFacet',
      ID: 'InvoiceHeaderFacet',
      Label: 'Invoice Header',
      Target: '@UI.FieldGroup#Header'
    },
    {
      $Type: 'UI.ReferenceFacet',
      ID: 'ExceptionFacet',
      Label: 'Exception Details',
      Target: '@UI.FieldGroup#Exception'
    },
    {
      $Type: 'UI.ReferenceFacet',
      ID: 'AIRecommendationFacet',
      Label: 'AI Recommendation',
      Target: '@UI.FieldGroup#AIRecommendation'
    },
    {
      $Type: 'UI.ReferenceFacet',
      ID: 'ClerkActionFacet',
      Label: 'Clerk Decision',
      Target: '@UI.FieldGroup#ClerkAction'
    },
    {
      $Type: 'UI.ReferenceFacet',
      ID: 'AuditTrailFacet',
      Label: 'Audit Trail (Recommendation Log)',
      Target: 'recommendations/@UI.LineItem'
    }
  ],

  UI.FieldGroup#Header: { Data: [
    { Value: invoiceNumber }, { Value: fiscalYear }, { Value: companyCode },
    { Value: vendor.name, Label: 'Vendor' }, { Value: purchaseOrder }, { Value: purchaseOrderItem },
    { Value: invoiceDate }, { Value: postingDate }, { Value: currency },
    { Value: grossAmount }, { Value: netAmount }, { Value: taxAmount },
    { Value: taxJurisdiction },
    { Value: taxCodeOnInvoice, Label: 'Tax Code (Invoice)' },
    { Value: taxCodeExpected,  Label: 'Tax Code (Expected)' }
  ]},

  UI.FieldGroup#Exception: { Data: [
    { Value: exceptionType.name, Label: 'Exception Type' },
    { Value: exceptionReasonText, Label: 'Exception Reason' },
    { Value: sourceChannel },
    { Value: extractionConfidence, Label: 'Extraction Confidence (DOX)' }
  ]},

  UI.FieldGroup#AIRecommendation: { Data: [
    { Value: status },
    { Value: confidenceScore, Label: 'AI Confidence Score' },
    { Value: slaDueAt, Label: 'SLA Due' }
  ]},

  UI.FieldGroup#ClerkAction: { Data: [
    { Value: assignedTo },
    { Value: clerkDecision },
    { Value: clerkComment }
  ]}
);

annotate service.InvoiceExceptions with {
  exceptionType @Common.Text: exceptionType.name @Common.TextArrangement: #TextOnly;
  vendor        @Common.Text: vendor.name        @Common.TextArrangement: #TextOnly;
};

// Approve / Reject / Edit surfaced as Object Page action buttons.
annotate service.InvoiceExceptions actions {
  approve @(Common.SideEffects: { TargetProperties: ['status', 'clerkDecision'] });
  rejectInvoice @(Common.SideEffects: { TargetProperties: ['status', 'clerkDecision'] });
};

annotate service.RecommendationLogs with @(
  UI.LineItem: [
    { Value: step,          Label: 'Step' },
    { Value: agentAction,   Label: 'Agent Action' },
    { Value: timestamp },
    { Value: confidence },
    { Value: outcome },
    { Value: reasoningTrace, Label: 'Reasoning' },
    { Value: humanUser,     Label: 'Human User' }
  ]
);

annotate service.ExceptionTypes with {
  code @Common.Text: name @Common.TextArrangement: #TextOnly;
};

annotate service.Vendors with {
  ID @Common.Text: name @Common.TextArrangement: #TextOnly;
}
