import * as THREE from 'three';
import { VRMHumanBoneName, type VRM } from '@pixiv/three-vrm';

import type {
  GestureEvent,
  GestureKind,
  GestureTarget,
  GestureTone,
  GesturePrefs,
} from '@shared/ipc';

// ─────────────────────────────────────────────────────────────────────
// Avatar gesture detection — body-wide, 8-verb edition
// ─────────────────────────────────────────────────────────────────────
//
// The renderer maintains an in-memory proprioceptive map of the loaded
// VRM and a small input-state machine that classifies cursor activity
// into one of eight gesture verbs (caress / poke / pat / tickle /
// stroke / grab / tug / pinch). Each fired gesture is shipped to main
// as a single GestureEvent; main batches bursts into one synthetic
// chat turn so a flurry of touches resolves to one in-character reply
// instead of a stuttered stream of replies.
//
// Three hit-test families share a single `RegionEntry` interface so
// the per-frame pass is one loop, not three:
//
//   • bone        — world position of a humanoid bone IS the centre
//                   (head, hand, individual finger distals).
//   • offset      — fixed bone-local offset from a parent bone (face
//                   sub-zones, torso sub-zones, hip variants).
//   • midpoint    — world-space midpoint between two bones (limbs
//                   where the bone itself sits at a joint, not at the
//                   middle of the segment we want to label).
//
// A fourth family — `softpart` — is built at load time by walking
// `vrm.springBoneManager.joints` and grouping them into hair / skirt /
// ribbon chains by name regex. Each chain becomes one entry whose
// centre is the live chain centroid (re-projected per frame).
//
// All radii are stored in metres (since VRM rigs are real-world-scaled)
// and converted to pixel-space radii each frame via a sibling-offset
// projection, so depth + zoom changes scale the hit zones correctly.

// ─── Tunables ────────────────────────────────────────────────────────

/** Caress dwell — shorter than naïve "did it break?" testing intuition. */
const CARESS_DWELL_MS = 1500;
/** Cooldown is per (kind, region) so caress on face doesn't suppress poke on face. */
const COOLDOWN_MS: Record<GestureKind, number> = {
  caress: 4000,
  poke: 1000,
  pat: 2000,
  tickle: 3000,
  stroke: 2000,
  grab: 2000,
  tug: 2000,
  pinch: 1000,
};

/** Stroke = drag along a strokeable region for ≥ this many px along its bone axis. */
const STROKE_MIN_PATH_PX = 80;
/** Stroke requires the cumulative motion vector to align with the bone axis (cos θ). */
const STROKE_AXIS_COS_THRESHOLD = 0.6;
/** Grab = mousedown + hold within this many px of the down point for ≥ GRAB_HOLD_MS. */
const GRAB_HOLD_MS = 350;
/** Tug = drag this many px away from the soft-part centroid. */
const TUG_MIN_AWAY_PX = 25;
/** Pat = a second tap on the same region within this window after the first. */
const PAT_WINDOW_MS = 400;

// ─── Per-platform tap / drag tunables ─────────────────────────────────
//
// Desktop figures are tuned for a 2 mm mouse hot-spot — perfectly fine
// for cursor work. Touch hardware reports an ~8-12 mm finger contact
// patch (32-48 CSS px at typical 400+ dpi panels), so the same
// thresholds register a held finger's natural jitter as drag and a
// quick tap as a sloppy poke. We define mobile-mode overrides ~2-3×
// the desktop values; M-2.5 selects between them at controller
// construction based on `platform`.
const DESKTOP_TUNING = {
  GRAB_MOVE_TOLERANCE_PX: 8,
  TAP_MAX_DURATION_MS: 250,
  TAP_MAX_DISTANCE_PX: 6,
  TICKLE_WINDOW_MS: 600,
  TICKLE_MIN_REVERSALS: 4,
  TICKLE_MIN_STEP_PX: 4,
} as const;

const MOBILE_TUNING = {
  // Capacitive touch wiggles ~10-20 px even on a "still" hold; bump
  // the grab/tap radii so the dwell timer doesn't abort under a
  // finger that the user perceives as motionless.
  GRAB_MOVE_TOLERANCE_PX: 22,
  TAP_MAX_DURATION_MS: 280,
  TAP_MAX_DISTANCE_PX: 16,
  // Slightly longer window because a finger's wiggle frequency is
  // lower than the mouse-cursor speed the desktop constants assume.
  TICKLE_WINDOW_MS: 700,
  // Three reversals is enough for a clearly-back-and-forth finger;
  // four required mouse precision few touch users can produce.
  TICKLE_MIN_REVERSALS: 3,
  // 10 px ignores normal sample noise but still lets a real wiggle
  // produce a sample every other frame.
  TICKLE_MIN_STEP_PX: 10,
} as const;

// ─── Multi-touch / pressure tunables (mobile only) ────────────────────
//
// Two-finger pinch on a touch screen is what users naturally try first
// for the `pinch` verb — the desktop's right-click path can't translate.
// We don't try to be a fully-general pinch detector: a quick squeeze
// over an identifiable body region is all the persona needs, and the
// looser thresholds keep false positives down when the user happens to
// land two fingers while tickling.
const PINCH_MIN_INITIAL_DISTANCE_PX = 40;
const PINCH_MIN_SHRINK_RATIO = 0.78;
const PINCH_MIN_TRAVEL_PX = 30;
const PINCH_MAX_DURATION_MS = 1200;
/**
 * Pressure threshold (0…1) above which a touch is treated as a "firm"
 * press for caress→grab promotion. Many devices report 0 (no sensor)
 * or 1.0 (synthetic / non-pressure-sensitive) — we ignore both via the
 * `> 0 && < 1` guard before applying the override.
 */
const FIRM_PRESS_THRESHOLD = 0.65;

// ─── Region table ────────────────────────────────────────────────────
//
// Wording is deliberately clinical / locative — we never emit slang or
// explicit body-part words. Reaction tone is what carries intent; the
// persona prompt knows to read tone='ticklish' as "squirm and laugh".

type Vec3 = readonly [number, number, number];

interface RegionAxis {
  readonly from: VRMHumanBoneName;
  readonly to: VRMHumanBoneName;
}

type RegionEntry =
  | {
      kind: 'bone';
      label: GestureTarget;
      tone: GestureTone;
      bone: VRMHumanBoneName;
      /** Fallback bone tried if `bone` isn't on the loaded rig. */
      fallback?: VRMHumanBoneName;
      /** Sphere radius in metres. */
      radius: number;
      strokeable?: boolean;
      axis?: RegionAxis;
    }
  | {
      kind: 'offset';
      label: GestureTarget;
      tone: GestureTone;
      parent: VRMHumanBoneName;
      fallback?: VRMHumanBoneName;
      /** Offset in the parent bone's local space, metres. */
      offset: Vec3;
      radius: number;
      strokeable?: boolean;
    }
  | {
      kind: 'midpoint';
      label: GestureTarget;
      tone: GestureTone;
      from: VRMHumanBoneName;
      to: VRMHumanBoneName;
      radius: number;
      strokeable?: boolean;
    };

