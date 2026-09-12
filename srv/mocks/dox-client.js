/**
 * Mocked call to SAP Document Information Extraction (DOX).
 * Real shape: POST /document-information-extraction/v1/document/jobs (multipart PDF),
 * poll GET .../jobs/{id} until status=SUCCESS, via a destination that keeps the
 * document in Canada Central per the data-residency constraint.
 * Here we return canned structured fields and inject one transient failure per
 * process lifetime so callers can exercise real retry logic against it.
 */
const CANNED_EXTRACTIONS = {
  'INV-7788-A': { poNumber: null, poItem: null, vendorNameOnDoc: 'Manitoba Industrial Coatings Co.', grossAmount: 4180.00, currency: 'CAD', confidence: 0.78 },
  'INV-5521': { poNumber: '4500001601', poItem: '20', vendorNameOnDoc: 'Manitoba Industrial Coatings Co.', grossAmount: 2210.00, currency: 'CAD', confidence: 0.94 }
}

let callCount = 0

async function extractInvoiceFields (invoiceNumber) {
  callCount++
  await new Promise(resolve => setTimeout(resolve, 150))

  if (callCount === 1 && process.env.DOX_SIMULATE_TRANSIENT_ERROR !== 'false') {
    const err = new Error('DOX service temporarily unavailable')
    err.code = 503
    throw err
  }

  return CANNED_EXTRACTIONS[invoiceNumber] || {
    poNumber: null, poItem: null, vendorNameOnDoc: null, grossAmount: null, currency: null, confidence: 0.0
  }
}

module.exports = { extractInvoiceFields }
