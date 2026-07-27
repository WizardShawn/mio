import type {
  AvatarTalkingPayload,
  ChatSendOptions,
  ReplyMood,
} from '@shared/protocol';

import { eventBus, type EventMeta } from '../eventBus';
import type { ApiPathway } from './agentCounters';
import { chatService } from './chatService';
import { replyCoordinator, type ReplyKind } from './replyCoordinator';

/**
 * Single entry point for every assistant chat turn — user typing,
 * gesture batch, and agent-loop notable check-in all funnel through
 * here so the avatar talking/idle signal and the coordinator slot are
 * managed in exactly one place.
 *
 * The coordinator slot is held from acquire() until `chatService.send`
 * fully resolves — which now waits not just for the Anthropic stream
 * but for the post-reply translation + TTS playback estimate (see
 * `replyTts.ts › dispatchAssistantReply`). That means the next-tier
 * reply source (e.g. the agent loop's interval) doesn't get to fire
 * until the operator is actually done with this one.
 *
 * If a higher-priority caller pre-empts mid-flight, the slot's
 * AbortSignal trips, the Anthropic stream is cancelled, the
 * post-reply events are skipped, and `chatService.send` returns
 * (via its existing AbortError path). `release()` here is then a no-op
 * because the coordinator already swapped the slot under us.
 */
/**
 * Phase-2 — inject a pre-generated assistant reply into the chat
 * surface WITHOUT firing another Anthropic call. Used by the
 * notable-check-in path: the cycle already ran one Claude call and
 * produced both the observation summary and the Japanese line it would
 * say; this skips the second full chat call and just plays that line.
 *
 * Same coordinator + avatar talking/idle bookkeeping as
 * `runAssistantChatTurn` so the renderer can't tell the difference,
 * but no system prompt, no history replay, no images, no tools, no
 * Anthropic call — just DB persistence + TTS + caption.
 */
export async function runInjectedAssistantChatTurn(args: {
  userText: string;
  assistantText: string;
  initialMood?: ReplyMood;
}): Promise<void> {
  const { userText, assistantText, initialMood } = args;

  const slot = replyCoordinator.acquire('auto');
  if (!slot) {
    console.log(
      `[chat-turn] dropped injected reply — coordinator busy with ${replyCoordinator.currentKind()}`,
    );
    return;
  }

  const onStart = (): void => {
    const payload: AvatarTalkingPayload = {};
    if (initialMood) payload.mood = initialMood;
    eventBus.emit('avatar.setTalking', payload);
  };
  const onEnd = (): void => {
    eventBus.emit('avatar.setIdle', undefined);
  };

  onStart();
  try {
    await chatService.injectAssistantTurn(userText, assistantText, slot);
  } finally {
    onEnd();
    slot.release();
  }
}

export async function runAssistantChatTurn(args: {
  text: string;
  options: ChatSendOptions;
  kind: ReplyKind;
  /**
   * Optional mood hint applied to the talking animation at stream
   * START — before the reply text exists. Used for gesture batches
   * (the tone of the touch tells us roughly how she'll react before
   * Claude has produced any words). The post-stream mood detection in
   * `chatService.send` may override this with a more specific match
   * once the JA reply is collected.
   */
  initialMood?: ReplyMood;
  /**
   * Phase-1 cost-meter attribution. Each caller (typed user, gesture
   * batch, notable check-in, welcome-back) labels its own pathway so
   * the per-surface breakdown in `agent_pathway_counters` tells us
   * exactly which leg of the chat surface is burning the daily cap.
   * Defaults to `'chat'` when omitted (typed-user entry from
   * `methods.ts > chatSend`).
   */
  pathway?: ApiPathway;
}): Promise<void> {
  const { text, options, kind, initialMood, pathway } = args;

  const slot = replyCoordinator.acquire(kind);
  if (!slot) {
    // A higher-or-equal-priority reply is already in flight — drop
    // this request on the floor. The current owner keeps the surface.
    console.log(
      `[chat-turn] dropped ${kind} reply — coordinator busy with ${replyCoordinator.currentKind()}`,
    );
    return;
  }

  // Route avatar talking/idle to the originating surface only so a
  // mobile-driven chat doesn't animate the desktop avatar without any
  // matching audio or caption (and vice versa). Cycles / greetings
  // have no origin and broadcast as before.
  const meta: EventMeta = options.origin ? { origin: options.origin } : {};

  const onStart = (): void => {
    const payload: AvatarTalkingPayload = {};
    if (initialMood) payload.mood = initialMood;
    eventBus.emit('avatar.setTalking', payload, meta);
  };
  const onEnd = (): void => {
    eventBus.emit('avatar.setIdle', undefined, meta);
  };

  // Map the reply-coordinator's priority kind onto the tool-context's
  // `sourceKind` so a tool that cares (Phase 10 `generate_image` for
  // its DB row + overlay payload) can tell a gesture-driven turn from
  // a typed-or-auto turn. Auto check-ins look like normal chat turns
  // from a tool's perspective — the cycle proper runs its own loop
  // outside chatService.
  const sourceKind = kind === 'gesture' ? 'gesture' : 'chat';
  // Default pathway mirrors the coordinator kind so a caller that
  // forgets to pass it still gets useful attribution instead of
  // every check-in / welcome-back collapsing into the typed-user bucket.
  const effectivePathway: ApiPathway =
    pathway ?? (kind === 'gesture' ? 'gesture' : 'chat');

  onStart();
  try {
    await chatService.send(text, options, slot, sourceKind, effectivePathway);
  } finally {
    onEnd();
    slot.release();
  }
}
