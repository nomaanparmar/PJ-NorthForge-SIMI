# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

NorthForge Manufacturing — an agentic AP invoice-exception triage prototype on SAP BTP/CAP.
It investigates flagged invoices (PO mismatch, missing goods receipt, tax variance,
contract-rate variance, missing metadata on scanned PDFs), builds an auditable evidence
trail, and either auto-resolves, routes to a clerk, or escalates to a supervisor.

## Commands

```bash
npm install
npx cds deploy --to sqlite:db.sqlite   # (re)build db.sqlite from db/schema.cds + db/data/*.csv
npm run watch                          # cds watch — live reload on :4004
npx jest                                # run the full test suite (NOT `npm test` — that script
                                        # just prints a pointer, it does not invoke jest)
npx jest test/triage-logic.test.js     # single file
npx jest -t "PO_MISMATCH"              # single test by name pattern
npx cds compile srv/invoice-service.cds srv/triage-orchestration-service.cds --to json
                                        # fast syntax/annotation sanity check without starting a server
                                        # (compiling only one of the two .cds files errors with
                                        # "Found multiple service definitions" / model-not-found —
                                        # always pass both together, or `-s <ServiceName>`)
```

Open the app at `http://localhost:4004/invoiceexceptions/webapp/index.html`. Mocked users
(`cds.requires.auth.users` in `package.json`): `clerk1`/`clerk1` (AP.Clerk),
`supervisor1`/`supervisor1` (AP.Clerk + AP.Supervisor), `auditor1`/`auditor1` (AP.Auditor).

**Gotcha:** if `db.sqlite` is deleted, `cds watch`/`cds serve` does **not** auto-create tables
and reseed from the CSVs on its own — it starts clean but every query 404s with
`SQLITE_ERROR: no such table`. Run `npx cds deploy --to sqlite:db.sqlite` first, then start
the server. Same applies any time `db/data/*.csv` changes while the server isn't running —
delete `db.sqlite*` and redeploy to pick the changes up; a running `cds watch` does pick up
`.cds`/`.js` file changes live, but not CSV reseeds into an existing table.

## Architecture

### Two CAP services, deliberately split

- **`InvoiceService`** (`srv/invoice-service.cds` / `.js`) — the only OData-exposed, UI-facing
  service. Thin: `approve`/`rejectInvoice`/`edit` contain the actual clerk-decision logic
  (segregation-of-duties check, audit log write); `retriage` is a one-line delegator that
  calls into the orchestration service and re-selects its own projection afterward.
- **`TriageOrchestrationService`** (`srv/triage-orchestration-service.cds` / `.js`) — internal
  only (`@protocol: 'none'`, not reachable via OData/REST — only via `cds.connect.to()`
  in-process). Holds the entire agent pipeline: DOX extraction, PO/contract/GR fetch, tax
  recompute, vendor-history check, confidence scoring, and the disposition decision. Split out
  so the pipeline has no dependency on `InvoiceService`'s UI-facing auth model, and can later
  be invoked by something other than a button click (an event handler, a scheduled job).
  Reads/writes go through `cds.entities('com.northforge.invoice')` (the raw db-layer entities),
  not `InvoiceService`'s own projection.

When changing triage/scoring logic, edit `triage-orchestration-service.js`, not
`invoice-service.js`. Pure functions (`recomputeProvincialTax`, `computeConfidence`,
`withRetry`) are exported from the orchestration file specifically for
`test/triage-logic.test.js`.

### The retriage pipeline (in `triage-orchestration-service.js`)

Six conditional steps, each only runs for the invoice's `exceptionType_code`, each writes its
own `RecommendationLogs` row via a shared `log()` closure (immutable, append-only, ordinal
`step` per invoice): `EXTRACT_DOX_FIELDS` → `FETCH_PO` → `FETCH_CONTRACT` → `RECOMPUTE_TAX` →
`FETCH_GR` → `CHECK_VENDOR_HISTORY` → `decideDisposition()` → `decideAndClose()`.

Confidence comes from one of two independent sources, never blended:
- **LLM path** (`genai-client.js`, only when a `genAIHub` BTP Destination is bound) — Claude
  returns its own confidence via a structured tool call.
- **Rule-based fallback** (`computeConfidence()`) — per-exception-type formula, then a global
  `overrideRate * 0.2` haircut based on the vendor's historical clerk-override rate.

`decideAndClose()` then applies thresholds (`AUTO_RESOLVE_CONFIDENCE = 0.85`,
`ESCALATE_CONFIDENCE_FLOOR = 0.35`) with one hard invariant enforced in code regardless of
confidence: amounts over `IN_SCOPE_MAX_AMOUNT = 250000` always escalate.

### Resilience pattern — same shape, different fallback per call

