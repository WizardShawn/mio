import { spawn } from 'node:child_process';

// Windows-only foreground-window title via PowerShell P/Invoke.
//
// We deliberately do NOT take a dependency on `active-win` here — that
// package ships native bindings whose Electron-rebuild dance is one of
// the most common ways a single-file Electron app turns into a build
// matrix. PowerShell is on every Windows host we ship to, so this stays
// zero-dep and easy to package.
//
// Phase 3 keeps this as a plain helper (used by the chat path for a
// lightweight "what window are you typing into?" hint when an auto
// screenshot fails). Phase 5 will register it as a Claude tool for the
// cycle's cheap "did the active window change?" check that skips a full
// screenshot.

const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue';
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Win {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@;
$h = [Win]::GetForegroundWindow();
if ($h -eq [IntPtr]::Zero) { '' ; exit 0 }
$len = [Win]::GetWindowTextLength($h);
if ($len -le 0) { '' ; exit 0 }
$buf = New-Object System.Text.StringBuilder ($len + 2);
[Win]::GetWindowText($h, $buf, $buf.Capacity) | Out-Null;
$buf.ToString();
`.trim();

const TIMEOUT_MS = 1500;

export async function getActiveWindowTitle(): Promise<string | null> {
  if (process.platform !== 'win32') return null;

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        PS_SCRIPT,
      ],
      { windowsHide: true },
    );

    let stdout = '';
    let stderr = '';

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // child may already be dead — ignore.
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        if (stderr.trim()) {
          console.warn('[activeWindow] powershell stderr', stderr.trim());
        }
        finish(null);
        return;
      }
      const title = stdout.trim();
      finish(title.length > 0 ? title : null);
    });
  });
}
