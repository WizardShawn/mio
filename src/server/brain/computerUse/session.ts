import Anthropic from '@anthropic-ai/sdk';

import {
  bumpChatUsage,
  getEstimatedCostTodayUsd,
  usageFromResponse,
} from '../agentCounters';
import { loadApiKey } from '../apiKey';
import { getAgentPrefs } from '../userPreferences';
import {
  setComputerUseStatus,
  setComputerUseStopHandler,
} from '../computerUseStatus';
import { getHost } from '../host';
import { forceApproval } from '../permissions/gate';
import type { ToolContext } from '../tools/types';
import * as exec from './executor';
import { screenAction } from './watchdog';

// The computer-use session loop.

const MODEL = 'claude-opus-4-7';
// Phase-7 — dropped from 30 to 12. A pre-Phase-7 30-step session
// could rack up `sum(1..30) × 1.6k = ~744k` vision tokens (~`$11`)
// because every step's call replayed every prior screenshot. The
// caching + elision below makes long sessions practical again, but
// most legitimate computer-use tasks finish in 4-8 steps; capping
// at 12 leaves headroom for "open app → click menu → fill form →
// submit → screenshot result" while killing runaway loops.
const MAX_STEPS = 12;
// Phase-7 — keep only this many recent screenshots in the message
// array on each round. Older tool_result blocks have their image
// content swapped for a short text placeholder so the model knows
// "a screenshot used to be here" without paying ~2 k tokens for the
// pixels it already acted on. Picked 3 because typical GUI flows
// reference the previous frame ("the dialog I just opened") more
// than the frame two steps back.
const KEEP_RECENT_SCREENSHOTS = 3;
const BETA_FLAG = 'computer-use-2025-01-24';
const COMPUTER_TOOL_TYPE = 'computer_20250124';
const STATUS_LABEL = 'Mio is controlling your screen';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface ActionResult {
  content: any;
  isError: boolean;
}

function imageBlock(data: string, mediaType: string): any {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

/**
 * Phase-7 — replace image blocks beyond the most recent
 * `keepRecent` with a tiny text placeholder, in-place across the
 * entire message array (top-level `content` arrays AND nested
 * `tool_result.content` arrays).
 *
 * Why: computer-use replays the full message history on every step,
 * which means step N pays for all N prior screenshots — `sum(1..N)`
 * scaling, ~`$11` on a 30-step run pre-Phase-7. After this pass
 * each call carries at most `keepRecent` real images, regardless
 * of step count. The model still sees the action chain (assistant
 * `tool_use` → user `tool_result`) intact; only the pixel payload
 * of older steps is collapsed.
 *
 * We walk the array tail-first to find the K most recent image
 * blocks and mark them "keep". Everything else gets replaced. The
 * seed message's screenshot at index 0 falls under the same rule —
 * once K steps have elapsed it's elided too, which is fine because
 * Mio has already moved well past the starting state by then.
 */
function elideOldScreenshots(messages: any[], keepRecent: number): void {
  if (keepRecent <= 0) return;
  // Walk messages in reverse order and find the first `keepRecent`
  // image blocks; mark them as "keep". Use a Set of stable refs.
  const keep = new Set<any>();
  let kept = 0;
  for (let i = messages.length - 1; i >= 0 && kept < keepRecent; i -= 1) {
    const msg = messages[i];
    const content = msg?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0 && kept < keepRecent; j -= 1) {
      const block = content[j];
      if (block?.type === 'image') {
        keep.add(block);
        kept += 1;
      } else if (block?.type === 'tool_result' && Array.isArray(block.content)) {
        for (let k = block.content.length - 1; k >= 0 && kept < keepRecent; k -= 1) {
          const inner = block.content[k];
          if (inner?.type === 'image') {
            keep.add(inner);
            kept += 1;
          }
        }
      }
    }
  }

  const replacement = (): any => ({
    type: 'text',
    text: '(earlier screenshot elided to save tokens)',
  });

  const visit = (blocks: any[]): void => {
    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i];
      if (block?.type === 'image' && !keep.has(block)) {
        blocks[i] = replacement();
      } else if (block?.type === 'tool_result' && Array.isArray(block.content)) {
        visit(block.content);
      }
    }
  };

  for (const msg of messages) {
    if (Array.isArray(msg?.content)) visit(msg.content);
  }
}

