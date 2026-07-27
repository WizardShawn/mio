import type {
  ImageBlockParam,
  TextBlockParam,
  Tool,
} from '@anthropic-ai/sdk/resources/messages';

// Shared shape for every tool Mio can call.

export type ToolSourceKind = 'chat' | 'gesture' | 'cycle';

export interface ToolContext {
  /** The tool-loop run id — task-scoped permission grants key off this. */
  taskId: string;
  /** Default cwd for shell + the anchor for relative file paths. */
  workspacePath: string;
  /** Trips when a higher-priority reply pre-empts the turn. */
  signal: AbortSignal;
  /** Which reply path drove this turn. */
  sourceKind: ToolSourceKind;
}

export type ToolResultContent = string | Array<TextBlockParam | ImageBlockParam>;

export interface ToolDescriptor {
  /** The Anthropic tool schema advertised to the model. */
  spec: Tool;
  execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResultContent>;
}

/** Narrow an unknown tool input field to a trimmed non-empty string. */
export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