// Built statically. Per-frame the projector resolves bone refs and skips
// any region whose bones aren't present on the loaded VRM (the optional
// VRM 1.0 bones — UpperChest, Shoulder, Toes — are common but not
// guaranteed, and the finger bones are sometimes absent on simplified
// rigs).
const REGION_TABLE: readonly RegionEntry[] = [
  // ── Head / face (Head bone is mandatory in VRM, so all of these resolve)
  { kind: 'offset', label: 'top of head', tone: 'affectionate', parent: VRMHumanBoneName.Head, offset: [0, 0.10, 0], radius: 0.06 },
  { kind: 'offset', label: 'forehead', tone: 'affectionate', parent: VRMHumanBoneName.Head, offset: [0, 0.055, 0.07], radius: 0.05 },
  { kind: 'offset', label: 'left temple', tone: 'casual', parent: VRMHumanBoneName.Head, offset: [0.06, 0.035, 0.025], radius: 0.04 },
  { kind: 'offset', label: 'right temple', tone: 'casual', parent: VRMHumanBoneName.Head, offset: [-0.06, 0.035, 0.025], radius: 0.04 },
  { kind: 'offset', label: 'left cheek', tone: 'affectionate', parent: VRMHumanBoneName.Head, offset: [0.045, -0.02, 0.06], radius: 0.04 },
  { kind: 'offset', label: 'right cheek', tone: 'affectionate', parent: VRMHumanBoneName.Head, offset: [-0.045, -0.02, 0.06], radius: 0.04 },
  { kind: 'offset', label: 'nose', tone: 'casual', parent: VRMHumanBoneName.Head, offset: [0, -0.035, 0.085], radius: 0.025 },
  { kind: 'offset', label: 'left ear', tone: 'shy', parent: VRMHumanBoneName.Head, offset: [0.075, 0.01, -0.005], radius: 0.032 },
  { kind: 'offset', label: 'right ear', tone: 'shy', parent: VRMHumanBoneName.Head, offset: [-0.075, 0.01, -0.005], radius: 0.032 },
  { kind: 'offset', label: 'lips', tone: 'shy', parent: VRMHumanBoneName.Head, offset: [0, -0.055, 0.075], radius: 0.022 },
  { kind: 'offset', label: 'chin', tone: 'casual', parent: VRMHumanBoneName.Head, offset: [0, -0.085, 0.05], radius: 0.03 },
  { kind: 'offset', label: 'back of head', tone: 'affectionate', parent: VRMHumanBoneName.Head, offset: [0, 0.04, -0.08], radius: 0.06 },
  { kind: 'offset', label: 'nape of neck', tone: 'ticklish', parent: VRMHumanBoneName.Head, offset: [0, -0.10, -0.04], radius: 0.04 },

  // ── Neck / torso  (UpperChest is optional → Chest is the fallback;
  //                   Chest is optional → Spine fallback; Spine + Hips
  //                   are mandatory)
  { kind: 'offset', label: 'front of neck', tone: 'ticklish', parent: VRMHumanBoneName.Neck, fallback: VRMHumanBoneName.Head, offset: [0, 0, 0.05], radius: 0.04 },
  { kind: 'bone', label: 'left shoulder', tone: 'casual', bone: VRMHumanBoneName.LeftShoulder, fallback: VRMHumanBoneName.LeftUpperArm, radius: 0.06 },
  { kind: 'bone', label: 'right shoulder', tone: 'casual', bone: VRMHumanBoneName.RightShoulder, fallback: VRMHumanBoneName.RightUpperArm, radius: 0.06 },
  { kind: 'offset', label: 'collarbone', tone: 'shy', parent: VRMHumanBoneName.UpperChest, fallback: VRMHumanBoneName.Chest, offset: [0, 0.05, 0.06], radius: 0.05 },
  { kind: 'offset', label: 'upper chest', tone: 'shy', parent: VRMHumanBoneName.UpperChest, fallback: VRMHumanBoneName.Chest, offset: [0, 0.02, 0.08], radius: 0.05 },
  { kind: 'offset', label: 'left side', tone: 'ticklish', parent: VRMHumanBoneName.Chest, fallback: VRMHumanBoneName.Spine, offset: [0.10, -0.04, 0], radius: 0.05 },
  { kind: 'offset', label: 'right side', tone: 'ticklish', parent: VRMHumanBoneName.Chest, fallback: VRMHumanBoneName.Spine, offset: [-0.10, -0.04, 0], radius: 0.05 },
  { kind: 'offset', label: 'stomach', tone: 'ticklish', parent: VRMHumanBoneName.Spine, fallback: VRMHumanBoneName.Hips, offset: [0, -0.04, 0.07], radius: 0.06 },
  { kind: 'offset', label: 'upper back', tone: 'casual', parent: VRMHumanBoneName.Chest, fallback: VRMHumanBoneName.UpperChest, offset: [0, 0, -0.07], radius: 0.07 },
  { kind: 'offset', label: 'lower back', tone: 'ticklish', parent: VRMHumanBoneName.Spine, fallback: VRMHumanBoneName.Hips, offset: [0, 0, -0.07], radius: 0.06 },

  // ── Arms — midpoints + bone-anchored at joints
  { kind: 'midpoint', label: 'left upper arm', tone: 'casual', from: VRMHumanBoneName.LeftUpperArm, to: VRMHumanBoneName.LeftLowerArm, radius: 0.06, strokeable: true },
  { kind: 'midpoint', label: 'right upper arm', tone: 'casual', from: VRMHumanBoneName.RightUpperArm, to: VRMHumanBoneName.RightLowerArm, radius: 0.06, strokeable: true },
  { kind: 'bone', label: 'left elbow', tone: 'casual', bone: VRMHumanBoneName.LeftLowerArm, radius: 0.045 },
  { kind: 'bone', label: 'right elbow', tone: 'casual', bone: VRMHumanBoneName.RightLowerArm, radius: 0.045 },
  { kind: 'midpoint', label: 'left forearm', tone: 'casual', from: VRMHumanBoneName.LeftLowerArm, to: VRMHumanBoneName.LeftHand, radius: 0.05, strokeable: true },
  { kind: 'midpoint', label: 'right forearm', tone: 'casual', from: VRMHumanBoneName.RightLowerArm, to: VRMHumanBoneName.RightHand, radius: 0.05, strokeable: true },
  { kind: 'bone', label: 'left palm', tone: 'ticklish', bone: VRMHumanBoneName.LeftHand, radius: 0.045 },
  { kind: 'bone', label: 'right palm', tone: 'ticklish', bone: VRMHumanBoneName.RightHand, radius: 0.045 },

  // ── Fingers — distal bones (sometimes absent on simplified rigs;
  //              skipped silently when resolveBone returns null)
  { kind: 'bone', label: 'left thumb', tone: 'ticklish', bone: VRMHumanBoneName.LeftThumbDistal, fallback: VRMHumanBoneName.LeftThumbProximal, radius: 0.018 },
  { kind: 'bone', label: 'left index finger', tone: 'ticklish', bone: VRMHumanBoneName.LeftIndexDistal, fallback: VRMHumanBoneName.LeftIndexProximal, radius: 0.018 },
  { kind: 'bone', label: 'left middle finger', tone: 'ticklish', bone: VRMHumanBoneName.LeftMiddleDistal, fallback: VRMHumanBoneName.LeftMiddleProximal, radius: 0.018 },
  { kind: 'bone', label: 'left ring finger', tone: 'ticklish', bone: VRMHumanBoneName.LeftRingDistal, fallback: VRMHumanBoneName.LeftRingProximal, radius: 0.018 },
  { kind: 'bone', label: 'left little finger', tone: 'ticklish', bone: VRMHumanBoneName.LeftLittleDistal, fallback: VRMHumanBoneName.LeftLittleProximal, radius: 0.018 },
  { kind: 'bone', label: 'right thumb', tone: 'ticklish', bone: VRMHumanBoneName.RightThumbDistal, fallback: VRMHumanBoneName.RightThumbProximal, radius: 0.018 },
  { kind: 'bone', label: 'right index finger', tone: 'ticklish', bone: VRMHumanBoneName.RightIndexDistal, fallback: VRMHumanBoneName.RightIndexProximal, radius: 0.018 },
  { kind: 'bone', label: 'right middle finger', tone: 'ticklish', bone: VRMHumanBoneName.RightMiddleDistal, fallback: VRMHumanBoneName.RightMiddleProximal, radius: 0.018 },
  { kind: 'bone', label: 'right ring finger', tone: 'ticklish', bone: VRMHumanBoneName.RightRingDistal, fallback: VRMHumanBoneName.RightRingProximal, radius: 0.018 },
  { kind: 'bone', label: 'right little finger', tone: 'ticklish', bone: VRMHumanBoneName.RightLittleDistal, fallback: VRMHumanBoneName.RightLittleProximal, radius: 0.018 },

  // ── Legs
  { kind: 'midpoint', label: 'left thigh', tone: 'casual', from: VRMHumanBoneName.LeftUpperLeg, to: VRMHumanBoneName.LeftLowerLeg, radius: 0.08, strokeable: true },
  { kind: 'midpoint', label: 'right thigh', tone: 'casual', from: VRMHumanBoneName.RightUpperLeg, to: VRMHumanBoneName.RightLowerLeg, radius: 0.08, strokeable: true },
  { kind: 'bone', label: 'left knee', tone: 'casual', bone: VRMHumanBoneName.LeftLowerLeg, radius: 0.05 },
  { kind: 'bone', label: 'right knee', tone: 'casual', bone: VRMHumanBoneName.RightLowerLeg, radius: 0.05 },
  { kind: 'midpoint', label: 'left shin', tone: 'casual', from: VRMHumanBoneName.LeftLowerLeg, to: VRMHumanBoneName.LeftFoot, radius: 0.05, strokeable: true },
  { kind: 'midpoint', label: 'right shin', tone: 'casual', from: VRMHumanBoneName.RightLowerLeg, to: VRMHumanBoneName.RightFoot, radius: 0.05, strokeable: true },
  { kind: 'offset', label: 'left calf', tone: 'ticklish', parent: VRMHumanBoneName.LeftLowerLeg, offset: [0, -0.13, -0.04], radius: 0.045 },
  { kind: 'offset', label: 'right calf', tone: 'ticklish', parent: VRMHumanBoneName.RightLowerLeg, offset: [0, -0.13, -0.04], radius: 0.045 },
  { kind: 'bone', label: 'left ankle', tone: 'casual', bone: VRMHumanBoneName.LeftFoot, radius: 0.04 },
  { kind: 'bone', label: 'right ankle', tone: 'casual', bone: VRMHumanBoneName.RightFoot, radius: 0.04 },
  { kind: 'midpoint', label: 'left foot', tone: 'ticklish', from: VRMHumanBoneName.LeftFoot, to: VRMHumanBoneName.LeftToes, radius: 0.05 },
  { kind: 'midpoint', label: 'right foot', tone: 'ticklish', from: VRMHumanBoneName.RightFoot, to: VRMHumanBoneName.RightToes, radius: 0.05 },
  { kind: 'bone', label: 'left toes', tone: 'ticklish', bone: VRMHumanBoneName.LeftToes, fallback: VRMHumanBoneName.LeftFoot, radius: 0.025 },
  { kind: 'bone', label: 'right toes', tone: 'ticklish', bone: VRMHumanBoneName.RightToes, fallback: VRMHumanBoneName.RightFoot, radius: 0.025 },
];

