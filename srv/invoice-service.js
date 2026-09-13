const cds = require('@sap/cds')

const AUTO_RESOLVE_CONFIDENCE = 0.85
const SUPERVISOR_REQUIRED_ABOVE = 50000

module.exports = cds.service.impl(async function () {
  const { InvoiceExceptions, RecommendationLogs } = this.entities

  // ---------------------------------------------------------------------
  // Action: retriage — delegates to TriageOrchestrationService, which holds
  // the actual agent pipeline (see triage-orchestration-service.js). Kept as
  // a thin call here so the action stays bound to InvoiceExceptions for
  // Fiori Elements' UI.DataFieldForAction button binding, while the
  // orchestration logic itself has no dependency on this UI-facing service.
  // ---------------------------------------------------------------------
  this.on('retriage', InvoiceExceptions, async (req) => {
    const key = req.params[req.params.length - 1]
    const invoiceID = key.ID || key
    const orchestrator = await cds.connect.to('TriageOrchestrationService')
    await orchestrator.send('retriage', { invoiceID })
    return SELECT.one.from(InvoiceExceptions, key)
  })

  // ---------------------------------------------------------------------
  // Human-in-the-loop actions
  // ---------------------------------------------------------------------
  this.on('approve', InvoiceExceptions, (req) => handleClerkDecision(req, 'APPROVE'))
  this.on('rejectInvoice', InvoiceExceptions, (req) => handleClerkDecision(req, 'REJECT'))
  this.on('edit', InvoiceExceptions, (req) => handleClerkDecision(req, 'EDIT'))

  async function handleClerkDecision (req, decision) {
    const key = req.params[req.params.length - 1]
    const invoice = await SELECT.one.from(InvoiceExceptions, key)
    if (!invoice) return req.error(404, 'Invoice exception not found')

    // Segregation-of-duties control: invoices above the threshold require AP.Supervisor,
    // not just AP.Clerk, regardless of what the UI sent.
    if (invoice.grossAmount > SUPERVISOR_REQUIRED_ABOVE && !req.user.is('AP.Supervisor')) {
      return req.error(403, `Invoices over $${SUPERVISOR_REQUIRED_ABOVE.toLocaleString()} require AP.Supervisor approval`)
    }

    const newStatus = decision === 'APPROVE' ? 'APPROVED' : decision === 'REJECT' ? 'REJECTED' : 'INVESTIGATING'
    await UPDATE(InvoiceExceptions, invoice.ID).with({
      status: newStatus,
      clerkDecision: decision,
      clerkComment: req.data.comment,
      assignedTo: req.user.id,
      ...(decision === 'EDIT' && {
        netAmount: req.data.correctedNetAmount ?? invoice.netAmount,
        taxCodeOnInvoice: req.data.correctedTaxCode ?? invoice.taxCodeOnInvoice
      })
    })

    const priorAiOutcome = invoice.confidenceScore >= AUTO_RESOLVE_CONFIDENCE ? 'AUTO_RESOLVED' : 'ROUTED'
    await INSERT.into(RecommendationLogs).entries({
      invoice_ID: invoice.ID,
      step: 99,
      timestamp: new Date().toISOString(),
      agentAction: 'HUMAN_DECISION',
      outcome: decision === 'REJECT' && priorAiOutcome === 'AUTO_RESOLVED' ? 'OVERRIDDEN' : decision,
      humanUser: req.user.id,
      reasoningTrace: req.data.comment || `Clerk ${decision.toLowerCase()}d without comment.`
    })

    return SELECT.one.from(InvoiceExceptions, invoice.ID)
  }
})
