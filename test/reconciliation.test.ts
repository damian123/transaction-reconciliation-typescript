import { describe, expect, it } from "vitest";

import { ReconciliationEngine } from "../src/engine.js";
import type { SourceRecordInput } from "../src/types.js";

const exchangeTrade: SourceRecordInput = {
  source: "exchange",
  recordId: "trade-1",
  externalId: "shared-1",
  kind: "trade",
  asset: "BTC",
  quantity: "1.00000000",
  fee: "0.00010000",
  occurredAt: "2026-08-27T09:00:00Z",
};

const ledgerTrade: SourceRecordInput = {
  source: "ledger",
  recordId: "ledger-1",
  externalId: "shared-1",
  kind: "trade",
  asset: "BTC",
  quantity: "1.00000000",
  fee: "0.00010000",
  occurredAt: "2026-08-27T09:02:00Z",
};

function withoutExternalId(input: SourceRecordInput, recordId: string): SourceRecordInput {
  const { externalId: _externalId, ...rest } = input;
  return { ...rest, recordId };
}

describe("transaction reconciliation", () => {
  it("makes re-import idempotent without duplicating source or match results", () => {
    const engine = new ReconciliationEngine();
    expect(engine.import(exchangeTrade).status).toBe("imported");
    expect(engine.import(exchangeTrade).status).toBe("duplicate");
    engine.import(ledgerTrade);
    engine.reconcileAll();

    expect(engine.store.sourceRecords.size).toBe(2);
    expect(engine.store.cases.size).toBe(1);
    expect(engine.store.exceptions).toContainEqual(expect.objectContaining({ category: "duplicate" }));
  });

  it("matches by shared identifier even when display timestamps differ", () => {
    const normal = new ReconciliationEngine();
    normal.import(exchangeTrade);
    normal.import({ ...ledgerTrade, occurredAt: "2026-08-28T09:00:00Z" });
    const [result] = normal.reconcileAll();

    expect(result).toMatchObject({ status: "accepted", ruleName: "exact-identifier", confidence: "exact" });
  });

  it("does not accept a shared identifier with conflicting financial fields", () => {
    const engine = new ReconciliationEngine();
    engine.import(exchangeTrade);
    engine.import({ ...ledgerTrade, quantity: "2.00000000" });

    const [result] = engine.reconcileAll();
    expect(result).toMatchObject({
      status: "ambiguous",
      ruleName: "identifier-conflict",
      confidence: "none",
      candidateEventIds: ["ledger:ledger-1"],
    });
  });

  it("reserves each ledger event for at most one accepted source case", () => {
    const engine = new ReconciliationEngine();
    engine.import(withoutExternalId(exchangeTrade, "source-a"));
    engine.import(withoutExternalId(exchangeTrade, "source-b"));
    engine.import(withoutExternalId(ledgerTrade, "exclusive-ledger"));

    expect(engine.reconcileAll().map((result) => result.status)).toEqual([
      "accepted",
      "unmatched",
    ]);
    expect(
      [...engine.store.cases.values()].filter((item) =>
        item.candidateEventIds.includes("ledger:exclusive-ledger"),
      ),
    ).toHaveLength(1);
  });

  it("matches a custody fee within the configured asset precision tolerance", () => {
    const engine = new ReconciliationEngine();
    engine.import({
      source: "custody",
      recordId: "custody-1",
      kind: "transfer",
      asset: "BTC",
      quantity: "0.50000000",
      fee: "0.00001000",
      occurredAt: "2026-08-27T10:00:00Z",
    });
    engine.import({
      source: "ledger",
      recordId: "ledger-fee",
      kind: "transfer",
      asset: "BTC",
      quantity: "0.50000000",
      fee: "0.00001002",
      occurredAt: "2026-08-27T10:00:20Z",
    });

    const [result] = engine.reconcileAll();
    expect(result).toMatchObject({ status: "accepted", ruleName: "asset-fee-tolerance", confidence: "tolerance" });
  });

  it("keeps equally plausible candidates ambiguous", () => {
    const engine = new ReconciliationEngine();
    engine.import(withoutExternalId(exchangeTrade, "ambiguous-source"));
    engine.import(withoutExternalId(ledgerTrade, "ambiguous-a"));
    engine.import(withoutExternalId(ledgerTrade, "ambiguous-b"));

    const [result] = engine.reconcileAll();
    expect(result?.status).toBe("ambiguous");
    expect(result?.candidateEventIds).toHaveLength(2);
  });

  it("reopens an accepted case for a late reversal without deleting history", () => {
    const engine = new ReconciliationEngine();
    engine.import(exchangeTrade);
    engine.import(ledgerTrade);
    const [accepted] = engine.reconcileAll();
    const auditBefore = engine.store.audit.length;

    engine.import({
      source: "exchange",
      recordId: "reversal-1",
      kind: "trade",
      asset: "BTC",
      quantity: "-1.00000000",
      occurredAt: "2026-08-28T09:00:00Z",
      reversalOf: "exchange:trade-1",
    });

    expect(engine.store.cases.get(accepted?.caseId ?? "")?.status).toBe("reopened");
    expect(engine.store.audit).toHaveLength(auditBefore + 1);
    expect(engine.store.audit.at(-1)).toMatchObject({
      action: "reversal_received",
      previousStatus: "accepted",
      newStatus: "reopened",
    });
    expect(engine.reconcileAll()[0]).toMatchObject({
      caseId: accepted?.caseId,
      status: "reopened",
      ruleName: "late-reversal",
    });
  });

  it("matches a split transfer only under an explicit aggregation rule and passing total", () => {
    const engine = new ReconciliationEngine(undefined, {
      aggregationRules: [
        {
          sourceRecordId: "custody:split-source",
          aggregationGroup: "split-77",
          maxParts: 3,
        },
      ],
    });
    engine.import({
      source: "custody",
      recordId: "split-source",
      kind: "transfer",
      asset: "USDT",
      quantity: "100.000000",
      occurredAt: "2026-08-27T11:00:00Z",
    });
    engine.import({
      source: "ledger",
      recordId: "split-a",
      kind: "transfer",
      asset: "USDT",
      quantity: "40.000000",
      aggregationGroup: "split-77",
      occurredAt: "2026-08-27T11:00:10Z",
    });
    engine.import({
      source: "ledger",
      recordId: "split-b",
      kind: "transfer",
      asset: "USDT",
      quantity: "60.000000",
      aggregationGroup: "split-77",
      occurredAt: "2026-08-27T11:00:20Z",
    });

    const [result] = engine.reconcileAll();
    expect(result).toMatchObject({ status: "accepted", ruleName: "explicit-one-to-many" });
    expect(result?.candidateEventIds).toHaveLength(2);
  });

  it("records actor, reason, previous result, new result, and evidence for an override", () => {
    const engine = new ReconciliationEngine();
    engine.import(withoutExternalId(exchangeTrade, "manual-source"));
    engine.import(withoutExternalId(ledgerTrade, "manual-a"));
    engine.import(withoutExternalId(ledgerTrade, "manual-b"));
    const [ambiguous] = engine.reconcileAll();
    if (!ambiguous) throw new Error("Expected an ambiguous case");

    const resolved = engine.resolveManually(
      ambiguous.caseId,
      ["ledger:manual-a"],
      "ops-user-42",
      "Confirmed against the synthetic custody reference",
    );

    expect(resolved.status).toBe("resolved");
    expect(engine.store.audit.at(-1)).toMatchObject({
      action: "manual_resolution",
      actor: "ops-user-42",
      reason: "Confirmed against the synthetic custody reference",
      previousStatus: "ambiguous",
      newStatus: "resolved",
      selectedEventIds: ["ledger:manual-a"],
    });
    expect(engine.reconcileAll()[0]).toEqual(resolved);
  });

  it("accounts explicitly for ledger records that no accepted case claims", () => {
    const engine = new ReconciliationEngine();
    engine.import(withoutExternalId(ledgerTrade, "orphan-ledger"));
    engine.reconcileAll();
    expect(engine.dashboard().ledgerCoverage).toEqual({
      total: 1,
      matched: 0,
      unmatched: 1,
      unmatchedEventIds: ["ledger:orphan-ledger"],
    });

    engine.import(withoutExternalId(exchangeTrade, "later-source"));
    engine.reconcileAll();
    expect(engine.dashboard().ledgerCoverage).toEqual({
      total: 1,
      matched: 1,
      unmatched: 0,
      unmatchedEventIds: [],
    });
  });

  it("requires deterministic RFC 3339 timestamps with an explicit offset", () => {
    const engine = new ReconciliationEngine();
    expect(engine.import({ ...exchangeTrade, recordId: "missing-offset", occurredAt: "2026-08-27T09:00:00" })).toMatchObject({
      status: "invalid",
      reason: expect.stringContaining("explicit UTC offset"),
    });
    expect(engine.import({ ...exchangeTrade, recordId: "invalid-day", occurredAt: "2026-02-30T09:00:00Z" }).status).toBe("invalid");
    expect(engine.import({ ...exchangeTrade, recordId: "offset-ok", occurredAt: "2026-08-27T18:00:00+09:00" }).status).toBe("imported");
    expect(engine.store.normalizedEvents.get("exchange:offset-ok")?.occurredAtMs).toBe(
      Date.parse("2026-08-27T09:00:00Z"),
    );
  });

  it("accepts a corrected re-import after invalid normalization but rejects accepted-key conflicts", () => {
    const engine = new ReconciliationEngine();
    const invalid = { ...exchangeTrade, recordId: "correctable", quantity: "bad" };
    expect(engine.import(invalid).status).toBe("invalid");
    expect(engine.store.normalizedEvents.has("exchange:correctable")).toBe(false);

    const corrected = { ...exchangeTrade, recordId: "correctable" };
    expect(engine.import(corrected)).toMatchObject({
      status: "imported",
      reason: "Corrected invalid source record imported",
    });
    expect(engine.store.normalizedEvents.get("exchange:correctable")?.quantityAtomic).toBe(
      100_000_000n,
    );

    expect(engine.import({ ...corrected, quantity: "2.00000000" })).toMatchObject({
      status: "conflict",
      reason: expect.stringContaining("conflicting payload"),
    });
    expect(engine.store.sourceRecords.get("exchange:correctable")?.quantity).toBe(
      "1.00000000",
    );
    expect(engine.store.exceptions.at(-1)?.category).toBe("conflict");
  });

  it("validates manual evidence source, domain, and exclusive ownership", () => {
    const engine = new ReconciliationEngine();
    engine.import(withoutExternalId(exchangeTrade, "manual-source-a"));
    engine.import(withoutExternalId(exchangeTrade, "manual-source-b"));
    engine.import(withoutExternalId(ledgerTrade, "claimed-ledger"));
    engine.import({
      ...withoutExternalId(ledgerTrade, "wrong-domain"),
      asset: "ETH",
    });
    const [accepted, unmatched] = engine.reconcileAll();
    if (accepted === undefined || unmatched === undefined) throw new Error("Expected two cases");

    expect(() =>
      engine.resolveManually(
        unmatched.caseId,
        ["exchange:manual-source-a"],
        "ops-user",
        "invalid source selection",
      ),
    ).toThrow("must be a non-reversal ledger event");
    expect(() =>
      engine.resolveManually(
        unmatched.caseId,
        ["ledger:wrong-domain"],
        "ops-user",
        "invalid domain selection",
      ),
    ).toThrow("outside the case domain");
    expect(() =>
      engine.resolveManually(
        unmatched.caseId,
        ["ledger:claimed-ledger"],
        "ops-user",
        "attempted duplicate ownership",
      ),
    ).toThrow("already claimed by another case");
  });

  it("routes invalid input to exceptions and ties dashboard totals to normalized records", () => {
    const engine = new ReconciliationEngine();
    engine.import(exchangeTrade);
    engine.import(ledgerTrade);
    engine.import({ ...exchangeTrade, recordId: "invalid", quantity: "not-a-number" });
    engine.reconcileAll();

    const dashboard = engine.dashboard();
    expect(dashboard.importAttempts).toBe(3);
    expect(dashboard.uniqueSourceRecords).toBe(3);
    expect(dashboard.normalizedEvents).toBe(2);
    expect(dashboard.exceptions).toBe(1);
    expect(dashboard.controlTotals).toEqual([
      expect.objectContaining({ source: "exchange", asset: "BTC", count: 1, quantityAtomic: 100000000n }),
      expect.objectContaining({ source: "ledger", asset: "BTC", count: 1, quantityAtomic: 100000000n }),
    ]);
  });
});
