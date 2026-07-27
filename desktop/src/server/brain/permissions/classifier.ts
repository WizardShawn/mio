import path from 'node:path';

import type { PermissionMode } from '@shared/protocol';

import { getHost } from '../host';
import { auditLogPath } from './auditLog';

// The risk classifier.

export type Verdict = 'auto' | 'prompt' | 'deny';

export interface ClassifyInput {
  tool: string;
  targetPath?: string | undefined;
  command?: string | undefined;
  itemCount?: number | undefined;
  mode: PermissionMode;
  /** Operator-curated extra hard-deny path prefixes. */
  denylistExtras: string[];
}

export interface ClassifyResult {
  verdict: Verdict;
  reason: string;
}

const READ_ONLY_TOOLS = new Set<string>([
  'read_file',
  'list_dir',
  'search_files',
  'web_search',
  'web_fetch',
  'browser_navigate',
  'browser_read',
  'browser_click',
  'browser_type',
]);

const BULK_DELETE_CEILING = 100;

function normalizePrefix(p: string): string {
  return path.normalize(p).replace(/[\\/]+$/, '').toLowerCase();
}

function builtinDenyPrefixes(): string[] {
  const prefixes: string[] = [];
  const env = process.env;
  const push = (v: string | undefined): void => {
    if (v && v.trim().length > 0) prefixes.push(normalizePrefix(v));
  };
  push(env['SystemRoot'] ?? 'C:\\Windows');
  push(env['ProgramFiles'] ?? 'C:\\Program Files');
  push(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)');
  push(path.join(env['ProgramData'] ?? 'C:\\ProgramData', 'Microsoft'));
  // Mio's own install dir + per-user data — she must not rewrite herself.
  try {
    push(getHost().paths.appPath);
  } catch {
    // host not installed yet — skip; the userData entry below still covers config.
  }
  try {
    push(getHost().paths.userData);
  } catch {
    // ignore
  }
  return prefixes;
}

const CREDENTIAL_FRAGMENTS: RegExp[] = [
  /[\\/]\.ssh[\\/]/i,
  /[\\/]\.aws[\\/]credentials/i,
  /[\\/]\.gnupg[\\/]/i,
  /\.kdbx$/i,
  /[\\/]login data$/i,
  /[\\/]appdata[\\/]local[\\/]microsoft[\\/]credentials[\\/]/i,
  /[\\/]appdata[\\/]roaming[\\/]microsoft[\\/]crypto[\\/]/i,
];

export interface HardDenyResult {
  denied: boolean;
  reason: string;
}

export function isHardDeniedPath(
  absPath: string,
  denylistExtras: string[],
): HardDenyResult {
  const norm = normalizePrefix(absPath);
  if (norm === normalizePrefix(auditLogPath())) {
    return { denied: true, reason: 'The audit log cannot be modified by a tool.' };
  }
  for (const frag of CREDENTIAL_FRAGMENTS) {
    if (frag.test(absPath)) {
      return {
        denied: true,
        reason: 'Refusing to touch a credential / key store.',
      };
    }
  }
  const prefixes = [
    ...builtinDenyPrefixes(),
    ...denylistExtras.map(normalizePrefix),
  ];
  for (const prefix of prefixes) {
    if (prefix.length > 0 && (norm === prefix || norm.startsWith(`${prefix}\\`))) {
      return {
        denied: true,
        reason: `"${absPath}" is inside a protected system / app location.`,
      };
    }
  }
  return { denied: false, reason: '' };
}

const CATASTROPHIC_SHELL: Array<{ re: RegExp; reason: string }> = [
  { re: /\bformat\s+[a-z]:/i, reason: 'Refusing to format a drive.' },
  { re: /\bdiskpart\b/i, reason: 'Refusing to run diskpart.' },
  { re: /\bbcdedit\b/i, reason: 'Refusing to modify the boot configuration.' },
  { re: /\bcipher\s+\/w/i, reason: 'Refusing to wipe free disk space.' },
  {
    re: /\breg(\.exe)?\s+(delete|add)\s+"?hk(lm|ey_local_machine)/i,
    reason: 'Refusing to modify the HKLM registry hive.',
  },
  {
    re: /remove-item[\s\S]*-recurse[\s\S]*(c:\\windows|program files)/i,
    reason: 'Refusing a recursive delete of a system folder.',
  },
  {
    re: /\b(rmdir|rd)\s+\/s\b[\s\S]*\b[a-z]:\\?(\s|"|$)/i,
    reason: 'Refusing a recursive delete of a drive root.',
  },
];

function catastrophicShell(command: string): string | null {
  for (const { re, reason } of CATASTROPHIC_SHELL) {
    if (re.test(command)) return reason;
  }
  return null;
}

export function classify(input: ClassifyInput): ClassifyResult {
  const { tool, mode } = input;

  if (READ_ONLY_TOOLS.has(tool)) {
    return { verdict: 'auto', reason: 'Read-only tool.' };
  }

  if (tool === 'start_computer_use') {
    if (mode === 'readonly') {
      return { verdict: 'deny', reason: 'Read-only mode — computer use is disabled.' };
    }
    return { verdict: 'prompt', reason: 'Computer use needs your approval to start.' };
  }

  if (input.targetPath) {
    const denied = isHardDeniedPath(input.targetPath, input.denylistExtras);
    if (denied.denied) return { verdict: 'deny', reason: denied.reason };
  }
  if (tool === 'run_command' && input.command) {
    const cat = catastrophicShell(input.command);
    if (cat) return { verdict: 'deny', reason: cat };
  }
  if (tool === 'delete_path' && (input.itemCount ?? 0) > BULK_DELETE_CEILING) {
    return {
      verdict: 'deny',
      reason: `Refusing to delete ${input.itemCount} items at once (ceiling ${BULK_DELETE_CEILING}).`,
    };
  }

  if (mode === 'readonly') {
    return { verdict: 'deny', reason: 'Read-only mode — mutating tools are disabled.' };
  }
  if (mode === 'autopilot') {
    return { verdict: 'auto', reason: 'Autopilot mode.' };
  }
  return { verdict: 'prompt', reason: 'This action changes your machine.' };
}
