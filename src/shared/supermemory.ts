/**
 * Shared types for the memory tab, backed by the local supermemory server.
 *
 * The Memory screen is a plain list: it reads what the server already holds
 * (documents and, on search, extracted facts) over IPC. No LLM, no indexing on
 * the renderer's side — just data.
 */
import { z } from 'zod';
import { IsoDateTimeSchema } from './common';

/** One saved memory item, as the list returns it. */
export const MemoryItemSchema = z.object({
  id: z.string(),
  /** The remembered text — the saved content or a fact. */
  memory: z.string().default(''),
  /** `done` once processed; `queued`/`indexing`/`processing`; or `failed`. */
  status: z.string().default('unknown'),
  createdAt: IsoDateTimeSchema.optional(),
  updatedAt: IsoDateTimeSchema.optional(),
  /** Present on search results: relevance 0..1. */
  relevance: z.number().optional(),
});
export type MemoryItem = z.infer<typeof MemoryItemSchema>;

/** A page of memories. */
export const MemoryPageSchema = z.object({
  items: z.array(MemoryItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
  /** False when the memory engine is off or still starting. */
  ready: z.boolean().default(true),
});
export type MemoryPage = z.infer<typeof MemoryPageSchema>;

export const MemoryListRequestSchema = z.object({
  page: z.number().int().positive().default(1),
  limit: z.number().int().positive().max(200).default(50),
});
export type MemoryListRequest = z.infer<typeof MemoryListRequestSchema>;
export type MemoryListRequestInput = z.input<typeof MemoryListRequestSchema>;

export const MemorySearchRequestSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).default(20),
});
export type MemorySearchRequest = z.infer<typeof MemorySearchRequestSchema>;
export type MemorySearchRequestInput = z.input<
  typeof MemorySearchRequestSchema
>;

export const MemoryAddRequestSchema = z.object({
  content: z.string().min(1).max(20_000),
});
export type MemoryAddRequest = z.infer<typeof MemoryAddRequestSchema>;
export type MemoryAddRequestInput = z.input<typeof MemoryAddRequestSchema>;

export const MemoryForgetRequestSchema = z.object({ id: z.string().min(1) });
export type MemoryForgetRequest = z.infer<typeof MemoryForgetRequestSchema>;
export type MemoryForgetRequestInput = z.input<
  typeof MemoryForgetRequestSchema
>;

/** Whether the memory engine is up. */
export const MemoryEngineStatusSchema = z.object({
  /** The local server is answering. */
  ready: z.boolean(),
  /** The engine is enabled in settings. */
  enabled: z.boolean(),
});
export type MemoryEngineStatus = z.infer<typeof MemoryEngineStatusSchema>;
