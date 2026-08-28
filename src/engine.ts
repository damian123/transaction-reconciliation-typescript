import { absolute, parseDecimal } from "./decimal.js";
import { InMemoryReconciliationStore } from "./store.js";
import type {
  AggregationRule,
  AuditEvent,
  CaseStatus,
  ControlTotal,
  DashboardSummary,
  ImportOutcome,
  NormalizedEvent,
  ReconciliationCase,
  ReconciliationConfig,
  SourceRecord,
  SourceRecordInput,
  SourceSystem,
} from "./types.js";

const defaultConfig: ReconciliationConfig = {
  ruleVersion: "rules-1",
  transformationVersion: "normalize-1",
  timestampWindowMs: 5 * 60 * 1000,
  assetScale: { BTC: 8, ETH: 8, USD: 2, USDT: 6 },
  feeToleranceAtomic: { BTC: 2n, ETH: 10n, USD: 1n, USDT: 1n },
  aggregationRules: [],
};

function now(): string {
  return new Date().toISOString();
}

function sourceKey(input: Pick<SourceRecordInput, "source" | "recordId">): string {
  return `${input.source}:${input.recordId}`;
}

function caseIdFor(event: NormalizedEvent): string {
  return `case:${event.eventId}`;
}

function optionalFields(input: SourceRecordInput): Pick<SourceRecordInput, "externalId" | "fee" | "aggregationGroup" | "reversalOf"> {
  return {
    ...(input.externalId ? { externalId: input.externalId } : {}),
    ...(input.fee ? { fee: input.fee } : {}),
    ...(input.aggregationGroup ? { aggregationGroup: input.aggregationGroup } : {}),
    ...(input.reversalOf ? { reversalOf: input.reversalOf } : {}),
  };
}

export class ReconciliationEngine {
  readonly config: ReconciliationConfig;

  constructor(
    readonly store = new InMemoryReconciliationStore(),
    config: Partial<ReconciliationConfig> = {},
  ) {
    this.config = {
      ...defaultConfig,
      ...config,
      assetScale: { ...defaultConfig.assetScale, ...(config.assetScale ?? {}) },
      feeToleranceAtomic: { ...defaultConfig.feeToleranceAtomic, ...(config.feeToleranceAtomic ?? {}) },
      aggregationRules: [...(config.aggregationRules ?? defaultConfig.aggregationRules)],
    };
  }

  import(input: SourceRecordInput, schemaVersion = "source-1"): ImportOutcome {
    this.store.importAttempts += 1;
    const key = sourceKey(input);
    if (this.store.sourceRecords.has(key)) {
      this.store.exceptions.push({
        exceptionId: `exception-${this.store.exceptions.length + 1}`,
        sourceKey: key,
        category: "duplicate",
        reason: "Duplicate source record ignored",
        at: now(),
      });
      return { sourceKey: key, status: "duplicate", reason: "Duplicate source record ignored" };
    }

    const importedAt = now();
    const record: SourceRecord = {
      source: input.source,
      recordId: input.recordId,
      kind: input.kind,
      asset: input.asset,
      quantity: input.quantity,
      occurredAt: input.occurredAt,
      ...optionalFields(input),
      sourceKey: key,
      importedAt,
      schemaVersion,
    };
    this.store.sourceRecords.set(key, record);

    try {
      const event = this.normalize(record);
      this.store.normalizedEvents.set(event.eventId, event);
      if (event.reversalOf) this.reopenForReversal(event);
      return { sourceKey: key, status: "imported" };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown normalization error";
      this.store.exceptions.push({
        exceptionId: `exception-${this.store.exceptions.length + 1}`,
        sourceKey: key,
        category: "invalid",
        reason,
        at: now(),
      });
      return { sourceKey: key, status: "invalid", reason };
    }
  }

  reconcileAll(): ReconciliationCase[] {
    const sources = [...this.store.normalizedEvents.values()].filter(
      (event) => event.source !== "ledger" && !event.reversalOf,
    );
    return sources.map((event) => this.reconcileEvent(event));
  }

