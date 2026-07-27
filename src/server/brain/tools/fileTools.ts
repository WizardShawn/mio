import fs from 'node:fs/promises';
import path from 'node:path';

import { requestPermission } from '../permissions/gate';
import { asString, type ToolContext, type ToolDescriptor } from './types';

// File tools. Reads (read_file / list_dir / search_files) are free —
// Mio can look anywhere. Writes (write_file / edit_file / delete_path /
// move_path) build a GateRequest and call the permission gate.

const MAX_READ_BYTES = 256 * 1024;
const MAX_SEARCH_RESULTS = 60;
const MAX_SEARCH_FILES = 4000;
const PREVIEW_LIMIT = 1600;
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'out']);

function resolvePath(p: string, ctx: ToolContext): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(ctx.workspacePath, p);
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 4096);
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

function clip(text: string, limit = PREVIEW_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more chars)` : text;
}

async function countEntries(dir: string, cap: number): Promise<number> {
  let count = 0;
  const stack = [dir];
  while (stack.length > 0 && count <= cap) {
    const current = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      count += 1;
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
      if (count > cap) break;
    }
  }
  return count;
}

const readFileTool: ToolDescriptor = {
  spec: {
    name: 'read_file',
    description:
      'Read a UTF-8 text file from anywhere on disk. Use an absolute path, ' +
      'or a path relative to the workspace folder.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path to read.' } },
      required: ['path'],
    },
  },
  async execute(input, ctx) {
    const rel = asString(input['path']);
    if (!rel) return 'Error: `path` is required.';
    const abs = resolvePath(rel, ctx);
    try {
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) return `Error: "${abs}" is a directory — use list_dir.`;
      if (stat.size > MAX_READ_BYTES) {
        return `Error: "${abs}" is ${stat.size} bytes (limit ${MAX_READ_BYTES}).`;
      }
      const buf = await fs.readFile(abs);
      if (looksBinary(buf)) {
        return `"${abs}" looks like a binary file (${stat.size} bytes) — not shown as text.`;
      }
      return `File: ${abs}\n\n${buf.toString('utf8')}`;
    } catch (err) {
      return `Error reading "${abs}": ${msg(err)}`;
    }
  },
};

const listDirTool: ToolDescriptor = {
  spec: {
    name: 'list_dir',
    description: 'List the entries of a directory (absolute or workspace-relative path).',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path.' } },
      required: ['path'],
    },
  },
  async execute(input, ctx) {
    const rel = asString(input['path']) ?? '.';
    const abs = resolvePath(rel, ctx);
    try {
      const entries = await fs.readdir(abs, { withFileTypes: true });
      if (entries.length === 0) return `(empty) ${abs}`;
      const lines = entries
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()))
        .map((e) => `${e.isDirectory() ? '[dir]  ' : '[file] '}${e.name}`);
      return `Directory: ${abs}\n\n${lines.join('\n')}`;
    } catch (err) {
      return `Error listing "${abs}": ${msg(err)}`;
    }
  },
};

const searchFilesTool: ToolDescriptor = {
  spec: {
    name: 'search_files',
    description:
      'Recursively search a directory for files whose name contains `name_query`, ' +
      'or — when `content_query` is given — whose UTF-8 text contains that string.',
    input_schema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Directory to search under.' },
        name_query: { type: 'string', description: 'Substring to match in file names.' },
        content_query: { type: 'string', description: 'Substring to match in file contents.' },
      },
      required: ['root'],
    },
  },
  async execute(input, ctx) {
    const rootRel = asString(input['root']);
    if (!rootRel) return 'Error: `root` is required.';
    const root = resolvePath(rootRel, ctx);
    const nameQuery = (asString(input['name_query']) ?? '').toLowerCase();
    const contentQuery = asString(input['content_query']);
    if (!nameQuery && !contentQuery) {
      return 'Error: provide `name_query` or `content_query`.';
    }
    const hits: string[] = [];
    let visited = 0;
    const stack = [root];
    try {
      while (stack.length > 0 && hits.length < MAX_SEARCH_RESULTS && visited < MAX_SEARCH_FILES) {
        const dir = stack.pop()!;
        let entries: import('node:fs').Dirent[];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) stack.push(full);
            continue;
          }
          visited += 1;
          const nameMatch = nameQuery ? entry.name.toLowerCase().includes(nameQuery) : true;
          if (!nameMatch) continue;
          if (contentQuery) {
            try {
              const stat = await fs.stat(full);
              if (stat.size > MAX_READ_BYTES) continue;
              const text = await fs.readFile(full, 'utf8');
              if (!text.includes(contentQuery)) continue;
            } catch {
              continue;
            }
          }
          hits.push(full);
          if (hits.length >= MAX_SEARCH_RESULTS) break;
        }
      }
    } catch (err) {
      return `Error searching "${root}": ${msg(err)}`;
    }
    if (hits.length === 0) return `No matches under ${root}.`;
    return `${hits.length} match(es) under ${root}:\n${hits.join('\n')}`;
  },
};

const writeFileTool: ToolDescriptor = {
  spec: {
    name: 'write_file',
    description:
      'Create or overwrite a file with the given text content. Requires the ' +
      "operator's approval unless they have granted a standing allowance.",
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write.' },
        content: { type: 'string', description: 'Full UTF-8 text content.' },
      },
      required: ['path', 'content'],
    },
  },
  async execute(input, ctx) {
    const rel = asString(input['path']);
    if (!rel) return 'Error: `path` is required.';
    const content = typeof input['content'] === 'string' ? (input['content'] as string) : null;
    if (content === null) return 'Error: `content` is required.';
    const abs = resolvePath(rel, ctx);
    let exists = false;
    try {
      exists = (await fs.stat(abs)).isFile();
    } catch {
      exists = false;
    }
    const verb = exists ? 'overwrite' : 'create';
    const gate = await requestPermission({
      tool: 'write_file',
      title: `Mio wants to ${verb} a file`,
      summary: `${verb === 'overwrite' ? 'Overwrite' : 'Create'} ${abs}`,
      preview: clip(content),
      previewKind: 'code',
      targetPath: abs,
      scopeKey: path.dirname(abs),
      allowAlways: true,
      taskId: ctx.taskId,
    });
    if (!gate.allowed) return `Denied: ${gate.reason}`;
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
      return `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${abs}.`;
    } catch (err) {
      return `Error writing "${abs}": ${msg(err)}`;
    }
  },
};

const editFileTool: ToolDescriptor = {
  spec: {
    name: 'edit_file',
    description:
      'Replace the first exact occurrence of `old_text` with `new_text` in a ' +
      'file. Requires the operator\'s approval.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to edit.' },
        old_text: { type: 'string', description: 'Exact text to find.' },
        new_text: { type: 'string', description: 'Replacement text.' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  async execute(input, ctx) {
    const rel = asString(input['path']);
    const oldText = typeof input['old_text'] === 'string' ? (input['old_text'] as string) : null;
    const newText = typeof input['new_text'] === 'string' ? (input['new_text'] as string) : null;
    if (!rel || oldText === null || newText === null) {
      return 'Error: `path`, `old_text`, and `new_text` are all required.';
    }
    const abs = resolvePath(rel, ctx);
    let current: string;
    try {
      current = await fs.readFile(abs, 'utf8');
    } catch (err) {
      return `Error reading "${abs}": ${msg(err)}`;
    }
    const idx = current.indexOf(oldText);
    if (idx === -1) return `Error: \`old_text\` not found in ${abs}.`;
    const updated = current.slice(0, idx) + newText + current.slice(idx + oldText.length);
    const gate = await requestPermission({
      tool: 'edit_file',
      title: 'Mio wants to edit a file',
      summary: `Edit ${abs}`,
      preview: `--- before\n${clip(oldText, 700)}\n\n+++ after\n${clip(newText, 700)}`,
      previewKind: 'diff',
      targetPath: abs,
      scopeKey: path.dirname(abs),
      allowAlways: true,
      taskId: ctx.taskId,
    });
    if (!gate.allowed) return `Denied: ${gate.reason}`;
    try {
      await fs.writeFile(abs, updated, 'utf8');
      return `Edited ${abs}.`;
    } catch (err) {
      return `Error writing "${abs}": ${msg(err)}`;
    }
  },
};

