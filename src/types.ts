export type SourceSystem = "exchange" | "custody" | "ledger";
export type EventKind = "trade" | "transfer";

export interface SourceRecordInput {
  source: SourceSystem;
  recordId: string;
  kind: EventKind;
  asset: string;
  quantity: string;
  occurredAt: string;
  externalId?: string;
  fee?: string;
  aggregationGroup?: string;
  reversalOf?: string;
}

export interface SourceRecord extends SourceRecordInput {
  sourceKey: string;
  importedAt: string;
  schemaVersion: string;
}

export interface NormalizedEvent {
  eventId: string;
  sourceKey: string;
  source: SourceSystem;
  kind: EventKind;
  asset: string;
  quantityAtomic: bigint;
  feeAtomic: bigint;
  occurredAtMs: number;
  externalId?: string;
  aggregationGroup?: string;
  reversalOf?: string;
  transformationVersion: string;
}

export type CaseStatus = "accepted" | "ambiguous" | "unmatched" | "resolved" | "reopened";

export interface ReconciliationCase {
  caseId: string;
  sourceEventIds: string[];
  candidateEventIds: string[];
  status: CaseStatus;
  ruleName: string;
  ruleVersion: string;
  explanation: string;
  confidence: "exact" | "tolerance" | "composite" | "manual" | "none";
  updatedAt: string;
}

export interface ExceptionRecord {
  exceptionId: string;
  sourceKey: string;
  category: "invalid" | "duplicate" | "conflict";
  reason: string;
  at: string;
}

export interface AuditEvent {
  auditId: string;
  action: "case_created" | "case_updated" | "manual_resolution" | "reversal_received";
  caseId: string;
  actor: string;
  reason: string;
  at: string;
  previousStatus?: CaseStatus;
  newStatus: CaseStatus;
  selectedEventIds: string[];
}

export interface AggregationRule {
  sourceRecordId: string;
  aggregationGroup: string;
  maxParts: number;
}

export interface ReconciliationConfig {
  ruleVersion: string;
  transformationVersion: string;
  timestampWindowMs: number;
  assetScale: Record<string, number>;
  feeToleranceAtomic: Record<string, bigint>;
  aggregationRules: AggregationRule[];
}

export interface ImportOutcome {
  sourceKey: string;
  status: "imported" | "duplicate" | "invalid" | "conflict";
  reason?: string;
}

export interface ControlTotal {
  source: SourceSystem;
  asset: string;
  count: number;
  quantityAtomic: bigint;
  feeAtomic: bigint;
}

export interface DashboardSummary {
  importAttempts: number;
  uniqueSourceRecords: number;
  normalizedEvents: number;
  exceptions: number;
  cases: Record<CaseStatus, number>;
  controlTotals: ControlTotal[];
  ledgerCoverage: {
    total: number;
    matched: number;
    unmatched: number;
    unmatchedEventIds: string[];
  };
}