  resolveManually(caseId: string, selectedEventIds: string[], actor: string, reason: string): ReconciliationCase {
    if (!actor.trim() || !reason.trim()) throw new Error("Manual resolution requires actor and reason");
    const existing = this.store.cases.get(caseId);
    if (!existing) throw new Error(`Unknown case ${caseId}`);
    for (const eventId of selectedEventIds) {
      if (!this.store.normalizedEvents.has(eventId)) throw new Error(`Unknown selected event ${eventId}`);
    }

    const updated: ReconciliationCase = {
      ...existing,
      candidateEventIds: [...selectedEventIds],
      status: "resolved",
      ruleName: "manual-override",
      explanation: reason,
      confidence: "manual",
      updatedAt: now(),
    };
    this.store.cases.set(caseId, updated);
    const audit: AuditEvent = {
      auditId: `audit-${this.store.audit.length + 1}`,
      action: "manual_resolution",
      caseId,
      actor,
      reason,
      at: updated.updatedAt,
      previousStatus: existing.status,
      newStatus: updated.status,
      selectedEventIds: [...selectedEventIds],
    };
    this.store.audit.push(audit);
    return updated;
  }

  dashboard(): DashboardSummary {
    const statuses: CaseStatus[] = ["accepted", "ambiguous", "unmatched", "resolved", "reopened"];
    const cases = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<CaseStatus, number>;
    for (const item of this.store.cases.values()) cases[item.status] += 1;

    return {
      importAttempts: this.store.importAttempts,
      uniqueSourceRecords: this.store.sourceRecords.size,
      normalizedEvents: this.store.normalizedEvents.size,
      exceptions: this.store.exceptions.length,
      cases,
      controlTotals: this.controlTotals(),
    };
  }

  private normalize(record: SourceRecord): NormalizedEvent {
    const asset = record.asset.trim().toUpperCase();
    const scale = this.config.assetScale[asset];
    if (scale === undefined) throw new Error(`Unsupported asset ${asset}`);
    const occurredAtMs = Date.parse(record.occurredAt);
    if (!Number.isFinite(occurredAtMs)) throw new Error(`Invalid timestamp ${record.occurredAt}`);

    return {
      eventId: record.sourceKey,
      sourceKey: record.sourceKey,
      source: record.source,
      kind: record.kind,
      asset,
      quantityAtomic: parseDecimal(record.quantity, scale),
      feeAtomic: parseDecimal(record.fee ?? "0", scale),
      occurredAtMs,
      ...(record.externalId ? { externalId: record.externalId } : {}),
      ...(record.aggregationGroup ? { aggregationGroup: record.aggregationGroup } : {}),
      ...(record.reversalOf ? { reversalOf: record.reversalOf } : {}),
      transformationVersion: this.config.transformationVersion,
    };
  }

  private reconcileEvent(source: NormalizedEvent): ReconciliationCase {
    const ledgers = [...this.store.normalizedEvents.values()].filter(
      (candidate) => candidate.source === "ledger" && !candidate.reversalOf,
    );
    const exactId = source.externalId
      ? ledgers.filter((candidate) => candidate.externalId === source.externalId && this.sameDomain(source, candidate))
      : [];
    if (exactId.length > 0) return this.finish(source, exactId, "exact-identifier", "exact");

    const aggregation = this.findAggregation(source, ledgers);
    if (aggregation.length > 0) return this.finish(source, aggregation, "explicit-one-to-many", "composite");

    const exactComposite = ledgers.filter(
      (candidate) =>
        this.sameDomain(source, candidate) &&
        candidate.quantityAtomic === source.quantityAtomic &&
        candidate.feeAtomic === source.feeAtomic &&
        this.withinWindow(source, candidate),
    );
    if (exactComposite.length > 0) return this.finish(source, exactComposite, "exact-composite", "composite");

    const tolerance = this.config.feeToleranceAtomic[source.asset] ?? 0n;
    const toleranceMatches = source.source === "custody"
      ? ledgers.filter(
          (candidate) =>
            this.sameDomain(source, candidate) &&
            candidate.quantityAtomic === source.quantityAtomic &&
            absolute(candidate.feeAtomic - source.feeAtomic) <= tolerance &&
            this.withinWindow(source, candidate),
        )
      : [];
    if (toleranceMatches.length > 0) return this.finish(source, toleranceMatches, "asset-fee-tolerance", "tolerance");

    return this.finish(source, [], "no-match", "none");
  }

