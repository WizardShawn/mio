import path from 'node:path';

import { chromium, type BrowserContext, type Page } from 'playwright';

import { getHost } from '../host';
import { asString, type ToolContext, type ToolDescriptor } from './types';

// Browser tools — Playwright-backed, all free (read-only category in the
// classifier). Mio drives a real Chromium window like a human.

const NAV_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;
const MAX_PAGE_TEXT = 6000;
const MAX_ELEMENTS = 60;

let pwBrowsersPathConfigured = false;
function configurePlaywrightBrowsersPath(): void {
  if (pwBrowsersPathConfigured) return;
  pwBrowsersPathConfigured = true;
  const host = getHost();
  if (host.paths.isPackaged) {
    // In a packaged build Chromium is shipped as an extraResource at
    // resources/pw-browsers (see electron-builder config). Point
    // Playwright there; its default per-user ms-playwright cache does
    // not exist on an end-user machine. In dev the cache is present,
    // so leave the default untouched.
    process.env['PLAYWRIGHT_BROWSERS_PATH'] = path.join(
      host.paths.resourcesPath,
      'pw-browsers',
    );
  }
}

let context: BrowserContext | null = null;
let page: Page | null = null;

function profileDir(): string {
  return path.join(getHost().paths.userData, 'browser-profile');
}

async function ensurePage(): Promise<Page> {
  if (context && page && !page.isClosed()) return page;
  configurePlaywrightBrowsersPath();
  context = await chromium.launchPersistentContext(profileDir(), {
    headless: false,
    viewport: { width: 1280, height: 800 },
  });
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  const existing = context.pages();
  page = existing.length > 0 && existing[0] ? existing[0] : await context.newPage();
  return page;
}

/** Tear the browser down on app shutdown. */
export async function closeBrowser(): Promise<void> {
  try {
    await context?.close();
  } catch {
    // ignore
  }
  context = null;
  page = null;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface PageElement {
  kind: string;
  text: string;
  selector: string;
}

async function readElements(p: Page): Promise<PageElement[]> {
  return p.evaluate((limit: number) => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const g = globalThis as any;
    const doc = g.document;
    const out: { kind: string; text: string; selector: string }[] = [];
    const cssEscape = (s: string): string =>
      g.CSS && g.CSS.escape ? g.CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
    const selectorFor = (el: any): string => {
      if (el.id) return `#${cssEscape(el.id)}`;
      const name = el.getAttribute('name');
      if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
      const aria = el.getAttribute('aria-label');
      if (aria) return `${el.tagName.toLowerCase()}[aria-label="${aria}"]`;
      return el.tagName.toLowerCase();
    };
    const nodes: any[] = Array.from(
      doc.querySelectorAll('a[href], button, input, textarea, select, [role="button"]'),
    );
    for (const el of nodes) {
      if (out.length >= limit) break;
      if (el.offsetParent === null && el.tagName !== 'INPUT') continue;
      const tag = String(el.tagName).toLowerCase();
      const text =
        (el.innerText || '').trim() ||
        el.getAttribute('placeholder') ||
        el.getAttribute('aria-label') ||
        el.getAttribute('value') ||
        '';
      out.push({
        kind: tag === 'a' ? 'link' : tag,
        text: String(text).slice(0, 80),
        selector: selectorFor(el),
      });
    }
    return out;
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }, MAX_ELEMENTS);
}

const navigateTool: ToolDescriptor = {
  spec: {
    name: 'browser_navigate',
    description:
      'Open a URL in Mio\'s browser (a persistent Chromium window). Returns ' +
      'the page title and URL after load.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http(s) URL.' } },
      required: ['url'],
    },
  },
  async execute(input, ctx) {
    if (ctx.signal.aborted) return 'Cancelled.';
    let url = asString(input['url']);
    if (!url) return 'Error: `url` is required.';
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try {
      const p = await ensurePage();
      await p.goto(url, { waitUntil: 'domcontentloaded' });
      return `Opened ${p.url()}\nTitle: ${await p.title()}`;
    } catch (err) {
      return `Navigation error: ${msg(err)}`;
    }
  },
};

