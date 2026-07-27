// Mobile foreground-app sample buffer (Phase M-5.4).
//
// The Android `MioAccessibilityService` pushes `perception.activeApp`
// whenever the phone's foreground app changes (debounced to ≤ 1/s on
// the client). This module keeps ONLY the most recent sample — there
// is no history and nothing touches disk. It answers exactly one
// question: "what app is the user looking at on their phone right
// now, and how fresh is that knowledge?"
//
// The agent loop (`agent.ts > executeAnthropicCycle`) reads this next
// to the desktop foreground-window probe and uses whichever sample is
// fresher for the cycle's "active window" line. A sample older than
// ACTIVE_APP_TTL_MS is treated as "no mobile data" so Mio never cites
// an app the user closed minutes ago.

export interface MobileActiveAppSample {
  packageName: string;
  activityLabel: string;
  /** Mobile-side capture timestamp (epoch ms). */
  ts: number;
  /** Server-side receive timestamp (epoch ms), used for freshness. */
  receivedAt: number;
}

/**
 * How long a foreground-app sample stays trustworthy. Past this the
 * agent loop ignores it — the user has almost certainly moved on.
 */
const ACTIVE_APP_TTL_MS = 60_000;

let latest: MobileActiveAppSample | null = null;

/**
 * Record the newest foreground-app sample from the mobile client.
 * Called by `methods.perceptionActiveApp`.
 */
export function storeMobileActiveApp(input: {
  packageName: string;
  activityLabel: string;
  ts: number;
}): void {
  latest = {
    packageName: input.packageName,
    activityLabel: input.activityLabel,
    ts: input.ts,
    receivedAt: Date.now(),
  };
}

/**
 * Most recent foreground-app sample, or `null` when none has arrived
 * or the last one has aged past `ACTIVE_APP_TTL_MS`.
 */
export function getMostRecentActiveApp(): MobileActiveAppSample | null {
  if (!latest) return null;
  if (Date.now() - latest.receivedAt > ACTIVE_APP_TTL_MS) return null;
  return latest;
}

/** Best-effort reset; for host shutdown / transport teardown / tests. */
export function clearMobileActiveApp(): void {
  latest = null;
}
