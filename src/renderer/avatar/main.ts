import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import {
  VRMAnimationLoaderPlugin,
  VRMLookAtQuaternionProxy,
  createVRMAnimationClip,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation';

import type {
  AssetManifest,
  AvatarApi,
  AvatarOutfitPayload,
  AvatarTalkingPayload,
  GestureKind,
  GesturePrefs,
  ReplyMood,
} from '@shared/ipc';

import { GestureController } from './gestures';

declare global {
  interface Window {
    avatarApi: AvatarApi & {
      /**
       * Mobile-only (M-2.5). Asks the native host to open the chat
       * history overlay. Present when the Android shim installed the
       * bridge; absent on the desktop preload.
       */
      openHistory?: () => void;
      /**
       * Mobile-only (M-2.8). Tells the native host to vibrate the
       * device for tactile gesture feedback. `kind` is the gesture
       * verb so the host can pick a per-verb pattern (a soft caress
       * vs. a sharp poke). Fire-and-forget — the host owns gating
       * on the user's haptics pref.
       */
      hapticTick?: (kind: GestureKind) => void;
    };
    /**
     * `'mobile'` only on Android (set by `__mioAvatarBridge.js` before
     * `main.ts` runs). `undefined` everywhere else, which the
     * `isMobilePlatform()` helper treats as desktop.
     */
    __MIO_PLATFORM__?: 'mobile' | string;
  }
}

/**
 * Single source of truth for the desktop-vs-mobile branches in this
 * file. Read after the shim has had a chance to run (i.e. inside
 * handlers / boot()). Kept as a function so we can be paranoid about
 * the shim load order (script order in `index.html` guarantees it,
 * but a runtime check costs nothing).
 */
function isMobilePlatform(): boolean {
  return typeof window !== 'undefined' && window.__MIO_PLATFORM__ === 'mobile';
}

const canvas = document.getElementById('avatar-canvas') as HTMLCanvasElement;
const placeholder = document.getElementById('placeholder') as HTMLDivElement;
const placeholderTitle = document.getElementById(
  'placeholder-title',
) as HTMLHeadingElement;
const placeholderBody = document.getElementById(
  'placeholder-body',
) as HTMLParagraphElement;

// Frameless window: the canvas must stay `-webkit-app-region: no-drag` so
// Phase 3 gestures receive pointer events on Windows. Reposition with Alt+drag.
//
// M-2.5: the mobile build runs full-screen inside a Compose `AndroidView`,
// so there's no frameless host window to translate. We skip the whole
// drag wiring there — it would only steal pointer events from the
// touch gesture controller without any user-visible effect.
if (!isMobilePlatform()) {
  let avatarWindowDragging = false;
  let lastDragScreenX = 0;
  let lastDragScreenY = 0;

  window.addEventListener('pointerdown', (e: PointerEvent) => {
    if (!e.altKey) return;
    avatarWindowDragging = true;
    lastDragScreenX = e.screenX;
    lastDragScreenY = e.screenY;
    try {
      document.documentElement.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });

  window.addEventListener('pointermove', (e: PointerEvent) => {
    if (!avatarWindowDragging) return;
    const dx = e.screenX - lastDragScreenX;
    const dy = e.screenY - lastDragScreenY;
    lastDragScreenX = e.screenX;
    lastDragScreenY = e.screenY;
    if (dx !== 0 || dy !== 0) {
      window.avatarApi.moveWindowBy(dx, dy);
    }
  });

  const endAvatarWindowDrag = (): void => {
    avatarWindowDragging = false;
  };

  window.addEventListener('pointerup', endAvatarWindowDrag);
  window.addEventListener('pointercancel', endAvatarWindowDrag);

  // ── Click-through management ──────────────────────────────────────
  // The avatar window starts click-through (see windows.ts) so its big
  // transparent area never blocks the desktop / menus underneath. We
  // flip it to "capturing" only while the cursor is actually over her
  // body (so gestures register) or while Alt is held (so the window can
  // be dragged). `forward: true` on the main side keeps these mousemove
  // events flowing even while the window is click-through.
  const ignoreRaycaster = new THREE.Raycaster();
  const ignoreNdc = new THREE.Vector2();
  let mouseIgnored = true; // matches the window's initial state

  const cursorOverAvatar = (clientX: number, clientY: number): boolean => {
    if (!state) return false;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w === 0 || h === 0) return false;
    ignoreNdc.x = (clientX / w) * 2 - 1;
    ignoreNdc.y = -(clientY / h) * 2 + 1;
    ignoreRaycaster.setFromCamera(ignoreNdc, camera);
    return ignoreRaycaster.intersectObject(state.vrm.scene, true).length > 0;
  };

  const applyMouseIgnore = (interactive: boolean): void => {
    const wantIgnore = !interactive;
    if (wantIgnore === mouseIgnored) return;
    mouseIgnored = wantIgnore;
    window.avatarApi.setMouseIgnore(wantIgnore);
  };

  window.addEventListener('mousemove', (e: MouseEvent) => {
    applyMouseIgnore(e.altKey || cursorOverAvatar(e.clientX, e.clientY));
  });

  // When the cursor leaves the window entirely, revert to click-through
  // so a stale "capturing" state can't linger after the pointer exits
  // over her body.
  document.documentElement.addEventListener('mouseleave', () => {
    applyMouseIgnore(false);
  });
}

const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: true,
  premultipliedAlpha: false,
});
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(window.devicePixelRatio);
// updateStyle stays at its default (true) so three.js writes the
// canvas's CSS width/height in explicit pixels. The Android WebView
// hosts this scene in a <canvas> whose CSS `height: 100%` / `100vh`
// both collapse to 0 — the explicit px from setSize is what gives the
// canvas a real on-screen size.
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// MToon (the VRM toon shader) is calibrated for linear, untonemapped output;
// any tone mapping crushes its cel-shaded highlights and reads as "muddy".
renderer.toneMapping = THREE.NoToneMapping;

