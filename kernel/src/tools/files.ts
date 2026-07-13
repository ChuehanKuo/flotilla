import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, sep, relative } from 'node:path';

function resolveSafe(workspaceDir: string, p: string): string | null {
  const full = resolve(workspaceDir, p);
  // WHY the sep suffix: prevents `${workspaceDir}-evil` prefix matches
  return full === workspaceDir || full.startsWith(workspaceDir + sep) ? full : null;
}

export function makeFileTools(workspaceDir: string): ToolSet {
  return {
    write_file: tool({
      description: 'Write a text file inside your mission workspace.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => {
        const full = resolveSafe(workspaceDir, path);
        if (!full) return 'error: path escapes workspace';
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
        return `wrote ${path}`;
      },
    }),
    read_file: tool({
      description: 'Read a text file from your mission workspace.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const full = resolveSafe(workspaceDir, path);
        if (!full) return 'error: path escapes workspace';
        try { return readFileSync(full, 'utf8'); } catch { return `error: ${path} not found`; }
      },
    }),
    list_files: tool({
      description: 'List all files in your mission workspace.',
      inputSchema: z.object({}),
      execute: async () => {
        const walk = (dir: string): string[] =>
          readdirSync(dir, { withFileTypes: true }).flatMap(e =>
            e.isDirectory() ? walk(resolve(dir, e.name)) : [relative(workspaceDir, resolve(dir, e.name))]);
        const files = walk(workspaceDir);
        return files.length ? files.join('\n') : '(workspace empty)';
      },
    }),
  };
}