  private finish(
    source: NormalizedEvent,
    candidates: NormalizedEvent[],
    ruleName: string,
    confidence: ReconciliationCase["confidence"],
  ): ReconciliationCase {
    const status: CaseStatus = candidates.length === 0 ? "unmatched" : candidates.length === 1 || ruleName === "explicit-one-to-many" ? "accepted" : "ambiguous";
    const explanation =
      status === "unmatched"
        ? "No candidate satisfied the ordered rules"
        : status === "ambiguous"
          ? `${candidates.length} equally valid candidates retained for review`
          : `${ruleName} matched ${candidates.length} ledger event${candidates.length === 1 ? "" : "s"}`;
    const next: ReconciliationCase = {
      caseId: caseIdFor(source),
      sourceEventIds: [source.eventId],
      candidateEventIds: candidates.map((candidate) => candidate.eventId),
      status,
      ruleName,
      ruleVersion: this.config.ruleVersion,
      explanation,
      confidence,
      updatedAt: now(),
    };
    return this.store.saveCase(next);
  }

  private findAggregation(source: NormalizedEvent, ledgers: NormalizedEvent[]): NormalizedEvent[] {
    const rule: AggregationRule | undefined = this.config.aggregationRules.find(
      (candidate) => candidate.sourceRecordId === source.sourceKey,
    );
    if (!rule) return [];
    const parts = ledgers.filter(
      (candidate) =>
        candidate.aggregationGroup === rule.aggregationGroup &&
        this.sameDomain(source, candidate) &&
        this.withinWindow(source, candidate),
    );
    if (parts.length < 2 || parts.length > rule.maxParts) return [];
    const total = parts.reduce((sum, part) => sum + part.quantityAtomic, 0n);
    return total === source.quantityAtomic ? parts : [];
  }

  private sameDomain(left: NormalizedEvent, right: NormalizedEvent): boolean {
    return left.kind === right.kind && left.asset === right.asset;
  }

  private withinWindow(left: NormalizedEvent, right: NormalizedEvent): boolean {
    return Math.abs(left.occurredAtMs - right.occurredAtMs) <= this.config.timestampWindowMs;
  }

  private reopenForReversal(reversal: NormalizedEvent): void {
    const originalEventId = reversal.reversalOf;
    if (!originalEventId) return;
    const target = [...this.store.cases.values()].find(
      (item) => item.sourceEventIds.includes(originalEventId) || item.candidateEventIds.includes(originalEventId),
    );
    if (!target) return;
    const updated: ReconciliationCase = {
      ...target,
      status: "reopened",
      ruleName: "late-reversal",
      explanation: `Late reversal ${reversal.eventId} reopened the accepted history`,
      confidence: "none",
      updatedAt: now(),
    };
    this.store.cases.set(updated.caseId, updated);
    this.store.audit.push({
      auditId: `audit-${this.store.audit.length + 1}`,
      action: "reversal_received",
      caseId: updated.caseId,
      actor: "system",
      reason: updated.explanation,
      at: updated.updatedAt,
      previousStatus: target.status,
      newStatus: updated.status,
      selectedEventIds: [...updated.candidateEventIds],
    });
  }

  private controlTotals(): ControlTotal[] {
    const totals = new Map<string, ControlTotal>();
    for (const event of this.store.normalizedEvents.values()) {
      const key = `${event.source}:${event.asset}`;
      const existing = totals.get(key) ?? {
        source: event.source as SourceSystem,
        asset: event.asset,
        count: 0,
        quantityAtomic: 0n,
        feeAtomic: 0n,
      };
      existing.count += 1;
      existing.quantityAtomic += event.quantityAtomic;
      existing.feeAtomic += event.feeAtomic;
      totals.set(key, existing);
    }
    return [...totals.values()].sort((left, right) =>
      `${left.source}:${left.asset}`.localeCompare(`${right.source}:${right.asset}`),
    );
  }
}