const scene = new THREE.Scene();

// Camera is framed so a ~1.7m VRM rig fits head-to-feet with arm-spread
// margin, with a touch of extra headroom/footroom so she reads as a
// slightly smaller figure on the desktop (less "in your face"). Pulled
// back from 3.75 → 4.15 to give ~10% smaller on-screen height.
const camera = new THREE.PerspectiveCamera(
  28,
  window.innerWidth / window.innerHeight,
  0.1,
  20,
);
camera.position.set(0, 0.95, 4.15);
camera.lookAt(0, 0.9, 0);

// three.js r155+ uses physically-correct light units, where intensity 1.0
// is roughly 1/π of the legacy r154 "1.0". The three-vrm reference viewer
// uses Math.PI (~3.14) as the directional-light gain for this reason. We
// deliberately undershoot that so MToon's flat-shaded fills don't blow
// out facial features into a "porcelain doll" white — at higher gains the
// eyes and nose shading wash out and she stops reading as expressive.
// 1.55 keeps the lit side bright enough to feel daylit but preserves
// enough mid-tone on the face that eyes, mouth corners and the brow ridge
// are still legible.
//
// M-8 aesthetic pass (mobile Grok-Ani look) — the rig is now a five-light
// setup tuned for the deep-purple background:
//   - Hemisphere fill, sky warm-white over a violet floor so subsurface
//     bounces pick up the room mood.
//   - Soft ambient floor, kept low so shapes still read.
//   - Warm front key (front-right, slightly above) — cheek/forehead lit.
//   - Cool front fill (front-left) — softens the shadow side.
//   - Warm back rim (above-back) — the classic edge highlight on hair
//     and shoulders, the one that pulls her silhouette off the
//     transparent backdrop.
//   - NEW: a violet back-rim light from the opposite side. It paints a
//     subtle lavender/magenta accent along the silhouette that mirrors
//     the Grok-Ani vignette without tinting the front-lit face, which
//     stays warm and readable.
const LIGHT_GAIN = 1.55;

// Sky white over a violet floor → MToon's bounce term gets a tinted
// lift on the under-lit planes, which integrates the figure with the
// dark-purple backdrop instead of leaving her floating in neutral grey.
const hemi = new THREE.HemisphereLight(0xfff4e8, 0x3c2a55, 0.42 * LIGHT_GAIN);
scene.add(hemi);

// Kept deliberately low — ambient lifts shadows but also flattens form,
// so we use just enough to keep the darkest planes from going inky and
// rely on hemi + key/fill/rim for shaping. Trimmed from 0.12 → 0.10 so
// the new violet back-rim isn't washed out by global lift.
const ambient = new THREE.AmbientLight(0xffffff, 0.10 * LIGHT_GAIN);
scene.add(ambient);

