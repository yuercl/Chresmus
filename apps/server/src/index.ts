import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import type {
  AppServerSupportedServerNotification,
  ThreadConversationState,
} from "@farfield/protocol";
import {
  JsonValueSchema,
  UnifiedCommandSchema,
  type UnifiedEvent,
  type JsonValue,
  type UnifiedProviderId,
  type UnifiedThread,
  type UnifiedTurn,
} from "@farfield/unified-surface";
import {
  DirectoryCreateBodySchema,
  DirectoryReadQuerySchema,
  FileReadQuerySchema,
  FilesystemEntriesReadQuerySchema,
  WorkspaceGitDiffQuerySchema,
  WorkspaceGitStatusQuerySchema,
  parseBody,
  parseQuery,
  TraceMarkBodySchema,
  TraceStartBodySchema,
} from "./http-schemas.js";
import { logger } from "./logger.js";
import {
  parseServerCliOptions,
  formatServerHelpText,
} from "./agents/cli-options.js";
import { AgentRegistry } from "./agents/registry.js";
import { ThreadIndex } from "./agents/thread-index.js";
import {
  CodexAgentAdapter,
  isAuthenticationRequiredToReadRateLimitsAppServerRpcError,
} from "./agents/adapters/codex-agent.js";
import { OpenCodeAgentAdapter } from "./agents/adapters/opencode-agent.js";
import type { AgentAdapter } from "./agents/types.js";
import {
  UnifiedBackendFeatureError,
  buildUnifiedFeatureMatrix,
  createUnifiedProviderAdapters,
  mapThread,
} from "./unified/adapter.js";

const HOST = process.env["HOST"] ?? "127.0.0.1";
const PORT = Number(process.env["PORT"] ?? 4311);
const HISTORY_LIMIT = 2_000;
const USER_AGENT = "farfield/0.2.2";
const SIDEBAR_PREVIEW_MAX_CHARS = 180;

const TRACE_DIR = path.resolve(process.cwd(), "traces");
const DEFAULT_WORKSPACE = path.resolve(process.cwd());

interface HistoryEntry {
  id: string;
  at: string;
  source: "stream" | "app" | "system";
  direction: "in" | "out" | "system";
  payload: unknown;
  meta: Record<string, unknown>;
}

interface DebugHistoryListEntry {
  id: string;
  at: string;
  source: HistoryEntry["source"];
  direction: HistoryEntry["direction"];
  meta: HistoryEntry["meta"];
}

interface TraceSummary {
  id: string;
  label: string;
  startedAt: string;
  stoppedAt: string | null;
  eventCount: number;
  path: string;
}

interface ActiveTrace {
  summary: TraceSummary;
  stream: fs.WriteStream;
}

function resolveCodexExecutablePath(): string {
  if (process.env["CODEX_CLI_PATH"]) {
    return process.env["CODEX_CLI_PATH"];
  }

  const desktopPath = "/Applications/Codex.app/Contents/Resources/codex";
  if (fs.existsSync(desktopPath)) {
    return desktopPath;
  }

  return "codex";
}

function resolveCodexAppServerUrl(): string | null {
  const raw = process.env["CODEX_APP_SERVER_URL"];
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveGitCommitHash(): string | null {
  try {
    const hash = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: DEFAULT_WORKSPACE,
      encoding: "utf8",
    }).trim();
    return hash.length > 0 ? hash : null;
  } catch {
    return null;
  }
}

function parseInteger(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseBoolean(value: string | null, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  if (value === "1" || value === "true") {
    return true;
  }

  if (value === "0" || value === "false") {
    return false;
  }

  return fallback;
}

function jsonResponse(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": encoded.length,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(encoded);
}

function eventResponse(res: ServerResponse, body: unknown): void {
  res.write(`data: ${JSON.stringify(body)}\n\n`);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk, "utf8"));
      continue;
    }
    chunks.push(chunk as Buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}

function compactSidebarPreview(preview: string): string {
  const compact = preview.replace(/\s+/g, " ").trim();
  if (compact.length <= SIDEBAR_PREVIEW_MAX_CHARS) {
    return compact;
  }
  const sliceLength = Math.max(0, SIDEBAR_PREVIEW_MAX_CHARS - 3);
  return `${compact.slice(0, sliceLength).trimEnd()}...`;
}

function toDebugHistoryListEntry(entry: HistoryEntry): DebugHistoryListEntry {
  return {
    id: entry.id,
    at: entry.at,
    source: entry.source,
    direction: entry.direction,
    meta: entry.meta,
  };
}

function ensureTraceDirectory(): void {
  if (!fs.existsSync(TRACE_DIR)) {
    fs.mkdirSync(TRACE_DIR, { recursive: true });
  }
}

const parsedCli = (() => {
  try {
    return parseServerCliOptions(process.argv.slice(2));
  } catch (error) {
    const message = toErrorMessage(error);
    process.stderr.write(`${message}\n`);
    process.stderr.write("Run with --help to see valid arguments.\n");
    process.exit(1);
  }
})();

if (parsedCli.showHelp) {
  process.stdout.write(formatServerHelpText());
  process.stdout.write("\n");
  process.exit(0);
}

const configuredAgentIds = parsedCli.agentIds;
const configuredUnifiedProviders: UnifiedProviderId[] = [...configuredAgentIds];
const codexExecutable = resolveCodexExecutablePath();
const codexAppServerUrl = resolveCodexAppServerUrl();
const gitCommit = resolveGitCommitHash();

const history: HistoryEntry[] = [];
const historyById = new Map<string, unknown>();
const unifiedSseClients = new Set<ServerResponse>();
const activeSockets = new Set<Socket>();
const SSE_KEEPALIVE_INTERVAL_MS = 15_000;
const threadIndex = new ThreadIndex();

let activeTrace: ActiveTrace | null = null;
const recentTraces: TraceSummary[] = [];
let runtimeLastError: string | null = null;

function recordTraceEvent(event: unknown): void {
  if (!activeTrace) {
    return;
  }

  activeTrace.summary.eventCount += 1;
  activeTrace.stream.write(`${JSON.stringify(event)}\n`);
}

function pushHistory(
  source: HistoryEntry["source"],
  direction: HistoryEntry["direction"],
  payload: unknown,
  meta: Record<string, unknown> = {},
): HistoryEntry {
  const entry: HistoryEntry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    source,
    direction,
    payload,
    meta,
  };

  history.push(entry);
  historyById.set(entry.id, payload);

  if (history.length > HISTORY_LIMIT) {
    const removed = history.shift();
    if (removed) {
      historyById.delete(removed.id);
    }
  }

  recordTraceEvent({ type: "history", ...entry });
  return entry;
}

function pushSystem(
  message: string,
  details: Record<string, unknown> = {},
): void {
  logger.info({ message, ...details }, "system-event");
  pushHistory("system", "system", { message, details });
}

