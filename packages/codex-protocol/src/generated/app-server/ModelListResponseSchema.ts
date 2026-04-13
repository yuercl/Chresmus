// GENERATED FILE. DO NOT EDIT.
// Source: vendor/codex-app-server-schema/stable/json/v2/ModelListResponse.json
import { z } from "zod"

export const ModelListResponseSchema = z.object({ "data": z.array(z.object({ "availabilityNux": z.union([z.object({ "message": z.string() }), z.null()]).optional(), "defaultReasoningEffort": z.enum(["none","minimal","low","medium","high","xhigh"]).describe("See https://platform.openai.com/docs/guides/reasoning?api-mode=responses#get-started-with-reasoning"), "description": z.string(), "displayName": z.string(), "hidden": z.boolean(), "id": z.string(), "inputModalities": z.array(z.any().superRefine((x, ctx) => {
    const schemas = [z.literal("text").describe("Plain text turns and tool payloads."), z.literal("image").describe("Image attachments included in user turns.")];
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
  }).describe("Canonical user-input modality tags advertised by a model.")).default(["text","image"]), "isDefault": z.boolean(), "model": z.string(), "supportedReasoningEfforts": z.array(z.object({ "description": z.string(), "reasoningEffort": z.enum(["none","minimal","low","medium","high","xhigh"]).describe("See https://platform.openai.com/docs/guides/reasoning?api-mode=responses#get-started-with-reasoning") })), "supportsPersonality": z.boolean().default(false), "upgrade": z.union([z.string(), z.null()]).optional(), "upgradeInfo": z.union([z.object({ "migrationMarkdown": z.union([z.string(), z.null()]).optional(), "model": z.string(), "modelLink": z.union([z.string(), z.null()]).optional(), "upgradeCopy": z.union([z.string(), z.null()]).optional() }), z.null()]).optional() })), "nextCursor": z.union([z.string().describe("Opaque cursor to pass to the next call to continue after the last item. If None, there are no more items to return."), z.null().describe("Opaque cursor to pass to the next call to continue after the last item. If None, there are no more items to return.")]).describe("Opaque cursor to pass to the next call to continue after the last item. If None, there are no more items to return.").optional() })