// ─── Soft parts (spring-bone discovery) ──────────────────────────────

/** Discovered chain — projected per frame via the live joint bone refs. */
interface SoftPartChain {
  label: GestureTarget;
  tone: GestureTone;
  bones: THREE.Object3D[];
  /**
   * Per-chain radius in metres, derived from how many joints the chain
   * has. Longer chains get larger hit radii so single ponytails stay
   * tappable end-to-end.
   */
  radius: number;
  /** Soft parts are tug-eligible — the user can pull on hair/skirt. */
  tug: boolean;
}

const HAIR_REGEX = /hair|髪|fringe|bang|tail|ponytail|braid|kami/i;
const SKIRT_REGEX = /skirt|スカート|dress|hem|coattail|frill/i;
const RIBBON_REGEX = /ribbon|bow|necktie|choker/i;

function discoverSoftParts(vrm: VRM): SoftPartChain[] {
  const manager = vrm.springBoneManager;
  if (!manager) return [];

  const head = vrm.humanoid?.getNormalizedBoneNode(VRMHumanBoneName.Head);
  const hips = vrm.humanoid?.getNormalizedBoneNode(VRMHumanBoneName.Hips);

  // Build a set of joint-owned bones so we can identify chain roots
  // (a chain root = the first ancestor of a joint bone that is NOT
  // itself a joint).
  const jointBones = new Set<THREE.Object3D>();
  for (const j of manager.joints) jointBones.add(j.bone);

  function chainRoot(bone: THREE.Object3D): THREE.Object3D {
    let cur = bone;
    while (cur.parent && jointBones.has(cur.parent)) cur = cur.parent;
    return cur;
  }

  const grouped = new Map<THREE.Object3D, THREE.Object3D[]>();
  for (const j of manager.joints) {
    const root = chainRoot(j.bone);
    const bones = grouped.get(root);
    if (bones) bones.push(j.bone);
    else grouped.set(root, [j.bone]);
  }

  type RawChain = { root: THREE.Object3D; bones: THREE.Object3D[]; category: 'hair' | 'skirt' | 'ribbon' };
  const rawHair: RawChain[] = [];
  const rawSkirt: RawChain[] = [];
  const rawRibbon: RawChain[] = [];

  for (const [root, bones] of grouped) {
    const names = [root.name, ...bones.map((b) => b.name)].join(' ');
    if (HAIR_REGEX.test(names)) rawHair.push({ root, bones, category: 'hair' });
    else if (SKIRT_REGEX.test(names)) rawSkirt.push({ root, bones, category: 'skirt' });
    else if (RIBBON_REGEX.test(names)) rawRibbon.push({ root, bones, category: 'ribbon' });
  }

  const out: SoftPartChain[] = [];
  out.push(...classifyHairChains(rawHair, head));
  out.push(...classifySkirtChains(rawSkirt, hips));
  if (rawRibbon.length > 0) {
    // Combine all ribbons into one umbrella region — they're usually small.
    out.push({
      label: 'ribbon',
      tone: 'affectionate',
      bones: rawRibbon.flatMap((c) => c.bones),
      radius: 0.04,
      tug: true,
    });
  }
  return out;
}

function classifyHairChains(
  chains: { root: THREE.Object3D; bones: THREE.Object3D[] }[],
  head: THREE.Object3D | null | undefined,
): SoftPartChain[] {
  if (chains.length === 0) return [];
  // Classify each chain by its root's position relative to the head
  // bone. Front/back uses Z; left/right uses X; ponytail vs side-hair
  // uses Y (a chain that hangs down well below the head is a ponytail).
  type Bucket = 'front' | 'back' | 'leftSide' | 'rightSide' | 'leftPonytail' | 'rightPonytail';
  const buckets = new Map<Bucket, THREE.Object3D[]>();

  const headWorld = new THREE.Vector3();
  if (head) head.getWorldPosition(headWorld);

  for (const chain of chains) {
    const rootPos = new THREE.Vector3();
    chain.root.getWorldPosition(rootPos);
    const local = head ? new THREE.Vector3().subVectors(rootPos, headWorld) : rootPos;
    // Heuristic thresholds: VRMs are scaled to ~1.7m tall, so 0.1m is
    // meaningful spatial separation.
    let bucket: Bucket;
    if (local.y < -0.20) {
      // Hangs well below the head — probably a ponytail / twintail.
      bucket = local.x >= 0 ? 'leftPonytail' : 'rightPonytail';
    } else if (Math.abs(local.x) > 0.07) {
      bucket = local.x > 0 ? 'leftSide' : 'rightSide';
    } else if (local.z > 0.02) {
      bucket = 'front';
    } else {
      bucket = 'back';
    }
    const existing = buckets.get(bucket);
    if (existing) existing.push(...chain.bones);
    else buckets.set(bucket, [...chain.bones]);
  }

  const BUCKET_LABELS: Record<Bucket, GestureTarget> = {
    front: 'front hair',
    back: 'back hair',
    leftSide: 'left side hair',
    rightSide: 'right side hair',
    leftPonytail: 'left ponytail',
    rightPonytail: 'right ponytail',
  };

  const out: SoftPartChain[] = [];
  for (const [bucket, bones] of buckets) {
    // Radius scales with chain length: 0.04 for ~3 bones, up to 0.08
    // for a 12-bone twintail.
    const r = THREE.MathUtils.clamp(0.03 + bones.length * 0.004, 0.04, 0.09);
    out.push({
      label: BUCKET_LABELS[bucket],
      tone: 'affectionate',
      bones,
      radius: r,
      tug: true,
    });
  }
  return out;
}

