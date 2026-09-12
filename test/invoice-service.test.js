const cds = require('@sap/cds')
// 'serve --with-mocks' is required (not just pointing cds.test at the project folder) so that
// API_PURCHASEORDER_PROCESS_SRV — an external service with no real destination in this profile —
// gets auto-mocked via srv/mocks/po-mock.js, exactly as it is under `cds watch` / `cds serve`.
const { GET, POST, expect, axios } = cds.test('serve', '--with-mocks', '--in-memory')


axios.defaults.auth = { username: 'supervisor1', password: 'supervisor1' }

describe('InvoiceService — contract tests against the live OData V4 service', () => {
  test('list returns seeded invoice exceptions', async () => {
    const { data } = await GET('/odata/v4/invoice/InvoiceExceptions')
    expect(data.value.length).to.be.greaterThan(0)
  })

  test('retriage on a CONTRACT_RATE exception fetches the contract and auto-resolves', async () => {
    const key = "(ID=c0ffee00-0000-0000-0000-000000000004)"
    const { data } = await POST(`/odata/v4/invoice/InvoiceExceptions${key}/InvoiceService.retriage`, {})
    expect(data.status).to.equal('AUTO_RESOLVED')
    expect(data.confidenceScore).to.be.greaterThan(0.85)

    const { data: logs } = await GET(
      `/odata/v4/invoice/RecommendationLogs?$filter=invoice_ID eq c0ffee00-0000-0000-0000-000000000004`
    )
    expect(logs.value.some(l => l.agentAction === 'FETCH_CONTRACT')).to.equal(true)
    expect(logs.value.some(l => l.agentAction === 'PROPOSE_RESOLUTION')).to.equal(true)
  })

  test('approve on an invoice above the supervisor threshold is rejected for a clerk-only user', async () => {
    axios.defaults.auth = { username: 'clerk1', password: 'clerk1' }
    const key = "(ID=c0ffee00-0000-0000-0000-000000000005)"
    await expect(
      POST(`/odata/v4/invoice/InvoiceExceptions${key}/InvoiceService.approve`, { comment: 'looks fine' })
    ).to.be.rejectedWith(/403/)
    axios.defaults.auth = { username: 'supervisor1', password: 'supervisor1' }
  })
})
