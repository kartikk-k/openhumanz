/**
 * The memory slice of the MCP surface.
 *
 * Three tools, and the shape of every result is governed by one fact: the agent
 * pays tokens per byte of everything we hand back. So search returns short
 * snippets and ids rather than documents, `memory_get` is the way to pay for
 * detail, and both truncate with an explicit marker instead of quietly cutting.
 *
 * We do not expose a file read, edit, search or shell tool here. Claude Code
 * ships better ones, and a duplicate causes tool-choice confusion — the model
 * picks the native one and bypasses our gate.
 */
import { z } from 'zod';
import { defineTool, type AnyToolDefinition } from '../types';
import type { MemoryIndexer } from './indexer';

/** Longest snippet returned per search hit. */
export const SNIPPET_LIMIT = 240;
/** Default and maximum body length for `memory_get`. */
export const GET_DEFAULT_CHARS = 4000;
export const GET_MAX_CHARS = 20000;

function truncate(
  input: string,
  limit: number,
): { text: string; truncated: boolean } {
  if (input.length <= limit) return { text: input, truncated: false };
  return { text: `${input.slice(0, limit)}…`, truncated: true };
}

const SearchInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'Words to look for. Quote a phrase for an exact match; a trailing * is a prefix search.',
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(25)
    .default(5)
    .describe('Maximum hits to return. Keep it small; fetch detail by id.'),
  pathPrefix: z
    .string()
    .optional()
    .describe('Restrict to a folder of the vault, e.g. "people/".'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Only documents carrying every one of these front-matter tags.'),
});
type SearchInput = z.infer<typeof SearchInputSchema>;

const GetInputSchema = z.object({
  id: z
    .string()
    .optional()
    .describe('A document id, or the chunk id from a search hit.'),
  path: z
    .string()
    .optional()
    .describe('Vault-relative path, e.g. "people/ana.md".'),
  maxChars: z
    .number()
    .int()
    .positive()
    .max(GET_MAX_CHARS)
    .default(GET_DEFAULT_CHARS)
    .describe('Truncate the body at this many characters.'),
});
type GetInput = z.infer<typeof GetInputSchema>;

const WriteInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe('Vault-relative path. ".md" is added if missing.'),
  content: z.string().describe('Markdown body. Front matter is optional.'),
  append: z
    .boolean()
    .default(false)
    .describe('Add to the end of the note instead of replacing it.'),
});
type WriteInput = z.infer<typeof WriteInputSchema>;

/**
 * Build the tool list against a live indexer.
 *
 * A factory rather than a constant because the tools need the module's `ctx`,
 * which does not exist until `start()`.
 */
export function createMemoryTools(
  resolve: () => MemoryIndexer,
): AnyToolDefinition[] {
  const search = defineTool<SearchInput>({
    name: 'memory_search',
    description:
      "Full-text search the memory vault (the user's Markdown notes). Returns short ranked snippets with the file and line range each came from. Use memory_get with a returned id to read the whole note.",
    inputSchema: SearchInputSchema,
    sideEffecting: false,
    annotations: { title: 'Search memory', readOnlyHint: true },
    handler: (input) => {
      const hits = resolve().search(input);
      return {
        count: hits.length,
        results: hits.map((hit) => {
          const snippet = truncate(hit.snippet, SNIPPET_LIMIT);
          return {
            id: hit.chunk.id,
            path: hit.chunk.docPath,
            title: hit.docTitle,
            tags: hit.docTags.length > 0 ? hit.docTags : undefined,
            heading: hit.chunk.heading || undefined,
            lines: `${hit.chunk.startLine}-${hit.chunk.endLine}`,
            snippet: snippet.text,
            truncated: snippet.truncated || undefined,
            score: hit.score,
          };
        }),
      };
    },
  });

  const get = defineTool<GetInput>({
    name: 'memory_get',
    description:
      'Read one memory note by id (from a search hit) or by vault-relative path. Returns the Markdown as it is on disk, truncated to maxChars.',
    inputSchema: GetInputSchema,
    sideEffecting: false,
    annotations: { title: 'Read a memory note', readOnlyHint: true },
    handler: async (input) => {
      if (!input.id && !input.path) {
        return { found: false, error: 'Supply either id or path.' };
      }
      const found = await resolve().get({ id: input.id, path: input.path });
      if (!found) return { found: false };
      const body = truncate(found.content, input.maxChars);
      return {
        found: true,
        id: found.doc.id,
        path: found.doc.path,
        title: found.doc.title,
        tags: found.doc.tags.length > 0 ? found.doc.tags : undefined,
        updatedAt: found.doc.updatedAt,
        sizeBytes: found.doc.sizeBytes,
        truncated: body.truncated || undefined,
        content: body.text,
      };
    },
  });

  const write = defineTool<WriteInput>({
    name: 'memory_store',
    description:
      'Save something to the memory vault as a Markdown file the user can open and edit. Use append to add to an existing note rather than overwrite it. Prefer a stable, descriptive path such as "people/ana.md" or "projects/relocation.md".',
    inputSchema: WriteInputSchema,
    sideEffecting: true,
    annotations: { title: 'Write a memory note', destructiveHint: true },
    summarize: (input) => {
      const lines = input.content.split('\n').length;
      const verb = input.append ? 'Add to' : 'Write';
      return `${verb} the memory note "${input.path}" (${lines} line${lines === 1 ? '' : 's'}, ${input.content.length} characters)`;
    },
    handler: async (input) => {
      const doc = await resolve().write(input);
      return {
        ok: true,
        id: doc.id,
        path: doc.path,
        title: doc.title,
        sizeBytes: doc.sizeBytes,
      };
    },
  });

  return [search, get, write];
}
