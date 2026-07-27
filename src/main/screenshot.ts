import { desktopCapturer, screen, type NativeImage } from 'electron';

// Phase 3 screenshot tool.
//
// Two callers in v1:
//   • Chat: every user turn auto-attaches a fresh screenshot (transient —
//     it's added to the API request but NOT persisted in chat history, so
//     the next turn doesn't pay tokens for a stale frame).
//   • Phase 5 agent loop will reuse the same capture for periodic
//     perception cycles.
//
// We capture only the primary display by default. Multi-monitor "all"
// option is plumbed through `captureScreens` but unused in chat — the
// per-monitor capture is a Phase 5/v2 toggle so a single turn doesn't
// silently 3× the vision-token cost on a triple-head setup.

export interface CapturedImage {
  /** Anthropic image-block media type; we emit JPEG to keep payloads small. */
  mediaType: 'image/jpeg';
  /** Base64-encoded image bytes (no `data:` prefix). */
  data: string;
  /** Final pixel dimensions of the encoded image. Useful for telemetry. */
  width: number;
  height: number;
  /** Electron `Display.id` we captured (primary monitor by default). */
  displayId: number;
}

// Claude bills vision at roughly `(width × height) / 750` tokens; a
// 1568×980 frame is ~`2,049` tokens, a 1280×800 frame is ~`1,365`
// tokens, and a 1024×640 frame is ~`875` tokens. The model's vision
// pipeline auto-downscales anything above 1568 px, so the old cap
// only saved tokens *up to* that ceiling.
//
// Phase-5 lowers the longest-dimension cap to 1280 px because:
//   - UI text on a typical 16:10 desktop downscaled to 1280×800 is
//     still readable (Mio uses this image for "what app / file is on
//     screen?" answers, not OCR-grade reads).
//   - The savings are real: ~`$0.020` per image per call vs. the
//     prior 1568 cap, and the image re-bills on every tool round.
//   - Operators who genuinely need higher resolution for a
//     screenshot-driven task (e.g. reading a small font in a code
//     review) can drop in a manual image via the camera button or
//     drag-drop — that path is unchanged.
//
// Drop further (e.g. 1024) if the cost meter still shows vision
// dominating after Phases 2/4; UI text starts getting fuzzy below
// ~1100 on a 16:10 display.
const MAX_DIMENSION_PX = 1280;

// JPEG quality picked to stay readable for code/UI text without
// exploding the base64 payload. At 1280×800 with q=75 a desktop
// screenshot lands around 150–220 KB → ~300 KB of base64 in the
// request body, well within Claude's 5 MB image limit.
const JPEG_QUALITY = 75;

function resizeToFit(image: NativeImage, maxDim: number): NativeImage {
  const { width, height } = image.getSize();
  const longest = Math.max(width, height);
  if (longest <= maxDim) return image;
  const scale = maxDim / longest;
  return image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'good',
  });
}

async function captureDisplay(
  display: Electron.Display,
): Promise<CapturedImage | null> {
  // desktopCapturer wants PHYSICAL pixels in thumbnailSize. `display.size`
  // is in logical pixels — multiply by scaleFactor so a HiDPI laptop still
  // hands back a sharp frame instead of a blurry upscale.
  const physicalWidth = Math.round(display.size.width * display.scaleFactor);
  const physicalHeight = Math.round(display.size.height * display.scaleFactor);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: physicalWidth, height: physicalHeight },
    fetchWindowIcons: false,
  });

  if (sources.length === 0) return null;

  // `Source.display_id` is a string when present; match against the
  // Display we're targeting. Falls back to the first source when the
  // host platform doesn't tag display ids on the source (Electron
  // doesn't guarantee it on every Windows version).
  const targetId = String(display.id);
  const source =
    sources.find((s) => s.display_id === targetId) ?? sources[0]!;

  const downscaled = resizeToFit(source.thumbnail, MAX_DIMENSION_PX);
  if (downscaled.isEmpty()) return null;

  const buf = downscaled.toJPEG(JPEG_QUALITY);
  const { width, height } = downscaled.getSize();

  return {
    mediaType: 'image/jpeg',
    data: buf.toString('base64'),
    width,
    height,
    displayId: display.id,
  };
}

/**
 * Capture the primary display as a Claude-ready image block payload.
 * Returns null on any failure (no displays, capture stream denied, etc.)
 * — callers should treat the screenshot as best-effort and never block
 * the user's turn on it.
 */
export async function capturePrimaryScreen(): Promise<CapturedImage | null> {
  try {
    const primary = screen.getPrimaryDisplay();
    return await captureDisplay(primary);
  } catch (err) {
    console.error('[screenshot] capture failed', err);
    return null;
  }
}

/**
 * Capture every connected display. Reserved for the v2 "all monitors"
 * toggle and the Phase 5 cycle's optional wide-perception mode; chat
 * uses `capturePrimaryScreen` exclusively.
 */
export async function captureAllScreens(): Promise<CapturedImage[]> {
  try {
    const displays = screen.getAllDisplays();
    const captures = await Promise.all(displays.map(captureDisplay));
    return captures.filter((c): c is CapturedImage => c !== null);
  } catch (err) {
    console.error('[screenshot] multi-capture failed', err);
    return [];
  }
}