// Key light is the one that, when too strong, flattens facial features.
// Bumped slightly (0.7 → 0.78) and warmed a touch so the face stays
// the brightest, most saturated thing in frame — the eye reads it
// first against the cool backdrop. MToon's lit-side ramp still lands
// in the mid-tones rather than clipping to white across the cheek and
// forehead.
const keyLight = new THREE.DirectionalLight(0xfff0d6, 0.78 * LIGHT_GAIN);
keyLight.position.set(1.2, 2.4, 1.6);
scene.add(keyLight);

// Cool fill — pulled a hair cooler (0xb6c6ff → 0xaab8ff) so it reads
// as "ambient sky bounce" against the warm key. Same intensity.
const fillLight = new THREE.DirectionalLight(0xaab8ff, 0.32 * LIGHT_GAIN);
fillLight.position.set(-1.8, 1.2, 0.6);
scene.add(fillLight);

// Warm back rim — stronger than before (0.6 → 0.85) and pulled directly
// behind-above so a clean amber edge wraps around the hair, jawline
// and shoulder. This is the single biggest aesthetic upgrade — it's
// what makes her look "lit by the room" rather than "pasted on top".
const rimLight = new THREE.DirectionalLight(0xffe4c2, 0.85 * LIGHT_GAIN);
rimLight.position.set(-0.4, 2.0, -1.6);
scene.add(rimLight);

// NEW — violet contour rim from the opposite back side. Subtle (0.55)
// and tinted with the same lavender used in the radial-vignette
// backdrop. It picks out the silhouette on the SHADOW side, which
// keeps the figure from melting into the dark purple background.
const accentRim = new THREE.DirectionalLight(0xc8a6ff, 0.55 * LIGHT_GAIN);
accentRim.position.set(1.6, 1.6, -1.8);
scene.add(accentRim);

window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});

interface LoadedAnimation {
  name: string;
  clip: THREE.AnimationClip;
  /**
   * Mood tags inferred from the animation's filename (Japanese or
   * English keyword scan). Multiple tags per clip is fine — the picker
   * uses set intersection with the requested mood. Empty array means
   * "neutral / always eligible".
   */
  moodTags: ReplyMood[];
}

interface AvatarState {
  vrm: VRM;
  mixer: THREE.AnimationMixer;
  idleClips: LoadedAnimation[];
  talkingClips: LoadedAnimation[];
  currentAction: THREE.AnimationAction | null;
  /** Filename of `currentAction`'s clip — used to avoid re-picking the same one. */
  currentName: string | null;
  mode: 'idle' | 'talking';
  /** Schedules an idle fidget swap when no other state change happens for a while. */
  idleFidgetTimer: ReturnType<typeof setTimeout> | null;
  /** Per-VRM facial-expression engine; null when the model has none registered. */
  expression: ExpressionState | null;
  /** Per-VRM gesture detector. Recreated on outfit swap because it binds to bones. */
  gestureController: GestureController | null;
  /** The asset manifest used to load this VRM — needed when outfits swap. */
  manifest: AssetManifest;
  /** Outfit id Mio is currently wearing, or null until a wardrobe is loaded. */
  currentOutfitId: string | null;
}

/**
 * Facial-expression driver. We sample the requested target weights
 * each frame and lerp the live weights toward them so mood changes
 * crossfade smoothly instead of snapping. Unknown preset names are
 * dropped at register time (`@pixiv/three-vrm`'s `getExpression`
 * returns null), so a VRM that only ships `happy`/`sad`/`angry`
 * silently degrades to a smaller palette.
 */
interface ExpressionState {
  /** Preset names this VRM actually supports, intersected with our palette. */
  supported: Set<string>;
  /** Live, last-rendered weight per preset (what the VRM is showing now). */
  current: Map<string, number>;
  /** Target weight per preset (what we want it to settle on). */
  target: Map<string, number>;
}

let state: AvatarState | null = null;
const clock = new THREE.Clock();

function buildLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  return loader;
}

async function loadVrm(url: string): Promise<VRM> {
  const loader = buildLoader();
  const gltf = await loader.loadAsync(url);
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) {
    throw new Error(`File at ${url} did not contain a VRM payload`);
  }

  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.combineMorphs(vrm);

  vrm.scene.traverse((obj) => {
    obj.frustumCulled = false;
  });

  // VRMAnimation drives look-at via a quaternion proxy; without one, the
  // VRMA loader auto-creates one and warns. Attach explicitly so look-at
  // tracks correctly when talking animations re-target.
  if (vrm.lookAt) {
    const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
    proxy.name = 'VRMLookAtQuaternionProxy';
    vrm.scene.add(proxy);
  }

  // VRM 1.0 models load facing +Z, which is where our camera lives
  // (positioned along +Z looking at the origin — see the camera setup
  // above), so the avatar faces the user without any extra rotation.
  // @pixiv/three-vrm v3 auto-normalises legacy VRM 0.x models (which face
  // -Z natively) to the same +Z convention, so this works for both
  // versions.
  vrm.scene.rotation.y = 0;

  return vrm;
}

