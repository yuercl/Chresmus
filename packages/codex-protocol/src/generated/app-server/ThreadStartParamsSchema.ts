// GENERATED FILE. DO NOT EDIT.
// Source: vendor/codex-app-server-schema/stable/json/v2/ThreadStartParams.json
import { z } from "zod"

export const ThreadStartParamsSchema = z.object({ "approvalPolicy": z.union([z.any().superRefine((x, ctx) => {
    const schemas = [z.enum(["untrusted","on-failure","on-request","never"]), z.object({ "reject": z.object({ "mcp_elicitations": z.boolean(), "rules": z.boolean(), "sandbox_approval": z.boolean() }) }).strict()];
    const { errors, failed } = schemas.reduce<{
      errors: z.ZodError[];
      failed: number;
    }>(
      ({ errors, failed }, schema) =>
        ((result) =>
          result.error
            ? {
                errors: [...errors, result.error],
                failed: failed + 1,
              }
            : { errors, failed })(
          schema.safeParse(x),
        ),
      { errors: [], failed: 0 },
    );
    const passed = schemas.length - failed;
    if (passed !== 1) {
      ctx.addIssue(errors.length ? {
        path: ctx.path,
        code: "invalid_union",
        unionErrors: errors,
        message: "Invalid input: Should pass single schema. Passed " + passed,
      } : {
        path: ctx.path,
        code: "custom",
        message: "Invalid input: Should pass single schema. Passed " + passed,
      });
    }
  }), z.null()]).optional(), "baseInstructions": z.union([z.string(), z.null()]).optional(), "config": z.union([z.record(z.any()), z.null()]).optional(), "cwd": z.union([z.string(), z.null()]).optional(), "developerInstructions": z.union([z.string(), z.null()]).optional(), "personality": z.union([z.enum(["none","friendly","pragmatic"]), z.null()]).optional(), "ephemeral": z.union([z.boolean(), z.null()]).optional(), "serviceName": z.union([z.string(), z.null()]).optional(), "sandbox": z.union([z.enum(["read-only","workspace-write","danger-full-access"]), z.null()]).optional(), "model": z.union([z.string(), z.null()]).optional(), "modelProvider": z.union([z.string(), z.null()]).optional() })