let codexAdapter: CodexAgentAdapter | null = null;
let openCodeAdapter: OpenCodeAgentAdapter | null = null;
const adapters: AgentAdapter[] = [];
let unifiedAdapters: ReturnType<typeof createUnifiedProviderAdapters> | null =
  null;

for (const agentId of configuredAgentIds) {
  if (agentId === "codex") {
    codexAdapter = new CodexAgentAdapter({
      appExecutable: codexExecutable,
      ...(codexAppServerUrl ? { appServerUrl: codexAppServerUrl } : {}),
      workspaceDir: DEFAULT_WORKSPACE,
      userAgent: USER_AGENT,
      onStateChange: () => {
        broadcastRuntimeState();
      },
    });

    codexAdapter.onAppEvent((event) => {
      pushHistory("app", event.direction, event.payload, {
        method: event.method,
        threadId: event.threadId,
      });
    });
    codexAdapter.onRealtimeThreadUpdate((event) => {
      broadcastUnifiedEvent({
        kind: "threadUpdated",
        threadId: event.threadId,
        provider: "codex",
        thread: mapThread("codex", event.thread),
      });
    });
    codexAdapter.onRealtimeThreadDelta((event) => {
      threadIndex.register(event.threadId, "codex");
      const deltaEvent = buildCodexThreadDeltaEvent(
        event.thread,
        event.notification,
      );
      if (!deltaEvent) {
        return;
      }
      broadcastTextDeltaCoalesced(deltaEvent);
    });

    adapters.push(codexAdapter);
    continue;
  }

  if (agentId === "opencode") {
    openCodeAdapter = new OpenCodeAgentAdapter();
    adapters.push(openCodeAdapter);
  }
}

const registry = new AgentRegistry(adapters);
unifiedAdapters = createUnifiedProviderAdapters({
  codex: codexAdapter,
  opencode: openCodeAdapter,
});

function getRuntimeStateSnapshot(): Record<string, unknown> {
  const codexRuntimeState = codexAdapter?.getRuntimeState();

  return {
    appExecutable: codexExecutable,
    ...(codexAppServerUrl ? { appServerUrl: codexAppServerUrl } : {}),
    gitCommit,
    appReady: codexRuntimeState?.appReady ?? false,
    transportConnected: codexRuntimeState?.transportConnected ?? false,
    transportInitialized: codexRuntimeState?.transportInitialized ?? false,
    codexAvailable: codexRuntimeState?.codexAvailable ?? false,
    lastError: runtimeLastError ?? codexRuntimeState?.lastError ?? null,
    historyCount: history.length,
    threadOwnerCount: codexAdapter?.getThreadOwnerCount() ?? 0,
    activeTrace: activeTrace?.summary ?? null,
  };
}

function resolveUnifiedAdapter(provider: UnifiedProviderId) {
  if (!unifiedAdapters) {
    return null;
  }
  return unifiedAdapters[provider];
}

function listUnifiedProviders(): UnifiedProviderId[] {
  return configuredUnifiedProviders;
}

function buildUnifiedProviderStateEvents(): UnifiedEvent[] {
  return listUnifiedProviders().map((provider) => {
    const adapter = resolveUnifiedAdapter(provider);
    const connected = adapter
      ? (registry.getAdapter(provider)?.isConnected() ?? false)
      : false;
    const enabled = adapter
      ? (registry.getAdapter(provider)?.isEnabled() ?? false)
      : false;

    return {
      kind: "providerStateChanged",
      provider,
      enabled,
      connected,
      lastError:
        provider === "codex"
          ? (runtimeLastError ??
            codexAdapter?.getRuntimeState().lastError ??
            null)
          : (runtimeLastError ?? null),
    };
  });
}

function jsonValueFromString(serialized: string): JsonValue {
  return JsonValueSchema.parse(JSON.parse(serialized));
}

function getProtocolTurnId(
  turn: ThreadConversationState["turns"][number],
): string {
  return turn.id ?? turn.turnId ?? "";
}

function buildThreadDeltaSnapshot(
  thread: ThreadConversationState,
): {
  updatedAt?: number;
  title?: string | null;
  latestCollaborationMode?: UnifiedThread["latestCollaborationMode"];
  latestModel?: string | null;
  latestReasoningEffort?: string | null;
  latestTokenUsageInfo?: JsonValue | null;
} {
  const mappedThread = mapThread("codex", { ...thread, turns: [], requests: [] });
  return {
    ...(mappedThread.updatedAt !== undefined
      ? { updatedAt: mappedThread.updatedAt }
      : {}),
    ...(mappedThread.title !== undefined ? { title: mappedThread.title } : {}),
    ...(mappedThread.latestCollaborationMode !== undefined
      ? { latestCollaborationMode: mappedThread.latestCollaborationMode }
      : {}),
    ...(mappedThread.latestModel !== undefined
      ? { latestModel: mappedThread.latestModel }
      : {}),
    ...(mappedThread.latestReasoningEffort !== undefined
      ? { latestReasoningEffort: mappedThread.latestReasoningEffort }
      : {}),
    ...(mappedThread.latestTokenUsageInfo !== undefined
      ? { latestTokenUsageInfo: mappedThread.latestTokenUsageInfo }
      : {}),
  };
}

function mapCodexTurnFromThread(
  thread: ThreadConversationState,
  turnId: string,
): UnifiedTurn | null {
  const protocolTurn = thread.turns.find((turn) => getProtocolTurnId(turn) === turnId);
  if (!protocolTurn) {
    return null;
  }
  const mappedThread = mapThread("codex", {
    ...thread,
    turns: [protocolTurn],
    requests: [],
  });
  return mappedThread.turns[0] ?? null;
}

