import { randomUUID } from 'node:crypto';

import type { PermissionChoice, PermissionRequest } from '@shared/protocol';

import { getPermissionPrefs, setPermissionPrefs } from '../userPreferences';
import { appendAudit } from './auditLog';
import { classify } from './classifier';

// The permission gate. Every mutating tool call funnels through
// `requestPermission` before it touches the machine.

export interface GateRequest {
  tool: string;
  title: string;
  summary: string;
  preview: string | null;
  previewKind: 'text' | 'code' | 'diff';
  targetPath?: string | undefined;
  command?: string | undefined;
  itemCount?: number | undefined;
  scopeKey: string;
  allowAlways: boolean;
  taskId: string;
}

export interface GateResult {
  allowed: boolean;
  reason: string;
}

type PromptHandler = (req: PermissionRequest) => Promise<PermissionChoice>;

let promptHandler: PromptHandler | null = null;

// taskId -> set of `tool::scopeKey` strings approved "for this task".
const taskGrants = new Map<string, Set<string>>();

/** Wire the approval popup. Passed `null` on shutdown. */
export function setPromptHandler(fn: PromptHandler | null): void {
  promptHandler = fn;
}

/** Drop every task-scoped grant for a finished tool-loop run. */
export function clearTaskGrants(taskId: string): void {
  taskGrants.delete(taskId);
}

function grantKey(req: GateRequest): string {
  return `${req.tool}::${req.scopeKey}`;
}

function audit(
  req: GateRequest,
  decision: 'auto' | 'allowed' | 'denied' | 'blocked',
  detail: string,
): void {
  appendAudit({
    at: Date.now(),
    tool: req.tool,
    summary: req.summary,
    decision,
    detail,
  });
}

export async function requestPermission(req: GateRequest): Promise<GateResult> {
  const prefs = getPermissionPrefs();

  const verdict = classify({
    tool: req.tool,
    targetPath: req.targetPath,
    command: req.command,
    itemCount: req.itemCount,
    mode: prefs.mode,
    denylistExtras: prefs.denylistExtras,
  });

  if (verdict.verdict === 'deny') {
    audit(req, 'blocked', verdict.reason);
    return { allowed: false, reason: verdict.reason };
  }

  if (verdict.verdict === 'auto') {
    audit(req, 'auto', verdict.reason);
    return { allowed: true, reason: verdict.reason };
  }

  // verdict === 'prompt' — honour standing grants before bothering the operator.
  const key = grantKey(req);
  if (prefs.allowlist.includes(key)) {
    audit(req, 'allowed', 'Standing "always allow" grant.');
    return { allowed: true, reason: 'Always-allow grant.' };
  }
  if (taskGrants.get(req.taskId)?.has(key)) {
    audit(req, 'allowed', 'Task-scoped grant.');
    return { allowed: true, reason: 'Task-scoped grant.' };
  }

  if (!promptHandler) {
    audit(req, 'denied', 'No approval surface available.');
    return { allowed: false, reason: 'No approval surface available — denied.' };
  }

  const permissionRequest: PermissionRequest = {
    id: randomUUID(),
    title: req.title,
    summary: req.summary,
    preview: req.preview,
    previewKind: req.previewKind,
    tool: req.tool,
    allowAlways: req.allowAlways,
  };

  let choice: PermissionChoice;
  try {
    choice = await promptHandler(permissionRequest);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    audit(req, 'denied', `Approval prompt failed: ${message}`);
    return { allowed: false, reason: 'Approval prompt failed — denied.' };
  }

  if (choice === 'deny') {
    audit(req, 'denied', 'Operator denied.');
    return { allowed: false, reason: 'You denied this action.' };
  }

  if (choice === 'task') {
    let set = taskGrants.get(req.taskId);
    if (!set) {
      set = new Set();
      taskGrants.set(req.taskId, set);
    }
    set.add(key);
  } else if (choice === 'always') {
    const fresh = getPermissionPrefs();
    if (!fresh.allowlist.includes(key)) {
      setPermissionPrefs({ ...fresh, allowlist: [...fresh.allowlist, key] });
    }
  }

  audit(req, 'allowed', `Operator approved (${choice}).`);
  return { allowed: true, reason: 'Operator approved.' };
}

/**
 * Force an approval prompt regardless of mode — used by the computer-use
 * watchdog. Returns true iff the operator allowed it.
 */
export async function forceApproval(req: {
  tool: string;
  title: string;
  summary: string;
  preview: string | null;
  previewKind: 'text' | 'code' | 'diff';
}): Promise<boolean> {
  if (!promptHandler) {
    appendAudit({
      at: Date.now(),
      tool: req.tool,
      summary: req.summary,
      decision: 'denied',
      detail: 'No approval surface available.',
    });
    return false;
  }
  const permissionRequest: PermissionRequest = {
    id: randomUUID(),
    title: req.title,
    summary: req.summary,
    preview: req.preview,
    previewKind: req.previewKind,
    tool: req.tool,
    allowAlways: false,
  };
  let choice: PermissionChoice;
  try {
    choice = await promptHandler(permissionRequest);
  } catch {
    appendAudit({
      at: Date.now(),
      tool: req.tool,
      summary: req.summary,
      decision: 'denied',
      detail: 'Approval prompt failed.',
    });
    return false;
  }
  const allowed = choice !== 'deny';
  appendAudit({
    at: Date.now(),
    tool: req.tool,
    summary: req.summary,
    decision: allowed ? 'allowed' : 'denied',
    detail: `Operator ${allowed ? 'approved' : 'denied'} (${choice}).`,
  });
  return allowed;
}
