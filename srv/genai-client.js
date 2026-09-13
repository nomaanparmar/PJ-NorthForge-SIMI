/**
 * Real LLM call for the triage decision step.
 *
 * Routed exclusively through a BTP Destination (see package.json
 * cds.requires.genAIHub, [production]/[hybrid] profile — destination
 * "GENAI_HUB") pointed directly at https://api.anthropic.com, same technique
 * as the S4HANA_SANDBOX destination — Authentication: NoAuthentication, with
 * the API key injected via an "URL.headers.x-api-key" additional property.
 * The Destination service holds the endpoint + key, centrally managed and
 * rotatable without redeploying this service; cds.connect.to() resolves it.
 *
 * No direct-call fallback: if no genAIHub destination is bound (e.g. running
 * locally on the default/[test] profile without `cds bind`), this returns
 * null and the caller falls back to deterministic rule-based scoring. An LLM
 * outage must never block triage — it only makes that invoice's disposition
 * less precise.
 */
const cds = require('@sap/cds')

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5'
const ANTHROPIC_API_VERSION = '2023-06-01'
// Real path on Anthropic's own API — same endpoint/shape whether called
// directly or through the destination, since the destination just points at
// api.anthropic.com rather than at some other proxy/orchestration layer.
const GENAI_HUB_PATH = process.env.GENAI_HUB_DEPLOYMENT_PATH || '/v1/messages'

const SYSTEM_PROMPT = `You are an AP invoice-exception triage assistant for NorthForge Manufacturing, a Canadian industrial manufacturer. \
You are given the facts an upstream system has already gathered for one flagged supplier invoice (PO data, contract terms, recomputed tax, vendor history) — you do not fetch anything yourself. \
Decide whether this exception can be safely auto-resolved, should be routed to an AP clerk with your findings attached, or must be escalated to a supervisor. \
Ground every claim in the facts provided; do not invent PO numbers, amounts, or policy clauses that were not given to you. \
Be conservative: prefer ROUTE_TO_CLERK over AUTO_RESOLVE whenever the facts are incomplete or the variance has more than one plausible explanation.`

async function getTriageRecommendation ({ invoice, poItem, contract, taxRecompute, overrideRate, gr }) {
  if (!cds.requires.genAIHub?.credentials) return null

  const userPrompt = buildPrompt({ invoice, poItem, contract, taxRecompute, overrideRate, gr })
  const requestBody = buildRequestBody(userPrompt)
  const data = await callViaDestination(requestBody)
  return parseResponse(data, userPrompt)
}

async function callViaDestination (requestBody) {
  const hub = await cds.connect.to('genAIHub')
  // x-api-key comes from the destination's own "URL.headers.x-api-key" property —
  // never set here. anthropic-version isn't secret, so it's fine as a per-request header.
  return hub.send({
    method: 'POST',
    path: GENAI_HUB_PATH,
    data: requestBody,
    headers: { 'anthropic-version': ANTHROPIC_API_VERSION }
  })
}

function buildRequestBody (userPrompt) {
  return {
    model: MODEL,
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    tools: [{
      name: 'submit_triage_recommendation',
      description: 'Submit the triage disposition for this invoice exception.',
      input_schema: {
        type: 'object',
        properties: {
          disposition: { type: 'string', enum: ['AUTO_RESOLVE', 'ROUTE_TO_CLERK', 'ESCALATE'] },
          confidence: { type: 'number', description: 'Confidence in this disposition, 0.0 to 1.0' },
          reasoning: { type: 'string', description: 'One to three sentences grounded in the facts given, explaining the disposition.' }
        },
        required: ['disposition', 'confidence', 'reasoning']
      }
    }],
    tool_choice: { type: 'tool', name: 'submit_triage_recommendation' }
  }
}

function parseResponse (data, userPrompt) {
  const toolUse = data.content?.find(c => c.type === 'tool_use')
  if (!toolUse) throw new Error('Model did not return a structured recommendation')
  return {
    disposition: toolUse.input.disposition,
    confidence: toolUse.input.confidence,
    reasoning: toolUse.input.reasoning,
    model: data.model,
    promptText: userPrompt,
    responseText: JSON.stringify(toolUse.input)
  }
}

function buildPrompt ({ invoice, poItem, contract, taxRecompute, overrideRate, gr }) {
  const lines = [
    `Invoice ${invoice.invoiceNumber}, exception type: ${invoice.exceptionType_code}.`,
    `Reason flagged: ${invoice.exceptionReasonText}`,
    `Gross amount: ${invoice.grossAmount} ${invoice.currency}; net: ${invoice.netAmount}; tax: ${invoice.taxAmount}.`
  ]
  if (poItem) {
    lines.push(`Matching PO item from S/4: qty ${poItem.OrderQuantity} ${poItem.OrderPriceUnit} at ${poItem.NetPriceAmount} ${invoice.currency} each.`)
  } else if (invoice.purchaseOrder) {
    lines.push(`No matching PO item was found in S/4 for PO ${invoice.purchaseOrder} item ${invoice.purchaseOrderItem}.`)
  }
  if (contract) {
    lines.push(`Active vendor contract ${contract.contractNumber}: rate ${contract.ratePerUnit}/${contract.unit}. Tax clause: ${contract.taxClauseSummary}`)
  }
  if (taxRecompute) {
    lines.push(`Recomputed expected tax: ${taxRecompute.expectedTax.toFixed(2)} vs invoiced ${invoice.taxAmount} (variance ${taxRecompute.variance.toFixed(2)}).`)
  }
  if (invoice.exceptionType_code === 'MISSING_GR') {
    lines.push(gr
      ? `Goods receipt ${gr.grDocument} has since been posted (qty ${gr.quantityReceived}, ${gr.postingDate}).`
      : `No goods receipt has been posted yet against this PO item.`)
  }
  lines.push(`Historical clerk-override rate for this vendor: ${(overrideRate * 100).toFixed(0)}%.`)
  lines.push(`In-scope ceiling for auto-resolution is $250,000 CAD; this invoice is ${invoice.grossAmount <= 250000 ? 'within' : 'over'} that ceiling.`)
  return lines.join('\n')
}

module.exports = { getTriageRecommendation }
