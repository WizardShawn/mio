import type {
  ComputerUseStatus,
  PermissionApi,
  PermissionChoice,
  PermissionRequest,
} from '@shared/ipc';

declare global {
  interface Window {
    permissionApi: PermissionApi;
  }
}

const cardEl = document.getElementById('card') as HTMLDivElement;
const promptEl = document.getElementById('prompt') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const titleEl = document.getElementById('prompt-title') as HTMLHeadingElement;
const summaryEl = document.getElementById('prompt-summary') as HTMLParagraphElement;
const previewEl = document.getElementById('prompt-preview') as HTMLPreElement;
const buttonsEl = promptEl.querySelector('.pbuttons') as HTMLDivElement;
const btnDeny = document.getElementById('btn-deny') as HTMLButtonElement;
const btnOnce = document.getElementById('btn-once') as HTMLButtonElement;
const btnTask = document.getElementById('btn-task') as HTMLButtonElement;
const btnAlways = document.getElementById('btn-always') as HTMLButtonElement;
const statusLabelEl = document.getElementById('status-label') as HTMLSpanElement;
const statusStepEl = document.getElementById('status-step') as HTMLSpanElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;

let activeRequestId: string | null = null;

/** Tell main how tall our content is so it can size the frameless window. */
function reportHeight(): void {
  // 8px body padding top + bottom around the card.
  window.permissionApi.resize(Math.ceil(cardEl.getBoundingClientRect().height) + 16);
}

/** Render a diff preview into the <pre>, tinting the +/- header lines. */
function renderPreview(text: string, kind: PermissionRequest['previewKind']): void {
  previewEl.replaceChildren();
  if (kind === 'diff') {
    for (const line of text.split('\n')) {
      const span = document.createElement('span');
      span.textContent = `${line}\n`;
      if (line.startsWith('---')) span.className = 'diff-del';
      else if (line.startsWith('+++')) span.className = 'diff-add';
      previewEl.appendChild(span);
    }
  } else {
    previewEl.textContent = text;
  }
}

function showPrompt(req: PermissionRequest): void {
  activeRequestId = req.id;
  statusEl.hidden = true;
  promptEl.hidden = false;

  titleEl.textContent = req.title;
  summaryEl.textContent = req.summary;

  if (req.preview && req.preview.trim().length > 0) {
    previewEl.hidden = false;
    renderPreview(req.preview, req.previewKind);
  } else {
    previewEl.hidden = true;
    previewEl.replaceChildren();
  }

  // "Always allow" is only offered for tools that take a stable scope
  // key (file writes, shell). Deletes / computer-use sessions don't.
  btnAlways.hidden = !req.allowAlways;
  buttonsEl.classList.toggle('no-always', !req.allowAlways);

  reportHeight();
}

function resolve(choice: PermissionChoice): void {
  if (!activeRequestId) return;
  window.permissionApi.respond({ id: activeRequestId, choice });
  activeRequestId = null;
}

function showStatus(status: ComputerUseStatus): void {
  if (!status.active) {
    statusEl.hidden = true;
    return;
  }
  promptEl.hidden = true;
  statusEl.hidden = false;
  statusLabelEl.textContent = status.label;
  statusStepEl.textContent =
    status.maxSteps > 0 ? `step ${status.step} / ${status.maxSteps}` : '';
  reportHeight();
}

btnDeny.addEventListener('click', () => resolve('deny'));
btnOnce.addEventListener('click', () => resolve('once'));
btnTask.addEventListener('click', () => resolve('task'));
btnAlways.addEventListener('click', () => resolve('always'));
btnStop.addEventListener('click', () => window.permissionApi.stop());

// Esc always denies the pending prompt — the safe default.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && activeRequestId) {
    e.preventDefault();
    resolve('deny');
  }
});

window.permissionApi.onRequest(showPrompt);
window.permissionApi.onStatus(showStatus);