function classifySkirtChains(
  chains: { root: THREE.Object3D; bones: THREE.Object3D[] }[],
  hips: THREE.Object3D | null | undefined,
): SoftPartChain[] {
  if (chains.length === 0) return [];
  // Skirt classification is coarser — most VRMs export skirt chains
  // radially around the hip but the operator just wants "skirt" as a
  // tug target. Split into front/back if there are at least 4 chains;
  // otherwise merge into a single 'skirt' label.
  const allBones: THREE.Object3D[] = [];
  for (const c of chains) allBones.push(...c.bones);
  if (chains.length < 4) {
    return [
      {
        label: 'skirt',
        tone: 'shy',
        bones: allBones,
        radius: 0.10,
        tug: true,
      },
    ];
  }
  const hipsWorld = new THREE.Vector3();
  if (hips) hips.getWorldPosition(hipsWorld);
  const front: THREE.Object3D[] = [];
  const back: THREE.Object3D[] = [];
  for (const chain of chains) {
    const rootPos = new THREE.Vector3();
    chain.root.getWorldPosition(rootPos);
    const dz = hips ? rootPos.z - hipsWorld.z : rootPos.z;
    if (dz >= 0) front.push(...chain.bones);
    else back.push(...chain.bones);
  }
  const out: SoftPartChain[] = [];
  if (front.length) out.push({ label: 'skirt', tone: 'shy', bones: front, radius: 0.10, tug: true });
  if (back.length) out.push({ label: 'skirt hem', tone: 'shy', bones: back, radius: 0.10, tug: true });
  return out;
}

// ─── Hit-testing ─────────────────────────────────────────────────────

interface ProjectionContext {
  canvas: HTMLCanvasElement;
  camera: THREE.PerspectiveCamera;
}

interface HitResult {
  label: GestureTarget;
  tone: GestureTone;
  distance: number;
  /**
   * Bone-axis vector in pixel space at the moment of hit — used by
   * stroke to score motion alignment. `null` if the region isn't
   * strokeable (most aren't).
   */
  axisPx?: { dx: number; dy: number };
  /** Pixel centroid of the matched region — used by tug to score "drag away". */
  centerPx: { x: number; y: number };
  /** Soft parts allow `tug`; humanoid regions don't. */
  tug: boolean;
}

/**
 * Resolve a humanoid bone, falling back to a parent bone if the
 * primary isn't present on the loaded rig.
 */
function resolveBone(vrm: VRM, primary: VRMHumanBoneName, fallback?: VRMHumanBoneName): THREE.Object3D | null {
  const direct = vrm.humanoid?.getNormalizedBoneNode(primary) ?? null;
  if (direct) return direct;
  if (fallback) return vrm.humanoid?.getNormalizedBoneNode(fallback) ?? null;
  return null;
}

function projectToPixels(world: THREE.Vector3, ctx: ProjectionContext, out: { x: number; y: number }): void {
  // `Vector3.project` returns NDC in [-1, +1]; convert to client pixels
  // using the canvas' DOM rect so cursor coordinates line up regardless
  // of the renderer's pixel ratio.
  const v = world.clone().project(ctx.camera);
  const rect = ctx.canvas.getBoundingClientRect();
  out.x = (v.x * 0.5 + 0.5) * rect.width + rect.left;
  out.y = (-v.y * 0.5 + 0.5) * rect.height + rect.top;
}

const _tmpWorld = new THREE.Vector3();
const _tmpOffset = new THREE.Vector3();
const _tmpFrom = new THREE.Vector3();
const _tmpTo = new THREE.Vector3();
const _tmpCenter = { x: 0, y: 0 };
const _tmpOffsetPx = { x: 0, y: 0 };
const _tmpAxisPx = { x: 0, y: 0 };

function computeEntryCenter(vrm: VRM, entry: RegionEntry): { world: THREE.Vector3; axisWorld?: THREE.Vector3 } | null {
  if (entry.kind === 'bone') {
    const bone = resolveBone(vrm, entry.bone, entry.fallback);
    if (!bone) return null;
    bone.getWorldPosition(_tmpWorld);
    if (entry.axis) {
      const from = resolveBone(vrm, entry.axis.from);
      const to = resolveBone(vrm, entry.axis.to);
      if (from && to) {
        from.getWorldPosition(_tmpFrom);
        to.getWorldPosition(_tmpTo);
        return { world: _tmpWorld.clone(), axisWorld: new THREE.Vector3().subVectors(_tmpTo, _tmpFrom) };
      }
    }
    return { world: _tmpWorld.clone() };
  }
  if (entry.kind === 'offset') {
    const parent = resolveBone(vrm, entry.parent, entry.fallback);
    if (!parent) return null;
    parent.updateWorldMatrix(true, false);
    _tmpOffset.set(entry.offset[0], entry.offset[1], entry.offset[2]).applyMatrix4(parent.matrixWorld);
    return { world: _tmpOffset.clone() };
  }
  // midpoint
  const from = resolveBone(vrm, entry.from);
  const to = resolveBone(vrm, entry.to);
  if (!from || !to) return null;
  from.getWorldPosition(_tmpFrom);
  to.getWorldPosition(_tmpTo);
  const mid = new THREE.Vector3().addVectors(_tmpFrom, _tmpTo).multiplyScalar(0.5);
  return { world: mid, axisWorld: new THREE.Vector3().subVectors(_tmpTo, _tmpFrom) };
}

function softPartCentroidWorld(chain: SoftPartChain): THREE.Vector3 | null {
  if (chain.bones.length === 0) return null;
  const acc = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  for (const b of chain.bones) {
    b.getWorldPosition(tmp);
    acc.add(tmp);
  }
  acc.multiplyScalar(1 / chain.bones.length);
  return acc;
}

/**
 * Project a sibling point offset by `radiusM` metres along screen-X and
 * report the resulting pixel-space radius. This makes the hit zone
 * scale with depth automatically.
 */
function pixelRadiusForCenter(centerWorld: THREE.Vector3, radiusM: number, ctx: ProjectionContext, center: { x: number; y: number }): number {
  _tmpOffset.copy(centerWorld).add(new THREE.Vector3(radiusM, 0, 0));
  projectToPixels(_tmpOffset, ctx, _tmpOffsetPx);
  return Math.hypot(_tmpOffsetPx.x - center.x, _tmpOffsetPx.y - center.y);
}

// ─── Controller ──────────────────────────────────────────────────────

export interface GestureControllerOptions {
  canvas: HTMLCanvasElement;
  camera: THREE.PerspectiveCamera;
  vrm: VRM;
  onGesture: (event: GestureEvent) => void;
  prefs: GesturePrefs;
  /**
   * 'desktop' (default) keeps the original behaviour — Alt-drag is
   * reserved for the frameless window move, no-press hover dwell
   * triggers caress, and a long-press hold triggers grab.
   *
   * 'mobile' (Phase M-2.5) drops the Alt check entirely (touch
   * screens have no modifier keys), repurposes the long-press hold
   * to fire `caress` at the dwell threshold (touchscreens have no
   * "hover without press" state), and enables off-body swipe-up
   * detection that calls `onOpenHistory` when present. Phase M-2.8
   * additionally turns on real two-finger pinch detection, mobile-
   * tuned tap/grab thresholds, pressure/ellipse classification, and
   * lets the per-drag tickle ring fire (the desktop branch leaves
   * it suspended during an active drag because the cursor is
   * implicitly tracked).
   */
  platform?: 'desktop' | 'mobile';
  /**
   * Mobile-only callback. Invoked when the user starts a touch
   * outside any body region in the lower portion of the canvas and
   * drags upward past [SWIPE_OPEN_MIN_PATH_PX]. Wire to the native
   * host's "open history" action (see `MioAvatarBridge.kt`).
   */
  onOpenHistory?: () => void;
  /**
   * Mobile-only (M-2.8) — fired the moment a gesture is emitted, so
   * the host can vibrate the device for tactile "the touch landed"
   * feedback. The receiver is expected to throttle / gate on user
   * pref; this controller fires it unconditionally on every emission.
   */
  onHaptic?: (kind: GestureKind) => void;
}

/** M-2.5 mobile swipe-up tunables — share with caress dwell for parity. */
const SWIPE_OPEN_MIN_PATH_PX = 80;
const SWIPE_OPEN_MIN_DY_PX = 60;
/** Only treat off-body drags that start in the bottom 40% as swipe-up candidates. */
const SWIPE_OPEN_START_RATIO = 0.6;

