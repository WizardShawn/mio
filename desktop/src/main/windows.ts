import { BrowserWindow, screen } from 'electron';
import path from 'node:path';

// Base design sizes, tuned for a 1080p work area. The avatar renderer
// frames the VRM so her feet land at the BOTTOM EDGE of the avatar
// window; the chat surface (caption + input pills) is a separate
// transparent window anchored directly under that edge.
//
// On smaller or DPI-scaled displays the whole avatar + chat strip is
// scaled down uniformly (see `computeLayout`) so the chat surface
// always lands cleanly under her feet instead of overlapping them.
const BASE_AVATAR_WIDTH = 560;
const BASE_AVATAR_HEIGHT = 800;
const BASE_CHAT_WIDTH = 392;
const BASE_CHAT_HEIGHT = 168;
const AVATAR_MARGIN = 16;

interface LayoutDims {
  /** Uniform scale applied to both windows (≤ 1, never upscales). */
  scale: number;
  avatarW: number;
  avatarH: number;
  chatW: number;
  chatH: number;
}

/**
 * Scale the avatar + chat strip so it always fits the display's work
 * area height. The avatar's feet sit at the bottom edge of the avatar
 * window and the chat strip extends `chatH` below that, so the strip
 * needs `avatarH + chatH + 2·margin` of vertical room. When the work
 * area is shorter than the 1080p design target we scale everything
 * down rather than letting the chat ride up over her feet.
 */
function computeLayout(workArea: Electron.Rectangle): LayoutDims {
  const designHeight = BASE_AVATAR_HEIGHT + BASE_CHAT_HEIGHT;
  const avail = workArea.height - AVATAR_MARGIN * 2;
  const scale = Math.min(1, Math.max(0.5, avail / designHeight));
  return {
    scale,
    avatarW: Math.round(BASE_AVATAR_WIDTH * scale),
    avatarH: Math.round(BASE_AVATAR_HEIGHT * scale),
    chatW: Math.round(BASE_CHAT_WIDTH * scale),
    chatH: Math.round(BASE_CHAT_HEIGHT * scale),
  };
}

const SETTINGS_WIDTH = 620;
const SETTINGS_HEIGHT = 480;

// Custom tray-menu popup — sized to fit the 4 items + header. Includes
// 6px breathing room on each side so the drop-shadow on the menu card
// isn't clipped by the BrowserWindow edges (see renderer/menu/style.css).
const MENU_WIDTH = 230;
const MENU_HEIGHT = 224;

// Permission approval popup — fixed width, height driven by the
// renderer (it measures its glass card and reports back). 380px card +
// 8px shadow padding on each side.
const PERMISSION_WIDTH = 396;
const PERMISSION_HEIGHT = 220;
const PERMISSION_MIN_HEIGHT = 96;
const PERMISSION_MAX_HEIGHT = 540;

// Phase 10 — generated image overlay. Frameless transparent window
// that sits to the left of the avatar so the image is visible while
// Mio speaks. Renderer reports its measured card size so we resize
// the window to fit any aspect ratio (16:9 lands wide, 9:16 lands
// tall). Defaults are sized for a 16:9 image at the default 512px
// long-edge — see `positionImageOverlayWindow`.
const IMAGE_OVERLAY_DEFAULT_WIDTH = 420;
const IMAGE_OVERLAY_DEFAULT_HEIGHT = 360;
const IMAGE_OVERLAY_MIN_WIDTH = 280;
const IMAGE_OVERLAY_MIN_HEIGHT = 220;
const IMAGE_OVERLAY_MAX_WIDTH = 720;
const IMAGE_OVERLAY_MAX_HEIGHT = 720;
const IMAGE_OVERLAY_GAP_PX = 12;

type RendererName =
  | 'avatar'
  | 'chat'
  | 'settings'
  | 'menu'
  | 'permission'
  | 'imageOverlay';

/** Windows / focus churn can demote HWND_TOPMOST; re-apply + moveTop in stack order. */
const ASSISTANT_ALWAYS_ON_TOP_LEVEL = 'screen-saver' as const;

export interface AssistantZStack {
  avatar: BrowserWindow;
  chat: BrowserWindow;
  permission: BrowserWindow | null;
  menu: BrowserWindow | null;
  imageOverlay: BrowserWindow | null;
}

function pinTopMost(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.setAlwaysOnTop(true, ASSISTANT_ALWAYS_ON_TOP_LEVEL);
  win.moveTop();
}

