import { ReconciliationEngine } from "./engine.js";
import type { SourceRecordInput } from "./types.js";

const records: SourceRecordInput[] = [
  {
    source: "exchange",
    recordId: "trade-100",
    externalId: "shared-trade-100",
    kind: "trade",
    asset: "BTC",
    quantity: "0.25000000",
    fee: "0.00001000",
    occurredAt: "2026-08-27T09:00:00Z",
  },
  {
    source: "ledger",
    recordId: "ledger-100",
    externalId: "shared-trade-100",
    kind: "trade",
    asset: "BTC",
    quantity: "0.25000000",
    fee: "0.00001000",
    occurredAt: "2026-08-27T09:00:30Z",
  },
  {
    source: "custody",
    recordId: "transfer-200",
    kind: "transfer",
    asset: "ETH",
    quantity: "2.00000000",
    fee: "0.00000100",
    occurredAt: "2026-08-27T10:00:00Z",
  },
  {
    source: "ledger",
    recordId: "ledger-200",
    kind: "transfer",
    asset: "ETH",
    quantity: "2.00000000",
    fee: "0.00000105",
    occurredAt: "2026-08-27T10:00:10Z",
  },
];

const engine = new ReconciliationEngine();
for (const record of records) engine.import(record);
engine.reconcileAll();

const output = {
  cases: [...engine.store.cases.values()],
  audit: engine.store.audit,
  dashboard: engine.dashboard(),
};

console.log(
  JSON.stringify(output, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value), 2),
);