function buildCodexThreadDeltaEvent(
  thread: ThreadConversationState,
  notification: AppServerSupportedServerNotification,
): UnifiedEvent | null {
  const snapshot = buildThreadDeltaSnapshot(thread);

  switch (notification.method) {
    case "thread/started": {
      return {
        kind: "threadDelta",
        threadId: notification.params.thread.id,
        provider: "codex",
        delta: {
          type: "threadTitleUpdated",
          title: notification.params.thread.title ?? null,
        },
        snapshot,
      };
    }
    case "thread/name/updated":
      return {
        kind: "threadDelta",
        threadId: notification.params.threadId,
        provider: "codex",
        delta: {
          type: "threadTitleUpdated",
          title: notification.params.threadName ?? null,
        },
        snapshot,
      };
    case "thread/tokenUsage/updated":
      return {
        kind: "threadDelta",
        threadId: notification.params.threadId,
        provider: "codex",
        delta: {
          type: "tokenUsageUpdated",
          tokenUsage: jsonValueFromString(
            JSON.stringify(notification.params.tokenUsage),
          ),
        },
        snapshot,
      };
    case "turn/started":
    case "turn/completed":
    case "turn/plan/updated":
    case "item/started":
    case "item/completed": {
      const turnId =
        "turn" in notification.params
          ? getProtocolTurnId(notification.params.turn)
          : notification.params.turnId;
      const turn = mapCodexTurnFromThread(thread, turnId);
      if (!turn) {
        return null;
      }
      return {
        kind: "threadDelta",
        threadId: notification.params.threadId,
        provider: "codex",
        delta: {
          type: "turnUpdated",
          turn,
        },
        snapshot,
      };
    }
    case "turn/diff/updated":
      return {
        kind: "threadDelta",
        threadId: notification.params.threadId,
        provider: "codex",
        delta: {
          type: "turnDiffUpdated",
          turnId: notification.params.turnId,
          diff: notification.params.diff,
        },
        snapshot,
      };
    case "item/agentMessage/delta":
      return {
        kind: "threadDelta",
        threadId: notification.params.threadId,
        provider: "codex",
        delta: {
          type: "itemTextDelta",
          turnId: notification.params.turnId,
          itemId: notification.params.itemId,
          itemType: "agentMessage",
          delta: notification.params.delta,
        },
        snapshot,
      };
    case "item/plan/delta":
      return {
        kind: "threadDelta",
        threadId: notification.params.threadId,
        provider: "codex",
        delta: {
          type: "itemTextDelta",
          turnId: notification.params.turnId,
          itemId: notification.params.itemId,
          itemType: "plan",
          delta: notification.params.delta,
        },
        snapshot,
      };
    case "item/commandExecution/outputDelta":
      return {
        kind: "threadDelta",
        threadId: notification.params.threadId,
        provider: "codex",
        delta: {
          type: "itemTextDelta",
          turnId: notification.params.turnId,
          itemId: notification.params.itemId,
          itemType: "commandExecution",
          delta: notification.params.delta,
        },
        snapshot,
      };
    case "item/fileChange/outputDelta":
      return {
        kind: "threadDelta",
        threadId: notification.params.threadId,
        provider: "codex",
        delta: {
          type: "itemTextDelta",
          turnId: notification.params.turnId,
          itemId: notification.params.itemId,
          itemType: "fileChange",
          delta: notification.params.delta,
        },
        snapshot,
      };
    case "item/mcpToolCall/progress":
      return null;
    case "item/reasoning/summaryPartAdded":
      return {
        kind: "threadDelta",
        threadId: notification.params.threadId,
        provider: "codex",
        delta: {
          type: "reasoningSummaryPartAdded",
          turnId: notification.params.turnId,
          itemId: notification.params.itemId,
          summaryIndex: notification.params.summaryIndex,
        },
        snapshot,
      };
    case "item/reasoning/summaryTextDelta":
      return {
        kind: "threadDelta",
        threadId: notification.params.threadId,
        provider: "codex",
        delta: {
          type: "itemTextDelta",
          turnId: notification.params.turnId,
          itemId: notification.params.itemId,
          itemType: "reasoningSummaryText",
          summaryIndex: notification.params.summaryIndex,
          delta: notification.params.delta,
        },
        snapshot,
      };
    case "item/reasoning/textDelta":
      return {
        kind: "threadDelta",
        threadId: notification.params.threadId,
        provider: "codex",
        delta: {
          type: "itemTextDelta",
          turnId: notification.params.turnId,
          itemId: notification.params.itemId,
          itemType: "reasoningText",
          delta: notification.params.delta,
        },
        snapshot,
      };
  }
}

function broadcastUnifiedEvent(event: UnifiedEvent): void {
  for (const client of unifiedSseClients) {
    eventResponse(client, event);
  }
}

// Per-item text-delta accumulator: coalesces rapid-fire character deltas from a single
// Codex response burst into one SSE event using setImmediate (fires after the current
// I/O poll phase drains, so natural burst batching with zero artificial latency).
interface PendingTextDelta {
  event: Extract<UnifiedEvent, { kind: "threadDelta" }>;
  handle: ReturnType<typeof setImmediate>;
}
const pendingTextDeltas = new Map<string, PendingTextDelta>();

function broadcastTextDeltaCoalesced(event: UnifiedEvent): void {
  if (
    event.kind !== "threadDelta" ||
    event.delta.type !== "itemTextDelta" ||
    unifiedSseClients.size === 0
  ) {
    broadcastUnifiedEvent(event);
    return;
  }

  const delta = event.delta;
  const key = `${event.threadId}\0${delta.turnId}\0${delta.itemId}`;
  const pending = pendingTextDeltas.get(key);

  if (pending) {
    // Merge: append delta string, keep latest snapshot
    const pendingDelta = pending.event.delta;
    if (pendingDelta.type === "itemTextDelta") {
      pendingDelta.delta += delta.delta;
    }
    pending.event.snapshot = event.snapshot;
    return;
  }

  // First delta for this key in the current burst — clone event so we can mutate it
  const merged: Extract<UnifiedEvent, { kind: "threadDelta" }> = {
    ...event,
    delta: { ...delta },
  };
  const handle = setImmediate(() => {
    pendingTextDeltas.delete(key);
    broadcastUnifiedEvent(merged);
  });
  pendingTextDeltas.set(key, { event: merged, handle });
}

function writeSseKeepalive(): void {
  for (const client of unifiedSseClients) {
    try {
      client.write(": keepalive\n\n");
    } catch {
      unifiedSseClients.delete(client);
    }
  }
}

function broadcastRuntimeState(): void {
  for (const event of buildUnifiedProviderStateEvents()) {
    broadcastUnifiedEvent(event);
  }
}

const sseKeepaliveTimer = setInterval(() => {
  writeSseKeepalive();
}, SSE_KEEPALIVE_INTERVAL_MS);
sseKeepaliveTimer.unref();

function printStartupBanner(): void {
  const supportsColor =
    process.stdout.isTTY &&
    process.env["NO_COLOR"] !== "1" &&
    process.env["TERM"] !== "dumb";
  const color = {
    reset: "\u001B[0m",
    bold: "\u001B[1m",
    dim: "\u001B[2m",
    green: "\u001B[32m",
    cyan: "\u001B[36m",
    yellow: "\u001B[33m",
    blue: "\u001B[34m",
    underline: "\u001B[4m",
  } as const;
  const paint = (
    text: string,
    tone: keyof typeof color,
    options?: { bold?: boolean; underline?: boolean },
  ): string => {
    if (!supportsColor) {
      return text;
    }
    const prefixes: string[] = [color[tone]];
    if (options?.bold) {
      prefixes.push(color.bold);
    }
    if (options?.underline) {
      prefixes.push(color.underline);
    }
    return `${prefixes.join("")}${text}${color.reset}`;
  };
  const rule = supportsColor
    ? paint("=".repeat(68), "dim")
    : "=".repeat(68);
  const lines = [
    "",
    rule,
    paint("Farfield Server", "green", { bold: true }),
    paint(`Local URL: http://${HOST}:${PORT}`, "cyan", { bold: true }),
    paint("Open this now: https://farfield.app", "blue", {
      bold: true,
      underline: true,
    }),
    paint(`Agents: ${configuredAgentIds.join(", ")}`, "dim"),
    "",
    paint("Remote access (recommended):", "yellow", { bold: true }),
    "1. Keep this server private. Do not expose it to the public internet.",
    "2. Put it behind a VPN, such as Tailscale.",
    "3. In farfield.app, open Settings and set your server URL.",
    "",
    paint("Setup guide:", "cyan", { bold: true }),
    paint("https://github.com/achimala/farfield#readme", "blue", {
      underline: true,
    }),
    "",
    paint("Press Control+C to stop.", "dim", { bold: true }),
    rule,
    "",
  ];
  process.stdout.write(lines.join("\n"));
}

