import type {
  AuditEvent,
  ExceptionRecord,
  NormalizedEvent,
  ReconciliationCase,
  SourceRecord,
} from "./types.js";

export class InMemoryReconciliationStore {
  readonly sourceRecords = new Map<string, SourceRecord>();
  readonly normalizedEvents = new Map<string, NormalizedEvent>();
  readonly cases = new Map<string, ReconciliationCase>();
  readonly exceptions: ExceptionRecord[] = [];
  readonly audit: AuditEvent[] = [];
  importAttempts = 0;

  saveCase(next: ReconciliationCase, actor = "system"): ReconciliationCase {
    const previous = this.cases.get(next.caseId);
    this.cases.set(next.caseId, next);
    this.audit.push({
      auditId: `audit-${this.audit.length + 1}`,
      action: previous ? "case_updated" : "case_created",
      caseId: next.caseId,
      actor,
      reason: next.explanation,
      at: next.updatedAt,
      ...(previous ? { previousStatus: previous.status } : {}),
      newStatus: next.status,
      selectedEventIds: [...next.candidateEventIds],
    });
    return next;
  }
}