`withRetry()` (exponential backoff, only retries on no-code/5xx/429) wraps every external
call, but what happens after retries are exhausted differs deliberately per step: DOX
extraction degrades (logs `ERROR`, continues without extracted fields); `fetchPurchaseOrderItem()`
falls back to `srv/mocks/po-mock.js` and tags the result `_s4Error` so the fallback is visible
in the audit trail (`outcome: 'FETCHED_MOCK_FALLBACK'`), never silently presented as a real S/4
response; the LLM call falls back to rule-based scoring with `llmError` folded into the
persisted `reasoningTrace`. **`FETCH_GR` is the one step with retries but no catch/fallback** —
if it exhausts retries, `retriage` throws and the invoice is left stuck at `INVESTIGATING`.
Known gap, not yet hardened.

When checking whether a real destination is configured, always check
`cds.requires.<name>.credentials?.destination` specifically — `cds serve --with-mocks`
auto-injects its own `credentials.url` for any required service with no real binding, which
makes a naive `if (!credentials)` check falsely true and routes into an empty auto-mocked
table instead of the intended local mock.

### LLM integration — destination-only, no direct-call fallback

`genai-client.js` routes exclusively through the `genAIHub` BTP Destination
(`cds.requires.genAIHub`, bound under `[hybrid]`/`[production]` to destination `GENAI_HUB` →
`https://api.anthropic.com`). If no destination is bound, `getTriageRecommendation()` returns
`null` and the caller falls back to rule-based scoring — there is intentionally no
`ANTHROPIC_API_KEY`-based direct-call path anymore.

### Role-based access — three roles, two different mechanisms

Defined in `cds.requires.auth.users` (mocked locally) / `xs-security.json` (real role
collections). Enforced in `invoice-service.cds` via `@restrict`, with two layers:

1. **Grant-level** (who can call an action at all): `approve`/`rejectInvoice`/`edit` →
   `AP.Clerk` + `AP.Supervisor`; `retriage` → `AP.Supervisor` only; `AP.Auditor` gets `READ`
   everywhere and is never added to any action grant (enforced server-side — a 403 on
   attempt — the Fiori Elements action buttons are *not* role-aware and render for every
   user regardless; only the backend check actually blocks it).
2. **Row-level, `AP.Clerk` only** (`@restrict.where` on `InvoiceExceptions`): a clerk sees
   only invoices already assigned to them (`assignedTo = $user`, any status — keeps their
   resolution history visible) or unclaimed rows sitting in the shared `ROUTED_TO_CLERK`
   queue (`assignedTo is null and status = 'ROUTED_TO_CLERK'`). `AP.Supervisor` and
   `AP.Auditor` read `InvoiceExceptions`/`RecommendationLogs`/`InvoiceExceptionItems`
   unrestricted. `assignedTo` is set as a side effect of a clerk acting (approve/reject/edit),
   not by any explicit "claim" step. Additionally, a clerk above `SUPERVISOR_REQUIRED_ABOVE`
   ($50,000) is rejected with a 403 even for approve/reject/edit, checked in
   `invoice-service.js`, independently of the CDS-level role grant.
   Note: this row-level filter is **not** mirrored on `RecommendationLogs` or
   `InvoiceExceptionItems` — a clerk only reaches those via Fiori navigation from an
   already-filtered `InvoiceExceptions` row, but a direct OData query to either entity set
   bypasses that. Known gap.

   **Role names must match exactly between three places**: `@restrict.to` in
   `invoice-service.cds` (`AP.Clerk`/`AP.Supervisor`/`AP.Auditor`, dots), the mocked
   `cds.requires.auth.users[*].roles` in `package.json` (same, dots), and the XSUAA `scope`
   `name` fields in `xs-security.json` (`$XSAPPNAME.AP.Clerk` etc.) — CAP strips the
   `$XSAPPNAME.` prefix off the JWT `scope` claim and string-compares what's left against
   `@restrict.to`. `xs-security.json`'s `role-template`/`role-collection` *names* are just
   internal identifiers and don't need to match this convention (they were left as
   `AP_Clerk`/`AP_Supervisor`/`AP_Auditor`, underscores, on purpose) — only the `scopes[].name`
   values are what actually reach the token check. Add any new role in all three places, using
   dots in the scope name, or it silently 403s against a real XSUAA token while working fine
   locally against mocked auth.

### Persistence & environment profiles (`package.json` → `cds.requires`)

Default/local: SQLite file (`db.sqlite`), mocked auth, `srv/mocks/*` for PO/GR/DOX.
`[test]`: in-memory SQLite (used by `cds.test()` in the Jest contract tests).
`[hybrid]`/`[production]`: `API_PURCHASEORDER_PROCESS_SRV` and `genAIHub` rebound to real BTP
Destinations (`S4HANA_SANDBOX`, `GENAI_HUB`); `[production]` also switches auth to `xsuaa`.
There is currently no `[production].db` override — production still resolves to the same
SQLite kind as local; swapping to HANA Cloud is a `cds.requires.db` entry away, no model/code
changes required (CAP's query layer is database-agnostic).

`cds bind --exec --profile hybrid -- <command>` is how real BTP Destination/Connectivity
credentials get injected into a locally-run process for hybrid testing.
