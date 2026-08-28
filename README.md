# Transaction reconciliation

**Status:** implemented synthetic demonstration.

A synthetic digital-asset operations system that reconciles exchange executions, custody movements, and an internal transaction ledger without using any real client, exchange, wallet, or third-party data.

![Transaction reconciliation architecture](portfolio/architecture.svg)

![Verified reconciliation results](portfolio/verified-results.svg)

PNG exports for proposals and interview screen sharing: [architecture](portfolio/architecture.png) and [verified results](portfolio/verified-results.png).

## Scenario

An operations team receives trades and transfers from multiple synthetic sources. Identifiers do not always align, timestamps and fees differ, transfers may be split or aggregated, reversals arrive late, and duplicate exports are common. Operators need deterministic automation without losing the evidence behind each decision.

## Demonstrated outcome

- Ingest versioned CSV and API-shaped fixtures with source provenance.
- Normalize assets, quantities, fees, identifiers, and UTC timestamps without discarding raw values.
- Apply exact rules before explicitly ordered tolerance and composite rules.
- Keep ambiguous candidates unresolved rather than selecting the closest record silently.
- Explain every match with rule version, input fields, tolerance, and confidence category.
- Route unmatched, invalid, duplicate, late, reversal, and ambiguous records to an exception queue.
- Record manual resolutions as append-only audit events.
- Produce population counts and quantity/value control totals by asset and source.

## Synthetic data model

```text
source_record
  → normalized_event
  → match_candidate
  → reconciliation_case
  → resolution_event
  → control_total
```

Every derived record retains stable links to its raw source and transformation version.

## Acceptance scenarios

1. Re-importing the same exchange export creates no duplicate source or match result.
2. A trade matches exactly by shared identifier even when its display timestamp differs.
3. A custody fee within the configured asset precision matches under a named tolerance rule.
4. Two equally plausible candidates create one ambiguous case and no automatic match.
5. A late reversal reopens the affected case without deleting its accepted history.
6. A split transfer can match one-to-many only when the explicit aggregation rule and control total pass.
7. An operator override records actor, reason, previous result, new result, and supporting evidence.
8. Dashboard counts and per-asset totals tie back to every source record in the acceptance fixtures.

## Implemented stack

TypeScript, Node.js, Vitest, strict compiler checks, deterministic synthetic fixtures, and an in-memory store that keeps the matching and audit behavior executable without external credentials or infrastructure. A production implementation would replace the store with PostgreSQL, add durable job processing, and expose operator workflows through an authenticated interface.

The engine uses fixed-scale `bigint` arithmetic rather than floating-point values for quantities and fees.

## Implemented behavior

- Idempotent import keyed by source and source record ID.
- Versioned normalization with preserved links to raw records.
- Ordered exact-identifier, explicit aggregation, exact-composite, and named tolerance rules.
- Ambiguous-candidate preservation instead of silent closest-match selection.
- Explicit one-to-many matching only under a configured aggregation rule and passing control total.
- Late-reversal reopening without deleting accepted history.
- Manual resolution with actor, reason, previous status, new status, and selected evidence.
- Source-and-asset control totals plus dashboard population counts.
- Invalid and duplicate inputs routed to an exception record.

## Repository shape

```text
src/decimal.ts    fixed-scale decimal parsing and arithmetic
src/types.ts      source, normalized, case, audit, and reporting contracts
src/store.ts      in-memory persistence and append-only audit recording
src/engine.ts     import, normalization, ordered matching, reversal, and override logic
src/demo.ts       executable structured-output walkthrough
test/             eight acceptance tests
```

## Run it

```bash
npm install
npm run typecheck
npm test
npm run demo
```

Verified on 2026-08-27: eight tests passed, the TypeScript compiler check passed, and the structured-output demo completed.

## Portfolio evidence

- Executable ordered matching and audit engine.
- Deterministic synthetic fixtures and boundary-focused tests.
- Duplicate, invalid-input, ambiguous-match, late-reversal, split-transfer, and manual-override scenarios.
- Structured case, audit, exception, dashboard, and control-total output.
- Documented limitations and production scaling path.

## Non-goals

No real customer, exchange, blockchain, wallet, account, tax lot, pricing feed, or regulated reporting data. The demo does not provide accounting, investment, audit, tax, custody, or regulatory advice.
