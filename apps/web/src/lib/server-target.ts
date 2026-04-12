import { z } from "zod";

const STORAGE_KEY = "chresmus.server-target.v2";
const LEGACY_STORAGE_KEY = "chresmus.server-target.v1";
const DEFAULT_SERVER_PORT = 4311;

const ServerProtocolSchema = z.enum(["http:", "https:"]);

const ServerBaseUrlSchema = z
  .string()
  .trim()
  .url()
  .superRefine((value, ctx) => {
    const url = new URL(value);

    if (!ServerProtocolSchema.safeParse(url.protocol).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Server URL must start with http:// or https://",
      });
    }

    if (url.pathname !== "/" && url.pathname.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Server URL cannot include a path",
      });
    }

    if (url.search.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Server URL cannot include a query string",
      });
    }

    if (url.hash.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Server URL cannot include a hash fragment",
      });
    }
  })
  .transform((value) => {
    const url = new URL(value);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  });

const StoredServerTargetSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().trim().min(1),
    baseUrl: ServerBaseUrlSchema,
  })
  .strict();

const LegacyStoredServerTargetSchema = z
  .object({
    version: z.literal(1),
    baseUrl: ServerBaseUrlSchema,
  })
  .strict();

const StoredServerTargetsV2Schema = z
  .object({
    version: z.literal(2),
    activeTargetId: z.union([z.string().min(1), z.null()]),
    targets: z.array(StoredServerTargetSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.activeTargetId === null) {
      return;
    }
    const targetExists = value.targets.some(
      (target) => target.id === value.activeTargetId,
    );
    if (!targetExists) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Active server target must exist in targets",
        path: ["activeTargetId"],
      });
    }
  });

const StoredServerTargetsSchema = z
  .union([LegacyStoredServerTargetSchema, StoredServerTargetsV2Schema])
  .transform((value) => {
    if (value.version === 2) {
      return value;
    }

    return {
      version: 2 as const,
      activeTargetId: "migrated-saved-server",
      targets: [
        {
          id: "migrated-saved-server",
          label: "Saved server",
          baseUrl: value.baseUrl,
        },
      ],
    };
  });

const StoredServerTargetsTextSchema = z.string().transform((raw, ctx) => {
  try {
    return JSON.parse(raw);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Saved server targets are not valid JSON",
    });
    return z.NEVER;
  }
});

const ApiPathSchema = z
  .string()
  .min(1, "API path is required")
  .regex(/^\//, "API path must start with '/'");

const SaveServerTargetInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    label: z.string().trim().min(1, "Server label is required"),
    baseUrl: z.string(),
  })
  .strict();

export type StoredServerTarget = z.infer<typeof StoredServerTargetSchema>;
export type StoredServerTargets = z.infer<typeof StoredServerTargetsV2Schema>;

function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

function makeServerTargetId(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }

  return `server-${String(Date.now())}`;
}

function writeStoredServerTargets(value: StoredServerTargets): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  window.localStorage.removeItem(LEGACY_STORAGE_KEY);
}

function parseStoredServerTargetsRaw(raw: string): StoredServerTargets {
  const parsedJson = StoredServerTargetsTextSchema.parse(raw);
  return StoredServerTargetsSchema.parse(parsedJson);
}

export function getDefaultServerBaseUrl(): string {
  if (typeof window === "undefined") {
    return `http://127.0.0.1:${String(DEFAULT_SERVER_PORT)}`;
  }

  const hostname = window.location.hostname;

  if (isLocalHost(hostname)) {
    return `http://127.0.0.1:${String(DEFAULT_SERVER_PORT)}`;
  }

  return window.location.origin;
}

export function readStoredServerTargets(): StoredServerTargets | null {
  if (typeof window === "undefined") {
    return null;
  }

  const currentRaw = window.localStorage.getItem(STORAGE_KEY);
  if (currentRaw !== null) {
    const parsed = parseStoredServerTargetsRaw(currentRaw);
    writeStoredServerTargets(parsed);
    return parsed;
  }

  const legacyRaw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacyRaw === null) {
    return null;
  }

  const migrated = parseStoredServerTargetsRaw(legacyRaw);
  writeStoredServerTargets(migrated);
  return migrated;
}

export function listStoredServerTargets(): StoredServerTarget[] {
  const stored = readStoredServerTargets();
  return stored?.targets ?? [];
}

export function readActiveStoredServerTarget(): StoredServerTarget | null {
  const stored = readStoredServerTargets();
  if (!stored || stored.activeTargetId === null) {
    return null;
  }

  return (
    stored.targets.find((target) => target.id === stored.activeTargetId) ?? null
  );
}

export function parseServerBaseUrl(value: string): string {
  return ServerBaseUrlSchema.parse(value);
}

export function saveServerTarget(value: {
  id?: string;
  label: string;
  baseUrl: string;
}): StoredServerTargets {
  const parsedInput = SaveServerTargetInputSchema.parse(value);
  const parsedBaseUrl = parseServerBaseUrl(parsedInput.baseUrl);
  const current = readStoredServerTargets() ?? {
    version: 2 as const,
    activeTargetId: null,
    targets: [],
  };
  const targetId = parsedInput.id ?? makeServerTargetId();
  const nextTarget: StoredServerTarget = {
    id: targetId,
    label: parsedInput.label,
    baseUrl: parsedBaseUrl,
  };
  const nextTargets = current.targets.some((target) => target.id === targetId)
    ? current.targets.map((target) =>
        target.id === targetId ? nextTarget : target,
      )
    : [...current.targets, nextTarget];
  const next: StoredServerTargets = {
    version: 2,
    activeTargetId: targetId,
    targets: nextTargets,
  };

  writeStoredServerTargets(next);
  return next;
}

export function removeStoredServerTarget(targetId: string): StoredServerTargets {
  const current = readStoredServerTargets() ?? {
    version: 2 as const,
    activeTargetId: null,
    targets: [],
  };
  const nextTargets = current.targets.filter((target) => target.id !== targetId);
  const nextActiveTargetId =
    current.activeTargetId === targetId ? null : current.activeTargetId;
  const next: StoredServerTargets = {
    version: 2,
    activeTargetId: nextActiveTargetId,
    targets: nextTargets,
  };
  writeStoredServerTargets(next);
  return next;
}

export function setActiveStoredServerTarget(
  targetId: string | null,
): StoredServerTargets {
  const current = readStoredServerTargets() ?? {
    version: 2 as const,
    activeTargetId: null,
    targets: [],
  };
  const next: StoredServerTargets = StoredServerTargetsV2Schema.parse({
    ...current,
    activeTargetId: targetId,
  });
  writeStoredServerTargets(next);
  return next;
}

export function clearStoredServerTarget(): void {
  const current = readStoredServerTargets();
  if (!current) {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      window.localStorage.removeItem(STORAGE_KEY);
    }
    return;
  }

  writeStoredServerTargets({
    ...current,
    activeTargetId: null,
  });
}

export function resolveServerBaseUrl(): string {
  const activeTarget = readActiveStoredServerTarget();
  if (activeTarget) {
    return activeTarget.baseUrl;
  }
  return getDefaultServerBaseUrl();
}

export function buildServerUrl(path: string, baseUrlOverride?: string): string {
  const parsedPath = ApiPathSchema.parse(path);
  const baseUrl =
    typeof baseUrlOverride === "string"
      ? parseServerBaseUrl(baseUrlOverride)
      : resolveServerBaseUrl();
  return new URL(parsedPath, `${baseUrl}/`).toString();
}
