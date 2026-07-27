import fs from 'node:fs';
import path from 'node:path';

import type { AuditEntry } from '@shared/protocol';

import { getHost } from '../host';

// Append-only audit trail for every gated tool call. One JSON object
// per line (JSONL) in userData; the Settings → Permissions page reads
// the tail.

const FILE_NAME = 'agent-audit.jsonl';
const DEFAULT_TAIL = 200;

function auditFilePath(): string {
  return path.join(getHost().paths.userData, FILE_NAME);
}

/** The absolute path of the audit log — hard-denied as a write target. */
export function auditLogPath(): string {
  return auditFilePath();
}

export function appendAudit(entry: AuditEntry): void {
  try {
    fs.appendFileSync(auditFilePath(), `${JSON.stringify(entry)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch (err) {
    console.warn('[audit] append failed', err);
  }
}

/** Most-recent entries, newest first. */
export function readAudit(limit = DEFAULT_TAIL): AuditEntry[] {
  try {
    const file = auditFilePath();
    if (!fs.existsSync(file)) return [];
    const lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const tail = lines.slice(-limit);
    const entries: AuditEntry[] = [];
    for (const line of tail) {
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // Skip a corrupt line rather than losing the whole log.
      }
    }
    return entries.reverse();
  } catch (err) {
    console.warn('[audit] read failed', err);
    return [];
  }
}