/**
 * Reassert always-on-top for the assistant surfaces. Call in bottom-to-top order
 * so the avatar stays above the chat (see stacking note in positionChatUnderAvatar)
 * while transient popups (menu / permission) remain clickable above her.
 */
export function refreshAssistantZOrder(stack: AssistantZStack): void {
  pinTopMost(stack.chat);
  pinTopMost(stack.avatar);
  if (stack.imageOverlay && !stack.imageOverlay.isDestroyed() && stack.imageOverlay.isVisible()) {
    pinTopMost(stack.imageOverlay);
  }
  if (stack.menu && !stack.menu.isDestroyed() && stack.menu.isVisible()) {
    pinTopMost(stack.menu);
  }
  if (stack.permission && !stack.permission.isDestroyed() && stack.permission.isVisible()) {
    pinTopMost(stack.permission);
  }
}

let assistantZStackForRefresh: AssistantZStack | null = null;

/** Re-pin using the stack registered by {@link wireAssistantGlobalTop} (menu / permission / image overlay). */
export function refreshRegisteredAssistantZOrder(): void {
  if (assistantZStackForRefresh) refreshAssistantZOrder(assistantZStackForRefresh);
}

/** Keeps the assistant above newly focused normal apps without fighting transient UI. */
export function wireAssistantGlobalTop(stack: AssistantZStack): void {
  assistantZStackForRefresh = stack;
  const scheduleRefresh = (): void => refreshAssistantZOrder(stack);

  const attach = (win: BrowserWindow): void => {
    win.on('blur', scheduleRefresh);
    win.on('show', scheduleRefresh);
  };

  attach(stack.avatar);
  attach(stack.chat);

  // Periodic fallback — some fullscreen / overlay apps bypass a single blur edge.
  const intervalMs = 2500;
  const id = setInterval(scheduleRefresh, intervalMs);
  const stopInterval = (): void => clearInterval(id);
  stack.avatar.once('closed', stopInterval);
  stack.chat.once('closed', stopInterval);
}

const isDev = !!process.env['ELECTRON_RENDERER_URL'];

function preloadPath(name: RendererName): string {
  // electron-vite outputs preload bundles as cjs at out/preload/<name>.js
  return path.join(__dirname, '..', 'preload', `${name}.js`);
}

function rendererUrl(name: RendererName): string {
  // electron-vite sets renderer root to `src/renderer`, so relative paths
  // collapse to `<name>/index.html` in both dev and prod builds.
  const devBase = process.env['ELECTRON_RENDERER_URL'];
  if (devBase) {
    return `${devBase}/${name}/index.html`;
  }
  return `file://${path.join(__dirname, '..', 'renderer', name, 'index.html').replace(/\\/g, '/')}`;
}

export interface AppWindows {
  avatar: BrowserWindow;
  chat: BrowserWindow;
}

