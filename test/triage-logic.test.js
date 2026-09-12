const { recomputeProvincialTax, computeConfidence, withRetry } = require('../srv/invoice-service')

describe('recomputeProvincialTax — provincial tax matrix (AP policy sec. 3.4)', () => {
  test('SK invoice under-taxed (GST-only) is flagged out of tolerance', () => {
    const result = recomputeProvincialTax({ taxJurisdiction: 'SK', netAmount: 8500.00, taxAmount: 524.75 })
    expect(result.expectedTax).toBeCloseTo(935.00, 2) // 8500 * (0.05 + 0.06)
    expect(result.withinTolerance).toBe(false)
    expect(result.expectedTaxCode).toBe('S1')
  })

  test('AB invoice with correct GST-only tax is within tolerance', () => {
    const result = recomputeProvincialTax({ taxJurisdiction: 'AB', netAmount: 1000.00, taxAmount: 50.00 })
    expect(result.withinTolerance).toBe(true)
    expect(result.expectedTaxCode).toBe('J1')
  })

  test('unknown jurisdiction falls back to GST-only default', () => {
    const result = recomputeProvincialTax({ taxJurisdiction: 'ON', netAmount: 1000.00, taxAmount: 50.00 })
    expect(result.expectedTax).toBeCloseTo(50.00, 2)
  })
})

describe('computeConfidence — decision-gating thresholds', () => {
  test('PO_MISMATCH within 2% quantity variance scores high confidence', () => {
    const confidence = computeConfidence({
      invoice: { exceptionType_code: 'PO_MISMATCH', grossAmount: 15945.00 },
      poItem: { NetPriceAmount: 159.45, OrderQuantity: 100 },
      overrideRate: 0
    })
    expect(confidence).toBeGreaterThanOrEqual(0.85)
  })

  test('PO_MISMATCH with no PO found scores very low confidence', () => {
    const confidence = computeConfidence({
      invoice: { exceptionType_code: 'PO_MISMATCH', grossAmount: 1000 },
      poItem: null,
      overrideRate: 0
    })
    expect(confidence).toBeLessThan(0.35)
  })

  test('CONTRACT_RATE with no active contract cannot auto-resolve', () => {
    const confidence = computeConfidence({
      invoice: { exceptionType_code: 'CONTRACT_RATE' },
      contract: null,
      overrideRate: 0
    })
    expect(confidence).toBeLessThan(0.85)
  })

  test('a vendor with a high historical clerk-override rate gets a confidence haircut', () => {
    const withoutHistory = computeConfidence({ invoice: { exceptionType_code: 'TAX_VARIANCE' }, taxRecompute: { withinTolerance: true }, overrideRate: 0 })
    const withHistory = computeConfidence({ invoice: { exceptionType_code: 'TAX_VARIANCE' }, taxRecompute: { withinTolerance: true }, overrideRate: 0.5 })
    expect(withHistory).toBeLessThan(withoutHistory)
  })
})

describe('withRetry — S/4 API resilience', () => {
  test('retries on a 503 and eventually succeeds', async () => {
    let attempts = 0
    const flaky = async () => {
      attempts++
      if (attempts < 3) { const e = new Error('unavailable'); e.code = 503; throw e }
      return 'ok'
    }
    const result = await withRetry(flaky, { attempts: 3, baseDelayMs: 1 })
    expect(result).toBe('ok')
    expect(attempts).toBe(3)
  })

  test('does not retry a non-retryable (4xx) error', async () => {
    let attempts = 0
    const badRequest = async () => { attempts++; const e = new Error('bad request'); e.code = 400; throw e }
    await expect(withRetry(badRequest, { attempts: 3, baseDelayMs: 1 })).rejects.toThrow('bad request')
    expect(attempts).toBe(1)
  })

  test('gives up after exhausting attempts', async () => {
    let attempts = 0
    const alwaysFails = async () => { attempts++; const e = new Error('still down'); e.code = 503; throw e }
    await expect(withRetry(alwaysFails, { attempts: 3, baseDelayMs: 1 })).rejects.toThrow('still down')
    expect(attempts).toBe(3)
  })
})