interface TrackingState {
  region: HitResult;
  pointerId: number;
  startX: number;
  startY: number;
  startTime: number;
  /** Cumulative path length since pointerdown, pixels. */
  pathLength: number;
  /** Cumulative motion vector since pointerdown (pixels). */
  netDx: number;
  netDy: number;
  /** Last pointer position seen during this drag. */
  lastX: number;
  lastY: number;
  /**
   * Mobile-only: peak normalized pressure (0…1) seen during the drag.
   * `0` means "no useful pressure data" (synthetic / non-pressure
   * device); use [peakPressureValid] before trusting the reading.
   */
  peakPressure: number;
  peakPressureValid: boolean;
  /**
   * Mobile-only: largest reported touch ellipse radius (the larger of
   * `event.width` and `event.height`, halved) seen during the drag.
   * Used to inflate jitter tolerances under chunky-finger contacts.
   */
  maxTouchRadius: number;
  /** Once a gesture has fired for this drag we suppress further fires until pointerup. */
  consumed: boolean;
  /** Pending grab timer; cleared when we move > tolerance or fire something. */
  grabTimer: number | null;
}

/**
 * M-2.8 mobile — per-pointer record used by the multi-touch pinch
 * detector. We track every active touch (not just the first) so that
 * the second finger landing on the canvas can pair with the first into
 * a [PinchState] without losing whichever finger was nominally the
 * "tracking" pointer.
 */
interface PointerSample {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startTime: number;
}

/**
 * M-2.8 mobile — active two-finger squeeze. Created when a second
 * pointer arrives over the canvas while the first is still down;
 * cleared when either pointer lifts. While present, the single-pointer
 * tracking state is suspended (`consumed = true`) so stroke/tug/poke
 * don't double-emit on the way out of the pinch.
 */
interface PinchState {
  primaryId: number;
  secondaryId: number;
  initialDistance: number;
  /** Smallest inter-pointer distance seen so far, for the shrink test. */
  minDistance: number;
  startTime: number;
  /** Body region resolved at pinch start (midpoint), `null` if off-body. */
  label: GestureTarget | null;
  tone: GestureTone;
  fired: boolean;
}

/**
 * M-2.5 mobile — off-body drag tracker for the swipe-up history
 * shortcut. We only allocate this when a touch lands outside any
 * region in the lower portion of the canvas; if the gesture turns
 * into an upward swipe we fire `onOpenHistory` and the state is
 * cleared.
 */
interface SwipeOpenState {
  startX: number;
  startY: number;
  netDx: number;
  netDy: number;
  pathLength: number;
  lastX: number;
  lastY: number;
  fired: boolean;
}

interface TickleSample {
  t: number;
  dx: number;
  dy: number;
}

export class GestureController {
  private readonly canvas: HTMLCanvasElement;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly vrm: VRM;
  private readonly emit: (event: GestureEvent) => void;
  private readonly platform: 'desktop' | 'mobile';
  private readonly emitOpenHistory: (() => void) | null;
  private readonly emitHaptic: ((kind: GestureKind) => void) | null;
  /** Resolved tap/drag/tickle thresholds — picked once at construction. */
  private readonly tuning: typeof DESKTOP_TUNING | typeof MOBILE_TUNING;
  private prefs: GesturePrefs;

  private softParts: SoftPartChain[] = [];

  // Hover (caress) state — desktop-only; mobile fires caress from the
  // press-and-hold timer in `tracking` instead.
  private hoverLabel: GestureTarget | null = null;
  private hoverSince = 0;
  private overBody = false;

  // Per-(kind, label) cooldown buckets
  private lastFiredAt = new Map<string, number>();

  // Tap memory for pat detection
  private lastTap: { time: number; label: GestureTarget; tone: GestureTone } | null = null;

  // Active drag tracking (left-button)
  private tracking: TrackingState | null = null;

  // Active off-body swipe tracking (mobile only). Lives in parallel with
  // `tracking` — never both set, because a touch either hit a body
  // region OR it didn't.
  private swipe: SwipeOpenState | null = null;

  // M-2.8 mobile — every active touch pointer, keyed by `pointerId`.
  // Populated for both `'touch'` and `'pen'` input types so a stylus
  // pinch still works. The desktop branch only ever has one entry
  // (the mouse), so `pinch` stays unreachable there without the
  // dedicated context-menu path.
  private activePointers = new Map<number, PointerSample>();
  private pinch: PinchState | null = null;

  // Tickle ring buffer (per region — when region changes we flush)
  private tickleSamples: TickleSample[] = [];
  private tickleRegion: GestureTarget | null = null;
  private prevX: number | null = null;
  private prevY: number | null = null;

  private disposed = false;

  constructor(opts: GestureControllerOptions) {
    this.canvas = opts.canvas;
    this.camera = opts.camera;
    this.vrm = opts.vrm;
    this.emit = opts.onGesture;
    this.platform = opts.platform ?? 'desktop';
    this.emitOpenHistory = opts.onOpenHistory ?? null;
    this.emitHaptic = opts.onHaptic ?? null;
    this.tuning = this.platform === 'mobile' ? MOBILE_TUNING : DESKTOP_TUNING;
    this.prefs = opts.prefs;
    this.softParts = discoverSoftParts(this.vrm);

    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerCancel);
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  dispose(): void {
    this.disposed = true;
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.clearTracking();
    this.activePointers.clear();
    this.pinch = null;
    this.canvas.classList.remove('over-body');
  }

  setPrefs(prefs: GesturePrefs): void {
    this.prefs = prefs;
  }

