# NorthForge — Intelligent Invoice Exception Handling with Agentic Triage

A working SAP BTP / CAP prototype for the NorthForge Manufacturing interview use case:
an agentic triage service that investigates AP invoice exceptions (PO mismatches, missing
GR, provincial tax variances, contract-rate variances, missing metadata on tail-spend PDFs),
proposes a resolution with a full auditable reasoning trace, and either auto-resolves,
routes to an AP clerk, or escalates to a supervisor.

## Stack

- **CAP (Node.js)** — CDS data model + service layer + custom handlers
- **SQLite** locally / **SAP HANA Cloud** in production (`@cap-js/hana`)
- **Fiori Elements** (List Report + Object Page) UI, OData V4
- **XSUAA** mocked locally, real role collections defined in `xs-security.json`
- Calls to the S/4HANA sandbox (`API_PURCHASEORDER_PROCESS_SRV`, via a real BTP Destination
  in `[hybrid]`/`[production]`, a local mock otherwise) and a mocked SAP Document
  Information Extraction (DOX) call

## Run it locally

```bash
npm install
npx cds deploy --to sqlite:db.sqlite   # seed the local database
npx cds serve all --with-mocks         # or: npm run watch
```

Open the app:

```
http://localhost:4004/invoiceexceptions/webapp/index.html
```

Sign in with one of the two mocked users (`cds.requires.auth.users` in `package.json`):

| user | password | roles |
|---|---|---|
| `clerk1` | `clerk1` | AP.Clerk |
| `supervisor1` | `supervisor1` | AP.Clerk, AP.Supervisor |

Use **supervisor1** to see the full experience — clerks are blocked from approving
invoices over $50,000 and from triggering re-triage (see the segregation-of-duties
check in `srv/invoice-service.js`).

### Try the agent

On the Object Page of any `NEW` invoice exception, the **Retriage** action (supervisor
only) runs the bounded investigation (extract DOX fields for email-PDF invoices →
fetch PO → fetch contract / recompute tax as relevant → check vendor history → decide)
and writes a full audit trail visible in the **Audit Trail (Recommendation Log)**
section. **Approve / Reject / Edit** are available to both roles, subject to the amount
threshold.

## Tests

```bash
npx jest
```

13 tests: pure-function unit tests for the tax/confidence/retry logic
(`test/triage-logic.test.js`) and OData-level contract tests against the live service
(`test/invoice-service.test.js`), the latter running against an isolated in-memory DB
(`[test]` cds profile in `package.json`).

## Project layout

```
db/schema.cds              domain model (InvoiceExceptions, InvoiceExceptionItems, Vendors, Contracts, RecommendationLogs)
db/data/                   seed data for the demo
srv/invoice-service.cds    service definition, actions, role restrictions
srv/invoice-service.js     triage pipeline (DOX extraction, S/4 call + retry), clerk actions
srv/external/              hand-authored subset of API_PURCHASEORDER_PROCESS_SRV
srv/mocks/                 local mocks for the S/4 PO lookup and the DOX extraction call
app/invoiceexceptions/     Fiori Elements List Report + Object Page app
test/                      unit + contract tests
xs-security.json           XSUAA scopes / role templates / role collections
mta.yaml                   Cloud Foundry deployment topology
```

`docs/invoice-service.openapi.json` is the generated OpenAPI contract for the service
(`cds compile srv --to openapi`).

## Learn more

<https://cap.cloud.sap>
