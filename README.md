# Transaction reconciliation

Match exchange executions, custody movements, and an internal ledger when identifiers, timestamps, and fees do not line up. The engine keeps every decision explainable: named rule, evidence IDs, and a confidence category rather than a silent closest match.

Portfolio project using fictional data. It is not connected to an employer, client, or production system.

![Transaction reconciliation architecture](portfolio/architecture.svg)

PNG copies: [architecture](portfolio/architecture.png) and [verified results](portfolio/verified-results.png).

## Capabilities

- Import versioned source records with provenance and preserved raw values, including corrected recovery and conflict rejection for accepted keys.
- Normalize assets, quantities, fees, and RFC 3339 timestamps that carry an explicit offset.
- Apply financially consistent rules in a fixed order: exact identifier, explicit aggregation, exact composite, then named tolerance.
- Leave ambiguous candidates unresolved instead of picking the closest record, and reserve each accepted ledger event to one case.
- Reopen cases for late reversals, record manual overrides as append-only audit events, and report unmatched-ledger coverage.

## Run

```bash
npm ci
npm run verify
```

`verify` type-checks, runs the fourteen Vitest cases, and prints a structured walkthrough from `src/demo.ts`. Node.js 22 is the CI runtime.

## Verification

![Verified reconciliation results](portfolio/verified-results.svg)

GitHub Actions on push and pull request runs `npm ci`, `npm run verify`, and checks that `MANIFEST.sha256` still matches `scripts/build-evidence-manifest.sh`.

Quantities and fees use fixed-scale `bigint` arithmetic, not floating point.

## Design

Pipeline:

```text
source_record → normalized_event → match_candidate
  → reconciliation_case → resolution_event → control_total
```

- A shared identifier still matches across timestamp drift when domain, quantity, and fee agree; conflicting financials stay unresolved.
- Two equally plausible candidates become one ambiguous case. Split transfers match one-to-many only under a configured aggregation rule whose control total passes.
- A late reversal reopens the case without deleting accepted history. Manual evidence must be non-reversal ledger data in the same domain and not already claimed.
- Invalid imports, identical duplicates, and conflicting reuse of an accepted key go to exception records. Dashboard totals distinguish raw imports from normalized events.

Layout: `src/decimal.ts` for scale, `src/engine.ts` for matching, `src/store.ts` for in-memory persistence and audit, `src/demo.ts` for the walkthrough.

## Limitations

In-memory store, no operator UI, and no connection to a live exchange or custody system. See [LIMITATIONS.md](LIMITATIONS.md) for the production boundary.