  // ─── Pointer wiring ────────────────────────────────────────────────

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.disposed || !this.prefs.gesturesEnabled) return;
    // Alt + pointer drag is reserved for window-move on desktop — see
    // avatar/main.ts. Touchscreens have no Alt key, so we never reach
    // this branch on mobile.
    if (this.platform === 'desktop' && event.altKey) {
      this.resetHover();
      return;
    }

    // M-2.8 — keep the per-pointer map in sync BEFORE we run any
    // detector so the pinch path sees the latest positions even when
    // the event below early-returns.
    this.recordPointerSample(event);

    const ctx: ProjectionContext = { canvas: this.canvas, camera: this.camera };
    const hit = this.bestHit(event.clientX, event.clientY, ctx);

    const nowOverBody = hit !== null;
    if (nowOverBody !== this.overBody) {
      this.overBody = nowOverBody;
      this.canvas.classList.toggle('over-body', nowOverBody);
    }

    const now = performance.now();

    // M-2.8 mobile — active two-finger pinch. Fires once when the
    // squeeze passes the shrink + travel thresholds; subsequent
    // moves are absorbed silently until both fingers lift. Suspends
    // the single-pointer tracking path while live (the body tracking
    // pointer was the first finger of the pinch).
    if (this.pinch) {
      this.updatePinch(now);
      // Hover dwell makes no sense mid-pinch; clear it.
      this.resetHover();
      return;
    }

    // M-2.5 — off-body upward drag becomes the "open chat history"
    // shortcut. Runs in parallel with body tracking so the user can
    // still poke/stroke the avatar without arming this path.
    if (this.swipe && this.emitOpenHistory) {
      const s = this.swipe;
      const dx = event.clientX - s.lastX;
      const dy = event.clientY - s.lastY;
      s.lastX = event.clientX;
      s.lastY = event.clientY;
      s.pathLength += Math.hypot(dx, dy);
      s.netDx += dx;
      s.netDy += dy;
      if (
        !s.fired &&
        s.pathLength >= SWIPE_OPEN_MIN_PATH_PX &&
        s.netDy <= -SWIPE_OPEN_MIN_DY_PX &&
        Math.abs(s.netDy) > Math.abs(s.netDx)
      ) {
        s.fired = true;
        this.emitOpenHistory();
      }
      // While the swipe path is live we don't double-dip on body
      // tracking; the next pointerup clears `swipe`.
      return;
    }

    // Update tracking (active left-button drag) — independent of the
    // caress dwell timer, which only ticks when no button is pressed.
    if (this.tracking && event.pointerId === this.tracking.pointerId) {
      const t = this.tracking;
      const dx = event.clientX - t.lastX;
      const dy = event.clientY - t.lastY;
      t.lastX = event.clientX;
      t.lastY = event.clientY;
      t.pathLength += Math.hypot(dx, dy);
      t.netDx += dx;
      t.netDy += dy;
      // Roll the per-drag peak pressure / contact size so the pointer-
      // up classifier can read "was this a firm press throughout?".
      this.absorbTouchProfile(event, t);

      // Mobile widens the dwell-cancel radius by the touch contact
      // diameter — a chunky finger reports more drift than a precise
      // mouse cursor, but only when the OS gave us a real ellipse.
      const tolerance = this.tuning.GRAB_MOVE_TOLERANCE_PX + t.maxTouchRadius;
      const distFromStart = Math.hypot(t.lastX - t.startX, t.lastY - t.startY);
      if (distFromStart > tolerance && t.grabTimer !== null) {
        window.clearTimeout(t.grabTimer);
        t.grabTimer = null;
      }

      if (!t.consumed) {
        // Tug: soft part + dragged far from the captured chain centroid.
        if (t.region.tug) {
          const awayFromCenter = Math.hypot(
            event.clientX - t.region.centerPx.x,
            event.clientY - t.region.centerPx.y,
          );
          if (awayFromCenter >= TUG_MIN_AWAY_PX) {
            this.fire('tug', t.region.label, t.region.tone);
            t.consumed = true;
          }
        }

        // Stroke: axis must be defined; path long enough; motion aligned.
        if (!t.consumed && t.region.axisPx && t.pathLength >= STROKE_MIN_PATH_PX) {
          const axisMag = Math.hypot(t.region.axisPx.dx, t.region.axisPx.dy);
          const motionMag = Math.hypot(t.netDx, t.netDy);
          if (axisMag > 0 && motionMag > 0) {
            const cos = Math.abs(
              (t.netDx * t.region.axisPx.dx + t.netDy * t.region.axisPx.dy) /
                (axisMag * motionMag),
            );
            if (cos >= STROKE_AXIS_COS_THRESHOLD) {
              this.fire('stroke', t.region.label, t.region.tone);
              t.consumed = true;
            }
          }
        }
      }

      // M-2.8 — on mobile, ALSO pump the tickle ring during an active
      // drag. The desktop branch leaves this to the no-button-pressed
      // hover path; touchscreens have no such state, so without this
      // line `tickle` is unreachable on mobile (a wiggling finger over
      // the body region just early-returns above).
      if (this.platform === 'mobile' && hit && !t.consumed) {
        this.updateTickleRing(event, hit, now);
      }
      // Hover dwell is intentionally suspended during an active drag.
      this.resetHover();
      return;
    }

    // Hover dwell (caress) + tickle bookkeeping. Mobile has no
    // hover-without-press, so the caress dwell is driven by the
    // press-and-hold timer in `onPointerDown` and we don't pump the
    // hover detector here at all.
    if (!hit) {
      this.resetHover();
      this.tickleSamples = [];
      this.tickleRegion = null;
      this.prevX = event.clientX;
      this.prevY = event.clientY;
      return;
    }

    // ── Tickle ring buffer (shared between desktop hover and mobile drag)
    this.updateTickleRing(event, hit, now);

    if (this.platform === 'mobile') {
      // Mobile has no hover-without-press: caress is fired by the
      // press-and-hold dwell timer in `onPointerDown`. We deliberately
      // skip the desktop hover branch here.
      return;
    }

    // ── Caress dwell (desktop)
    if (this.hoverLabel !== hit.label) {
      this.hoverLabel = hit.label;
      this.hoverSince = now;
      return;
    }
    if (now - this.hoverSince < CARESS_DWELL_MS) return;
    if (this.onCooldown('caress', hit.label, now)) return;
    this.fire('caress', hit.label, hit.tone);
    // Bump dwell to infinity so the user has to leave and re-enter.
    this.hoverSince = Number.POSITIVE_INFINITY;
  };

  private updateTickleRing(event: PointerEvent, hit: HitResult, now: number): void {
    if (this.prevX !== null && this.prevY !== null) {
      const stepDx = event.clientX - this.prevX;
      const stepDy = event.clientY - this.prevY;
      const step = Math.hypot(stepDx, stepDy);
      if (step >= this.tuning.TICKLE_MIN_STEP_PX) {
        if (this.tickleRegion !== hit.label) {
          this.tickleSamples = [];
          this.tickleRegion = hit.label;
        }
        this.tickleSamples.push({ t: now, dx: stepDx, dy: stepDy });
        const cutoff = now - this.tuning.TICKLE_WINDOW_MS;
        while (this.tickleSamples.length > 0 && this.tickleSamples[0]!.t < cutoff) {
          this.tickleSamples.shift();
        }
        const reversals = countReversals(this.tickleSamples);
        if (reversals >= this.tuning.TICKLE_MIN_REVERSALS) {
          this.fire('tickle', hit.label, hit.tone);
          this.tickleSamples = [];
          this.resetHover();
        }
      }
    }
    this.prevX = event.clientX;
    this.prevY = event.clientY;
  }

  private readonly onPointerLeave = (event: PointerEvent): void => {
    this.activePointers.delete(event.pointerId);
    this.resetHover();
    this.tickleSamples = [];
    this.tickleRegion = null;
    this.prevX = null;
    this.prevY = null;
    this.swipe = null;
    if (this.overBody) {
      this.overBody = false;
      this.canvas.classList.remove('over-body');
    }
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.disposed || !this.prefs.gesturesEnabled) return;
    // Alt is desktop's window-move modifier; mobile has no Alt key
    // so the check is a no-op there.
    if (this.platform === 'desktop' && event.altKey) return;
    if (event.button !== 0) return; // pinch handled by contextmenu (desktop) / multi-touch (mobile)

    // M-2.8 — remember every active pointer for the multi-touch pinch
    // detector. We track even the first finger here (the tracking
    // state owns it for body-region semantics, but `activePointers`
    // is what `bestPinchPartner` consults to find a peer).
    this.activePointers.set(event.pointerId, {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      startTime: performance.now(),
    });

    // Second pointer on mobile + an active body tracking → arm pinch.
    // Off-body second pointers also arm pinch (so a user can squeeze
    // a soft part where the midpoint lands away from the original
    // tracking center). When the first pointer was off-body
    // (`tracking === null`) we still arm pinch if at least two
    // pointers are now present; the body label resolves to whatever
    // the midpoint sits over (or `null` for an off-body squeeze).
    if (
      this.platform === 'mobile' &&
      this.activePointers.size >= 2 &&
      !this.pinch
    ) {
      this.tryStartPinch(event);
      return;
    }

    const ctx: ProjectionContext = { canvas: this.canvas, camera: this.camera };
    const hit = this.bestHit(event.clientX, event.clientY, ctx);

    if (!hit) {
      // M-2.5 — off-body press in the lower portion of the canvas
      // arms the swipe-up history shortcut. Above the threshold we
      // ignore the press entirely (no body region, no swipe target).
      if (this.platform !== 'mobile' || !this.emitOpenHistory) return;
      const rect = this.canvas.getBoundingClientRect();
      const yRatio = (event.clientY - rect.top) / Math.max(rect.height, 1);
      if (yRatio < SWIPE_OPEN_START_RATIO) return;
      this.swipe = {
        startX: event.clientX,
        startY: event.clientY,
        netDx: 0,
        netDy: 0,
        pathLength: 0,
        lastX: event.clientX,
        lastY: event.clientY,
        fired: false,
      };
      return;
    }

    const now = performance.now();

    // M-2.5 — touchscreens can't differentiate "hovering over the
    // body" from "no body contact", so the desktop's hover-dwell
    // caress doesn't translate. We repurpose the existing
    // press-and-hold timer to fire `caress` at the longer dwell
    // threshold; `grab` is still reachable but uses a quicker
    // settle window. The mobile branch uses caress so a calm hold
    // reads as affection rather than aggression. M-2.8 — a "firm"
    // initial press (`event.pressure` above [FIRM_PRESS_THRESHOLD])
    // promotes the mobile dwell from caress to grab so a hard
    // squeeze reads as grab even before motion begins.
    const firmFromStart = this.isFirmPress(event);
    const dwellKind: GestureKind = this.platform === 'mobile'
      ? (firmFromStart ? 'grab' : 'caress')
      : 'grab';
    const dwellMs = this.platform === 'mobile'
      ? (firmFromStart ? GRAB_HOLD_MS : CARESS_DWELL_MS)
      : GRAB_HOLD_MS;
    // Inflate tolerance by the touch ellipse radius so a chunky-
    // finger contact reports as "still" the way a precise mouse
    // cursor would. Defaults to 0 on desktop (no touch ellipse).
    const initialTouchRadius = touchRadiusFor(event);
    const tolerance = this.tuning.GRAB_MOVE_TOLERANCE_PX + initialTouchRadius;
    const grabTimer = window.setTimeout(() => {
      if (!this.tracking || this.tracking.consumed) return;
      const distFromStart = Math.hypot(
        this.tracking.lastX - this.tracking.startX,
        this.tracking.lastY - this.tracking.startY,
      );
      if (distFromStart > tolerance) return;
      // M-2.8 — late-stage promotion: if the user held still AND the
      // peak pressure during the hold was firm, escalate caress→grab.
      const heldFirm = this.tracking.peakPressureValid &&
        this.tracking.peakPressure >= FIRM_PRESS_THRESHOLD;
      const resolvedKind: GestureKind =
        this.platform === 'mobile' && heldFirm ? 'grab' : dwellKind;
      const resolvedMs = this.platform === 'mobile' && heldFirm
        ? GRAB_HOLD_MS
        : dwellMs;
      // If we discovered firmness only mid-hold and the elapsed
      // dwell hasn't reached the grab threshold yet, reschedule.
      if (
        this.platform === 'mobile' &&
        heldFirm &&
        performance.now() - this.tracking.startTime < resolvedMs
      ) {
        this.tracking.grabTimer = window.setTimeout(
          this.fireDwell(resolvedKind),
          resolvedMs - (performance.now() - this.tracking.startTime),
        );
        return;
      }
      if (!this.onCooldown(resolvedKind, this.tracking.region.label, performance.now())) {
        this.fire(resolvedKind, this.tracking.region.label, this.tracking.region.tone);
      }
      this.tracking.consumed = true;
      this.tracking.grabTimer = null;
    }, dwellMs);

    this.tracking = {
      region: hit,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTime: now,
      pathLength: 0,
      netDx: 0,
      netDy: 0,
      lastX: event.clientX,
      lastY: event.clientY,
      peakPressure: 0,
      peakPressureValid: false,
      maxTouchRadius: initialTouchRadius,
      consumed: false,
      grabTimer,
    };
    // Capture the opening pressure / size sample too.
    this.absorbTouchProfile(event, this.tracking);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.activePointers.delete(event.pointerId);

    // M-2.8 — pinch ends as soon as either finger lifts. We swallow
    // the tap/poke that would otherwise be inferred from the original
    // tracking pointer — a finger that just took part in a squeeze
    // shouldn't also count as a tap on the way up.
    if (this.pinch) {
      const wasPinch = this.pinch;
      this.pinch = null;
      this.clearTracking();
      if (wasPinch.fired) {
        // Pinch already emitted; nothing more to do.
        return;
      }
      // Squeeze never qualified — fall through so the remaining
      // finger can still register a poke / pat on its own pointerup.
      // (We've already cleared tracking, so nothing fires here.)
      return;
    }

    if (this.swipe) {
      // Swipe-up tracking lifecycle ends here regardless of whether
      // it fired. (Released without enough upward travel = silent
      // no-op; that's fine — the user can swipe again.)
      this.swipe = null;
    }
    if (!this.tracking) return;
    if (event.pointerId !== this.tracking.pointerId) return;
    if (event.button !== 0) {
      // Right-button up is handled by contextmenu; do nothing here.
      return;
    }
    const t = this.tracking;
    const now = performance.now();
    if (t.grabTimer !== null) {
      window.clearTimeout(t.grabTimer);
      t.grabTimer = null;
    }

    if (!t.consumed) {
      const distFromStart = Math.hypot(t.lastX - t.startX, t.lastY - t.startY);
      const dur = now - t.startTime;
      // Touch-mode tap radius scales with the contact ellipse — a
      // chunky-finger tap reports more drift than a precise mouse
      // click and shouldn't degrade to a drag-poke for it.
      const tapDistance = this.tuning.TAP_MAX_DISTANCE_PX + t.maxTouchRadius;
      const isTap = distFromStart <= tapDistance && dur <= this.tuning.TAP_MAX_DURATION_MS;
      if (isTap) {
        // M-2.8 — a hard, quick tap on mobile reads as poke directly
        // (no pat-promotion window). Soft taps still go through the
        // double-tap → pat path.
        const firmTap = this.platform === 'mobile' &&
          t.peakPressureValid &&
          t.peakPressure >= FIRM_PRESS_THRESHOLD;
        if (firmTap) {
          this.fire('poke', t.region.label, t.region.tone);
          this.lastTap = null;
        } else if (
          // Pat fires when a second tap lands on same region within window.
          this.lastTap &&
          this.lastTap.label === t.region.label &&
          now - this.lastTap.time <= PAT_WINDOW_MS
        ) {
          this.fire('pat', t.region.label, t.region.tone);
          this.lastTap = null;
        } else {
          // Don't emit poke yet — wait briefly to see if a second tap
          // arrives. If not, the timer below emits poke; if yes, the
          // logic above promotes the pair to pat.
          this.lastTap = { time: now, label: t.region.label, tone: t.region.tone };
          const pendingLabel = t.region.label;
          const pendingTone = t.region.tone;
          window.setTimeout(() => {
            if (
              this.lastTap &&
              this.lastTap.label === pendingLabel &&
              this.lastTap.time + PAT_WINDOW_MS <= performance.now()
            ) {
              if (!this.onCooldown('poke', pendingLabel, performance.now())) {
                this.fire('poke', pendingLabel, pendingTone);
              }
              this.lastTap = null;
            }
          }, PAT_WINDOW_MS + 20);
        }
      } else {
        // Moved enough to not be a tap but didn't trigger stroke or tug.
        // Treat as a poke on the region we were over at pointerup
        // (re-test, since the cursor may have crossed regions).
        const ctx: ProjectionContext = { canvas: this.canvas, camera: this.camera };
        const hit = this.bestHit(event.clientX, event.clientY, ctx);
        const label = hit?.label ?? t.region.label;
        const tone = hit?.tone ?? t.region.tone;
        this.fire('poke', label, tone);
      }
    }

    this.tracking = null;
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    this.activePointers.delete(event.pointerId);
    if (this.pinch &&
      (event.pointerId === this.pinch.primaryId || event.pointerId === this.pinch.secondaryId)
    ) {
      this.pinch = null;
    }
    if (this.tracking && event.pointerId === this.tracking.pointerId) {
      this.clearTracking();
    }
    this.swipe = null;
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    if (this.disposed || !this.prefs.gesturesEnabled) return;
    // Touchscreens don't have a context-menu equivalent (long-press
    // gives caress instead), so we leave this entirely no-op on
    // mobile rather than risk surprise pinch-fires from accessibility
    // shortcuts.
    if (this.platform === 'mobile') return;
    if (event.altKey) return;
    const ctx: ProjectionContext = { canvas: this.canvas, camera: this.camera };
    const hit = this.bestHit(event.clientX, event.clientY, ctx);
    if (!hit) return;
    // Suppress the actual right-click context menu — frameless avatar
    // window has no use for it anyway.
    event.preventDefault();
    this.fire('pinch', hit.label, hit.tone);
  };

  // ─── Hit resolution ────────────────────────────────────────────────

  private bestHit(px: number, py: number, ctx: ProjectionContext): HitResult | null {
    let best: HitResult | null = null;

    // Humanoid regions
    for (const entry of REGION_TABLE) {
      const resolved = computeEntryCenter(this.vrm, entry);
      if (!resolved) continue;
      projectToPixels(resolved.world, ctx, _tmpCenter);
      if (!Number.isFinite(_tmpCenter.x) || !Number.isFinite(_tmpCenter.y)) continue;
      const radius = pixelRadiusForCenter(resolved.world, entry.radius, ctx, _tmpCenter);
      if (radius <= 0) continue;
      const d = Math.hypot(_tmpCenter.x - px, _tmpCenter.y - py);
      if (d > radius) continue;
      if (best && d >= best.distance) continue;

      let axisPx: { dx: number; dy: number } | undefined;
      if (entry.kind !== 'offset' && entry.strokeable && resolved.axisWorld) {
        // Project a sibling point at world + axis to recover the axis
        // direction in pixel space. This handles arbitrary bone rotations.
        _tmpOffset.copy(resolved.world).add(resolved.axisWorld);
        projectToPixels(_tmpOffset, ctx, _tmpAxisPx);
        axisPx = { dx: _tmpAxisPx.x - _tmpCenter.x, dy: _tmpAxisPx.y - _tmpCenter.y };
      }

      best = {
        label: entry.label,
        tone: entry.tone,
        distance: d,
        axisPx,
        centerPx: { x: _tmpCenter.x, y: _tmpCenter.y },
        tug: false,
      };
    }

    // Soft parts (hair / skirt / ribbon)
    for (const chain of this.softParts) {
      const centroid = softPartCentroidWorld(chain);
      if (!centroid) continue;
      projectToPixels(centroid, ctx, _tmpCenter);
      if (!Number.isFinite(_tmpCenter.x) || !Number.isFinite(_tmpCenter.y)) continue;
      const radius = pixelRadiusForCenter(centroid, chain.radius, ctx, _tmpCenter);
      if (radius <= 0) continue;
      const d = Math.hypot(_tmpCenter.x - px, _tmpCenter.y - py);
      if (d > radius) continue;
      if (best && d >= best.distance) continue;
      best = {
        label: chain.label,
        tone: chain.tone,
        distance: d,
        centerPx: { x: _tmpCenter.x, y: _tmpCenter.y },
        tug: chain.tug,
      };
    }

    return best;
  }

  // ─── Firing helpers ────────────────────────────────────────────────

  private fire(kind: GestureKind, label: GestureTarget, tone: GestureTone): void {
    const now = performance.now();
    if (this.onCooldown(kind, label, now)) return;
    this.lastFiredAt.set(`${kind}|${label}`, now);
    this.emit({ kind, target: label, tone });
    // M-2.8 — fire-and-forget haptic. The host decides whether to
    // honour it (mobile pref toggle); we just hand off the verb so the
    // host can pick a different vibration pattern per kind if desired.
    if (this.emitHaptic) {
      try { this.emitHaptic(kind); } catch { /* host's problem */ }
    }
  }

  private onCooldown(kind: GestureKind, label: GestureTarget, now: number): boolean {
    const key = `${kind}|${label}`;
    const last = this.lastFiredAt.get(key) ?? 0;
    return now - last < COOLDOWN_MS[kind];
  }

  private resetHover(): void {
    this.hoverLabel = null;
    this.hoverSince = 0;
  }

  private clearTracking(): void {
    if (this.tracking?.grabTimer !== null && this.tracking?.grabTimer !== undefined) {
      window.clearTimeout(this.tracking.grabTimer);
    }
    this.tracking = null;
  }

  // ─── Multi-touch helpers (M-2.8 mobile) ────────────────────────────

  /** Keep `activePointers` in sync; harmless when the pointer is absent. */
  private recordPointerSample(event: PointerEvent): void {
    const sample = this.activePointers.get(event.pointerId);
    if (!sample) return;
    sample.lastX = event.clientX;
    sample.lastY = event.clientY;
  }

  /** Returns true when this pointer is reporting a firm initial press. */
  private isFirmPress(event: PointerEvent): boolean {
    if (this.platform !== 'mobile') return false;
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return false;
    // Many devices report 1.0 for "no real sensor" or 0 for synthetic
    // events; only trust strictly intermediate values.
    return event.pressure > FIRM_PRESS_THRESHOLD && event.pressure < 1;
  }

  /**
   * Update tracking's per-drag peak pressure + contact ellipse. Skips
   * the absorb entirely on desktop so mouse drags stay deterministic.
   */
  private absorbTouchProfile(event: PointerEvent, t: TrackingState): void {
    if (this.platform !== 'mobile') return;
    const radius = touchRadiusFor(event);
    if (radius > t.maxTouchRadius) t.maxTouchRadius = radius;
    if (event.pressure > 0 && event.pressure < 1) {
      t.peakPressureValid = true;
      if (event.pressure > t.peakPressure) t.peakPressure = event.pressure;
    }
  }

  /** Inner factory for the dwell-timer callback. Used by the firm-press reschedule path. */
  private fireDwell(kind: GestureKind): () => void {
    return () => {
      if (!this.tracking || this.tracking.consumed) return;
      const t = this.tracking;
      if (!this.onCooldown(kind, t.region.label, performance.now())) {
        this.fire(kind, t.region.label, t.region.tone);
      }
      t.consumed = true;
      t.grabTimer = null;
    };
  }

  /**
   * Arm pinch detection between the two oldest active pointers. The
   * body region resolves to whatever the midpoint of the two pointers
   * sits over; an off-body squeeze produces a `null` label and is
   * suppressed by [updatePinch] so we don't emit `pinch` on thin air.
   */
  private tryStartPinch(event: PointerEvent): void {
    const ids = Array.from(this.activePointers.keys());
    if (ids.length < 2) return;
    const a = this.activePointers.get(ids[0]!)!;
    const b = this.activePointers.get(ids[1]!)!;
    const initialDistance = Math.hypot(a.lastX - b.lastX, a.lastY - b.lastY);
    if (initialDistance < PINCH_MIN_INITIAL_DISTANCE_PX) return;

    const midX = (a.lastX + b.lastX) * 0.5;
    const midY = (a.lastY + b.lastY) * 0.5;
    const ctx: ProjectionContext = { canvas: this.canvas, camera: this.camera };
    const hit = this.bestHit(midX, midY, ctx);
    // Fall back to the original tracking region if the midpoint
    // misses a hit zone but a body was already engaged — common when
    // the user squeezes around a thin part (an arm, ribbon).
    const label = hit?.label ?? this.tracking?.region.label ?? null;
    const tone = hit?.tone ?? this.tracking?.region.tone ?? 'casual';

    // Suspend the single-pointer tracker so its stroke/tug/poke logic
    // can't fire during the squeeze. We don't clear `tracking` outright
    // because the user may continue to drag the original finger after
    // the squeeze ends; suppressing it via `consumed` covers both
    // outcomes (pinch fires, or pinch never qualifies and we end
    // cleanly on the next pointerup with no synthetic poke).
    if (this.tracking) {
      this.tracking.consumed = true;
      if (this.tracking.grabTimer !== null) {
        window.clearTimeout(this.tracking.grabTimer);
        this.tracking.grabTimer = null;
      }
    }

    this.pinch = {
      primaryId: ids[0]!,
      secondaryId: ids[1]!,
      initialDistance,
      minDistance: initialDistance,
      startTime: performance.now(),
      label,
      tone,
      fired: false,
    };
  }

  /** Run the pinch shrink/travel test; emits at most once per [pinch] lifetime. */
  private updatePinch(now: number): void {
    const p = this.pinch;
    if (!p || p.fired) return;
    const a = this.activePointers.get(p.primaryId);
    const b = this.activePointers.get(p.secondaryId);
    if (!a || !b) return;
    const distance = Math.hypot(a.lastX - b.lastX, a.lastY - b.lastY);
    if (distance < p.minDistance) p.minDistance = distance;
    if (now - p.startTime > PINCH_MAX_DURATION_MS) {
      // Squeeze took too long — give up so a slow pinch-then-spread
      // doesn't accidentally fire when the fingers finally close.
      this.pinch = null;
      return;
    }
    const ratio = distance / Math.max(p.initialDistance, 1);
    const travel = p.initialDistance - p.minDistance;
    if (ratio > PINCH_MIN_SHRINK_RATIO || travel < PINCH_MIN_TRAVEL_PX) return;
    if (!p.label) {
      // Off-body squeeze — no region to address. Treat as a no-op
      // and let the lifecycle end on pointerup without firing.
      p.fired = true;
      return;
    }
    p.fired = true;
    if (!this.onCooldown('pinch', p.label, now)) {
      this.fire('pinch', p.label, p.tone);
    }
  }
}

/**
 * Returns half the larger of `event.width` / `event.height` (the touch
 * contact ellipse radius in CSS px) when the OS gave us a real ellipse;
 * 0 otherwise. The Pointer Events spec defaults `width`/`height` to 1
 * for mouse / pen, so we filter on `pointerType` and treat anything
 * non-touch as zero.
 */
function touchRadiusFor(event: PointerEvent): number {
  if (event.pointerType !== 'touch') return 0;
  const w = Number.isFinite(event.width) ? event.width : 0;
  const h = Number.isFinite(event.height) ? event.height : 0;
  return Math.max(w, h) * 0.5;
}

function countReversals(samples: TickleSample[]): number {
  let count = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    const dot = a.dx * b.dx + a.dy * b.dy;
    if (dot < 0) count++;
  }
  return count;
}
