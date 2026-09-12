const cds = require('@sap/cds')
const { extractInvoiceFields } = require('./mocks/dox-client')
const { fetchPurchaseOrderItem: fetchPurchaseOrderItemLocalMock } = require('./mocks/po-mock')
const { getTriageRecommendation } = require('./genai-client')

// Decision thresholds — mirror the AP policy document (sec. 2, "Confidence Gating").
const AUTO_RESOLVE_CONFIDENCE = 0.85
const ESCALATE_CONFIDENCE_FLOOR = 0.35
const IN_SCOPE_MAX_AMOUNT = 250000
const SUPERVISOR_REQUIRED_ABOVE = 50000

// Provincial sales-tax matrix from the 8-page AP policy doc (GST 5% federal everywhere;
// HST/PST layered per province). Hardcoded here; in a later phase this table itself
// becomes a RAG-retrieved, versioned artifact rather than code.
const PROVINCIAL_TAX = {
  AB: { gst: 0.05, pst: 0 },
  SK: { gst: 0.05, pst: 0.06 },
  MB: { gst: 0.05, pst: 0.07 }
}

module.exports = cds.service.impl(async function () {
  const { InvoiceExceptions, RecommendationLogs, Contracts } = this.entities

  // ---------------------------------------------------------------------
  // Action: retriage — runs the bounded agent investigation over one exception.
  // ---------------------------------------------------------------------
  this.on('retriage', InvoiceExceptions, async (req) => {
    const key = req.params[req.params.length - 1]
    const invoice = await SELECT.one.from(InvoiceExceptions, key).columns(
      '*', 'vendor.ID as vendor_ID', 'vendor.name as vendor_name', 'exceptionType_code'
    )
    if (!invoice) return req.error(404, `Invoice exception ${key.ID || key} not found`)

    await UPDATE(InvoiceExceptions, invoice.ID).with({ status: 'INVESTIGATING' })
    let step = 0
    const log = (fields) => INSERT.into(RecommendationLogs).entries({
      invoice_ID: invoice.ID, step: ++step, timestamp: new Date().toISOString(), ...fields
    })

    // --- Step: FETCH_PO — call the S/4 sandbox via destination, with retry ---
    let poItem = null
    if (invoice.purchaseOrder) {
      try {
        poItem = await withRetry(
          () => fetchPurchaseOrderItem(invoice.purchaseOrder, invoice.purchaseOrderItem),
          { attempts: 3, baseDelayMs: 200 }
        )
        await log({
          agentAction: 'FETCH_PO',
          groundingSources: JSON.stringify([{ type: 'PurchaseOrder', id: `${invoice.purchaseOrder}/${invoice.purchaseOrderItem}`, source: 'API_PURCHASEORDER_PROCESS_SRV' }]),
          reasoningTrace: poItem
            ? `Fetched PO ${invoice.purchaseOrder} item ${invoice.purchaseOrderItem}: qty ${poItem.OrderQuantity} ${poItem.OrderPriceUnit} at ${poItem.NetPriceAmount} ${invoice.currency}.`
            : `PO ${invoice.purchaseOrder} item ${invoice.purchaseOrderItem} not found in S/4.`,
          outcome: 'FETCHED'
        })
      } catch (err) {
        // S/4 unreachable after retries — cannot safely auto-resolve; route to a human rather than fail silently.
        await log({ agentAction: 'FETCH_PO', reasoningTrace: `S/4 API call failed after retries: ${err.message}`, outcome: 'ERROR' })
        return escalateOrRoute(invoice)
      }
    }

    // --- Step: FETCH_CONTRACT — only relevant for contract-rate variances ---
    let contract = null
    if (invoice.exceptionType_code === 'CONTRACT_RATE') {
      contract = await SELECT.one.from(Contracts).where({ vendor_ID: invoice.vendor_ID })
      await log({
        agentAction: 'FETCH_CONTRACT',
        groundingSources: JSON.stringify(contract ? [{ type: 'Contract', id: contract.contractNumber, source: contract.documentRef }] : []),
        reasoningTrace: contract
          ? `Active MSA ${contract.contractNumber} rate ${contract.ratePerUnit}/${contract.unit}; invoice implies ${(invoice.netAmount / 1).toFixed(2)}.`
          : 'No active contract found for vendor.'
      })
    }

    // --- Step: RECOMPUTE_TAX — only relevant for tax-jurisdiction variances ---
    let taxRecompute = null
    if (invoice.exceptionType_code === 'TAX_VARIANCE') {
      taxRecompute = recomputeProvincialTax(invoice)
      await log({
        agentAction: 'RECOMPUTE_TAX',
        promptText: `jurisdiction=${invoice.taxJurisdiction}, net=${invoice.netAmount}, invoiced tax=${invoice.taxAmount}`,
        responseText: `Expected tax ${taxRecompute.expectedTax.toFixed(2)} vs invoiced ${invoice.taxAmount}. Variance ${taxRecompute.variance.toFixed(2)}.`,
        groundingSources: JSON.stringify([{ type: 'PolicyDoc', id: 'AP-Policy-2026 sec.3.4' }]),
        reasoningTrace: taxRecompute.withinTolerance
          ? 'Recomputed tax matches invoice within tolerance.'
          : `Tax code mismatch — recommend reposting with tax code ${taxRecompute.expectedTaxCode}.`
      })
    }

    // --- Step: CHECK_VENDOR_HISTORY — clerk-override rate for this vendor, informs confidence ---
    const history = await SELECT.from(InvoiceExceptions)
      .where({ vendor_ID: invoice.vendor_ID, status: { in: ['APPROVED', 'REJECTED', 'POSTED'] } })
    const overrideRate = history.length ? history.filter(h => h.clerkDecision === 'REJECT').length / history.length : 0
    await log({
      agentAction: 'CHECK_VENDOR_HISTORY',
      reasoningTrace: `${history.length} prior resolved exceptions for this vendor; historical override rate ${(overrideRate * 100).toFixed(0)}%.`
    })

    // --- Decide: auto-resolve / route to clerk / escalate to supervisor ---
    const decision = await decideDisposition({ invoice, poItem, contract, taxRecompute, overrideRate })
    return decideAndClose(invoice, decision, log)
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

  // ---------------------------------------------------------------------
  // Event Mesh consumption — new/blocked invoices arrive as CloudEvents,
  // not via polling. Wired through CAP's messaging plugin (see package.json
  // cds.requires.messaging); local dev uses the file-based transport automatically.
  // ---------------------------------------------------------------------
  this.on('SupplierInvoice.Blocked', async (msg) => {
    const { invoiceNumber, companyCode, sourceChannel, vendorId, rawPayload } = msg.data
    let extractedPayload, extractionConfidence
    if (sourceChannel === 'EMAIL_PDF') {
      try {
        const fields = await withRetry(() => extractInvoiceFields(invoiceNumber), { attempts: 3, baseDelayMs: 200 })
        extractedPayload = JSON.stringify(fields)
        extractionConfidence = fields.confidence
      } catch (err) {
        console.error(`DOX extraction failed for ${invoiceNumber} after retries: ${err.message}`)
        return
      }
    }
    const created = await INSERT.into(InvoiceExceptions).entries({
      invoiceNumber, companyCode, sourceChannel, vendor_ID: vendorId,
      extractedPayload, extractionConfidence, status: 'NEW', ...rawPayload
    })
    return created
  })
})

// --- helpers -------------------------------------------------------------

async function fetchPurchaseOrderItem (poNumber, itemNumber) {
  // No destination bound locally (dev/test) -> use the local mock directly rather than
  // relying on cds's external-service auto-mocking, which needs a real BTP Destination
  // service to behave consistently. Production (a real S4HANA_SANDBOX destination
  // configured, see package.json cds.requires.[production]) takes the real path below.
  if (!cds.requires.API_PURCHASEORDER_PROCESS_SRV.credentials) {
    return fetchPurchaseOrderItemLocalMock(poNumber, itemNumber)
  }
  const po = await cds.connect.to('API_PURCHASEORDER_PROCESS_SRV')
  const items = await po.read('A_PurchaseOrderItem').where({ PurchaseOrder: poNumber, PurchaseOrderItem: itemNumber })
  return items[0] || null
}

async function withRetry (fn, { attempts, baseDelayMs }) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const retryable = !err.code || err.code >= 500 || err.code === 429
      if (!retryable || i === attempts - 1) throw err
      await new Promise(r => setTimeout(r, baseDelayMs * 2 ** i)) // exponential backoff
    }
  }
  throw lastErr
}

