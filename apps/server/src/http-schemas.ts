import { z } from "zod";

export const TraceStartBodySchema = z
  .object({
    label: z.string().min(1).max(120),
  })
  .strict();

export const TraceMarkBodySchema = z
  .object({
    note: z.string().max(500),
  })
  .strict();

export const DirectoryCreateBodySchema = z
  .object({
    path: z.string().trim().min(1),
    createParents: z.boolean().optional(),
  })
  .strict();

export const AgentScopedQuerySchema = z
  .object({
    agentId: z.enum(["codex", "opencode"]).optional()
  })
  .strict();

export const DirectoryReadQuerySchema = z
  .object({
    path: z.string().trim().min(1).optional(),
  })
  .strict();

export const FilesystemEntriesReadQuerySchema = z
  .object({
    path: z.string().trim().min(1).optional(),
  })
  .strict();

export const FileReadQuerySchema = z
  .object({
    path: z.string().trim().min(1),
  })
  .strict();

export const WorkspaceGitStatusQuerySchema = z
  .object({
    cwd: z.string().trim().min(1),
  })
  .strict();

export const WorkspaceGitDiffQuerySchema = z
  .object({
    cwd: z.string().trim().min(1),
    path: z.string().trim().min(1),
  })
  .strict();

export function parseBody<Schema extends z.ZodTypeAny>(
  schema: Schema,
  value: unknown,
): z.infer<Schema> {
  return schema.parse(value);
}

export function parseQuery<Schema extends z.ZodTypeAny>(
  schema: Schema,
  value: unknown
): z.infer<Schema> {
  return schema.parse(value);
}
