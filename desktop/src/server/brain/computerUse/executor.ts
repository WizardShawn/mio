import { spawn } from 'node:child_process';

import { getHost } from '../host';

// Computer-use input synthesis via PowerShell P/Invoke. No native module.

const PS_TIMEOUT_MS = 8000;

const CSHARP = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class CU {',
  '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
  '  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, IntPtr e);',
  '}',
].join('\n');

const MOUSE = {
  leftDown: 0x0002,
  leftUp: 0x0004,
  rightDown: 0x0008,
  rightUp: 0x0010,
  middleDown: 0x0020,
  middleUp: 0x0040,
  wheel: 0x0800,
};

let shotWidth = 0;
let shotHeight = 0;

/** Tell the executor the dimensions of the screenshot the model is seeing. */
export function setCoordinateSpace(width: number, height: number): void {
  shotWidth = width;
  shotHeight = height;
}

/** Map a model-space (screenshot) point to primary-display logical pixels. */
export function toScreen(x: number, y: number): { x: number; y: number } {
  const info = getHost().computer.getPrimaryDisplayInfo();
  if (shotWidth <= 0 || shotHeight <= 0) {
    return { x: Math.round(x), y: Math.round(y) };
  }
  return {
    x: Math.round((x / shotWidth) * info.width),
    y: Math.round((y / shotHeight) * info.height),
  };
}

function runPs(body: string): Promise<void> {
  const script = `$ErrorActionPreference='SilentlyContinue';\nAdd-Type @"\n${CSHARP}\n"@;\n${body}`;
  return new Promise<void>((resolve) => {
    let settled = false;
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true },
    );
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      finish();
    }, PS_TIMEOUT_MS);
    child.on('error', finish);
    child.on('close', finish);
  });
}

function psQuote(text: string): string {
  return text.replace(/'/g, "''");
}

function sendKeysEscape(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch === '\n' || ch === '\r') out += '{ENTER}';
    else if ('+^%~(){}[]'.includes(ch)) out += `{${ch}}`;
    else out += ch;
  }
  return out;
}

const KEY_NAMES: Record<string, string> = {
  return: '{ENTER}',
  enter: '{ENTER}',
  tab: '{TAB}',
  escape: '{ESC}',
  esc: '{ESC}',
  backspace: '{BACKSPACE}',
  delete: '{DELETE}',
  space: ' ',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}',
  home: '{HOME}',
  end: '{END}',
  page_up: '{PGUP}',
  page_down: '{PGDN}',
  prior: '{PGUP}',
  next: '{PGDN}',
};

const MODIFIERS: Record<string, string> = {
  ctrl: '^',
  control: '^',
  alt: '%',
  shift: '+',
};

function keyToSendKeys(spec: string): string {
  const parts = spec.split('+').map((p) => p.trim().toLowerCase());
  let prefix = '';
  let main = '';
  for (const part of parts) {
    if (MODIFIERS[part]) {
      prefix += MODIFIERS[part];
    } else if (KEY_NAMES[part]) {
      main = KEY_NAMES[part];
    } else if (/^f([1-9]|1[0-2])$/.test(part)) {
      main = `{${part.toUpperCase()}}`;
    } else if (part.length === 1) {
      main = part;
    } else {
      main = `{${part.toUpperCase()}}`;
    }
  }
  return prefix + main;
}

function withSendKeys(escaped: string): string {
  return [
    "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');",
    `[System.Windows.Forms.SendKeys]::SendWait('${psQuote(escaped)}');`,
  ].join('\n');
}

export async function moveMouse(x: number, y: number): Promise<void> {
  const p = toScreen(x, y);
  await runPs(`[CU]::SetCursorPos(${p.x}, ${p.y});`);
}

export async function clickMouse(
  x: number,
  y: number,
  button: 'left' | 'right' | 'middle' = 'left',
  double = false,
): Promise<void> {
  const p = toScreen(x, y);
  const down = button === 'right' ? MOUSE.rightDown : button === 'middle' ? MOUSE.middleDown : MOUSE.leftDown;
  const up = button === 'right' ? MOUSE.rightUp : button === 'middle' ? MOUSE.middleUp : MOUSE.leftUp;
  const oneClick = `[CU]::mouse_event(${down},0,0,0,[IntPtr]::Zero);[CU]::mouse_event(${up},0,0,0,[IntPtr]::Zero);`;
  await runPs(
    `[CU]::SetCursorPos(${p.x}, ${p.y});Start-Sleep -Milliseconds 40;${oneClick}${double ? oneClick : ''}`,
  );
}

export async function dragMouse(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Promise<void> {
  const a = toScreen(x1, y1);
  const b = toScreen(x2, y2);
  await runPs(
    [
      `[CU]::SetCursorPos(${a.x}, ${a.y});Start-Sleep -Milliseconds 40;`,
      `[CU]::mouse_event(${MOUSE.leftDown},0,0,0,[IntPtr]::Zero);Start-Sleep -Milliseconds 60;`,
      `[CU]::SetCursorPos(${b.x}, ${b.y});Start-Sleep -Milliseconds 60;`,
      `[CU]::mouse_event(${MOUSE.leftUp},0,0,0,[IntPtr]::Zero);`,
    ].join(''),
  );
}

export async function scrollMouse(
  x: number,
  y: number,
  direction: 'up' | 'down',
  clicks = 3,
): Promise<void> {
  const p = toScreen(x, y);
  const delta = (direction === 'up' ? 120 : -120) * Math.max(1, clicks);
  await runPs(
    `[CU]::SetCursorPos(${p.x}, ${p.y});[CU]::mouse_event(${MOUSE.wheel},0,0,${delta},[IntPtr]::Zero);`,
  );
}

export async function typeText(text: string): Promise<void> {
  if (!text) return;
  await runPs(withSendKeys(sendKeysEscape(text)));
}

export async function pressKey(spec: string): Promise<void> {
  if (!spec) return;
  await runPs(withSendKeys(keyToSendKeys(spec)));
}
