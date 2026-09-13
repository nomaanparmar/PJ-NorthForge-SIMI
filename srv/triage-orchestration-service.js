const cds = require('@sap/cds')
const { extractInvoiceFields } = require('./mocks/dox-client')
const { fetchPurchaseOrderItem: fetchPurchaseOrderItemLocalMock } = require('./mocks/po-mock')
const { checkGoodsReceipt } = require('./mocks/gr-mock')
const { getTriageRecommendation } = require('./genai-client')

// Decision thresholds — mirror the AP policy document (sec. 2, "Confidence Gating").
const AUTO_RESOLVE_CONFIDENCE = 0.85
const ESCALATE_CONFIDENCE_FLOOR = 0.35
const IN_SCOPE_MAX_AMOUNT = 250000

// Provincial sales-tax matrix from the 8-page AP policy doc (GST 5% federal everywhere;
// HST/PST layered per province). Hardcoded here; in a later phase this table itself
// becomes a RAG-retrieved, versioned artifact rather than code.
const PROVINCIAL_TAX = {
  AB: { gst: 0.05, pst: 0 },
  SK: { gst: 0.05, pst: 0.06 },
  MB: { gst: 0.05, pst: 0.07 }
}

module.exports = cds.service.impl(async function () {
  // Internal service — reads/writes the raw domain entities directly rather than
  // through InvoiceService's UI-facing projection, since this has no UI concerns
  // of its own (no computed columns, no draft handling).
  const { InvoiceExceptions, RecommendationLogs, Contracts } = cds.entities('com.northforge.invoice')

  // ---------------------------------------------------------------------
  // Action: retriage — runs the bounded agent investigation over one exception.
  // ---------------------------------------------------------------------
  this.on('retriage', async (req) => {
    const { invoiceID } = req.data
    const invoice = await SELECT.one.from(InvoiceExceptions, invoiceID).columns(
      '*', 'vendor.ID as vendor_ID', 'vendor.name as vendor_name', 'exceptionType_code'
    )
    if (!invoice) return req.error(404, `Invoice exception ${invoiceID} not found`)

    await UPDATE(InvoiceExceptions, invoice.ID).with({ status: 'INVESTIGATING' })
    let step = 0
    const log = (fields) => INSERT.into(RecommendationLogs).entries({
      invoice_ID: invoice.ID, step: ++step, timestamp: new Date().toISOString(), ...fields
    })

    // --- Step: EXTRACT_DOX_FIELDS — mocked SAP Document Information Extraction (DOX)
    // call for unstructured (EMAIL_PDF) tail-spend invoices that arrived without
    // parsed fields, e.g. a PO number scanned off a PDF rather than sent structured. ---
    if (invoice.sourceChannel === 'EMAIL_PDF' && !invoice.extractedPayload) {
      try {
        const fields = await withRetry(() => extractInvoiceFields(invoice.invoiceNumber), { attempts: 3, baseDelayMs: 200 })
        invoice.extractedPayload = JSON.stringify(fields)
        invoice.extractionConfidence = fields.confidence
        await UPDATE(InvoiceExceptions, invoice.ID).with({
          extractedPayload: invoice.extractedPayload,
          extractionConfidence: invoice.extractionConfidence
        })
        await log({
          agentAction: 'EXTRACT_DOX_FIELDS',
          groundingSources: JSON.stringify([{ type: 'DOXExtraction', id: invoice.invoiceNumber, source: 'document-information-extraction' }]),
          reasoningTrace: `DOX extracted PO ${fields.poNumber || 'n/a'}/${fields.poItem || 'n/a'}, vendor "${fields.vendorNameOnDoc}", amount ${fields.grossAmount} ${fields.currency} at confidence ${fields.confidence}.`,
          outcome: 'FETCHED'
        })
      } catch (err) {
        await log({ agentAction: 'EXTRACT_DOX_FIELDS', reasoningTrace: `DOX extraction failed after retries: ${err.message}`, outcome: 'ERROR' })
      }
    }

    // --- Step: FETCH_PO — call the S/4 sandbox via destination; retry + mock
    // fallback both happen inside fetchPurchaseOrderItem itself now, so this
    // only needs to log what happened, not handle failure itself. ---
    let poItem = null
    if (invoice.purchaseOrder) {
      poItem = await fetchPurchaseOrderItem(invoice.purchaseOrder, invoice.purchaseOrderItem)
      const fallbackNote = poItem?._s4Error
        ? ` [Real S/4 destination unreachable (${poItem._s4Error}) — used local mock data instead.]`
        : ''
      await log({
        agentAction: 'FETCH_PO',
        groundingSources: JSON.stringify([{
          type: 'PurchaseOrder',
          id: `${invoice.purchaseOrder}/${invoice.purchaseOrderItem}`,
          source: poItem?._s4Error ? 'local-mock-fallback' : 'API_PURCHASEORDER_PROCESS_SRV'
        }]),
        reasoningTrace: (poItem
          ? `Fetched PO ${invoice.purchaseOrder} item ${invoice.purchaseOrderItem}: qty ${poItem.OrderQuantity} ${poItem.OrderPriceUnit} at ${poItem.NetPriceAmount} ${invoice.currency}.`
          : `PO ${invoice.purchaseOrder} item ${invoice.purchaseOrderItem} not found.`) + fallbackNote,
        outcome: poItem?._s4Error ? 'FETCHED_MOCK_FALLBACK' : 'FETCHED'
      })
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

    // --- Step: FETCH_GR — only relevant for missing-goods-receipt exceptions ---
    let gr = null
    if (invoice.exceptionType_code === 'MISSING_GR') {
      gr = await withRetry(() => checkGoodsReceipt(invoice.purchaseOrder, invoice.purchaseOrderItem), { attempts: 3, baseDelayMs: 200 })
      await log({
        agentAction: 'FETCH_GR',
        groundingSources: JSON.stringify(gr ? [{ type: 'MaterialDocument', id: gr.grDocument, source: 'A_MaterialDocument' }] : []),
        reasoningTrace: gr
          ? `GR ${gr.grDocument} posted ${gr.postingDate} for qty ${gr.quantityReceived}.`
          : `No goods receipt found for PO ${invoice.purchaseOrder} item ${invoice.purchaseOrderItem}.`,
        outcome: gr ? 'FETCHED' : 'NOT_FOUND'
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
    const decision = await decideDisposition({ invoice, poItem, contract, taxRecompute, overrideRate, gr })
    return decideAndClose(invoice, decision, log)
  })
})

// --- helpers -------------------------------------------------------------

async function fetchPurchaseOrderItem (poNumber, itemNumber) {
  // Only take the real remote path when a genuine BTP Destination is configured
  // ([hybrid]/[production] profile, see package.json). Checking for `credentials.destination`
  // specifically (not just truthy `credentials`) matters because `cds serve --with-mocks`
  // auto-injects its own `credentials.url` pointing at a self-hosted auto-mock service —
  // whose backing table is never seeded, so treating that as "a destination is configured"
  // would wrongly skip our own po-mock.js and hit an empty auto-mocked table instead.
  if (!cds.requires.API_PURCHASEORDER_PROCESS_SRV.credentials?.destination) {
    return fetchPurchaseOrderItemLocalMock(poNumber, itemNumber)
  }
  try {
    return await withRetry(async () => {
      const po = await cds.connect.to('API_PURCHASEORDER_PROCESS_SRV')
      const items = await po.read('A_PurchaseOrderItem').where({ PurchaseOrder: poNumber, PurchaseOrderItem: itemNumber })
      return items[0] || null
    }, { attempts: 3, baseDelayMs: 200 })
  } catch (err) {
    // Real S/4 destination unreachable after retries (e.g. the confirmed SAP-side sandbox
    // outage) — fall back to local mock data so the pipeline still functions, but tag the
    // result so the caller can keep this visible in the audit trail rather than silently
    // presenting mock data as if it were a genuine S/4 response.
    const mockItem = await fetchPurchaseOrderItemLocalMock(poNumber, itemNumber)
    return mockItem ? { ...mockItem, _s4Error: err.message } : null
  }
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

function computeConfidence ({ invoice, poItem, contract, taxRecompute, overrideRate, gr }) {
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
    // Both branches stay below AUTO_RESOLVE_CONFIDENCE — a GR check on its own is never
    // sufficient grounds to auto-post an invoice, only to inform how urgently a human should look.
    confidence = gr ? 0.8 : 0.3 // GR now on file -> route to clerk; still missing -> escalate
  }

  confidence -= overrideRate * 0.2 // vendors this clerk community frequently overrides get a haircut
  return Math.max(0, Math.min(1, confidence))
}

// Tries the real LLM call (Anthropic today; SAP Generative AI Hub in production —
// see genai-client.js) first; falls back to the deterministic rule-based scoring
// if no API key is configured or the call fails after retries. An LLM outage must
// never block triage — it only makes that one invoice's disposition less precise.
async function decideDisposition ({ invoice, poItem, contract, taxRecompute, overrideRate, gr }) {
  let llmError = null
  try {
    const llm = await withRetry(
      () => getTriageRecommendation({ invoice, poItem, contract, taxRecompute, overrideRate, gr }),
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
    // Falling back is the right call (an LLM outage must never block triage), but the
    // fallback itself is a decision-relevant event and must not be audit-invisible —
    // console.error alone doesn't satisfy "every AI action produces an immutable log
    // entry", so the caller folds llmError into the persisted reasoningTrace below.
    console.error(`GenAI call failed, falling back to rule-based scoring: ${err.message}`)
    llmError = err.message
  }
  const confidence = computeConfidence({ invoice, poItem, contract, taxRecompute, overrideRate, gr })
  return { confidence, disposition: null, reasoningTrace: null, model: null, promptText: null, responseText: null, source: 'rules', llmError }
}

async function decideAndClose (invoice, decision, log) {
  const { InvoiceExceptions } = cds.entities('com.northforge.invoice')
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

  const baseReasoningTrace = outOfScope
    ? `Amount ${invoice.grossAmount} exceeds in-scope ceiling of ${IN_SCOPE_MAX_AMOUNT} -> escalate regardless of confidence.`
    : decision.reasoningTrace ||
      `Confidence ${confidence.toFixed(2)} vs thresholds [auto>=${AUTO_RESOLVE_CONFIDENCE}, escalate<${ESCALATE_CONFIDENCE_FLOOR}] -> ${status}.`
  // Fold a real LLM failure into the persisted trace — falling back to rules is correct
  // behavior, but it must be visible in the audit trail, not just a server console line.
  const reasoningTrace = decision.llmError
    ? `GenAI call failed (${decision.llmError}); fell back to rule-based scoring. ${baseReasoningTrace}`
    : baseReasoningTrace

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

// Exposed for unit testing (test/triage-logic.test.js) — pure functions, no DB/network access.
module.exports.recomputeProvincialTax = recomputeProvincialTax
module.exports.computeConfidence = computeConfidence
module.exports.withRetry = withRetry