async function freshScreenshot(): Promise<any> {
  const shot = await getHost().sensors.capturePrimaryScreen();
  if (!shot) return 'Action done, but the follow-up screenshot failed.';
  exec.setCoordinateSpace(shot.width, shot.height);
  return [imageBlock(shot.data, shot.mediaType)];
}

function coord(value: unknown): { x: number; y: number } | null {
  if (Array.isArray(value) && value.length === 2) {
    const x = Number(value[0]);
    const y = Number(value[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  }
  return null;
}

async function runComputerAction(input: Record<string, any>): Promise<ActionResult> {
  const action = String(input['action'] ?? '');
  const point = coord(input['coordinate']);
  const start = coord(input['start_coordinate']);

  const watch = await screenAction(point ?? start);
  if (watch.verdict === 'block') {
    return { content: watch.reason, isError: true };
  }
  if (watch.verdict === 'prompt') {
    const approved = await forceApproval({
      tool: 'computer_use',
      title: 'Mio wants to act on a sensitive window',
      summary: watch.reason,
      preview: `Action: ${action}`,
      previewKind: 'text',
    });
    if (!approved) {
      return { content: 'Denied: the operator declined this action.', isError: false };
    }
  }

  try {
    switch (action) {
      case 'screenshot':
        return { content: await freshScreenshot(), isError: false };
      case 'cursor_position':
        return { content: 'Cursor position is not tracked; take a screenshot.', isError: false };
      case 'wait':
        await new Promise((r) => setTimeout(r, 1000));
        return { content: await freshScreenshot(), isError: false };
      case 'mouse_move':
        if (!point) return { content: 'mouse_move needs a coordinate.', isError: true };
        await exec.moveMouse(point.x, point.y);
        return { content: await freshScreenshot(), isError: false };
      case 'left_click':
      case 'left_mouse_down':
        if (!point) return { content: 'left_click needs a coordinate.', isError: true };
        await exec.clickMouse(point.x, point.y, 'left');
        return { content: await freshScreenshot(), isError: false };
      case 'right_click':
        if (!point) return { content: 'right_click needs a coordinate.', isError: true };
        await exec.clickMouse(point.x, point.y, 'right');
        return { content: await freshScreenshot(), isError: false };
      case 'middle_click':
        if (!point) return { content: 'middle_click needs a coordinate.', isError: true };
        await exec.clickMouse(point.x, point.y, 'middle');
        return { content: await freshScreenshot(), isError: false };
      case 'double_click':
      case 'triple_click':
        if (!point) return { content: 'double_click needs a coordinate.', isError: true };
        await exec.clickMouse(point.x, point.y, 'left', true);
        return { content: await freshScreenshot(), isError: false };
      case 'left_click_drag': {
        const from = start ?? point;
        if (!from || !point) return { content: 'drag needs start + end coordinates.', isError: true };
        await exec.dragMouse(from.x, from.y, point.x, point.y);
        return { content: await freshScreenshot(), isError: false };
      }
      case 'scroll': {
        const at = point ?? { x: 0, y: 0 };
        const dir = String(input['scroll_direction'] ?? 'down') === 'up' ? 'up' : 'down';
        const amount = Number(input['scroll_amount']) || 3;
        await exec.scrollMouse(at.x, at.y, dir, amount);
        return { content: await freshScreenshot(), isError: false };
      }
      case 'type': {
        const text = typeof input['text'] === 'string' ? input['text'] : '';
        await exec.typeText(text);
        return { content: await freshScreenshot(), isError: false };
      }
      case 'key': {
        const text = typeof input['text'] === 'string' ? input['text'] : '';
        await exec.pressKey(text);
        return { content: await freshScreenshot(), isError: false };
      }
      default:
        return { content: `Unsupported action: ${action}`, isError: true };
    }
  } catch (err) {
    return {
      content: `Action "${action}" failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

export async function runComputerUseSession(
  task: string,
  ctx: ToolContext,
): Promise<string> {
  const apiKey = loadApiKey();
  if (!apiKey) return 'Computer use unavailable: no Anthropic API key configured.';

  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
  };
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  setComputerUseStopHandler(onAbort);

  const finish = (summary: string): string => {
    ctx.signal.removeEventListener('abort', onAbort);
    setComputerUseStopHandler(null);
    setComputerUseStatus({ active: false, label: '', step: 0, maxSteps: 0 });
    return summary;
  };

  setComputerUseStatus({ active: true, label: STATUS_LABEL, step: 0, maxSteps: MAX_STEPS });

  const shot = await getHost().sensors.capturePrimaryScreen();
  if (!shot) return finish('Computer use failed: could not capture the screen.');
  exec.setCoordinateSpace(shot.width, shot.height);

  const computerTool = {
    type: COMPUTER_TOOL_TYPE,
    name: 'computer',
    display_width_px: shot.width,
    display_height_px: shot.height,
  };

  // Phase-7 — mark the seed task text as a cache breakpoint. The
  // task description + initial screenshot are byte-identical on
  // every step within a session, so caching them turns the per-step
  // seed cost into a ~10% cache read after step 0. The seed image
  // is kept fresh on the breakpoint so the model still has the
  // starting state visible at step 1 (after which the elision
  // below kicks in for older steps).
  const seedMessage: any = {
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          `Operate this task on the Windows desktop with the computer tool:\n\n${task}\n\n` +
          'Work step by step. Take a screenshot whenever you need to see the ' +
          'current state. When the task is finished — or cannot be done — stop ' +
          'calling tools and reply with a short plain-text summary of what happened.',
        cache_control: { type: 'ephemeral' },
      },
      imageBlock(shot.data, shot.mediaType),
    ],
  };
  const messages: any[] = [seedMessage];

  const client = new Anthropic({ apiKey });
  let summary = '';

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (aborted) return finish('Computer-use session stopped by the operator.');

    // Phase-3 — re-check the daily cost cap on every step. A long
    // computer-use session can rack up `$0.50/step` once accumulated
    // screenshots inflate the message array; without this check the
    // session would keep grinding past the cap and only stop at the
    // `MAX_STEPS` ceiling. The chat-path cap check in
    // `chatService.send` only protects the initial entry, not the
    // multi-step loop that the tool then enters.
    const prefs = getAgentPrefs();
    if (prefs.dailyCostCapUsd > 0) {
      const spentUsd = getEstimatedCostTodayUsd();
      if (spentUsd >= prefs.dailyCostCapUsd) {
        return finish(
          `Computer-use stopped at step ${step + 1}: daily cost cap reached ` +
            `($${spentUsd.toFixed(2)} / $${prefs.dailyCostCapUsd}).`,
        );
      }
    }

    setComputerUseStatus({
      active: true,
      label: STATUS_LABEL,
      step: step + 1,
      maxSteps: MAX_STEPS,
    });

    // Phase-7 — elide screenshots beyond the most recent K from the
    // message history before issuing this step's call. Without this,
    // step N replays N screenshots: the cost of vision tokens is
    // `sum(1..N) × ~1.6k`, which on a 30-step session burns ~$11.
    // We mutate the message array in place because Anthropic stores
    // tool_result blocks in `messages[i].content` arrays; swapping
    // each image block for a tiny text placeholder cuts vision cost
    // to `K × ~1.6k` regardless of step count, while preserving the
    // assistant's tool_use → tool_result chain (the model can still
    // follow the action sequence).
    elideOldScreenshots(messages, KEEP_RECENT_SCREENSHOTS);

    let response: any;
    try {
      response = await client.beta.messages.create(
        {
          model: MODEL,
          max_tokens: 1536,
          betas: [BETA_FLAG],
          tools: [computerTool as any],
          messages,
        } as any,
        { signal: ctx.signal },
      );
    } catch (err) {
      if (aborted) return finish('Computer-use session stopped by the operator.');
      return finish(
        `Computer use failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      bumpChatUsage(usageFromResponse(response.usage), 'computer_use');
    } catch {
      // best-effort accounting
    }

    messages.push({ role: 'assistant', content: response.content });

    const text = (response.content as any[])
      .filter((b) => b.type === 'text')
      .map((b) => b.text as string)
      .join(' ')
      .trim();
    if (text) summary = text;

    const toolUses = (response.content as any[]).filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      return finish(summary || 'Computer-use session finished.');
    }

    const results: any[] = [];
    for (const use of toolUses) {
      if (aborted) {
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: 'Stopped by the operator.',
          is_error: true,
        });
        continue;
      }
      const outcome = await runComputerAction((use.input ?? {}) as Record<string, any>);
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: outcome.content,
        is_error: outcome.isError,
      });
    }
    messages.push({ role: 'user', content: results });
  }

  return finish(summary || `Computer-use session ended after the ${MAX_STEPS}-step budget.`);
}
