/**
 * Real LLM call for the triage decision step.
 *
 * Production path: routed through SAP Generative AI Hub via a bound BTP
 * Destination (see package.json cds.requires.genAIHub, [production] profile —
 * destination "GENAI_HUB"). This satisfies the data-residency constraint in the
 * brief: no direct cross-border call to a public LLM endpoint from app code —
 * the Destination service holds the endpoint + credentials (an OAuth2 technical
 * user, typically), centrally managed and rotatable without redeploying this
 * service. cds.connect.to() resolves and authenticates that destination for us.
 *
 * Local dev fallback: when no genAIHub destination is bound (i.e. running
 * locally without a BTP Destination service), calls the Anthropic API directly
 * using a key from ANTHROPIC_API_KEY, purely for convenience while developing.
 * Neither present -> returns null, and the caller falls back to deterministic
 * rule-based scoring. An LLM outage (either path) must never block triage.
 */
const cds = require('@sap/cds')

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5'
// Real SAP AI Core / Generative AI Hub deployments are addressed by a deployment
// id under this path shape; set once the destination's target deployment exists.
const GENAI_HUB_PATH = process.env.GENAI_HUB_DEPLOYMENT_PATH || '/v2/inference/deployments/anthropic-claude/invoke'

const SYSTEM_PROMPT = `You are an AP invoice-exception triage assistant for NorthForge Manufacturing, a Canadian industrial manufacturer. \
You are given the facts an upstream system has already gathered for one flagged supplier invoice (PO data, contract terms, recomputed tax, vendor history) — you do not fetch anything yourself. \
Decide whether this exception can be safely auto-resolved, should be routed to an AP clerk with your findings attached, or must be escalated to a supervisor. \
Ground every claim in the facts provided; do not invent PO numbers, amounts, or policy clauses that were not given to you. \
Be conservative: prefer ROUTE_TO_CLERK over AUTO_RESOLVE whenever the facts are incomplete or the variance has more than one plausible explanation.`

async function getTriageRecommendation ({ invoice, poItem, contract, taxRecompute, overrideRate }) {
  const userPrompt = buildPrompt({ invoice, poItem, contract, taxRecompute, overrideRate })
  const requestBody = buildRequestBody(userPrompt)

  if (cds.requires.genAIHub?.credentials) {
    const data = await callViaDestination(requestBody)
    return parseResponse(data, userPrompt)
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  const data = await callAnthropicDirect(requestBody, apiKey)
  return parseResponse(data, userPrompt)
}

async function callViaDestination (requestBody) {
  const hub = await cds.connect.to('genAIHub')
  return hub.send({ method: 'POST', path: GENAI_HUB_PATH, data: requestBody })
}

async function callAnthropicDirect (requestBody, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const err = new Error(`Anthropic API call failed: ${res.status} ${body}`.slice(0, 500))
    err.code = res.status
    throw err
  }
  return res.json()
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

function buildPrompt ({ invoice, poItem, contract, taxRecompute, overrideRate }) {
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
  lines.push(`Historical clerk-override rate for this vendor: ${(overrideRate * 100).toFixed(0)}%.`)
  lines.push(`In-scope ceiling for auto-resolution is $250,000 CAD; this invoice is ${invoice.grossAmount <= 250000 ? 'within' : 'over'} that ceiling.`)
  return lines.join('\n')
}

module.exports = { getTriageRecommendation }