async function loadAnimationClip(
  url: string,
  vrm: VRM,
): Promise<THREE.AnimationClip | null> {
  const loader = buildLoader();
  const gltf = await loader.loadAsync(url);
  const animations = gltf.userData.vrmAnimations as
    | VRMAnimation[]
    | undefined;
  if (!animations || animations.length === 0) return null;
  return createVRMAnimationClip(animations[0]!, vrm);
}

function basename(url: string): string {
  try {
    const u = new URL(url);
    const segs = decodeURIComponent(u.pathname).split('/');
    return segs[segs.length - 1] ?? url;
  } catch {
    return url;
  }
}

async function loadAnimationList(
  urls: string[],
  vrm: VRM,
): Promise<LoadedAnimation[]> {
  const results: LoadedAnimation[] = [];
  for (const url of urls) {
    try {
      const clip = await loadAnimationClip(url, vrm);
      if (clip) {
        const name = basename(url);
        results.push({ name, clip, moodTags: classifyAnimationMood(name) });
      }
    } catch (err) {
      console.error('[avatar] failed to load animation', url, err);
    }
  }
  return results;
}

// Phase 7 — file-name based mood classifier. Animations ship as VRMA
// files with descriptive (often Japanese) names like `VRMA_02挨拶.vrma`
// (greeting), `VRMA_03Vサイン.vrma` (V-sign), `VRMA_07屈伸運動.vrma`
// (squat exercise / fidget). We tag each loaded clip with one or more
// mood buckets; the talking-animation picker prefers clips whose tags
// match the reply mood, falling back to the full pool when nothing
// matches.
//
// Order inside the table is just readability — each entry is checked
// independently and ALL matches stick to the clip. So a clip whose
// name contains both "挨拶" and "warm" gets both `'warm'` and
// `'neutral'` tags.
const MOOD_NAME_HINTS: ReadonlyArray<{
  test: RegExp;
  tags: readonly ReplyMood[];
}> = [
  { test: /挨拶|greet|wave|hello|bow/i, tags: ['warm', 'neutral'] },
  { test: /Vサイン|peace|v-sign|vsign/i, tags: ['playful', 'amused'] },
  { test: /笑|smile|laugh|giggle/i, tags: ['amused', 'playful'] },
  { test: /照れ|shy|blush|embarrass/i, tags: ['shy'] },
  { test: /考え|think|hmm|wonder|考/i, tags: ['thinking'] },
  { test: /怒|angry|firm|stern|disagree|orz/i, tags: ['firm'] },
  { test: /心配|worried|concern|sad/i, tags: ['concerned'] },
  { test: /回|spin|turn|twirl|dance/i, tags: ['playful', 'amused'] },
  { test: /撃|shoot|gun|finger-?gun/i, tags: ['playful', 'firm'] },
  { test: /全身|show|pose|reveal/i, tags: ['warm', 'playful'] },
  { test: /屈伸|stretch|fidget|exercise/i, tags: ['neutral'] },
  { test: /モデル|model|stand|standing|neutral/i, tags: ['neutral'] },
];

function classifyAnimationMood(fileName: string): ReplyMood[] {
  const tags = new Set<ReplyMood>();
  for (const hint of MOOD_NAME_HINTS) {
    if (hint.test.test(fileName)) {
      for (const t of hint.tags) tags.add(t);
    }
  }
  return Array.from(tags);
}