export function createAvatarWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  const L = computeLayout(workArea);
  const x = workArea.x + workArea.width - L.avatarW - AVATAR_MARGIN;
  // Anchor so the chat surface (which begins at the avatar's feet =
  // the avatar window's bottom edge) still fits inside the work area.
  // `computeLayout` already scaled the windows so `avatarH + chatH`
  // fits with margin to spare; this just places the strip flush to the
  // bottom of the work area.
  const idealY = workArea.y + workArea.height - L.avatarH - L.chatH;
  const y = Math.max(workArea.y + AVATAR_MARGIN, idealY);

  const iconPath = path.join(__dirname, '../../build/icon.png');

  const win = new BrowserWindow({
    width: L.avatarW,
    height: L.avatarH,
    x,
    y,
    icon: iconPath,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath('avatar'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, ASSISTANT_ALWAYS_ON_TOP_LEVEL);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.removeMenu();

  // Start fully click-through: the avatar window is a large transparent
  // overlay, and only the pixels actually covered by her body should
  // catch clicks. The renderer (avatar/main.ts) flips this off while the
  // cursor is over the avatar (or Alt is held for a window drag) and
  // back on over empty space. `forward: true` keeps mouse-move events
  // flowing to the renderer so it can do that hit-testing.
  win.setIgnoreMouseEvents(true, { forward: true });

  win.once('ready-to-show', () => {
    win.show();
  });

  void win.loadURL(rendererUrl('avatar'));

  if (isDev) {
    // Keep devtools detached so they don't steal the transparent canvas.
    win.webContents.on('before-input-event', (event, input) => {
      if (input.control && input.shift && input.key.toLowerCase() === 'i') {
        win.webContents.openDevTools({ mode: 'detach' });
        event.preventDefault();
      }
    });
  }

  return win;
}

export function createChatWindow(avatarWin: BrowserWindow): BrowserWindow {
  // Chat surface is always visible (anchored under the avatar's feet).
  // It only loses focus, never visibility — so users always know where
  // to type. The window itself stays click-through-friendly via its
  // transparent areas: only the pills inside it actually catch clicks.
  const L = computeLayout(screen.getPrimaryDisplay().workArea);
  const win = new BrowserWindow({
    width: L.chatW,
    height: L.chatH,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath('chat'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, ASSISTANT_ALWAYS_ON_TOP_LEVEL);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.removeMenu();

  // Start click-through, same as the avatar window — only the chat
  // pills (caption / input) should catch clicks; the transparent gaps
  // around them pass clicks to whatever is underneath. The renderer
  // (chat/main.ts) flips this off while the cursor is over a pill.
  win.setIgnoreMouseEvents(true, { forward: true });

  // On smaller / DPI-scaled displays the chat window is scaled down
  // (see computeLayout). Zoom the renderer by the same factor so the
  // pills shrink to fit instead of overflowing the window.
  if (L.scale !== 1) {
    win.webContents.on('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.setZoomFactor(L.scale);
    });
  }

  // Anchor under the avatar's feet immediately on creation; the avatar
  // window's ready-to-show fires independently, but both bounds are
  // deterministic so we can place the chat without waiting for the
  // avatar's first paint.
  positionChatUnderAvatar(win, avatarWin);

  const iconPath = path.join(__dirname, '../../build/icon.png');
  win.setIcon(iconPath);

  // Keep the chat surface glued to the avatar if the user drags her
  // around the desktop.
  avatarWin.on('move', () => positionChatUnderAvatar(win, avatarWin));
  avatarWin.on('moved', () => positionChatUnderAvatar(win, avatarWin));

  win.once('ready-to-show', () => {
    // showInactive (not show) so the chat surface paints under the
    // avatar's feet without stealing OS focus from the avatar. Stealing
    // focus would put the chat into a state where the renderer's focus
    // handler runs before the user has summoned the input pill.
    win.showInactive();
  });

  void win.loadURL(rendererUrl('chat'));

  if (isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.control && input.shift && input.key.toLowerCase() === 'i') {
        win.webContents.openDevTools({ mode: 'detach' });
        event.preventDefault();
      }
    });
  }

  return win;
}

function positionChatUnderAvatar(
  chat: BrowserWindow,
  avatar: BrowserWindow,
): void {
  const display = screen.getPrimaryDisplay();
  const { workArea, bounds } = display;
  const L = computeLayout(workArea);
  const avatarBounds = avatar.getBounds();

  let x =
    avatarBounds.x + Math.floor((avatarBounds.width - L.chatW) / 2);
  // The avatar renderer frames her feet at the bottom edge of the
  // avatar window, so the chat strip simply begins there.
  let y = avatarBounds.y + avatarBounds.height;

  // Keep the chat inside the physical display. `computeLayout` already
  // scaled the strip so it fits the work area, so this clamp only
  // fires in the rare case the avatar was dragged partly off-screen.
  const displayBottom = bounds.y + bounds.height;
  if (y + L.chatH > displayBottom) {
    y = displayBottom - L.chatH;
  }
  if (x < workArea.x + AVATAR_MARGIN) x = workArea.x + AVATAR_MARGIN;
  if (x + L.chatW > workArea.x + workArea.width - AVATAR_MARGIN) {
    x = workArea.x + workArea.width - L.chatW - AVATAR_MARGIN;
  }

  chat.setBounds({ x, y, width: L.chatW, height: L.chatH });
}

export function showChatNearAvatar(
  chat: BrowserWindow,
  avatar: BrowserWindow,
): void {
  // The chat surface is already always-visible and pinned under the
  // avatar's feet — the hotkey just needs to re-anchor it (in case the
  // user dragged the avatar) and pull focus so the input pill catches
  // keystrokes.
  positionChatUnderAvatar(chat, avatar);
  if (!chat.isVisible()) chat.show();
  chat.focus();
}

// ---------- Settings window ----------
//
// The settings surface is the one place we deliberately allow normal app
// chrome — it's a rare-access window for managing the Anthropic key, and
// later for cycle interval / hotkey / caps. Opened from the tray menu only.

