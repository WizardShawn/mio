import type { ImageOverlayApi, ImageOverlayPayload } from '@shared/ipc';

// Phase 10 — renderer for the generated-image overlay window. Reads
// pushes from main via the contextBridge-exposed `imageOverlayApi`,
// paints the image + intent caption + action row, and reports its
// final rendered size so main can size the frameless window to fit.

declare global {
  interface Window {
    imageOverlayApi: ImageOverlayApi;
  }
}

const cardEl = document.getElementById('card') as HTMLDivElement;
const imgEl = document.getElementById('img') as HTMLImageElement;
const intentEl = document.getElementById('intent') as HTMLDivElement;
const btnCloseEl = document.getElementById('btn-close') as HTMLButtonElement;
const btnCopyEl = document.getElementById('btn-copy') as HTMLButtonElement;
const btnOpenEl = document.getElementById('btn-open') as HTMLButtonElement;
const btnRevealEl = document.getElementById('btn-reveal') as HTMLButtonElement;

let currentAbsPath: string | null = null;

/**
 * Tell main how big our card actually rendered, so it can resize the
 * frameless window to match. We add the 8px body padding (top + bottom,
 * left + right) so the drop-shadow isn't clipped.
 */
function reportSize(): void {
  const rect = cardEl.getBoundingClientRect();
  const width = Math.ceil(rect.width) + 16;
  const height = Math.ceil(rect.height) + 16;
  window.imageOverlayApi.resize(width, height);
}

function show(payload: ImageOverlayPayload): void {
  currentAbsPath = payload.absPath;
  imgEl.src = payload.dataUrl;
  imgEl.alt = payload.intent ?? payload.sourcePrompt ?? 'Generated image';

  if (payload.intent && payload.intent.trim().length > 0) {
    intentEl.textContent = payload.intent;
    intentEl.hidden = false;
  } else {
    intentEl.textContent = '';
    intentEl.hidden = true;
  }

  cardEl.hidden = false;

  // The image is a data URL, so it usually decodes synchronously; but
  // the first paint after `cardEl.hidden = false` still happens after
  // a tick. Report the size both immediately (so main can place the
  // window) and after decode (in case the actual rendered image
  // changed the card's natural height).
  reportSize();
  imgEl
    .decode()
    .then(() => reportSize())
    .catch(() => undefined);
}

function dismissSelf(): void {
  currentAbsPath = null;
  cardEl.hidden = true;
  window.imageOverlayApi.dismiss();
}

btnCloseEl.addEventListener('click', (e) => {
  e.preventDefault();
  dismissSelf();
});

btnCopyEl.addEventListener('click', (e) => {
  e.preventDefault();
  if (currentAbsPath) window.imageOverlayApi.copy(currentAbsPath);
});

btnOpenEl.addEventListener('click', (e) => {
  e.preventDefault();
  if (currentAbsPath) window.imageOverlayApi.open(currentAbsPath);
});

btnRevealEl.addEventListener('click', (e) => {
  e.preventDefault();
  if (currentAbsPath) window.imageOverlayApi.reveal(currentAbsPath);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    dismissSelf();
  }
});

// Re-measure on resize (image scaling, font load, etc.) so an animation
// or late-loading asset doesn't leave the frameless window clipped.
window.addEventListener('resize', () => {
  if (!cardEl.hidden) reportSize();
});

window.imageOverlayApi.onShow(show);