const FILE_READ_MAX_BYTES = 256 * 1024;
const GIT_DIFF_MAX_BYTES = 512 * 1024;

const TEXT_DIFF_EXTENSIONS = new Set([
  "c",
  "cc",
  "cjs",
  "cpp",
  "cs",
  "css",
  "go",
  "h",
  "hpp",
  "htm",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "md",
  "mjs",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svg",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

const IMAGE_CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  avif: "image/avif",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

type WorkspaceGitFileStatusKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "unmerged"
  | "untracked"
  | "typeChanged";

function resolveWorkspacePath(inputPath: string): string {
  return path.isAbsolute(inputPath)
    ? path.normalize(inputPath)
    : path.resolve(DEFAULT_WORKSPACE, inputPath);
}

function ensurePathInsideRoot(rootPath: string, candidatePath: string): void {
  const relative = path.relative(rootPath, candidatePath);
  if (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  ) {
    return;
  }
  throw new Error(`Path ${candidatePath} is outside workspace root ${rootPath}`);
}

function detectBinaryContent(buffer: Buffer): boolean {
  for (const byte of buffer) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

function fileExtensionFromPath(pathValue: string): string {
  const extension = path.extname(pathValue).toLowerCase();
  return extension.startsWith(".") ? extension.slice(1) : extension;
}

function isImagePath(pathValue: string): boolean {
  const extension = fileExtensionFromPath(pathValue);
  return Object.hasOwn(IMAGE_CONTENT_TYPE_BY_EXTENSION, extension);
}

function isTextDiffPath(pathValue: string): boolean {
  const fileName = path.basename(pathValue).toLowerCase();
  if (fileName === "dockerfile") {
    return true;
  }
  const extension = fileExtensionFromPath(pathValue);
  return TEXT_DIFF_EXTENSIONS.has(extension);
}

function contentTypeForPath(pathValue: string): string {
  const extension = fileExtensionFromPath(pathValue);
  return IMAGE_CONTENT_TYPE_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function readWorkspaceFile(pathValue: string):
  | {
      status: "available";
      path: string;
      content: string;
      truncated: boolean;
      isBinary: boolean;
    }
  | {
      status: "missing";
      path: string;
    } {
  const resolvedPath = resolveWorkspacePath(pathValue);
  if (!fs.existsSync(resolvedPath)) {
    return {
      status: "missing",
      path: resolvedPath,
    };
  }
  const stats = fs.statSync(resolvedPath);
  if (!stats.isFile()) {
    throw new Error(`Requested path is not a file: ${resolvedPath}`);
  }

  const raw = fs.readFileSync(resolvedPath);
  const isBinary = detectBinaryContent(raw);
  const limited = raw.subarray(0, FILE_READ_MAX_BYTES);

  return {
    status: "available",
    path: resolvedPath,
    content: isBinary ? "" : limited.toString("utf8"),
    truncated: raw.length > FILE_READ_MAX_BYTES,
    isBinary,
  };
}

function readWorkspaceRawFile(pathValue: string): {
  path: string;
  contentType: string;
  data: Buffer;
} {
  const resolvedPath = resolveWorkspacePath(pathValue);
  const stats = fs.statSync(resolvedPath);
  if (!stats.isFile()) {
    throw new Error(`Requested path is not a file: ${resolvedPath}`);
  }

  return {
    path: resolvedPath,
    contentType: contentTypeForPath(resolvedPath),
    data: fs.readFileSync(resolvedPath),
  };
}

function listFilesystemEntries(pathValue: string | undefined): {
  path: string;
  parentPath: string | null;
  entries: Array<{
    name: string;
    path: string;
    kind: "directory" | "file";
  }>;
} {
  const requestedPath =
    typeof pathValue === "string" && pathValue.length > 0
      ? pathValue
      : DEFAULT_WORKSPACE;
  const resolvedPath = resolveWorkspacePath(requestedPath);
  const stats = fs.statSync(resolvedPath);
  if (!stats.isDirectory()) {
    throw new Error(`Requested path is not a directory: ${resolvedPath}`);
  }

  const entries = fs
    .readdirSync(resolvedPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => ({
      name: entry.name,
      path: path.join(resolvedPath, entry.name),
      kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
    }))
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

  const parentPath = path.dirname(resolvedPath);
  return {
    path: resolvedPath,
    parentPath: parentPath === resolvedPath ? null : parentPath,
    entries,
  };
}

function runGitTextCommand(cwdPath: string, args: string[]): string {
  const resolvedCwd = resolveWorkspacePath(cwdPath);
  const stats = fs.statSync(resolvedCwd);
  if (!stats.isDirectory()) {
    throw new Error(`Requested cwd is not a directory: ${resolvedCwd}`);
  }

  return execFileSync("git", args, {
    cwd: resolvedCwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  }).trimEnd();
}

function runGitTextCommandAllowStatusOne(cwdPath: string, args: string[]): string {
  const resolvedCwd = resolveWorkspacePath(cwdPath);
  const stats = fs.statSync(resolvedCwd);
  if (!stats.isDirectory()) {
    throw new Error(`Requested cwd is not a directory: ${resolvedCwd}`);
  }

  const result = spawnSync("git", args, {
    cwd: resolvedCwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  const status = result.status ?? 0;
  if (status !== 0 && status !== 1) {
    const stderr = result.stderr.trim();
    throw new Error(stderr.length > 0 ? stderr : `git exited with status ${String(status)}`);
  }

  return result.stdout.trimEnd();
}

function parseGitStatusKind(code: string): WorkspaceGitFileStatusKind | null {
  switch (code) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "unmerged";
    case "T":
      return "typeChanged";
    case "?":
      return "untracked";
    case " ":
      return null;
    default:
      return null;
  }
}

function parseGitBranchName(statusHeaderLine: string | undefined): string | null {
  if (!statusHeaderLine || !statusHeaderLine.startsWith("## ")) {
    return null;
  }

  const branchInfo = statusHeaderLine.slice(3);
  if (branchInfo.startsWith("No commits yet on ")) {
    return branchInfo.slice("No commits yet on ".length);
  }

  const branchName = branchInfo.split("...")[0] ?? branchInfo;
  return branchName.length > 0 ? branchName : null;
}

function readWorkspaceGitStatus(cwdPath: string): {
  cwd: string;
  branch: string | null;
  hasUncommittedChanges: boolean;
  files: Array<{
    path: string;
    previousPath?: string;
    stagedStatus: WorkspaceGitFileStatusKind | null;
    unstagedStatus: WorkspaceGitFileStatusKind | null;
  }>;
} {
  const resolvedCwd = resolveWorkspacePath(cwdPath);
  const raw = runGitTextCommand(resolvedCwd, [
    "status",
    "--porcelain=v1",
    "--branch",
    "--untracked-files=all",
  ]);
  const lines = raw.length > 0 ? raw.split("\n") : [];
  const branch = parseGitBranchName(lines[0]);
  const files: Array<{
    path: string;
    previousPath?: string;
    stagedStatus: WorkspaceGitFileStatusKind | null;
    unstagedStatus: WorkspaceGitFileStatusKind | null;
  }> = [];

  for (const line of lines.slice(branch ? 1 : 0)) {
    if (line.length < 3) {
      continue;
    }

    const stagedCode = line[0] ?? " ";
    const unstagedCode = line[1] ?? " ";
    const rawPath = line.slice(3);
    const renamedParts = rawPath.split(" -> ");
    const nextPath = renamedParts[renamedParts.length - 1] ?? rawPath;
    const resolvedPath = path.resolve(resolvedCwd, nextPath);
    ensurePathInsideRoot(resolvedCwd, resolvedPath);

    const entry = {
      path: resolvedPath,
      stagedStatus: parseGitStatusKind(stagedCode),
      unstagedStatus: parseGitStatusKind(unstagedCode),
    };

    const previousPathSegment =
      renamedParts.length > 1 ? (renamedParts[0] ?? null) : null;
    if (previousPathSegment !== null) {
      const previousPath = path.resolve(resolvedCwd, previousPathSegment);
      ensurePathInsideRoot(resolvedCwd, previousPath);
      files.push({
        ...entry,
        previousPath,
      });
      continue;
    }

    files.push(entry);
  }

  return {
    cwd: resolvedCwd,
    branch,
    hasUncommittedChanges: files.length > 0,
    files,
  };
}

function readWorkspaceGitStatusEntry(
  cwdPath: string,
  filePath: string,
): {
  path: string;
  previousPath?: string;
  stagedStatus: WorkspaceGitFileStatusKind | null;
  unstagedStatus: WorkspaceGitFileStatusKind | null;
} | null {
  const resolvedFilePath = resolveWorkspacePath(filePath);
  const status = readWorkspaceGitStatus(cwdPath);
  return status.files.find((entry) => entry.path === resolvedFilePath) ?? null;
}

function buildUnifiedAddedDiff(cwdPath: string, filePath: string): string {
  const file = readWorkspaceFile(filePath);
  if (file.status !== "available" || file.isBinary || !isTextDiffPath(file.path)) {
    return "";
  }
  return runGitTextCommandAllowStatusOne(cwdPath, [
    "diff",
    "--no-index",
    "--no-ext-diff",
    "--",
    "/dev/null",
    file.path,
  ]);
}

function buildTextDiffCandidateCommands(relativePath: string): string[][] {
  return [
    [
      "diff",
      "--no-ext-diff",
      "HEAD",
      "--",
      relativePath,
    ],
    [
      "diff",
      "--no-ext-diff",
      "--cached",
      "--",
      relativePath,
    ],
    [
      "diff",
      "--no-ext-diff",
      "--",
      relativePath,
    ],
  ];
}

function firstSuccessfulGitDiff(cwdPath: string, commands: readonly string[][]): string {
  for (const command of commands) {
    try {
      const diff = runGitTextCommandAllowStatusOne(cwdPath, command);
      if (diff.length > 0) {
        return diff;
      }
    } catch {
      continue;
    }
  }
  return "";
}

function readWorkspaceGitDiff(cwdPath: string, filePath: string): {
  cwd: string;
  path: string;
  diff: string;
  truncated: boolean;
} {
  const resolvedCwd = resolveWorkspacePath(cwdPath);
  const resolvedFilePath = resolveWorkspacePath(filePath);
  ensurePathInsideRoot(resolvedCwd, resolvedFilePath);
  const statusEntry = readWorkspaceGitStatusEntry(resolvedCwd, resolvedFilePath);
  const supportsTextDiff = isTextDiffPath(resolvedFilePath);
  let rawDiff = "";

  if (supportsTextDiff && statusEntry) {
    const isAddedLike =
      statusEntry.unstagedStatus === "untracked" ||
      statusEntry.unstagedStatus === "added" ||
      statusEntry.stagedStatus === "added";
    if (isAddedLike && fs.existsSync(resolvedFilePath)) {
      rawDiff = buildUnifiedAddedDiff(resolvedCwd, resolvedFilePath);
    } else {
      const relativePath = path.relative(resolvedCwd, resolvedFilePath);
      rawDiff = firstSuccessfulGitDiff(
        resolvedCwd,
        buildTextDiffCandidateCommands(relativePath),
      );
    }
  }

  if (!supportsTextDiff || rawDiff.length === 0) {
    const relativePath = path.relative(resolvedCwd, resolvedFilePath);
    rawDiff =
      rawDiff ||
      runGitTextCommandAllowStatusOne(resolvedCwd, [
        "diff",
        "--no-ext-diff",
        "HEAD",
        "--",
        relativePath,
      ]);
  }
  const truncated = Buffer.byteLength(rawDiff, "utf8") > GIT_DIFF_MAX_BYTES;
  const diff = truncated
    ? Buffer.from(rawDiff, "utf8")
        .subarray(0, GIT_DIFF_MAX_BYTES)
        .toString("utf8")
    : rawDiff;

  return {
    cwd: resolvedCwd,
    path: resolvedFilePath,
    diff,
    truncated,
  };
}

function parseUnifiedProviderId(
  value: string | null,
): UnifiedProviderId | null {
  if (value === "codex" || value === "opencode") {
    return value;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      jsonResponse(res, 400, { ok: false, error: "Missing request URL" });
      return;
    }

    if (req.method === "OPTIONS") {
      jsonResponse(res, 204, {});
      return;
    }

    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const pathname = url.pathname;
    const segments = pathname.split("/").filter(Boolean);

    if (req.method === "GET" && pathname === "/api/health") {
      jsonResponse(res, 200, {
        ok: true,
        state: getRuntimeStateSnapshot(),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/unified/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      });
      res.write("retry: 1000\n\n");

      unifiedSseClients.add(res);
      for (const event of buildUnifiedProviderStateEvents()) {
        eventResponse(res, event);
      }

      req.on("close", () => {
        unifiedSseClients.delete(res);
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/unified/features") {
      const features = buildUnifiedFeatureMatrix({
        codex: codexAdapter,
        opencode: openCodeAdapter,
      });

      jsonResponse(res, 200, {
        ok: true,
        features,
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/filesystem/directories") {
      const body = parseBody(DirectoryCreateBodySchema, await readJsonBody(req));
      const resolvedPath = path.isAbsolute(body.path)
        ? path.normalize(body.path)
        : path.resolve(DEFAULT_WORKSPACE, body.path);
      fs.mkdirSync(resolvedPath, { recursive: body.createParents ?? true });
      const stats = fs.statSync(resolvedPath);
      if (!stats.isDirectory()) {
        jsonResponse(res, 400, {
          ok: false,
          error: "Created path is not a directory",
        });
        return;
      }
      jsonResponse(res, 200, {
        ok: true,
        path: resolvedPath,
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/filesystem/directory") {
      const query = parseQuery(DirectoryReadQuerySchema, {
        path: url.searchParams.get("path") ?? undefined,
      });
      const requestedPath =
        typeof query.path === "string" && query.path.length > 0
          ? query.path
          : DEFAULT_WORKSPACE;
      const resolvedPath = path.isAbsolute(requestedPath)
        ? path.normalize(requestedPath)
        : path.resolve(DEFAULT_WORKSPACE, requestedPath);
      const stats = fs.statSync(resolvedPath);
      if (!stats.isDirectory()) {
        jsonResponse(res, 400, {
          ok: false,
          error: "Requested path is not a directory",
        });
        return;
      }

      const entries = fs
        .readdirSync(resolvedPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          name: entry.name,
          path: path.join(resolvedPath, entry.name),
          kind: "directory" as const,
        }))
        .sort((left, right) => left.name.localeCompare(right.name));

      const parentPath = path.dirname(resolvedPath);
      jsonResponse(res, 200, {
        ok: true,
        path: resolvedPath,
        parentPath: parentPath === resolvedPath ? null : parentPath,
        entries,
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/filesystem/entries") {
      const query = parseQuery(FilesystemEntriesReadQuerySchema, {
        path: url.searchParams.get("path") ?? undefined,
      });
      const result = listFilesystemEntries(query.path);
      jsonResponse(res, 200, {
        ok: true,
        path: result.path,
        parentPath: result.parentPath,
        entries: result.entries,
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/filesystem/file") {
      const query = parseQuery(FileReadQuerySchema, {
        path: url.searchParams.get("path") ?? undefined,
      });
      const result = readWorkspaceFile(query.path);
      jsonResponse(res, 200, {
        ok: true,
        status: result.status,
        path: result.path,
        ...(result.status === "available"
          ? {
              content: result.content,
              truncated: result.truncated,
              isBinary: result.isBinary,
            }
          : {}),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/filesystem/file/raw") {
      const query = parseQuery(FileReadQuerySchema, {
        path: url.searchParams.get("path") ?? undefined,
      });
      const result = readWorkspaceRawFile(query.path);
      res.writeHead(200, {
        "Content-Type": result.contentType,
        "Content-Length": result.data.length,
        "Access-Control-Allow-Origin": "*",
      });
      res.end(result.data);
      return;
    }

    if (req.method === "GET" && pathname === "/api/workspace/git/status") {
      const query = parseQuery(WorkspaceGitStatusQuerySchema, {
        cwd: url.searchParams.get("cwd") ?? undefined,
      });
      const result = readWorkspaceGitStatus(query.cwd);
      jsonResponse(res, 200, {
        ok: true,
        cwd: result.cwd,
        branch: result.branch,
        hasUncommittedChanges: result.hasUncommittedChanges,
        files: result.files,
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/workspace/git/diff") {
      const query = parseQuery(WorkspaceGitDiffQuerySchema, {
        cwd: url.searchParams.get("cwd") ?? undefined,
        path: url.searchParams.get("path") ?? undefined,
      });
      const result = readWorkspaceGitDiff(query.cwd, query.path);
      jsonResponse(res, 200, {
        ok: true,
        cwd: result.cwd,
        path: result.path,
        diff: result.diff,
        truncated: result.truncated,
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/unified/command") {
      const command = UnifiedCommandSchema.parse(await readJsonBody(req));
      const adapter = resolveUnifiedAdapter(command.provider);

      if (!adapter) {
        jsonResponse(res, 503, {
          ok: false,
          error: {
            code: "providerDisabled",
            message: `Provider ${command.provider} is not available`,
          },
        });
        return;
      }

      try {
        const result = await adapter.execute(command);

        if (result.kind === "listThreads") {
          for (const thread of result.data) {
            threadIndex.register(thread.id, thread.provider);
          }
        }

        if (result.kind === "readThread" || result.kind === "createThread") {
          threadIndex.register(result.thread.id, result.thread.provider);
          broadcastUnifiedEvent({
            kind: "threadUpdated",
            threadId: result.thread.id,
            provider: result.thread.provider,
            thread: result.thread,
          });
        }

        jsonResponse(res, 200, {
          ok: true,
          result,
        });
      } catch (error) {
        if (error instanceof UnifiedBackendFeatureError) {
          jsonResponse(res, 200, {
            ok: false,
            error: {
              code: error.reason,
              message: error.message,
              details: {
                provider: error.provider,
                featureId: error.featureId,
                reason: error.reason,
              },
            },
          });
          return;
        }

        const message = toErrorMessage(error);
        broadcastUnifiedEvent({
          kind: "error",
          message,
          code: "internalError",
        });
        jsonResponse(res, 500, {
          ok: false,
          error: {
            code: "internalError",
            message,
          },
        });
      }
      return;
    }

    if (req.method === "GET" && pathname === "/api/unified/threads") {
      const limit = parseInteger(url.searchParams.get("limit"), 80);
      const archived = parseBoolean(url.searchParams.get("archived"), false);
      const all = parseBoolean(url.searchParams.get("all"), false);
      const maxPages = parseInteger(url.searchParams.get("maxPages"), 20);
      const cursor = url.searchParams.get("cursor") ?? null;

      const data: Array<{
        id: string;
        provider: UnifiedProviderId;
        preview: string;
        title?: string | null | undefined;
        isGenerating?: boolean | undefined;
        createdAt: number;
        updatedAt: number;
        cwd?: string | undefined;
        source?: string | undefined;
      }> = [];
      const cursors: Record<UnifiedProviderId, string | null> = {
        codex: null,
        opencode: null,
      };
      const errors: Record<
        UnifiedProviderId,
        {
          code: string;
          message: string;
          details?: Record<string, string>;
        } | null
      > = {
        codex: null,
        opencode: null,
      };

      await Promise.all(
        listUnifiedProviders().map(async (provider) => {
          const adapter = resolveUnifiedAdapter(provider);
          if (!adapter) {
            errors[provider] = {
              code: "providerDisabled",
              message: `Provider ${provider} is not available`,
            };
            return;
          }

          try {
            const result = await adapter.execute({
              kind: "listThreads",
              provider,
              limit,
              archived,
              all,
              maxPages,
              cursor,
            });

            cursors[provider] = result.nextCursor ?? null;
            for (const thread of result.data) {
              threadIndex.register(thread.id, thread.provider);
              data.push(thread);
            }
          } catch (error) {
            const message = toErrorMessage(error);
            errors[provider] = {
              code: "listThreadsFailed",
              message,
              details: {
                provider,
              },
            };
            logger.warn(
              {
                provider,
                error: message,
              },
              "unified-list-threads-failed",
            );
          }
        }),
      );

      jsonResponse(res, 200, {
        ok: true,
        data,
        cursors,
        errors,
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/unified/sidebar") {
      const limit = parseInteger(url.searchParams.get("limit"), 80);
      const archived = parseBoolean(url.searchParams.get("archived"), false);
      const all = parseBoolean(url.searchParams.get("all"), false);
      const maxPages = parseInteger(url.searchParams.get("maxPages"), 20);
      const cursor = url.searchParams.get("cursor") ?? null;

      const rows: Array<{
        id: string;
        provider: UnifiedProviderId;
        preview: string;
        title?: string | null | undefined;
        isGenerating?: boolean | undefined;
        createdAt: number;
        updatedAt: number;
        cwd?: string | undefined;
        source?: string | undefined;
      }> = [];
      const errors: Record<
        UnifiedProviderId,
        {
          code: string;
          message: string;
          details?: Record<string, string>;
        } | null
      > = {
        codex: null,
        opencode: null,
      };

      await Promise.all(
        listUnifiedProviders().map(async (provider) => {
          const adapter = resolveUnifiedAdapter(provider);
          if (!adapter) {
            errors[provider] = {
              code: "providerDisabled",
              message: `Provider ${provider} is not available`,
            };
            return;
          }

          try {
            const result = await adapter.execute({
              kind: "listThreads",
              provider,
              limit,
              archived,
              all,
              maxPages,
              cursor,
            });

            for (const thread of result.data) {
              threadIndex.register(thread.id, thread.provider);
              rows.push({
                ...thread,
                preview: compactSidebarPreview(thread.preview),
              });
            }
          } catch (error) {
            const message = toErrorMessage(error);
            errors[provider] = {
              code: "listThreadsFailed",
              message,
              details: {
                provider,
              },
            };
            logger.warn(
              {
                provider,
                error: message,
              },
              "unified-sidebar-threads-failed",
            );
          }
        }),
      );

      jsonResponse(res, 200, {
        ok: true,
        rows,
        errors,
      });
      return;
    }

    if (
      req.method === "GET" &&
      segments[0] === "api" &&
      segments[1] === "unified" &&
      segments[2] === "thread" &&
      segments[3]
    ) {
      const threadId = decodeURIComponent(segments[3]);
      const rawProvider = url.searchParams.get("provider");
      const providerFromQuery = parseUnifiedProviderId(rawProvider);
      if (rawProvider !== null && providerFromQuery === null) {
        jsonResponse(res, 400, {
          ok: false,
          error: {
            code: "invalidProvider",
            message: `Provider ${rawProvider} is not supported`,
            details: {
              provider: rawProvider,
            },
          },
        });
        return;
      }
      const includeTurns = parseBoolean(
        url.searchParams.get("includeTurns"),
        true,
      );
      const knownProviders = threadIndex.providers(threadId);
      const resolvedProvider = threadIndex.resolve(threadId);
      const provider = providerFromQuery ?? resolvedProvider;

      if (!provider) {
        if (knownProviders.length > 1) {
          jsonResponse(res, 409, {
            ok: false,
            error: {
              code: "threadProviderAmbiguous",
              message: `Thread ${threadId} exists in multiple providers; provider query is required`,
              details: {
                threadId,
                providers: knownProviders,
              },
            },
          });
          return;
        }

        jsonResponse(res, 404, {
          ok: false,
          error: {
            code: "threadNotFound",
            message: `Thread ${threadId} is not registered`,
            details: {
              threadId,
            },
          },
        });
        return;
      }

      const adapter = resolveUnifiedAdapter(provider);
      if (!adapter) {
        jsonResponse(res, 503, {
          ok: false,
          error: {
            code: "providerDisabled",
            message: `Provider ${provider} is not available`,
            details: {
              provider,
            },
          },
        });
        return;
      }

      try {
        const result = await adapter.execute({
          kind: "readThread",
          provider,
          threadId,
          includeTurns,
        });

        threadIndex.register(result.thread.id, result.thread.provider);
        jsonResponse(res, 200, {
          ok: true,
          thread: result.thread,
        });
      } catch (error) {
        const message = toErrorMessage(error);
        jsonResponse(res, 500, {
          ok: false,
          error: {
            code: "threadReadFailed",
            message,
            details: {
              provider,
              threadId,
              includeTurns,
            },
          },
        });
      }
      return;
    }

    if (segments[0] === "api" && segments[1] === "debug") {
      if (req.method === "GET" && segments[2] === "history" && segments[3]) {
        const entryId = decodeURIComponent(segments[3]);
        const entry = history.find((item) => item.id === entryId) ?? null;
        if (!entry) {
          jsonResponse(res, 404, {
            ok: false,
            error: "History entry not found",
          });
          return;
        }

        jsonResponse(res, 200, {
          ok: true,
          entry: toDebugHistoryListEntry(entry),
          fullPayloadJson: JSON.stringify(historyById.get(entryId) ?? null, null, 2),
        });
        return;
      }

      if (req.method === "GET" && segments[2] === "history") {
        const limit = parseInteger(url.searchParams.get("limit"), 120);
        const data = history.slice(-limit).map(toDebugHistoryListEntry);
        jsonResponse(res, 200, { ok: true, history: data });
        return;
      }

      if (req.method === "GET" && pathname === "/api/debug/trace/status") {
        jsonResponse(res, 200, {
          ok: true,
          active: activeTrace?.summary ?? null,
          recent: recentTraces,
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/debug/trace/start") {
        const body = parseBody(TraceStartBodySchema, await readJsonBody(req));
        if (activeTrace) {
          jsonResponse(res, 409, {
            ok: false,
            error: "A trace is already active",
          });
          return;
        }

        ensureTraceDirectory();
        const id = `${Date.now()}-${randomUUID()}`;
        const tracePath = path.join(TRACE_DIR, `${id}.ndjson`);
        const stream = fs.createWriteStream(tracePath, { flags: "a" });

        const summary: TraceSummary = {
          id,
          label: body.label,
          startedAt: new Date().toISOString(),
          stoppedAt: null,
          eventCount: 0,
          path: tracePath,
        };

        activeTrace = {
          summary,
          stream,
        };

        pushSystem("Trace started", {
          traceId: id,
          label: body.label,
        });

        jsonResponse(res, 200, {
          ok: true,
          trace: summary,
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/debug/trace/mark") {
        const body = parseBody(TraceMarkBodySchema, await readJsonBody(req));
        if (!activeTrace) {
          jsonResponse(res, 409, { ok: false, error: "No active trace" });
          return;
        }

        const marker = {
          type: "trace-marker",
          at: new Date().toISOString(),
          note: body.note,
        };

        activeTrace.stream.write(`${JSON.stringify(marker)}\n`);
        activeTrace.summary.eventCount += 1;

        jsonResponse(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && pathname === "/api/debug/trace/stop") {
        if (!activeTrace) {
          jsonResponse(res, 409, { ok: false, error: "No active trace" });
          return;
        }

        const trace = activeTrace;
        activeTrace = null;

        trace.summary.stoppedAt = new Date().toISOString();
        trace.stream.end();

        recentTraces.unshift(trace.summary);
        if (recentTraces.length > 20) {
          recentTraces.splice(20);
        }

        pushSystem("Trace stopped", { traceId: trace.summary.id });

        jsonResponse(res, 200, {
          ok: true,
          trace: trace.summary,
        });
        return;
      }

      if (
        req.method === "GET" &&
        segments[2] === "trace" &&
        segments[3] &&
        segments[4] === "download"
      ) {
        const traceId = decodeURIComponent(segments[3]);
        const trace = recentTraces.find((item) => item.id === traceId);

        if (!trace || !fs.existsSync(trace.path)) {
          jsonResponse(res, 404, { ok: false, error: "Trace not found" });
          return;
        }

        const data = fs.readFileSync(trace.path);
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          "Content-Length": data.length,
          "Content-Disposition": `attachment; filename="${trace.id}.ndjson"`,
          "Access-Control-Allow-Origin": "*",
        });
        res.end(data);
        return;
      }
    }

    if (req.method === "GET" && pathname === "/api/account/rate-limits") {
      const adapter = registry.resolveFirstWithCapability("canReadRateLimits");
      if (!adapter || !adapter.readRateLimits) {
        jsonResponse(res, 400, {
          ok: false,
          error: "No agent supports rate limit reading",
        });
        return;
      }

      try {
        const result = await adapter.readRateLimits();
        jsonResponse(res, 200, { ok: true, ...result });
      } catch (error) {
        if (
          isAuthenticationRequiredToReadRateLimitsAppServerRpcError(
            error instanceof Error ? error : null,
          )
        ) {
          jsonResponse(res, 200, {
            ok: true,
            rateLimits: {},
            rateLimitsByLimitId: null,
          });
          return;
        }
        const message = toErrorMessage(error);
        logger.warn({ error: message }, "rate-limits-read-failed");
        jsonResponse(res, 500, { ok: false, error: message });
      }
      return;
    }

    jsonResponse(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    runtimeLastError = toErrorMessage(error);
    logger.error(
      {
        method: req.method ?? "unknown",
        url: req.url ?? "unknown",
        error: runtimeLastError,
      },
      "request-failed",
    );
    pushSystem("Request failed", {
      error: runtimeLastError,
      method: req.method ?? "unknown",
      url: req.url ?? "unknown",
    });
    broadcastRuntimeState();
    jsonResponse(res, 500, {
      ok: false,
      error: runtimeLastError,
    });
  }
});

server.on("connection", (socket) => {
  activeSockets.add(socket);
  socket.on("close", () => {
    activeSockets.delete(socket);
  });
});

async function start(): Promise<void> {
  ensureTraceDirectory();

  pushSystem("Starting Farfield monitor server", {
    appExecutable: codexExecutable,
    agentIds: configuredAgentIds,
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };

    server.once("error", onError);
    server.listen({ port: PORT, host: HOST, exclusive: true }, () => {
      server.off("error", onError);
      resolve();
    });
  });

  pushSystem("Monitor server ready", {
    url: `http://${HOST}:${PORT}`,
    appExecutable: codexExecutable,
    agentIds: configuredAgentIds,
  });

  for (const adapter of registry.listAdapters()) {
    try {
      await adapter.start();
      pushSystem("Agent connected", {
        agentId: adapter.id,
        connected: adapter.isConnected(),
      });

      if (adapter.id === "opencode" && openCodeAdapter) {
        pushSystem("OpenCode backend connected", {
          url: openCodeAdapter.getUrl(),
        });
      }
    } catch (error) {
      pushSystem("Agent failed to connect", {
        agentId: adapter.id,
        error: toErrorMessage(error),
      });
      logger.error(
        {
          agentId: adapter.id,
          error: toErrorMessage(error),
        },
        "agent-start-failed",
      );
    }
  }

  broadcastRuntimeState();
  printStartupBanner();
  logger.info({ url: `http://${HOST}:${PORT}` }, "monitor-server-ready");
}

let shutdownPromise: Promise<void> | null = null;

async function shutdown(): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    clearInterval(sseKeepaliveTimer);

    for (const client of unifiedSseClients) {
      try {
        client.end();
      } catch {
        // Ignore close errors while shutting down.
      }
    }
    unifiedSseClients.clear();

    for (const socket of activeSockets) {
      socket.destroy();
    }
    activeSockets.clear();

    if (activeTrace) {
      activeTrace.stream.end();
      activeTrace = null;
    }

    await registry.stopAll();

    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  })();

  return shutdownPromise;
}

let shutdownRequested = false;
let forcedExitTimer: NodeJS.Timeout | null = null;

async function handleShutdownSignal(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (shutdownRequested) {
    process.stderr.write(`\nReceived ${signal} again. Exiting now.\n`);
    process.exit(130);
    return;
  }

  shutdownRequested = true;
  process.stdout.write("\nStopping Farfield server...\n");

  forcedExitTimer = setTimeout(() => {
    process.stderr.write("Shutdown is taking too long. Exiting now.\n");
    process.exit(130);
  }, 4_000);
  forcedExitTimer.unref();

  try {
    await shutdown();
    if (forcedExitTimer) {
      clearTimeout(forcedExitTimer);
      forcedExitTimer = null;
    }
    process.exit(0);
  } catch (error) {
    if (forcedExitTimer) {
      clearTimeout(forcedExitTimer);
      forcedExitTimer = null;
    }
    process.stderr.write(`Shutdown failed: ${toErrorMessage(error)}\n`);
    process.exit(1);
  }
}

process.on("SIGINT", () => {
  void handleShutdownSignal("SIGINT");
});

process.on("SIGTERM", () => {
  void handleShutdownSignal("SIGTERM");
});

void start().catch((error) => {
  runtimeLastError = toErrorMessage(error);
  pushSystem("Monitor server failed to start", { error: runtimeLastError });
  logger.fatal({ error: runtimeLastError }, "monitor-server-failed-to-start");
  process.exit(1);
});