function recomputeProvincialTax (invoice) {
  const rates = PROVINCIAL_TAX[invoice.taxJurisdiction] || { gst: 0.05, pst: 0 }
  const expectedTax = invoice.netAmount * (rates.gst + rates.pst)
  const variance = Math.abs(expectedTax - invoice.taxAmount)
  return {
    expectedTax,
    variance,
    withinTolerance: variance < 1.0,
    expectedTaxCode: rates.pst > 0 ? 'S1' : 'J1'
  }
}

function computeConfidence ({ invoice, poItem, contract, taxRecompute, overrideRate }) {
  let confidence = 0.7 // baseline for a clean single-cause exception

  if (invoice.exceptionType_code === 'PO_MISMATCH') {
    if (!poItem) confidence = 0.2
    else {
      const qtyVariancePct = Math.abs(1 - (invoice.grossAmount / (poItem.NetPriceAmount * poItem.OrderQuantity)))
      confidence = qtyVariancePct <= 0.02 ? 0.9 : qtyVariancePct <= 0.05 ? 0.7 : 0.6
    }
  }
  if (invoice.exceptionType_code === 'TAX_VARIANCE' && taxRecompute) {
    confidence = taxRecompute.withinTolerance ? 0.95 : 0.91 // clear policy citation -> high confidence either way
  }
  if (invoice.exceptionType_code === 'CONTRACT_RATE') {
    confidence = contract ? 0.88 : 0.3
  }
  if (invoice.exceptionType_code === 'MISSING_METADATA') {
    confidence = invoice.extractionConfidence ?? 0.4
  }
  if (invoice.exceptionType_code === 'MISSING_GR') {
    confidence = 0.45 // needs a human to confirm receipt status; never auto-resolved
  }

  confidence -= overrideRate * 0.2 // vendors this clerk community frequently overrides get a haircut
  return Math.max(0, Math.min(1, confidence))
}