const deletePathTool: ToolDescriptor = {
  spec: {
    name: 'delete_path',
    description: 'Delete a file or directory (recursive). Requires approval.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to delete.' } },
      required: ['path'],
    },
  },
  async execute(input, ctx) {
    const rel = asString(input['path']);
    if (!rel) return 'Error: `path` is required.';
    const abs = resolvePath(rel, ctx);
    let isDir = false;
    try {
      isDir = (await fs.stat(abs)).isDirectory();
    } catch (err) {
      return `Error: cannot stat "${abs}": ${msg(err)}`;
    }
    const itemCount = isDir ? await countEntries(abs, 200) : 1;
    const gate = await requestPermission({
      tool: 'delete_path',
      title: 'Mio wants to delete something',
      summary: `Delete ${abs}`,
      preview: isDir ? `Directory — ${itemCount} entr${itemCount === 1 ? 'y' : 'ies'} inside.` : 'Single file.',
      previewKind: 'text',
      targetPath: abs,
      itemCount,
      scopeKey: abs,
      allowAlways: false,
      taskId: ctx.taskId,
    });
    if (!gate.allowed) return `Denied: ${gate.reason}`;
    try {
      await fs.rm(abs, { recursive: true, force: true });
      return `Deleted ${abs}.`;
    } catch (err) {
      return `Error deleting "${abs}": ${msg(err)}`;
    }
  },
};

const movePathTool: ToolDescriptor = {
  spec: {
    name: 'move_path',
    description: 'Move or rename a file or directory. Requires approval.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source path.' },
        to: { type: 'string', description: 'Destination path.' },
      },
      required: ['from', 'to'],
    },
  },
  async execute(input, ctx) {
    const fromRel = asString(input['from']);
    const toRel = asString(input['to']);
    if (!fromRel || !toRel) return 'Error: `from` and `to` are required.';
    const from = resolvePath(fromRel, ctx);
    const to = resolvePath(toRel, ctx);
    const gate = await requestPermission({
      tool: 'move_path',
      title: 'Mio wants to move something',
      summary: `Move a path`,
      preview: `from: ${from}\n  to: ${to}`,
      previewKind: 'text',
      targetPath: to,
      scopeKey: path.dirname(to),
      allowAlways: false,
      taskId: ctx.taskId,
    });
    if (!gate.allowed) return `Denied: ${gate.reason}`;
    try {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
      return `Moved ${from} -> ${to}.`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        try {
          await fs.cp(from, to, { recursive: true });
          await fs.rm(from, { recursive: true, force: true });
          return `Moved ${from} -> ${to} (cross-device copy).`;
        } catch (err2) {
          return `Error moving "${from}": ${msg(err2)}`;
        }
      }
      return `Error moving "${from}": ${msg(err)}`;
    }
  },
};

export const fileToolDescriptors: ToolDescriptor[] = [
  readFileTool,
  listDirTool,
  searchFilesTool,
  writeFileTool,
  editFileTool,
  deletePathTool,
  movePathTool,
];
