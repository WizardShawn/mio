import { spawn } from 'node:child_process';
import fs from 'node:fs';

import { requestPermission } from '../permissions/gate';
import { asString, type ToolContext, type ToolDescriptor } from './types';

// Shell tool. Always gated — `run_command` is the single most powerful
// thing Mio can do.

const COMMAND_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_CHARS = 12_000;
const PERMISSION_SUMMARY_MAX = 220;

function scopeOf(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? command.trim();
  return first.toLowerCase();
}

function clipOutput(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (${text.length - MAX_OUTPUT_CHARS} more chars truncated)`
    : text;
}

function permissionSummaryForCommand(command: string): string {
  const t = command.trim();
  if (t.length <= PERMISSION_SUMMARY_MAX) {
    return `Run: ${t}`;
  }
  const head = t.slice(0, PERMISSION_SUMMARY_MAX);
  return `Run: ${head}… (${t.length} chars — full script in preview below)`;
}

const runCommandTool: ToolDescriptor = {
  spec: {
    name: 'run_command',
    description:
      'Run a shell command and return its combined stdout/stderr. Runs in ' +
      'the workspace folder. Requires the operator\'s approval.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command line to run.' },
      },
      required: ['command'],
    },
  },
  async execute(input, ctx) {
    const command = asString(input['command']);
    if (!command) return 'Error: `command` is required.';

    const gate = await requestPermission({
      tool: 'run_command',
      title: 'Mio wants to run a command',
      summary: permissionSummaryForCommand(command),
      preview: command,
      previewKind: 'code',
      command,
      scopeKey: scopeOf(command),
      allowAlways: true,
      taskId: ctx.taskId,
    });
    if (!gate.allowed) return `Denied: ${gate.reason}`;

    const cwd = fs.existsSync(ctx.workspacePath) ? ctx.workspacePath : process.cwd();

    return new Promise<string>((resolve) => {
      let settled = false;
      const child = spawn(command, {
        shell: true,
        cwd,
        windowsHide: true,
      });
      let out = '';
      const finish = (text: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        resolve(text);
      };
      const onAbort = (): void => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        finish(`${clipOutput(out)}\n\n(command cancelled)`);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        finish(`${clipOutput(out)}\n\n(timed out after ${COMMAND_TIMEOUT_MS / 1000}s)`);
      }, COMMAND_TIMEOUT_MS);

      ctx.signal.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      child.stderr.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      child.on('error', (err) => {
        finish(`Failed to start command: ${err.message}`);
      });
      child.on('close', (code) => {
        const body = clipOutput(out.trim().length > 0 ? out.trim() : '(no output)');
        finish(`exit code ${code ?? 'unknown'}\n\n${body}`);
      });
    });
  },
};

export const shellToolDescriptor: ToolDescriptor = runCommandTool;
