# Limitations

This repository is a local, deterministic reconciliation engine. It is not an operations platform.

## Persistence and runtime

The store is in-memory. Restarting the process drops cases, exceptions, and audit history. A production service would need PostgreSQL (or equivalent), durable job processing, and an authenticated operator interface.

## Data and advice

All names, balances, and identifiers are fictional. There is no customer, exchange, blockchain, wallet, account, tax-lot, pricing, or regulated-reporting data. The demo is not accounting, investment, audit, tax, custody, or regulatory advice.

## Matching scope

Rules cover exact identifiers, a configured aggregation path, exact composites, and named fee tolerances. They do not cover fuzzy entity resolution, machine-learned matching, multi-entity netting, or tax-lot accounting.

## What would have to change

- Durable storage with the same exclusive-ownership invariants for ledger evidence.
- Authenticated roles for manual resolution.
- Real source adapters instead of fixtures.
- Backpressure, retention, and operational metrics around import and rerun.