let settingsWin: BrowserWindow | null = null;

export function openSettingsWindow(): BrowserWindow {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (!settingsWin.isVisible()) settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }

  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  const x = workArea.x + Math.floor((workArea.width - SETTINGS_WIDTH) / 2);
  const y = workArea.y + Math.floor((workArea.height - SETTINGS_HEIGHT) / 2);

  const iconPath = path.join(__dirname, '../../build/icon.png');

  const win = new BrowserWindow({
    width: SETTINGS_WIDTH,
    height: SETTINGS_HEIGHT,
    x,
    y,
    icon: iconPath,
    title: 'Mio — Settings',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    show: false,
    backgroundColor: '#12141b',
    webPreferences: {
      preload: preloadPath('settings'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  win.removeMenu();
  void win.loadURL(rendererUrl('settings'));

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  win.on('closed', () => {
    settingsWin = null;
  });

  if (isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.control && input.shift && input.key.toLowerCase() === 'i') {
        win.webContents.openDevTools({ mode: 'detach' });
        event.preventDefault();
      }
    });
  }

  settingsWin = win;
  return win;
}

export function closeSettingsWindow(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.close();
  }
}

// ---------- Tray menu popup ----------
//
// Replaces Electron's native Tray context menu with a custom HTML
// popup so we can actually style it (the native menu inherits the OS
// look and ignores CSS entirely). Built once at bootstrap, hidden by
// default, and re-positioned + shown on every tray right-click. We
// hide on blur so clicking elsewhere on the desktop dismisses it the
// same way the native menu did.

export function createMenuWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: MENU_WIDTH,
    height: MENU_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath('menu'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, ASSISTANT_ALWAYS_ON_TOP_LEVEL);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.removeMenu();

  void win.loadURL(rendererUrl('menu'));

  // Auto-dismiss when focus leaves the popup, matching the native
  // context menu's "click elsewhere to dismiss" behavior.
  win.on('blur', () => {
    if (!win.isDestroyed() && win.isVisible()) win.hide();
  });

  if (isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.control && input.shift && input.key.toLowerCase() === 'i') {
        win.webContents.openDevTools({ mode: 'detach' });
        event.preventDefault();
      }
    });
  }

  return win;
}

// ---------- Permission approval popup ----------
//
// A frameless transparent glass card (renderer/permission) that the
// permission gate raises whenever a mutating tool needs the operator's
// approval. Built once at bootstrap, hidden by default; the bridge in
// `permissionPrompt.ts` shows it on demand and resizes it to its
// content via `positionPermissionWindow`.

export function createPermissionWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: PERMISSION_WIDTH,
    height: PERMISSION_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath('permission'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, ASSISTANT_ALWAYS_ON_TOP_LEVEL);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.removeMenu();

  void win.loadURL(rendererUrl('permission'));

  if (isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.control && input.shift && input.key.toLowerCase() === 'i') {
        win.webContents.openDevTools({ mode: 'detach' });
        event.preventDefault();
      }
    });
  }

  return win;
}

/**
 * Centre the permission popup near the top of the primary work area and
 * size it to the renderer-reported content height (clamped).
 */
