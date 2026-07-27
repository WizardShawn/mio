import type {
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages';

import { getToolDescriptor } from './tools/registry';
import type { ToolContext, ToolResultContent } from './tools/types';

// Short 繁中 progress labels surfaced in the caption pill while a tool
// runs. Operator-facing, so they match the subtitle language.
const ACTIVITY_LABELS: Record<string, string> = {
  read_file: '讀取檔案中…',
  list_dir: '查看資料夾中…',
  search_files: '搜尋檔案中…',
  web_search: '搜尋網路中…',
  web_fetch: '讀取網頁中…',
  write_file: '寫入檔案中…',
  edit_file: '編輯檔案中…',
  delete_path: '刪除檔案中…',
  move_path: '移動檔案中…',
  run_command: '執行指令中…',
  browser_navigate: '開啟網頁中…',
  browser_read: '閱讀網頁中…',
  browser_click: '點擊網頁中…',
  browser_type: '輸入內容中…',
  start_computer_use: '操作畫面中…',
  generate_image: '描いてる…',
  change_clothes: '着替え中…',
};

export function toolActivityLabel(name: string): string {
  return ACTIVITY_LABELS[name] ?? '處理中…';
}

/**
 * Execute one round's worth of tool calls. Never throws — a tool that
 * crashes becomes an `is_error` result so the model can recover instead
 * of the whole turn dying.
 */
export async function executeToolUses(
  uses: ToolUseBlock[],
  ctx: ToolContext,
  onActivity?: (label: string) => void,
): Promise<ToolResultBlockParam[]> {
  const results: ToolResultBlockParam[] = [];
  for (const use of uses) {
    if (ctx.signal.aborted) {
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: 'Cancelled before execution.',
        is_error: true,
      });
      continue;
    }
    const descriptor = getToolDescriptor(use.name);
    if (!descriptor) {
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: `Unknown tool: ${use.name}`,
        is_error: true,
      });
      continue;
    }
    onActivity?.(toolActivityLabel(use.name));
    let content: ToolResultContent;
    let isError = false;
    try {
      content = await descriptor.execute(
        (use.input ?? {}) as Record<string, unknown>,
        ctx,
      );
    } catch (err) {
      content = `Tool ${use.name} crashed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      isError = true;
    }
    results.push({
      type: 'tool_result',
      tool_use_id: use.id,
      content,
      is_error: isError,
    });
  }
  return results;
}
