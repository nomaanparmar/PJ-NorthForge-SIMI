// Internal orchestration service — deliberately not exposed via any protocol
// (OData/REST). Holds the actual agentic triage pipeline so it can be invoked
// by more than one caller in the future (today: InvoiceService's retriage
// action, on behalf of a human clicking a button; later: an Event Mesh handler
// reacting to SupplierInvoice.Blocked, or a scheduled job) without coupling
// that logic to InvoiceService's UI-facing auth model and annotations.
//
// No `returns` clause: the caller (InvoiceService) re-selects its own copy of
// the invoice from its own projection afterward, so this internal action's
// return value is never itself serialized over any protocol.
@protocol: 'none'
service TriageOrchestrationService {
  action retriage(invoiceID: UUID);
}