export function positionPermissionWindow(
  win: BrowserWindow,
  contentHeight: number,
): void {
  if (win.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  const height = Math.round(
    Math.max(PERMISSION_MIN_HEIGHT, Math.min(contentHeight, PERMISSION_MAX_HEIGHT)),
  );
  const x = workArea.x + Math.floor((workArea.width - PERMISSION_WIDTH) / 2);
  const y = workArea.y + Math.floor(workArea.height * 0.15);
  win.setBounds({ x, y, width: PERMISSION_WIDTH, height });
}

/**
 * Position the menu near a tray point and show it, clamped inside the
 * work area so it can never spawn off-screen. Mirrors how the native
 * Tray menu lands above the icon when the taskbar is on the bottom.
 */
export function showMenuAt(
  menu: BrowserWindow,
  trayBounds: Electron.Rectangle,
): void {
  if (menu.isDestroyed()) return;
  const display = screen.getDisplayNearestPoint({
    x: trayBounds.x + Math.floor(trayBounds.width / 2),
    y: trayBounds.y + Math.floor(trayBounds.height / 2),
  });
  const { workArea } = display;

  // Default: anchor the bottom-right of the popup to the tray icon's
  // top-right (taskbar-on-bottom layout). If that overflows the work
  // area we flip to the appropriate corner.
  let x = trayBounds.x + trayBounds.width - MENU_WIDTH;
  let y = trayBounds.y - MENU_HEIGHT;

  if (y < workArea.y) {
    // Tray at top of screen — drop below.
    y = trayBounds.y + trayBounds.height;
  }
  if (x < workArea.x) {
    x = workArea.x;
  }
  if (x + MENU_WIDTH > workArea.x + workArea.width) {
    x = workArea.x + workArea.width - MENU_WIDTH;
  }
  if (y + MENU_HEIGHT > workArea.y + workArea.height) {
    y = workArea.y + workArea.height - MENU_HEIGHT;
  }

  menu.setBounds({ x, y, width: MENU_WIDTH, height: MENU_HEIGHT });
  menu.show();
  menu.focus();
  refreshRegisteredAssistantZOrder();
}

// ---------- Phase 10 — Generated-image overlay ----------
//
// A second frameless transparent glass card (renderer/imageOverlay)
// that fades in next to the avatar when `generate_image` finishes.
// Built once at bootstrap, hidden by default; the bridge in
// `imageOverlay.ts` shows it on demand and resizes via
// `positionImageOverlayWindow`. Styling tokens are shared with the
// permission popup (`#ffd07a` accent, `blur(18px) saturate(140%)`,
// 12 px radius) so the two reads as the same product.

export function createImageOverlayWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: IMAGE_OVERLAY_DEFAULT_WIDTH,
    height: IMAGE_OVERLAY_DEFAULT_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    focusable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath('imageOverlay'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, ASSISTANT_ALWAYS_ON_TOP_LEVEL);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.removeMenu();
  win.setIgnoreMouseEvents(false);

  void win.loadURL(rendererUrl('imageOverlay'));

  if (isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.control && input.shift && input.key.toLowerCase() === 'i') {
        win.webContents.openDevTools({ mode: 'detach' });
        event.preventDefault();
      }
    });
  }

  return win;
}

/**
 * Park the overlay just to the LEFT of the avatar window (so the
 * image is visible while she speaks). On a screen too narrow for
 * left-anchoring, fall back to the right side. The renderer measures
 * its glass card and pushes the width/height through IPC; this
 * function clamps them to safe bounds and re-anchors against the
 * current avatar position.
 */
export function positionImageOverlayWindow(
  win: BrowserWindow,
  avatar: BrowserWindow,
  contentWidth: number,
  contentHeight: number,
): void {
  if (win.isDestroyed()) return;
  const width = Math.round(
    Math.max(
      IMAGE_OVERLAY_MIN_WIDTH,
      Math.min(contentWidth, IMAGE_OVERLAY_MAX_WIDTH),
    ),
  );
  const height = Math.round(
    Math.max(
      IMAGE_OVERLAY_MIN_HEIGHT,
      Math.min(contentHeight, IMAGE_OVERLAY_MAX_HEIGHT),
    ),
  );

  const avatarBounds = avatar.isDestroyed()
    ? null
    : avatar.getBounds();
  const display = avatarBounds
    ? screen.getDisplayMatching(avatarBounds)
    : screen.getPrimaryDisplay();
  const { workArea } = display;

  let x: number;
  let y: number;
  if (avatarBounds) {
    // Default: park to the left of the avatar, vertically centred on
    // her torso (~upper third of the avatar window — feet are at the
    // bottom, head near the top).
    x = avatarBounds.x - width - IMAGE_OVERLAY_GAP_PX;
    y = avatarBounds.y + Math.floor(avatarBounds.height * 0.18);
    if (x < workArea.x + 8) {
      // No room on the left → flip to the right side.
      x = avatarBounds.x + avatarBounds.width + IMAGE_OVERLAY_GAP_PX;
    }
  } else {
    x = workArea.x + Math.floor((workArea.width - width) / 2);
    y = workArea.y + Math.floor(workArea.height * 0.2);
  }

  // Clamp inside the work area.
  if (x + width > workArea.x + workArea.width - 4) {
    x = workArea.x + workArea.width - width - 4;
  }
  if (x < workArea.x + 4) x = workArea.x + 4;
  if (y + height > workArea.y + workArea.height - 4) {
    y = workArea.y + workArea.height - height - 4;
  }
  if (y < workArea.y + 4) y = workArea.y + 4;

  win.setBounds({ x, y, width, height });
}
