using com.northforge.invoice as db from '../db/schema';

/**
 * AP exception queue + triage service.
 * Consumed by the Fiori Elements app and (in a later phase) by ServiceNow/Teams bots.
 */
@path: '/odata/v4/invoice'
service InvoiceService {

  // No @odata.draft.enabled: edits happen only through the controlled approve/rejectInvoice/edit
  // actions below, not ad-hoc inline drafts — keeps the SOX-style audit trail authoritative.
  @cds.redirection.target
  entity InvoiceExceptions as projection on db.InvoiceExceptions {
    *,
    // drives the LineItem Criticality annotation (1=red/negative, 2=orange/critical, 3=green/positive, 5=neutral)
    case status
      when 'ESCALATED'      then 1
      when 'ROUTED_TO_CLERK' then 2
      when 'REJECTED'        then 1
      when 'AUTO_RESOLVED'   then 3
      when 'APPROVED'        then 3
      when 'POSTED'          then 3
      else 5
    end as statusCriticality : Integer
  } actions {
    // Human-in-the-loop actions exposed on the Object Page.
    // Handlers enforce role + confidence/amount gating server-side (see invoice-service.js).
    action approve(comment : String) returns InvoiceExceptions;
    // named rejectInvoice, not reject — `reject` shadows ApplicationService's built-in method
    action rejectInvoice(comment : String) returns InvoiceExceptions;
    action edit(
      correctedNetAmount : Decimal(15,2),
      correctedTaxCode   : String(4),
      comment            : String
    ) returns InvoiceExceptions;

    // Re-runs the agent pipeline on demand (e.g. after a clerk supplies missing info).
    action retriage() returns InvoiceExceptions;
  };

  @readonly // populated at ingestion only; the header's edit action handles corrections
  entity InvoiceExceptionItems as projection on db.InvoiceExceptionItems;

  entity Vendors as projection on db.Vendors;
  entity Contracts as projection on db.Contracts;

  @readonly // append-only audit trail — no update/delete exposed at any privilege level
  entity RecommendationLogs as projection on db.RecommendationLogs;

  @readonly
  entity ExceptionTypes as projection on db.ExceptionTypes;

  // Simple KPI aggregate for a dashboard tile on the list report.
  @readonly
  entity Kpis as projection on db.InvoiceExceptions {
    key status,
    count(*) as count : Integer
  } group by status;
}

annotate InvoiceService with @(requires: 'authenticated-user');

// Read visibility is segregated by role — a supervisor sees the whole book (including
// escalations), a clerk sees only what's in their own queue: exceptions already assigned
// to them (any status — keeps their resolution history visible), or still-unclaimed rows
// sitting in ROUTED_TO_CLERK (the shared queue anyone with AP.Clerk can pick up). A clerk
// never sees NEW/INVESTIGATING (not yet triaged) or ESCALATED (supervisor-only) rows.
// Write/actions: gated per-action in the handler (clerk vs supervisor, plus amount-threshold
// checks) — see invoice-service.js.
// AP.Auditor is read-only everywhere and unrestricted (no assignedTo/ownership filter —
// internal audit/SOX-compliance review needs the whole book, same as a supervisor's view,
// but with zero grant on any of the actions below).
annotate InvoiceService.InvoiceExceptions with @(restrict: [
  { grant: 'READ', to: ['AP.Supervisor', 'AP.Auditor'] },
  { grant: 'READ', to: ['AP.Clerk'], where: 'assignedTo = $user or (assignedTo is null and status = ''ROUTED_TO_CLERK'')' },
  { grant: ['approve', 'rejectInvoice', 'edit'], to: ['AP.Clerk', 'AP.Supervisor'] },
  { grant: 'retriage',                       to: ['AP.Supervisor'] }
]);

annotate InvoiceService.RecommendationLogs with @(restrict: [
  { grant: 'READ', to: ['AP.Clerk', 'AP.Supervisor', 'AP.Auditor'] }
]);

annotate InvoiceService.InvoiceExceptionItems with @(restrict: [
  { grant: 'READ', to: ['AP.Clerk', 'AP.Supervisor', 'AP.Auditor'] }
]);