function pickRandom<T>(arr: T[]): T | null {
  if (arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/**
 * Pick the best clip for a desired mood. Strategy:
 *   1. Prefer clips whose `moodTags` includes the requested mood.
 *   2. Fall back to clips whose `moodTags` includes a "compatible"
 *      mood (loose buckets — `playful`/`amused` substitute for each
 *      other, `warm`/`neutral` are interchangeable, etc).
 *   3. Fall back to the entire pool.
 *   4. Avoid picking the same animation twice in a row when there's a
 *      choice — variety reads as "alive", repetition reads as "stuck".
 */
const MOOD_FALLBACKS: Record<ReplyMood, readonly ReplyMood[]> = {
  neutral:    ['warm', 'thinking'],
  playful:    ['amused', 'warm'],
  warm:       ['neutral', 'playful'],
  shy:        ['warm', 'neutral'],
  amused:     ['playful', 'warm'],
  concerned:  ['warm', 'thinking', 'neutral'],
  thinking:   ['neutral', 'warm'],
  firm:       ['neutral', 'thinking'],
};

function pickClipForMood(
  pool: LoadedAnimation[],
  mood: ReplyMood | undefined,
  avoidName: string | null,
): LoadedAnimation | null {
  if (pool.length === 0) return null;

  const exclude = (cand: LoadedAnimation): boolean =>
    avoidName !== null && cand.name === avoidName && pool.length > 1;

  if (!mood) {
    // No mood hint — pure random, but avoid back-to-back repeats.
    const filtered = pool.filter((c) => !exclude(c));
    const choice = pickRandom(filtered.length > 0 ? filtered : pool);
    return choice ?? null;
  }

  const exact = pool.filter((c) => c.moodTags.includes(mood) && !exclude(c));
  if (exact.length > 0) return pickRandom(exact);

  for (const fallback of MOOD_FALLBACKS[mood] ?? []) {
    const compat = pool.filter(
      (c) => c.moodTags.includes(fallback) && !exclude(c),
    );
    if (compat.length > 0) return pickRandom(compat);
  }

  // Last resort — any clip in the pool, repetition allowed.
  const any = pool.filter((c) => !exclude(c));
  return pickRandom(any.length > 0 ? any : pool);
}

// How long an idle animation is allowed to loop before we crossfade
// into a different idle clip ("occasional fidget" from the Phase 7
// polish list). Real bodies don't repeat the exact same shift-of-weight
// every 4 s — having two idle clips and rotating between them produces
// a noticeable "she's actually here" feel without being twitchy.
const IDLE_FIDGET_MIN_MS = 18_000;
const IDLE_FIDGET_MAX_MS = 36_000;

function clearIdleFidgetTimer(s: AvatarState): void {
  if (s.idleFidgetTimer !== null) {
    clearTimeout(s.idleFidgetTimer);
    s.idleFidgetTimer = null;
  }
}

function scheduleIdleFidget(s: AvatarState): void {
  clearIdleFidgetTimer(s);
  if (s.idleClips.length < 2) return; // Single clip → no point fidgeting between identical poses.
  const delay = IDLE_FIDGET_MIN_MS +
    Math.random() * (IDLE_FIDGET_MAX_MS - IDLE_FIDGET_MIN_MS);
  s.idleFidgetTimer = setTimeout(() => {
    s.idleFidgetTimer = null;
    if (s.mode !== 'idle') return;
    playRandomIdle(s);
  }, delay);
}

function playClip(
  s: AvatarState,
  pick: LoadedAnimation,
  mode: 'idle' | 'talking',
): void {
  const next = s.mixer.clipAction(pick.clip);
  next.reset();
  next.setLoop(THREE.LoopRepeat, Infinity);
  next.clampWhenFinished = false;
  next.enabled = true;
  // 0.4 s crossfade — long enough to read as a smooth blend (limbs
  // settle into their new pose instead of snapping) but short enough
  // that idle ↔ talking transitions feel responsive when she's reacting
  // to a fresh user message.
  next.fadeIn(0.4).play();

  if (s.currentAction && s.currentAction !== next) {
    s.currentAction.fadeOut(0.4);
  }
  s.currentAction = next;
  s.currentName = pick.name;
  s.mode = mode;

  if (mode === 'idle') {
    scheduleIdleFidget(s);
  } else {
    clearIdleFidgetTimer(s);
  }
}

function playRandomIdle(s: AvatarState): void {
  const pick = pickClipForMood(s.idleClips, undefined, s.currentName);
  if (!pick) return;
  playClip(s, pick, 'idle');
  // Idle = neutral face. We let the natural blink remain (driven
  // separately by `vrm.expressionManager.blink`-overridden presets).
  applyExpressionForMood(s, undefined);
}

function playTalking(s: AvatarState, mood?: ReplyMood): void {
  const pick = pickClipForMood(s.talkingClips, mood, s.currentName);
  if (!pick) {
    // Fall back to idle if no talking animations were provided at all.
    playRandomIdle(s);
    return;
  }
  playClip(s, pick, 'talking');
  applyExpressionForMood(s, mood);
}

// ─── Facial expression engine ────────────────────────────────────────
//
// VRM 1.0 ships a fixed palette of preset expressions (`happy`,
// `angry`, `sad`, `relaxed`, `surprised`, plus mouth/eye phonemes).
// Booth models rarely implement every preset, so we probe the
// `expressionManager` for the ones we want and only drive what's
// available — a model with just `happy` + `sad` degrades gracefully
// to those two without breaking the renderer.
//
// The mapping below is what each `ReplyMood` looks like on a face.
// Some moods stack two presets (e.g. `shy` = happy + sad at low
// weights) for a more nuanced read than a single peak. Weights are
// kept ≤ 0.8 so the natural lid+lip neutrality bleeds through —
// 1.0 reads as a comic-book grimace, not a real expression.

const EMOTION_PRESETS = ['happy', 'angry', 'sad', 'relaxed', 'surprised'] as const;
type EmotionPreset = (typeof EMOTION_PRESETS)[number];

const MOOD_EXPRESSION_TABLE: Record<ReplyMood, Partial<Record<EmotionPreset, number>>> = {
  neutral:   {},
  playful:   { happy: 0.55, relaxed: 0.30 },
  amused:    { happy: 0.80 },
  warm:      { happy: 0.50, relaxed: 0.45 },
  shy:       { happy: 0.35, sad: 0.20 },
  concerned: { sad: 0.55, relaxed: 0.20 },
  thinking:  { relaxed: 0.45 },
  firm:      { angry: 0.55 },
};

/**
 * Slew speed (1/s) for expression-weight lerps. A value of `8` means
 * the live weight closes ~63% of the remaining gap each ~125 ms,
 * which lands on a perceptibly smooth ~250-300 ms crossfade — fast
 * enough to feel reactive when she starts talking, slow enough to
 * read as a face changing instead of a slide cutting.
 */
const EXPRESSION_LERP_PER_SEC = 8;

function buildExpressionState(vrm: VRM): ExpressionState | null {
  const mgr = vrm.expressionManager;
  if (!mgr) return null;
  const supported = new Set<string>();
  const current = new Map<string, number>();
  const target = new Map<string, number>();
  for (const name of EMOTION_PRESETS) {
    if (mgr.getExpression(name)) {
      supported.add(name);
      current.set(name, 0);
      target.set(name, 0);
    }
  }
  if (supported.size === 0) return null;
  return { supported, current, target };
}

function applyExpressionForMood(s: AvatarState, mood: ReplyMood | undefined): void {
  const exp = s.expression;
  if (!exp) return;
  // Reset every preset's target so a previous mood (e.g. `firm`'s
  // angry) doesn't bleed into the next clip just because the new
  // mood's table doesn't mention it.
  for (const name of exp.supported) exp.target.set(name, 0);
  if (!mood) return;
  const map = MOOD_EXPRESSION_TABLE[mood];
  if (!map) return;
  for (const [name, weight] of Object.entries(map)) {
    if (!exp.supported.has(name)) continue;
    exp.target.set(name, typeof weight === 'number' ? weight : 0);
  }
  if (exp.supported.size > 0) {
    const summary = Array.from(exp.target.entries())
      .filter(([, w]) => w > 0)
      .map(([n, w]) => `${n}=${w.toFixed(2)}`)
      .join(' ');
    console.log(`[avatar] expression mood=${mood} → ${summary || '(neutral)'}`);
  }
}

function tickExpression(s: AvatarState, dt: number): void {
  const exp = s.expression;
  if (!exp) return;
  const mgr = s.vrm.expressionManager;
  if (!mgr) return;
  const t = Math.min(1, dt * EXPRESSION_LERP_PER_SEC);
  for (const name of exp.supported) {
    const cur = exp.current.get(name) ?? 0;
    const tgt = exp.target.get(name) ?? 0;
    if (Math.abs(cur - tgt) < 0.001) {
      if (cur !== tgt) {
        exp.current.set(name, tgt);
        mgr.setValue(name, tgt);
      }
      continue;
    }
    const next = cur + (tgt - cur) * t;
    exp.current.set(name, next);
    mgr.setValue(name, next);
  }
}

function animate(): void {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  if (state) {
    state.mixer.update(dt);
    tickExpression(state, dt);
    // `vrm.update(dt)` finalises the expression manager's blend on
    // the underlying morph targets, so `tickExpression` MUST run
    // before this line.
    state.vrm.update(dt);
  }
  renderer.render(scene, camera);
}

// Shown when the resolver returned no VRM at all — a genuinely missing
// file (or a wrong assets path).
function showMissingPlaceholder(rootHint: string): void {
  placeholder.hidden = false;
  placeholderTitle.textContent = 'No VRM model found';
  placeholderBody.textContent =
    `Drop a .vrm file into ${rootHint}/vrm/ and restart Mio. ` +
    'If a model is already in place, check the startup terminal for the ' +
    '"[assets]" lines — they list every folder that was searched.';
}

// Shown when a VRM WAS found but loading/parsing it threw. Surfaces the
// real error instead of the misleading "drop a file" message.
function showErrorPlaceholder(detail: string): void {
  placeholder.hidden = false;
  placeholderTitle.textContent = 'Avatar failed to load';
  placeholderBody.textContent = detail;
}

function hidePlaceholder(): void {
  placeholder.hidden = true;
}

/**
 * Take down whatever the prior outfit installed. Called both when
 * swapping mid-session and as the rollback on a failed load. We
 * dispose three.js GPU resources eagerly via `VRMUtils.deepDispose`
 * — without it a long session that swaps outfits several times
 * leaks ~20-50 MB of texture memory per cycle.
 */
function uninstallCurrentOutfit(s: AvatarState): void {
  clearIdleFidgetTimer(s);
  if (s.gestureController) {
    s.gestureController.dispose();
    s.gestureController = null;
  }
  if (s.currentAction) {
    s.currentAction.stop();
    s.currentAction = null;
  }
  s.mixer.stopAllAction();
  s.mixer.uncacheRoot(s.vrm.scene);
  scene.remove(s.vrm.scene);
  try {
    VRMUtils.deepDispose(s.vrm.scene);
  } catch (err) {
    console.warn('[avatar] VRM dispose failed', err);
  }
}

interface InstallOutfitArgs {
  vrm: VRM;
  manifest: AssetManifest;
  outfitId: string | null;
  /** When swapping outfits we already have prefs cached; pass to skip an extra IPC round-trip. */
  initialPrefs: GesturePrefs;
}

async function installOutfit(args: InstallOutfitArgs): Promise<AvatarState> {
  const { vrm, manifest, outfitId, initialPrefs } = args;
  scene.add(vrm.scene);

  const idleClips = await loadAnimationList(manifest.idleAnimations, vrm);
  const talkingClips = await loadAnimationList(manifest.talkingAnimations, vrm);
  // Phase 7: extras (V-sign, full-body show, spin, etc.) join the
  // talking pool with their own mood tags so a `mood: 'playful'`
  // reply can pull from them. They never auto-play during idle.
  const extrasClips = await loadAnimationList(manifest.extrasAnimations ?? [], vrm);
  const fullTalkingPool = [...talkingClips, ...extrasClips];
  console.log(
    `[avatar] animation clips: idle=${idleClips.length} talking=${talkingClips.length} extras=${extrasClips.length}`,
  );

  const expression = buildExpressionState(vrm);
  if (expression) {
    console.log(
      `[avatar] facial expression presets supported: ${Array.from(expression.supported).join(', ')}`,
    );
  } else {
    console.log('[avatar] VRM has no facial-expression manager; mood faces disabled');
  }

  const mobile = isMobilePlatform();
  const gestureController = new GestureController({
    canvas,
    camera,
    vrm,
    prefs: initialPrefs,
    onGesture: (event) => {
      window.avatarApi.sendGesture(event);
    },
    // M-2.5: mobile-only — caress dwell becomes touch-and-hold,
    // and an off-body swipe-up opens the chat history overlay via
    // the bridge.
    platform: mobile ? 'mobile' : 'desktop',
    onOpenHistory: mobile
      ? () => {
          // Use optional chaining so a stale Electron build (no
          // openHistory exposed) just drops the request silently.
          window.avatarApi.openHistory?.();
        }
      : undefined,
    // M-2.8 mobile-only — wire the controller's haptic callback to
    // the bridge. The Kotlin side reads the user's `Haptics`
    // mobile pref and either vibrates with a per-verb pattern or
    // silently swallows the call; either way it never blocks.
    onHaptic: mobile
      ? (kind) => {
          window.avatarApi.hapticTick?.(kind);
        }
      : undefined,
  });

  const fresh: AvatarState = {
    vrm,
    mixer: new THREE.AnimationMixer(vrm.scene),
    idleClips,
    talkingClips: fullTalkingPool,
    currentAction: null,
    currentName: null,
    mode: 'idle',
    idleFidgetTimer: null,
    expression,
    gestureController,
    manifest,
    currentOutfitId: outfitId,
  };
  playRandomIdle(fresh);
  return fresh;
}

/**
 * Swap to a different outfit at runtime. The manifest stays the same
 * (animations + extras are shared across outfits), only the VRM
 * changes. We tear down the prior model first so failed loads can
 * fall back to a clean placeholder instead of leaving two avatars
 * stacked in the scene.
 */
async function swapOutfit(payload: AvatarOutfitPayload): Promise<void> {
  if (!state) {
    console.warn('[avatar] outfit swap ignored — scene not ready yet');
    return;
  }
  if (state.currentOutfitId === payload.outfitId) {
    console.log(`[avatar] outfit ${payload.outfitId} already active; no swap`);
    return;
  }
  console.log(
    `[avatar] swapping outfit -> ${payload.outfitId} (${payload.label}) from ${payload.vrmPath}`,
  );
  let next: VRM;
  try {
    next = await loadVrm(payload.vrmPath);
  } catch (err) {
    console.error('[avatar] failed to load swap target VRM', err);
    return;
  }

  // Preserve gesture prefs across the swap so the user doesn't lose
  // their touch-input setting just because Mio changed clothes.
  const prefs = await window.avatarApi.getGesturePrefs();
  uninstallCurrentOutfit(state);

  // Mutate `manifest.vrmPath` so a subsequent `requestAssets`-driven
  // boot (e.g. after a chat-window reload) reflects the active outfit.
  // The brain also persists it, but updating the in-memory copy here
  // keeps the renderer self-consistent if the brain isn't queried again.
  const updatedManifest: AssetManifest = {
    ...state.manifest,
    vrmPath: payload.vrmPath,
    activeOutfitId: payload.outfitId,
  };

  try {
    state = await installOutfit({
      vrm: next,
      manifest: updatedManifest,
      outfitId: payload.outfitId,
      initialPrefs: prefs,
    });
    console.log(`[avatar] outfit ${payload.outfitId} active`);
  } catch (err) {
    console.error('[avatar] outfit swap install failed', err);
    showErrorPlaceholder(
      `Couldn't apply ${payload.label} (${payload.outfitId}) — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function boot(): Promise<void> {
  animate();

  console.log('[avatar] requesting assets');
  const manifest: AssetManifest = await window.avatarApi.requestAssets();
  console.log('[avatar] manifest', {
    vrmPath: manifest.vrmPath,
    idleCount: manifest.idleAnimations.length,
    talkingCount: manifest.talkingAnimations.length,
    outfitCount: manifest.outfits?.length ?? 0,
    activeOutfit: manifest.activeOutfitId ?? '(default)',
  });

  if (!manifest.vrmPath) {
    showMissingPlaceholder('<userData>/assets');
    return;
  }

  try {
    console.log('[avatar] loading VRM from', manifest.vrmPath);
    const vrm = await loadVrm(manifest.vrmPath);
    hidePlaceholder();
    console.log('[avatar] VRM added to scene');

    const initialPrefs = await window.avatarApi.getGesturePrefs();
    state = await installOutfit({
      vrm,
      manifest,
      outfitId: manifest.activeOutfitId ?? null,
      initialPrefs,
    });

    window.avatarApi.onSetTalking((payload: AvatarTalkingPayload) => {
      if (state) playTalking(state, payload?.mood);
    });
    window.avatarApi.onSetIdle(() => {
      if (state) playRandomIdle(state);
    });
    window.avatarApi.onSetGesturePrefs((prefs) => {
      state?.gestureController?.setPrefs(prefs);
    });
    // Outfit pushes are gated on the host actually wiring the
    // handler. The desktop preload always does; the Android shim
    // may or may not, depending on the bundle version — so we
    // defensively skip when missing rather than crashing the boot.
    if (typeof window.avatarApi.onSetOutfit === 'function') {
      window.avatarApi.onSetOutfit((payload) => {
        void swapOutfit(payload);
      });
    } else {
      console.log('[avatar] host did not expose onSetOutfit; wardrobe swap disabled');
    }
  } catch (err) {
    console.error('[avatar] failed to initialize VRM scene', err);
    const detail = err instanceof Error ? err.message : String(err);
    showErrorPlaceholder(`Couldn't load ${manifest.vrmPath} — ${detail}`);
  }
}

void boot();
