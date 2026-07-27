import fs from 'node:fs';
import path from 'node:path';

import { getHost } from './host';

// Single source of truth for Mio's persona + agent-loop rules.
//
// `persona.md` is the unified character sheet (see project root). The chat
// path uses it verbatim as Anthropic's `system` prompt, joined with a
// short runtime appendix that documents the auto-screenshot channel and
// the gesture vocabulary — kept in code because those specs are
// dictated by how the renderer ships gesture events, not by the
// character's voice.
//
// The cycle path uses the same persona plus a small "you are in silent
// observation mode" prefix, then leans on the JSON contract inside the
// markdown itself (`### The format of your private notes`).

const PERSONA_FILE = 'persona.md';

function personaPathCandidates(): string[] {
  const host = getHost();
  if (host.paths.isPackaged) {
    return [path.join(host.paths.resourcesPath, PERSONA_FILE)];
  }
  // Dev: __dirname = <repo>/out/main; persona.md is at the repo root.
  return [
    path.resolve(__dirname, '..', '..', PERSONA_FILE),
    path.resolve(process.cwd(), PERSONA_FILE),
  ];
}

let cached: string | null = null;

export function loadPersonaMarkdown(): string {
  if (cached !== null) return cached;
  for (const candidate of personaPathCandidates()) {
    try {
      if (fs.existsSync(candidate)) {
        cached = fs.readFileSync(candidate, 'utf8');
        return cached;
      }
    } catch (err) {
      console.warn('[persona] failed to read', candidate, err);
    }
  }
  console.error('[persona] persona.md not found in any candidate path');
  cached = '';
  return cached;
}

/**
 * Parse the quoted startup line(s) out of `## On startup`. The persona
 * convention is one 「…」 quote per language — Japanese first (TTS
 * voice), Traditional Chinese second (caption). We pull up to the
 * first two consecutive quotes after the heading so the rest of the
 * section can document tone without being mistaken for spoken text.
 *
 * Legacy single-quote files (one 「…」 only) are handled gracefully:
 * the single line is used for both halves so the existing behavior
 * doesn't break.
 */
export interface StartupLines {
  /** Japanese line, fed to TTS. Empty if persona has no JA half. */
  ja: string;
  /** Traditional Chinese line, displayed as the subtitle. Empty if persona has no ZH half. */
  zh: string;
}

const HEADING_RE = /^##\s+On startup\b/m;
const QUOTE_RE = /「([\s\S]*?)」/g;

export function parseStartupLinesFromPersona(): StartupLines {
  const md = loadPersonaMarkdown();
  const headingIdx = md.search(HEADING_RE);
  if (headingIdx < 0) return { ja: '', zh: '' };
  const rest = md.slice(headingIdx);
  // Limit search to the current section so quotes from the next H2
  // can't leak in if the operator deletes the JA/ZH pair.
  const nextHeadingIdx = rest.slice(2).search(/^##\s+/m);
  const section = nextHeadingIdx < 0 ? rest : rest.slice(0, 2 + nextHeadingIdx);

  const matches: string[] = [];
  for (const m of section.matchAll(QUOTE_RE)) {
    const line = m[1]?.trim();
    if (line) matches.push(line);
    if (matches.length === 2) break;
  }
  if (matches.length === 0) return { ja: '', zh: '' };
  if (matches.length === 1) {
    // Legacy single-line persona: speak and caption the same text.
    return { ja: matches[0]!, zh: matches[0]! };
  }
  return { ja: matches[0]!, zh: matches[1]! };
}

/**
 * @deprecated Prefer {@link parseStartupLinesFromPersona} — returns the
 * Chinese half for backward compatibility with the legacy single-line
 * persona format (the old caption text).
 */
export function parseStartupLineFromPersona(): string {
  const lines = parseStartupLinesFromPersona();
  return lines.zh || lines.ja;
}
