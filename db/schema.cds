namespace com.northforge.invoice;

using { cuid, managed, sap.common.CodeList } from '@sap/cds/common';

/**
 * Core entity: one row per exception-flagged supplier invoice.
 * Populated by the ingestion event handler (SupplierInvoice.Blocked)
 * and enriched by the agentic triage pipeline.
 */
entity InvoiceExceptions : cuid, managed {
  // --- Header, as received from S/4 / EDI / DOX extraction ---
  invoiceNumber       : String(16);
  fiscalYear          : String(4);
  companyCode         : String(4);
  sourceChannel       : String(10) enum { EDI; ARIBA; EMAIL_PDF; }; // ingestion channel
  vendor              : Association to Vendors;
  purchaseOrder       : String(10);   // EBELN, kept denormalized for fast filtering
  purchaseOrderItem   : String(5);
  invoiceDate         : Date;
  postingDate         : Date;
  currency            : String(3);
  grossAmount         : Decimal(15,2);
  netAmount           : Decimal(15,2);
  taxAmount           : Decimal(15,2);
  taxJurisdiction     : String(2);    // AB / SK / MB / ...
  taxCodeOnInvoice    : String(4);
  taxCodeExpected     : String(4);

  // --- Exception classification ---
  exceptionType       : Association to ExceptionTypes;
  exceptionReasonText : String(500);

  // --- Extracted / OCR fields (populated by DOX mock for EMAIL_PDF channel) ---
  extractedPayload    : LargeString; // raw JSON from DOX extraction result
  extractionConfidence: Decimal(3,2);

  // --- Agentic triage outcome ---
  aiRecommendation    : Association to RecommendationLogs;
  status              : String(20) enum {
    NEW; INVESTIGATING; AUTO_RESOLVED; ROUTED_TO_CLERK; ESCALATED; APPROVED; REJECTED; POSTED;
  } default 'NEW';
  confidenceScore     : Decimal(3,2);       // 0.00 - 1.00, drives auto-resolve vs. route vs. escalate
  slaDueAt            : DateTime;           // now + 24h once routed to human
  assignedTo          : String(80);         // clerk/supervisor user id
  clerkDecision        : String(10) enum { APPROVE; REJECT; EDIT; }; // human action taken
  clerkComment        : String(1000);

  recommendations     : Association to many RecommendationLogs on recommendations.invoice = $self;
}

/**
 * Immutable, append-only audit trail. One row per agent action/decision.
 * Never updated after insert — satisfies the SOX-style audit requirement.
 */
entity RecommendationLogs : cuid {
  invoice             : Association to InvoiceExceptions;
  step                : Integer;                    // ordinal within the agent's investigation trace
  agentAction         : String(40) enum {
    FETCH_PO; FETCH_GR; FETCH_CONTRACT; RECOMPUTE_TAX; CHECK_VENDOR_HISTORY;
    PROPOSE_RESOLUTION; ROUTE_TO_HUMAN; ESCALATE; HUMAN_DECISION;
  };
  timestamp           : DateTime;
  model               : String(60);   // e.g. gpt-4.1@2025-04-14 via Generative AI Hub
  promptText          : LargeString;
  responseText        : LargeString;
  groundingSources     : LargeString; // JSON array: [{type:'PO', id:'4500001234'}, {type:'Contract', id:'MSA-0091', clause:'4.2'}]
  reasoningTrace       : LargeString;
  confidence          : Decimal(3,2);
  outcome             : String(20);   // AUTO_RESOLVED | ROUTED | ESCALATED | OVERRIDDEN
  humanUser           : String(80);   // set only for outcome = OVERRIDDEN / HUMAN_DECISION rows
}

entity Vendors : cuid {
  vendorNumber        : String(10);   // S/4 LIFNR, BP number
  name                : String(120);
  province            : String(2);
  taxId               : String(15);
  isTailSpend         : Boolean default false;
  paymentTermsDays    : Integer;
  earlyPaymentDiscountPct : Decimal(4,2);
  invoices            : Association to many InvoiceExceptions on invoices.vendor = $self;
  contracts           : Association to many Contracts on contracts.vendor = $self;
}

entity Contracts : cuid {
  vendor              : Association to Vendors;
  contractNumber      : String(20);
  title               : String(200);
  effectiveFrom       : Date;
  effectiveTo         : Date;
  documentRef         : String(200); // OpenText content repository ref, fetched via RAG at query time
  ratePerUnit         : Decimal(15,2);
  unit                : String(10);
  taxClauseSummary    : String(1000);
}

entity ExceptionTypes : CodeList {
  key code            : String(20);
}
