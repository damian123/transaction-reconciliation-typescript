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

function parseTimestampWithExplicitOffset(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (match === null) {
    throw new Error(`Timestamp must be RFC 3339 with an explicit UTC offset: ${value}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0") || "0");
  const offsetHour = Number(match[10] ?? "0");
  const offsetMinute = Number(match[11] ?? "0");
  if (offsetHour > 23 || offsetMinute > 59) {
    throw new Error(`Invalid UTC offset in timestamp ${value}`);
  }

  const wallClock = new Date(0);
  wallClock.setUTCFullYear(year, month - 1, day);
  wallClock.setUTCHours(hour, minute, second, millisecond);
  if (
    wallClock.getUTCFullYear() !== year ||
    wallClock.getUTCMonth() !== month - 1 ||
    wallClock.getUTCDate() !== day ||
    wallClock.getUTCHours() !== hour ||
    wallClock.getUTCMinutes() !== minute ||
    wallClock.getUTCSeconds() !== second ||
    wallClock.getUTCMilliseconds() !== millisecond
  ) {
    throw new Error(`Invalid timestamp ${value}`);
  }

  const direction = match[9] === "-" ? -1 : 1;
  const offsetMs = direction * (offsetHour * 60 + offsetMinute) * 60 * 1_000;
  const occurredAtMs = wallClock.getTime() - offsetMs;
  if (!Number.isSafeInteger(occurredAtMs)) throw new Error(`Invalid timestamp ${value}`);
  return occurredAtMs;
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
    const existing = this.store.sourceRecords.get(key);
    if (existing !== undefined && this.sameSourceRecord(existing, record)) {
      this.store.exceptions.push({
        exceptionId: `exception-${this.store.exceptions.length + 1}`,
        sourceKey: key,
        category: "duplicate",
        reason: "Duplicate source record ignored",
        at: now(),
      });
      return { sourceKey: key, status: "duplicate", reason: "Duplicate source record ignored" };
    }

    if (existing !== undefined && this.store.normalizedEvents.has(key)) {
      const reason = "Accepted source key was reused with a conflicting payload";
      this.store.exceptions.push({
        exceptionId: `exception-${this.store.exceptions.length + 1}`,
        sourceKey: key,
        category: "conflict",
        reason,
        at: now(),
      });
      return { sourceKey: key, status: "conflict", reason };
    }

    try {
      const event = this.normalize(record);
      this.store.sourceRecords.set(key, record);
      this.store.normalizedEvents.set(event.eventId, event);
      if (event.reversalOf) this.reopenForReversal(event);
      return {
        sourceKey: key,
        status: "imported",
        ...(existing === undefined ? {} : { reason: "Corrected invalid source record imported" }),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown normalization error";
      if (existing === undefined) this.store.sourceRecords.set(key, record);
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
    ).sort((left, right) => left.eventId.localeCompare(right.eventId));
    const ledgers = [...this.store.normalizedEvents.values()].filter(
      (event) => event.source === "ledger" && !event.reversalOf,
    ).sort((left, right) => left.eventId.localeCompare(right.eventId));
    const claimedLedgerIds = new Set<string>();
    const protectedCases = new Map<string, ReconciliationCase>();

    for (const source of sources) {
      const existing = this.store.cases.get(caseIdFor(source));
      if (existing?.status !== "resolved" && existing?.status !== "reopened") continue;
      protectedCases.set(source.eventId, existing);
      this.claimCaseLedgers(existing, claimedLedgerIds);
    }

    const results: ReconciliationCase[] = [];
    for (const source of sources) {
      const protectedCase = protectedCases.get(source.eventId);
      if (protectedCase !== undefined) {
        results.push(protectedCase);
        continue;
      }
      const availableLedgers = ledgers.filter(
        (candidate) => !claimedLedgerIds.has(candidate.eventId),
      );
      const result = this.reconcileEvent(source, availableLedgers, ledgers);
      results.push(result);
      if (result.status === "accepted") this.claimCaseLedgers(result, claimedLedgerIds);
    }
    return results;
  }

  resolveManually(caseId: string, selectedEventIds: string[], actor: string, reason: string): ReconciliationCase {
    if (!actor.trim() || !reason.trim()) throw new Error("Manual resolution requires actor and reason");
    const existing = this.store.cases.get(caseId);
    if (!existing) throw new Error(`Unknown case ${caseId}`);
    if (selectedEventIds.length === 0) throw new Error("Manual resolution requires evidence selections");
    if (new Set(selectedEventIds).size !== selectedEventIds.length) {
      throw new Error("Manual evidence selections must be unique");
    }
    const sourceEvents = existing.sourceEventIds.map((eventId) => {
      const event = this.store.normalizedEvents.get(eventId);
      if (event === undefined || event.source === "ledger") {
        throw new Error(`Case ${caseId} has no valid non-ledger source evidence`);
      }
      return event;
    });
    const claimedElsewhere = this.claimedLedgerIds(caseId);
    for (const eventId of selectedEventIds) {
      const selected = this.store.normalizedEvents.get(eventId);
      if (selected === undefined) throw new Error(`Unknown selected event ${eventId}`);
      if (selected.source !== "ledger" || selected.reversalOf) {
        throw new Error(`Manual evidence ${eventId} must be a non-reversal ledger event`);
      }
      if (sourceEvents.some((source) => !this.sameDomain(source, selected))) {
        throw new Error(`Manual evidence ${eventId} is outside the case domain`);
      }
      if (claimedElsewhere.has(eventId)) {
        throw new Error(`Manual evidence ${eventId} is already claimed by another case`);
      }
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
      actor: actor.trim(),
      reason: reason.trim(),
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
      ledgerCoverage: this.ledgerCoverage(),
    };
  }

  private normalize(record: SourceRecord): NormalizedEvent {
    const asset = record.asset.trim().toUpperCase();
    const scale = this.config.assetScale[asset];
    if (scale === undefined) throw new Error(`Unsupported asset ${asset}`);
    const occurredAtMs = parseTimestampWithExplicitOffset(record.occurredAt);

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

  private reconcileEvent(
    source: NormalizedEvent,
    ledgers: NormalizedEvent[],
    allLedgers: NormalizedEvent[],
  ): ReconciliationCase {
    const sameIdentifier = source.externalId
      ? allLedgers.filter((candidate) => candidate.externalId === source.externalId)
      : [];
    if (sameIdentifier.length > 0) {
      const availableIds = new Set(ledgers.map((candidate) => candidate.eventId));
      const exactId = sameIdentifier.filter(
        (candidate) =>
          availableIds.has(candidate.eventId) &&
          this.sameDomain(source, candidate) &&
          candidate.quantityAtomic === source.quantityAtomic &&
          candidate.feeAtomic === source.feeAtomic,
      );
      if (exactId.length === sameIdentifier.length) {
        return this.finish(source, exactId, "exact-identifier", "exact");
      }
      return this.identifierConflict(source, sameIdentifier);
    }

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

  private identifierConflict(
    source: NormalizedEvent,
    candidates: NormalizedEvent[],
  ): ReconciliationCase {
    return this.store.saveCase({
      caseId: caseIdFor(source),
      sourceEventIds: [source.eventId],
      candidateEventIds: candidates.map((candidate) => candidate.eventId),
      status: "ambiguous",
      ruleName: "identifier-conflict",
      ruleVersion: this.config.ruleVersion,
      explanation: "Shared identifier candidates conflict on domain, financial fields, or exclusive ownership",
      confidence: "none",
      updatedAt: now(),
    });
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

  private claimCaseLedgers(
    reconciliationCase: ReconciliationCase,
    claimed: Set<string>,
  ): void {
    for (const eventId of reconciliationCase.candidateEventIds) {
      const event = this.store.normalizedEvents.get(eventId);
      if (event?.source !== "ledger" || event.reversalOf) continue;
      if (claimed.has(eventId)) {
        throw new Error(`Ledger event ${eventId} is claimed by multiple preserved cases`);
      }
      claimed.add(eventId);
    }
  }

  private claimedLedgerIds(excludedCaseId?: string): Set<string> {
    const claimed = new Set<string>();
    for (const reconciliationCase of this.store.cases.values()) {
      if (
        reconciliationCase.caseId === excludedCaseId ||
        !["accepted", "resolved", "reopened"].includes(reconciliationCase.status)
      ) {
        continue;
      }
      for (const eventId of reconciliationCase.candidateEventIds) {
        if (this.store.normalizedEvents.get(eventId)?.source === "ledger") claimed.add(eventId);
      }
    }
    return claimed;
  }

  private sameSourceRecord(left: SourceRecord, right: SourceRecord): boolean {
    return (
      left.source === right.source &&
      left.recordId === right.recordId &&
      left.kind === right.kind &&
      left.asset === right.asset &&
      left.quantity === right.quantity &&
      left.occurredAt === right.occurredAt &&
      left.externalId === right.externalId &&
      left.fee === right.fee &&
      left.aggregationGroup === right.aggregationGroup &&
      left.reversalOf === right.reversalOf &&
      left.schemaVersion === right.schemaVersion
    );
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

  private ledgerCoverage(): DashboardSummary["ledgerCoverage"] {
    const ledgerIds = [...this.store.normalizedEvents.values()]
      .filter((event) => event.source === "ledger" && !event.reversalOf)
      .map((event) => event.eventId)
      .sort();
    const claimed = this.claimedLedgerIds();
    const unmatchedEventIds = ledgerIds.filter((eventId) => !claimed.has(eventId));
    return {
      total: ledgerIds.length,
      matched: ledgerIds.length - unmatchedEventIds.length,
      unmatched: unmatchedEventIds.length,
      unmatchedEventIds,
    };
  }
}