// Tries the real LLM call (Anthropic today; SAP Generative AI Hub in production —
// see genai-client.js) first; falls back to the deterministic rule-based scoring
// if no API key is configured or the call fails after retries. An LLM outage must
// never block triage — it only makes that one invoice's disposition less precise.
async function decideDisposition ({ invoice, poItem, contract, taxRecompute, overrideRate }) {
  try {
    const llm = await withRetry(
      () => getTriageRecommendation({ invoice, poItem, contract, taxRecompute, overrideRate }),
      { attempts: 2, baseDelayMs: 300 }
    )
    if (llm) {
      return {
        confidence: Math.max(0, Math.min(1, llm.confidence)),
        disposition: llm.disposition,
        reasoningTrace: llm.reasoning,
        model: llm.model,
        promptText: llm.promptText,
        responseText: llm.responseText,
        source: 'llm'
      }
    }
  } catch (err) {
    console.error(`GenAI call failed, falling back to rule-based scoring: ${err.message}`)
  }
  const confidence = computeConfidence({ invoice, poItem, contract, taxRecompute, overrideRate })
  return { confidence, disposition: null, reasoningTrace: null, model: null, promptText: null, responseText: null, source: 'rules' }
}

async function decideAndClose (invoice, decision, log) {
  const { InvoiceExceptions } = cds.entities('InvoiceService')
  const { confidence } = decision
  // Amount ceiling is a hard policy invariant, enforced in code regardless of what
  // an LLM recommends — never trust a model's own read of the in-scope boundary.
  const outOfScope = invoice.grossAmount > IN_SCOPE_MAX_AMOUNT

  let status, outcome
  if (!outOfScope && confidence >= AUTO_RESOLVE_CONFIDENCE) {
    status = 'AUTO_RESOLVED'; outcome = 'AUTO_RESOLVED'
  } else if (outOfScope || confidence < ESCALATE_CONFIDENCE_FLOOR) {
    status = 'ESCALATED'; outcome = 'ESCALATED'
  } else {
    status = 'ROUTED_TO_CLERK'; outcome = 'ROUTED'
  }

  const reasoningTrace = outOfScope
    ? `Amount ${invoice.grossAmount} exceeds in-scope ceiling of ${IN_SCOPE_MAX_AMOUNT} -> escalate regardless of confidence.`
    : decision.reasoningTrace ||
      `Confidence ${confidence.toFixed(2)} vs thresholds [auto>=${AUTO_RESOLVE_CONFIDENCE}, escalate<${ESCALATE_CONFIDENCE_FLOOR}] -> ${status}.`

  await log({
    agentAction: status === 'AUTO_RESOLVED' ? 'PROPOSE_RESOLUTION' : status === 'ESCALATED' ? 'ESCALATE' : 'ROUTE_TO_HUMAN',
    confidence,
    outcome,
    reasoningTrace,
    model: decision.model,
    promptText: decision.promptText,
    responseText: decision.responseText
  })

  await UPDATE(InvoiceExceptions, invoice.ID).with({
    status, confidenceScore: confidence,
    slaDueAt: status === 'ROUTED_TO_CLERK' || status === 'ESCALATED'
      ? new Date(Date.now() + 24 * 3600 * 1000).toISOString()
      : null
  })
  return SELECT.one.from(InvoiceExceptions, invoice.ID)
}

async function escalateOrRoute (invoice) {
  const { InvoiceExceptions } = cds.entities('InvoiceService')
  await UPDATE(InvoiceExceptions, invoice.ID).with({
    status: 'ESCALATED', confidenceScore: 0,
    slaDueAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString()
  })
  return SELECT.one.from(InvoiceExceptions, invoice.ID)
}

// Exposed for unit testing (test/triage-logic.test.js) — pure functions, no DB/network access.
module.exports.recomputeProvincialTax = recomputeProvincialTax
module.exports.computeConfidence = computeConfidence
module.exports.withRetry = withRetry