const readTool: ToolDescriptor = {
  spec: {
    name: 'browser_read',
    description:
      'Read the current browser page: title, URL, visible text, and a list ' +
      'of interactive elements (links, buttons, inputs) you can act on.',
    input_schema: { type: 'object', properties: {} },
  },
  async execute(_input, ctx) {
    if (ctx.signal.aborted) return 'Cancelled.';
    if (!page || page.isClosed()) return 'No page open — call browser_navigate first.';
    try {
      const title = await page.title();
      const url = page.url();
      const bodyText = (
        await page.evaluate(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const doc = (globalThis as any).document;
          return doc && doc.body ? String(doc.body.innerText ?? '') : '';
        })
      ).trim();
      const clipped =
        bodyText.length > MAX_PAGE_TEXT
          ? `${bodyText.slice(0, MAX_PAGE_TEXT)}\n… (truncated)`
          : bodyText;
      const elements = await readElements(page);
      const elementList = elements
        .map((e, i) => `  [${i}] ${e.kind}: "${e.text}"  (selector: ${e.selector})`)
        .join('\n');
      return [
        `Title: ${title}`,
        `URL: ${url}`,
        '',
        '--- Page text ---',
        clipped || '(no visible text)',
        '',
        '--- Interactive elements ---',
        elementList || '(none found)',
      ].join('\n');
    } catch (err) {
      return `Read error: ${msg(err)}`;
    }
  },
};

const clickTool: ToolDescriptor = {
  spec: {
    name: 'browser_click',
    description:
      'Click an element on the current page. Provide a CSS `selector` ' +
      '(preferred — from browser_read) or visible `text`.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to click.' },
        text: { type: 'string', description: 'Visible text of the element to click.' },
      },
    },
  },
  async execute(input, ctx) {
    if (ctx.signal.aborted) return 'Cancelled.';
    if (!page || page.isClosed()) return 'No page open — call browser_navigate first.';
    const selector = asString(input['selector']);
    const text = asString(input['text']);
    if (!selector && !text) return 'Error: provide `selector` or `text`.';
    try {
      const locator = selector
        ? page.locator(selector).first()
        : page.getByText(text!, { exact: false }).first();
      await locator.click();
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      return `Clicked ${selector ?? `text "${text}"`}. Now at ${page.url()}.`;
    } catch (err) {
      return `Click error: ${msg(err)}`;
    }
  },
};

const typeTool: ToolDescriptor = {
  spec: {
    name: 'browser_type',
    description:
      'Type text into an input/textarea on the current page. Provide a CSS ' +
      '`selector` (from browser_read) and the `value`. Set `submit` to press Enter.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the field.' },
        value: { type: 'string', description: 'Text to type.' },
        submit: { type: 'boolean', description: 'Press Enter after typing.' },
      },
      required: ['selector', 'value'],
    },
  },
  async execute(input, ctx) {
    if (ctx.signal.aborted) return 'Cancelled.';
    if (!page || page.isClosed()) return 'No page open — call browser_navigate first.';
    const selector = asString(input['selector']);
    const value = typeof input['value'] === 'string' ? (input['value'] as string) : null;
    if (!selector || value === null) return 'Error: `selector` and `value` are required.';
    try {
      const locator = page.locator(selector).first();
      await locator.fill(value);
      if (input['submit'] === true) {
        await locator.press('Enter');
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      }
      return `Typed into ${selector}${input['submit'] === true ? ' and submitted' : ''}.`;
    } catch (err) {
      return `Type error: ${msg(err)}`;
    }
  },
};

export const browserToolDescriptors: ToolDescriptor[] = [
  navigateTool,
  readTool,
  clickTool,
  typeTool,
];
