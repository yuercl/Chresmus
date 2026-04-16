import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  Bug,
  Circle,
  CircleDot,
  FileText,
  Folder,
  FolderOpen,
  Github,
  GripVertical,
  Loader2,
  Menu,
  Moon,
  Palette,
  PanelLeft,
  Plus,
  Sun,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import {
  clearServerBaseUrl,
  createThread,
  createServerDirectory,
  getActiveSavedServerTarget,
  getDefaultServerBaseUrl,
  getAccountRateLimits,
  getHealth,
  getHistoryEntry,
  getLiveState,
  getPendingApprovalRequests,
  getPendingThreadRequests,
  getPendingUserInputRequests,
  getFilesystemRawFileUrl,
  getServerBaseUrl,
  getStreamEvents,
  getUnifiedEventsUrl,
  getWorkspaceGitDiff,
  getWorkspaceGitStatus,
  listAgentsForBaseUrl,
  listSavedServerTargets,
  readFilesystemEntries,
  readFilesystemFile,
  readThread,
  readServerDirectory,
  removeNamedServerTarget,
  getTraceStatus,
  interruptThread,
  listAgents,
  listCollaborationModes,
  listModels,
  listDebugHistory,
  listSidebarThreads,
  markTrace,
  sendMessage,
  setCollaborationMode,
  startTrace,
  stopTrace,
  submitUserInput,
  saveNamedServerTarget,
  setActiveServerTarget,
  type AgentId,
} from "@/lib/api";
import {
  groupColors,
  readCollapseMap,
  readProjectColors,
  readSidebarOrder,
  type GroupColor,
  writeCollapseMap,
  writeProjectColors,
  writeSidebarOrder,
} from "@/lib/sidebar-prefs";
import {
  UnifiedEventSchema,
  type UnifiedEvent,
  type UnifiedItem,
  type UnifiedThreadRequestResponse,
  type UnifiedFeatureAvailability,
  type UnifiedFeatureId,
  type UnifiedInputPart,
} from "@chresmus/unified-surface";
import { useTheme } from "@/hooks/useTheme";
import { languageFromPath } from "@/lib/code-language";
import { ChatTimeline, type ChatTimelineEntry } from "@/components/ChatTimeline";
import { ChatComposer } from "@/components/ChatComposer";
import { CodeSnippet } from "@/components/CodeSnippet";
import { DiffBlock } from "@/components/DiffBlock";
import { PendingApprovalCard } from "@/components/PendingApprovalCard";
import { PendingInformationalRequestCard } from "@/components/PendingInformationalRequestCard";
import { PendingRequestCard } from "@/components/PendingRequestCard";
import { SidebarThreadWaitingIndicators } from "@/components/SidebarThreadWaitingIndicators";
import { StreamEventCard } from "@/components/StreamEventCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { z } from "zod";

/* ── Types ─────────────────────────────────────────────────── */
type Health = Awaited<ReturnType<typeof getHealth>>;
type SidebarThreadsResponse = Awaited<ReturnType<typeof listSidebarThreads>>;
type ModesResponse = Awaited<ReturnType<typeof listCollaborationModes>>;
type ModelsResponse = Awaited<ReturnType<typeof listModels>>;
type LiveStateResponse = Awaited<ReturnType<typeof getLiveState>>;
type StreamEventsResponse = Awaited<ReturnType<typeof getStreamEvents>>;
type ReadThreadResponse = Awaited<ReturnType<typeof readThread>>;
type AgentsResponse = Awaited<ReturnType<typeof listAgents>>;
type WorkspaceGitStatusResponse = Awaited<ReturnType<typeof getWorkspaceGitStatus>>;
type WorkspaceGitDiffResponse = Awaited<ReturnType<typeof getWorkspaceGitDiff>>;
type WorkspaceFileResponse = Awaited<ReturnType<typeof readFilesystemFile>>;
type WorkspaceEntriesResponse = Awaited<ReturnType<typeof readFilesystemEntries>>;
type TraceStatus = Awaited<ReturnType<typeof getTraceStatus>>;
type HistoryResponse = Awaited<ReturnType<typeof listDebugHistory>>;
type HistoryDetail = Awaited<ReturnType<typeof getHistoryEntry>>;
type CreatedThread = Awaited<ReturnType<typeof createThread>>["thread"];
type PendingRequest = ReturnType<typeof getPendingUserInputRequests>[number];
type PendingApprovalRequest = ReturnType<typeof getPendingApprovalRequests>[number];
type PendingThreadRequest = ReturnType<typeof getPendingThreadRequests>[number];
type PendingRequestId = PendingRequest["id"];
type SavedServerTarget = ReturnType<typeof listSavedServerTargets>[number];
type ModelEntry = ModelsResponse["data"][number];
type Thread = SidebarThreadsResponse["rows"][number] & {
  serverId: string;
  serverLabel: string;
  serverBaseUrl: string;
};
type ThreadListProviderErrors = SidebarThreadsResponse["errors"];
type AgentDescriptor = AgentsResponse["agents"][number];
type ConversationTurn = NonNullable<
  ReadThreadResponse["thread"]
>["turns"][number];
type ConversationTurnItem = NonNullable<ConversationTurn["items"]>[number];
type FlatConversationItem = ChatTimelineEntry;
type UnifiedThreadDeltaEvent = Extract<UnifiedEvent, { kind: "threadDelta" }>;
const AppTabSchema = z.enum(["chat", "workspace", "debug"]);

interface RefreshFlags {
  refreshCore: boolean;
  refreshHistory: boolean;
  refreshSelectedThread: boolean;
}

const TokenUsageSnakeCaseSchema = z
  .object({
    total_token_usage: z.object({ total_tokens: z.number() }).passthrough(),
    last_token_usage: z.object({ total_tokens: z.number() }).passthrough(),
    model_context_window: z.number().nullable(),
  })
  .passthrough();

const TokenUsageCamelCaseSchema = z
  .object({
    total: z.object({ totalTokens: z.number() }).passthrough(),
    last: z.object({ totalTokens: z.number() }).passthrough(),
    modelContextWindow: z.number().nullable(),
  })
  .passthrough();

const TurnErrorMessageSchema = z
  .object({
    message: z.string(),
  })
  .strict();

const ErrorMessageCarrierSchema = z
  .object({
    message: z.string(),
  })
  .strict();

interface NormalizedTokenUsage {
  contextTokens: number;
  sessionTotalTokens: number;
  contextWindow: number | null;
}

type ThreadStatusTone = "progress" | "warning" | "danger" | "neutral";

interface ThreadStatusSummary {
  label: string;
  detail: string | null;
  tone: ThreadStatusTone;
}

interface LoadSelectedThreadOptions {
  includeTurns: boolean;
  includeStreamEvents: boolean;
}

interface CachedThreadViewState {
  readThreadState: ReadThreadResponse | null;
  liveState: LiveStateResponse | null;
  streamEvents: StreamEventsResponse["events"];
}

interface AgentCacheEntry {
  value: AgentsResponse;
  fetchedAt: number;
  baseUrl: string;
}

interface ProviderCatalogCacheEntry {
  modes: ModesResponse["data"];
  models: ModelsResponse["data"];
  fetchedAt: number;
  baseUrl: string;
}

type AppTab = z.infer<typeof AppTabSchema>;

interface AppViewSnapshot {
  threads: Thread[];
  threadListErrors: ThreadListProviderErrors;
  selectedThreadId: string | null;
  liveState: LiveStateResponse | null;
  readThreadState: ReadThreadResponse | null;
  streamEvents: StreamEventsResponse["events"];
  modes: ModesResponse["data"];
  models: ModelsResponse["data"];
  agentDescriptors: AgentDescriptor[];
  selectedAgentId: AgentId;
  activeTab: AppTab;
}

interface SidebarTargetResult {
  target: ServerTargetOption;
  result: SidebarThreadsResponse;
}

const EMPTY_THREAD_LIST_ERRORS: ThreadListProviderErrors = {
  codex: null,
  opencode: null,
  claude: null,
  qwen: null,
};

const AGENT_LABEL_BY_ID: Record<AgentId, string> = {
  codex: "Codex",
  opencode: "OpenCode",
  claude: "Claude Code",
  qwen: "Qwen Code",
};

const AGENT_MONOGRAM_BY_ID: Record<AgentId, string> = {
  codex: "C",
  opencode: "O",
  claude: "A",
  qwen: "Q",
};

const AGENT_ICON_CLASS_BY_ID: Record<AgentId, string> = {
  codex: "bg-emerald-100 text-emerald-800",
  opencode: "bg-sky-100 text-sky-800",
  claude: "bg-orange-100 text-orange-800",
  qwen: "bg-amber-100 text-amber-800",
};

interface MobileSidebarSwipeGesture {
  mode: "open" | "close";
  startX: number;
  startY: number;
}

interface ServerTargetOption {
  id: string;
  label: string;
  baseUrl: string;
  isPrimary: boolean;
}

interface NewThreadModalState {
  serverId: string;
  agentId: AgentId;
  projectPath: string;
}

interface DirectoryBrowserState {
  path: string;
  parentPath: string | null;
  entries: Array<{
    name: string;
    path: string;
    kind: "directory";
  }>;
}

interface WorkspaceEntriesState {
  path: string;
  parentPath: string | null;
  entries: Array<{
    name: string;
    path: string;
    kind: "directory" | "file";
  }>;
}

/* ── Helpers ────────────────────────────────────────────────── */
function formatCompactRelativeTime(
  value: number | string | null | undefined,
): string {
  let timestampSeconds: number | null = null;

  if (typeof value === "number") {
    timestampSeconds = normalizeUnixTimestampSeconds(value);
  } else if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      timestampSeconds = Math.floor(date.getTime() / 1000);
    }
  }

  if (timestampSeconds === null) {
    return "";
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const diffSeconds = Math.max(0, nowSeconds - timestampSeconds);
  const minute = 60;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;

  if (diffSeconds < minute) return "1m";
  if (diffSeconds < hour) return `${Math.floor(diffSeconds / minute)}m`;
  if (diffSeconds < day) return `${Math.floor(diffSeconds / hour)}h`;
  if (diffSeconds < week) return `${Math.floor(diffSeconds / day)}d`;
  if (diffSeconds < month) return `${Math.floor(diffSeconds / week)}w`;
  if (diffSeconds < year) return `${Math.floor(diffSeconds / month)}mo`;
  return `${Math.floor(diffSeconds / year)}y`;
}

function threadLabel(thread: Thread): string {
  const title = thread.title?.trim();
  if (title) return title;
  const text = thread.preview.trim();
  if (!text) return `thread ${thread.id.slice(0, 8)}`;
  return text;
}

function buildServerTargetOptions(
  targets: SavedServerTarget[],
  primaryTargetId: string | null,
  defaultBaseUrl: string,
): ServerTargetOption[] {
  const explicitTargets =
    targets.length > 0
      ? targets
      : [
          {
            id: "automatic-server",
            label: "Automatic server",
            baseUrl: defaultBaseUrl,
          },
        ];

  return explicitTargets.map((target, index) => ({
    id: target.id,
    label: target.label,
    baseUrl: target.baseUrl,
    isPrimary:
      primaryTargetId !== null
        ? target.id === primaryTargetId
        : targets.length === 0
          ? index === 0
          : index === 0,
  }));
}

function threadRecencyTimestamp(thread: Thread): number {
  if (typeof thread.updatedAt === "number") {
    return normalizeUnixTimestampSeconds(thread.updatedAt);
  }
  if (typeof thread.createdAt === "number") {
    return normalizeUnixTimestampSeconds(thread.createdAt);
  }
  return 0;
}

function compareThreadsByRecency(left: Thread, right: Thread): number {
  const recencyDelta =
    threadRecencyTimestamp(right) - threadRecencyTimestamp(left);
  if (recencyDelta !== 0) {
    return recencyDelta;
  }

  const createdDelta =
    normalizeUnixTimestampSeconds(right.createdAt) -
    normalizeUnixTimestampSeconds(left.createdAt);
  if (createdDelta !== 0) {
    return createdDelta;
  }

  return right.id.localeCompare(left.id);
}

function sortThreadsByRecency(threads: Thread[]): Thread[] {
  return [...threads].sort(compareThreadsByRecency);
}

function normalizeUnixTimestampSeconds(value: number): number {
  if (value >= 10_000_000_000) {
    return Math.floor(value / 1000);
  }
  return Math.floor(value);
}

function parseTokenUsageInfo(
  raw: string | number | boolean | object | null | undefined,
): NormalizedTokenUsage | null {
  const snake = TokenUsageSnakeCaseSchema.safeParse(raw);
  if (snake.success) {
    return {
      contextTokens: snake.data.last_token_usage.total_tokens,
      sessionTotalTokens: snake.data.total_token_usage.total_tokens,
      contextWindow: snake.data.model_context_window,
    };
  }

  const camel = TokenUsageCamelCaseSchema.safeParse(raw);
  if (camel.success) {
    return {
      contextTokens: camel.data.last.totalTokens,
      sessionTotalTokens: camel.data.total.totalTokens,
      contextWindow: camel.data.modelContextWindow,
    };
  }

  return null;
}

function buildThreadSignature(thread: Thread): string {
  const serializedSource =
    thread.source === undefined ? "" : JSON.stringify(thread.source);
  return [
    thread.serverId,
    thread.id,
    String(thread.updatedAt ?? 0),
    String(thread.createdAt ?? 0),
    thread.title ?? "",
    thread.isGenerating ? "1" : "0",
    thread.waitingOnApproval ? "1" : "0",
    thread.waitingOnUserInput ? "1" : "0",
    thread.preview,
    thread.provider,
    thread.serverBaseUrl,
    thread.cwd ?? "",
    thread.agentNickname ?? "",
    thread.agentRole ?? "",
    serializedSource,
  ].join("|");
}

function mergeSidebarTargetResults(
  results: readonly SidebarTargetResult[],
  primaryBaseUrl: string,
): {
  threads: Thread[];
  errors: ThreadListProviderErrors;
} {
  const incomingThreads = sortThreadsByRecency(
    results.flatMap(({ target, result }) =>
      result.rows.map((thread) => ({
        ...thread,
        serverId: target.id,
        serverLabel: target.label,
        serverBaseUrl: target.baseUrl,
      })),
    ),
  );

  const primaryResult =
    results.find(({ target }) => target.baseUrl === primaryBaseUrl)?.result ??
    null;
  return {
    threads: incomingThreads,
    errors: primaryResult?.errors ?? {
      codex: null,
      opencode: null,
      claude: null,
      qwen: null,
    },
  };
}

function buildThreadsSignature(threads: Thread[]): string[] {
  return threads.map(buildThreadSignature);
}

function buildOptimisticThreadSummary(
  threadId: string,
  provider: AgentId,
  thread: CreatedThread,
  server: ServerTargetOption,
): Thread {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const createdAt =
    typeof thread.createdAt === "number"
      ? normalizeUnixTimestampSeconds(thread.createdAt)
      : nowSeconds;
  const updatedAt =
    typeof thread.updatedAt === "number"
      ? normalizeUnixTimestampSeconds(thread.updatedAt)
      : createdAt;
  const normalizedTitle =
    typeof thread.title === "string" ? thread.title.trim() : "";
  const preview = normalizedTitle.length > 0 ? normalizedTitle : "New thread";
  const title =
    thread.title === undefined
      ? undefined
      : thread.title === null
        ? null
        : thread.title;

  return {
    id: threadId,
    provider,
    serverId: server.id,
    serverLabel: server.label,
    serverBaseUrl: server.baseUrl,
    preview,
    createdAt,
    updatedAt,
    ...(title !== undefined ? { title } : {}),
    ...(thread.cwd ? { cwd: thread.cwd } : {}),
    ...(thread.source ? { source: thread.source } : {}),
    isGenerating: false,
    waitingOnApproval: false,
    waitingOnUserInput: false,
  };
}

function mergeIncomingThreads(
  nextThreads: Thread[],
  previousThreads: Thread[],
): Thread[] {
  const previousById = new Map(
    previousThreads.map((thread) => [thread.id, thread]),
  );
  const merged = nextThreads.map((thread) => {
    const previous = previousById.get(thread.id);
    if (
      (thread.title !== undefined || previous?.title === undefined) &&
      (thread.isGenerating !== undefined ||
        previous?.isGenerating === undefined) &&
      (thread.waitingOnApproval !== undefined ||
        previous?.waitingOnApproval === undefined) &&
      (thread.waitingOnUserInput !== undefined ||
        previous?.waitingOnUserInput === undefined)
    ) {
      return thread;
    }
    return {
      ...thread,
      ...(thread.title !== undefined || previous?.title === undefined
        ? {}
        : { title: previous.title }),
      ...(thread.isGenerating !== undefined ||
      previous?.isGenerating === undefined
        ? {}
        : { isGenerating: previous.isGenerating }),
      ...(thread.waitingOnApproval !== undefined ||
      previous?.waitingOnApproval === undefined
        ? {}
        : { waitingOnApproval: previous.waitingOnApproval }),
      ...(thread.waitingOnUserInput !== undefined ||
      previous?.waitingOnUserInput === undefined
        ? {}
        : { waitingOnUserInput: previous.waitingOnUserInput }),
    };
  });

  return sortThreadsByRecency(merged);
}

function toErrorMessage<T>(err: T): string {
  const normalize = (message: string): string => {
    const trimmed = message.trim();
    const normalized = trimmed.toLowerCase();
    if (trimmed === "Codex app-server is not connected") {
      return "";
    }
    if (
      trimmed === "Network request failed" ||
      trimmed === "Failed to fetch"
    ) {
      return "Request failed. Check network/server, then send again.";
    }
    if (trimmed === "Claude Code does not support image messages") {
      return "Image message was rejected by Claude Code. Send again or switch model/provider.";
    }
    if (trimmed === "OpenCode does not support image messages") {
      return "Image message was rejected by OpenCode. Send again or switch model/provider.";
    }
    if (trimmed === "Qwen Code does not support image messages") {
      return "Image message was rejected by Qwen Code. Send again or switch model/provider.";
    }
    if (
      normalized.includes("model call failed") ||
      normalized.includes("model request failed")
    ) {
      return "Model call failed. Send again. If it keeps failing, switch model or check the provider/server status.";
    }
    if (
      normalized.includes("rate limit") ||
      normalized.includes("too many requests")
    ) {
      return "Rate limited. Wait a moment, then send again.";
    }
    if (
      normalized.includes("context window") ||
      normalized.includes("context length") ||
      normalized.includes("prompt is too long") ||
      normalized.includes("maximum context")
    ) {
      return "Message is too large for the current model context. Start a new thread or reduce the input, then send again.";
    }
    return trimmed;
  };

  if (err instanceof Error) {
    return normalize(err.message);
  }
  if (typeof err === "string") {
    return normalize(err);
  }
  const parsed = ErrorMessageCarrierSchema.safeParse(err);
  if (parsed.success) {
    return normalize(parsed.data.message);
  }
  return normalize(String(err ?? ""));
}

const DEFAULT_CODEX_APPROVAL_POLICY = "never";
const DEFAULT_CODEX_SANDBOX = "danger-full-access";

type ParsedModelVersion = {
  family: string;
  major: number;
  minor: number;
  patch: number;
};

function parseModelVersion(value: string): ParsedModelVersion | null {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "-");
  const match = /^([a-z]+(?:-[a-z]+)*)-(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(
    normalized,
  );
  if (!match) {
    return null;
  }
  const family = match[1];
  const majorText = match[2];
  if (!family || !majorText) {
    return null;
  }
  return {
    family,
    major: Number.parseInt(majorText, 10),
    minor: match[3] ? Number.parseInt(match[3], 10) : 0,
    patch: match[4] ? Number.parseInt(match[4], 10) : 0,
  };
}

function compareModelVersions(
  left: ParsedModelVersion,
  right: ParsedModelVersion,
): number {
  if (left.family !== right.family) {
    return left.family.localeCompare(right.family);
  }
  if (left.major !== right.major) {
    return right.major - left.major;
  }
  if (left.minor !== right.minor) {
    return right.minor - left.minor;
  }
  if (left.patch !== right.patch) {
    return right.patch - left.patch;
  }
  return 0;
}

function compareModelsByPreference(left: ModelEntry, right: ModelEntry): number {
  const leftVersion =
    parseModelVersion(left.id) ?? parseModelVersion(left.displayName);
  const rightVersion =
    parseModelVersion(right.id) ?? parseModelVersion(right.displayName);

  if (leftVersion && rightVersion) {
    const versionComparison = compareModelVersions(leftVersion, rightVersion);
    if (versionComparison !== 0) {
      return versionComparison;
    }
  } else if (leftVersion || rightVersion) {
    return leftVersion ? -1 : 1;
  }

  if (left.isDefault !== right.isDefault) {
    return left.isDefault ? -1 : 1;
  }

  const leftLabel = left.displayName || left.id;
  const rightLabel = right.displayName || right.id;
  return leftLabel.localeCompare(rightLabel);
}

function sortModelsByPreference(models: ReadonlyArray<ModelEntry>): ModelEntry[] {
  return [...models].sort(compareModelsByPreference);
}

function buildThreadListErrorMessage(
  errors: ThreadListProviderErrors,
): string | null {
  const messages: string[] = [];
  for (const agentId of Object.keys(AGENT_LABEL_BY_ID) as AgentId[]) {
    const error = errors[agentId];
    if (error) {
      messages.push(`${AGENT_LABEL_BY_ID[agentId]}: ${error.message}`);
    }
  }

  if (messages.length === 0) {
    return null;
  }

  return `Thread list sync failed for provider(s): ${messages.join(" | ")}`;
}

function hasSameThreadListErrors(
  left: ThreadListProviderErrors,
  right: ThreadListProviderErrors,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function shouldRenderConversationItem(item: ConversationTurnItem): boolean {
  switch (item.type) {
    case "userMessage":
    case "steeringUserMessage":
      return item.content.some(
        (part) => part.type === "text" && part.text.length > 0,
      );
    case "agentMessage":
      return item.text.length > 0;
    case "reasoning": {
      return (item.summary?.length ?? 0) > 0 || Boolean(item.text);
    }
    case "userInputResponse":
      return Object.values(item.answers).some((answers) => answers.length > 0);
    default:
      return true;
  }
}

function isFeatureAvailable(
  availability: UnifiedFeatureAvailability | undefined,
): boolean {
  return availability?.status === "available";
}

function canUseFeature(
  descriptor: AgentDescriptor | null | undefined,
  featureId: UnifiedFeatureId,
): boolean {
  if (!descriptor) {
    return false;
  }
  return isFeatureAvailable(descriptor.features[featureId]);
}

function isTurnInProgressStatus(status: string | undefined): boolean {
  return status === "in-progress" || status === "inProgress";
}

function isTurnFailedStatus(status: string | undefined): boolean {
  return status === "failed" || status === "error";
}

function isTurnInterruptedStatus(status: string | undefined): boolean {
  return (
    status === "interrupted" ||
    status === "aborted" ||
    status === "cancelled" ||
    status === "canceled"
  );
}

function readTurnErrorMessage(
  error: ConversationTurn["error"] | undefined,
): string | null {
  if (error === undefined || error === null) {
    return null;
  }

  const parsed = TurnErrorMessageSchema.safeParse(error);
  if (!parsed.success) {
    return null;
  }

  const message = parsed.data.message.trim();
  return message.length > 0 ? message : null;
}

function buildThreadStatusSummary(input: {
  isGenerating: boolean;
  waitingOnApproval: boolean;
  waitingOnUserInput: boolean;
  lastTurn: ConversationTurn | undefined;
  liveStateError: LiveStateResponse["liveStateError"];
  uiErrorMessage?: string | null;
}): ThreadStatusSummary | null {
  const lastTurnErrorMessage = readTurnErrorMessage(input.lastTurn?.error);
  const uiErrorMessage =
    typeof input.uiErrorMessage === "string" &&
    input.uiErrorMessage.trim().length > 0
      ? input.uiErrorMessage.trim()
      : null;

  if (isTurnFailedStatus(input.lastTurn?.status)) {
    return {
      label: "Error",
      detail: lastTurnErrorMessage ?? "The last turn failed.",
      tone: "danger",
    };
  }

  if (isTurnInterruptedStatus(input.lastTurn?.status)) {
    return {
      label: "Interrupted",
      detail: lastTurnErrorMessage ?? "The last turn was interrupted.",
      tone: "danger",
    };
  }

  if (input.isGenerating) {
    return {
      label: "Responding",
      detail: null,
      tone: "progress",
    };
  }

  if (uiErrorMessage) {
    return {
      label: "Error",
      detail: uiErrorMessage,
      tone: "danger",
    };
  }

  if (input.liveStateError) {
    return {
      label: "Sync issue",
      detail: input.liveStateError.message,
      tone: "danger",
    };
  }

  return null;
}

function threadStatusClasses(
  tone: ThreadStatusTone,
): { container: string; dot: string } {
  switch (tone) {
    case "progress":
      return {
        container:
          "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        dot: "bg-emerald-500",
      };
    case "warning":
      return {
        container:
          "border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-300",
        dot: "bg-amber-500",
      };
    case "danger":
      return {
        container:
          "border-rose-500/30 bg-rose-500/12 text-rose-700 dark:text-rose-300",
        dot: "bg-rose-500",
      };
    case "neutral":
      return {
        container: "border-border bg-muted/40 text-muted-foreground",
        dot: "bg-muted-foreground",
      };
  }
}

function isThreadGeneratingState(
  state: NonNullable<ReadThreadResponse["thread"]> | null | undefined,
): boolean {
  if (!state) {
    return false;
  }
  const lastTurn = state.turns[state.turns.length - 1];
  return isTurnInProgressStatus(lastTurn?.status);
}

function signaturesMatch(prev: string[], next: string[]): boolean {
  if (prev.length !== next.length) {
    return false;
  }
  return prev.every((value, index) => value === next[index]);
}

const DEFAULT_EFFORT_OPTIONS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
const EFFORT_ORDER: ReadonlyArray<string> = DEFAULT_EFFORT_OPTIONS;
const INITIAL_VISIBLE_CHAT_ITEMS = 90;
const VISIBLE_CHAT_ITEMS_STEP = 80;
const APP_DEFAULT_VALUE = "__app_default__";
const ASSUMED_APP_DEFAULT_MODEL = "gpt-5.3-codex";
const ASSUMED_APP_DEFAULT_EFFORT = "medium";
const AGENT_CACHE_TTL_MS = 30_000;
const PROVIDER_CATALOG_CACHE_TTL_MS = 20_000;
const APP_SERVER_OWNER_CLIENT_ID = "app-server";
const DEBUG_UI_ENABLED = import.meta.env.MODE !== "production";
const MOBILE_SIDEBAR_WIDTH_PX = 256;
const MOBILE_SWIPE_EDGE_PX = 24;
const MOBILE_SIDEBAR_TOGGLE_THRESHOLD_PX = 88;
const ASSUMED_DEFAULT_MODEL_BY_AGENT: Record<AgentId, string> = {
  codex: "gpt-5.3-codex",
  opencode: "",
  claude: "default",
  qwen: "coder-model",
};
const ASSUMED_DEFAULT_MODEL_LABEL_BY_AGENT: Record<AgentId, string> = {
  codex: "gpt-5.3-codex",
  opencode: "Default",
  claude: "Claude Default (default)",
  qwen: "Qwen Coder Model (coder-model)",
};
const AGENT_FAVICON_BY_ID: Record<AgentId, string> = {
  codex: "/agent-icons/codex.png",
  opencode: "/agent-icons/opencode.svg",
  claude: "/agent-icons/claude.png",
  qwen: "/agent-icons/qwen.png",
};

let appViewSnapshotCache: AppViewSnapshot | null = null;
const ENABLE_VIEW_SNAPSHOT_CACHE =
  typeof window !== "undefined" && import.meta.env.MODE !== "test";

function agentFavicon(agentId: AgentId | null | undefined): string | null {
  if (!agentId) {
    return null;
  }
  return AGENT_FAVICON_BY_ID[agentId] ?? null;
}

function assumedDefaultModelIdForAgent(agentId: AgentId): string {
  return ASSUMED_DEFAULT_MODEL_BY_AGENT[agentId];
}

function assumedDefaultModelLabelForAgent(agentId: AgentId): string {
  return ASSUMED_DEFAULT_MODEL_LABEL_BY_AGENT[agentId];
}

function compareEffortOptions(left: string, right: string): number {
  const leftIndex = EFFORT_ORDER.indexOf(left);
  const rightIndex = EFFORT_ORDER.indexOf(right);
  const leftKnown = leftIndex !== -1;
  const rightKnown = rightIndex !== -1;

  if (leftKnown && rightKnown) {
    return leftIndex - rightIndex;
  }
  if (leftKnown) {
    return -1;
  }
  if (rightKnown) {
    return 1;
  }
  return left.localeCompare(right);
}

function sortEffortOptions(options: string[]): string[] {
  return [...options].sort(compareEffortOptions);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function AgentFavicon({
  agentId,
  label,
  className,
}: {
  agentId: AgentId;
  label: string;
  className?: string;
}) {
  const faviconUrl = agentFavicon(agentId);
  const [imageFailed, setImageFailed] = useState(false);
  const iconClassName = className ?? "h-4 w-4";

  if (!faviconUrl || imageFailed) {
    return (
      <span
        aria-label={label}
        title={label}
        className={`inline-flex items-center justify-center rounded-[0.35rem] text-[9px] font-semibold leading-none shadow-sm ring-1 ring-black/8 ${AGENT_ICON_CLASS_BY_ID[agentId]} ${iconClassName}`}
      >
        {AGENT_MONOGRAM_BY_ID[agentId]}
      </span>
    );
  }

  return (
    <span
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center rounded-[0.35rem] bg-white p-[2px] shadow-sm ring-1 ring-black/8 ${iconClassName}`}
    >
      <img
        src={faviconUrl}
        alt={label}
        title={label}
        className="h-full w-full object-contain"
        loading="lazy"
        decoding="async"
        onError={() => setImageFailed(true)}
      />
    </span>
  );
}

function isPlanModeOption(mode: {
  mode?: string | null | undefined;
  name: string;
}): boolean {
  const modeKey = typeof mode.mode === "string" ? mode.mode : "";
  return (
    modeKey.toLowerCase().includes("plan") ||
    mode.name.toLowerCase().includes("plan")
  );
}

function buildModeSignature(
  modeKey: string,
  modelId: string,
  effort: string,
): string {
  return `${modeKey}|${modelId}|${effort}`;
}

function parseAgentId(value: string): AgentId | null {
  return value === "codex" ||
    value === "opencode" ||
    value === "claude" ||
    value === "qwen"
    ? value
    : null;
}

function getConversationStateUpdatedAt(
  state: NonNullable<ReadThreadResponse["thread"]> | null | undefined,
): number {
  if (!state || typeof state.updatedAt !== "number") {
    return Number.NEGATIVE_INFINITY;
  }
  return state.updatedAt;
}

function buildApprovalResponse(
  request: PendingApprovalRequest,
  action: "approve" | "deny",
): UnifiedThreadRequestResponse {
  switch (request.method) {
    case "item/commandExecution/requestApproval": {
      const available = request.params.availableDecisions ?? [];
      if (action === "approve") {
        const approveDecision =
          available.find(
            (decision) => decision !== "decline" && decision !== "cancel",
          ) ?? null;
        if (approveDecision !== null) {
          return { decision: approveDecision };
        }
        return { decision: "accept" };
      }

      const decline =
        available.find((decision) => decision === "decline") ?? null;
      if (decline) {
        return { decision: decline };
      }
      const cancel =
        available.find((decision) => decision === "cancel") ?? null;
      if (cancel) {
        return { decision: cancel };
      }
      return { decision: "decline" };
    }

    case "item/fileChange/requestApproval":
      return {
        decision: action === "approve" ? "accept" : "decline",
      };

    case "applyPatchApproval":
    case "execCommandApproval":
      return {
        decision: action === "approve" ? "approved" : "denied",
      };
  }

  throw new Error("Unsupported approval request method");
}

function normalizeNullableModeValue(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : "";
}

function normalizeModeSettingValue(
  value: string | null | undefined,
  assumedDefault: string,
): string {
  const normalized = normalizeNullableModeValue(value);
  if (!normalized) {
    return "";
  }
  if (normalized === assumedDefault) {
    return "";
  }
  return normalized;
}

function readModeSelectionFromConversationState(
  state: NonNullable<ReadThreadResponse["thread"]> | null,
): {
  modeKey: string;
  modelId: string;
  reasoningEffort: string;
} {
  if (!state) {
    return {
      modeKey: "",
      modelId: "",
      reasoningEffort: "",
    };
  }

  if (state.latestCollaborationMode) {
    const modelId =
      normalizeModeSettingValue(
        state.latestCollaborationMode.settings.model,
        ASSUMED_APP_DEFAULT_MODEL,
      ) ||
      normalizeModeSettingValue(state.latestModel, ASSUMED_APP_DEFAULT_MODEL);
    const reasoningEffort =
      normalizeModeSettingValue(
        state.latestCollaborationMode.settings.reasoningEffort,
        ASSUMED_APP_DEFAULT_EFFORT,
      ) ||
      normalizeModeSettingValue(
        state.latestReasoningEffort,
        ASSUMED_APP_DEFAULT_EFFORT,
      );

    return {
      modeKey: state.latestCollaborationMode.mode,
      modelId,
      reasoningEffort,
    };
  }

  return {
    modeKey: "",
    modelId: normalizeModeSettingValue(
      state.latestModel,
      ASSUMED_APP_DEFAULT_MODEL,
    ),
    reasoningEffort: normalizeModeSettingValue(
      state.latestReasoningEffort,
      ASSUMED_APP_DEFAULT_EFFORT,
    ),
  };
}

function modeSelectionSignatureFromConversationState(
  state: NonNullable<ReadThreadResponse["thread"]> | null | undefined,
): string {
  const selection = readModeSelectionFromConversationState(state ?? null);
  return buildModeSignature(
    selection.modeKey,
    selection.modelId,
    selection.reasoningEffort,
  );
}

function conversationProgressSignature(
  state: NonNullable<ReadThreadResponse["thread"]> | null | undefined,
): string {
  if (!state) {
    return "";
  }

  const lastTurn = state.turns[state.turns.length - 1];
  if (!lastTurn) {
    return "no-turns";
  }

  const lastTurnId = lastTurn.id ?? lastTurn.turnId ?? "";
  const items = lastTurn.items ?? [];
  const lastItem = items[items.length - 1];

  return [
    String(state.turns.length),
    lastTurnId,
    lastTurn.status,
    String(items.length),
    lastItem?.id ?? "",
    lastItem?.type ?? "",
  ].join("|");
}

function conversationContentSignature(
  state: NonNullable<ReadThreadResponse["thread"]> | null | undefined,
): string {
  if (!state) {
    return "";
  }

  const lastTurn = state.turns[state.turns.length - 1];
  if (!lastTurn) {
    return "no-turn-content";
  }

  // Cheap O(n) signature using text-length tracking instead of full JSON.stringify.
  // Captures all meaningful changes (new items, status transitions, text growth,
  // command output growth, reasoning growth) without serialising item content.
  const items = lastTurn.items ?? [];
  const itemSig = items
    .map((item) => {
      let contentLen = 0;
      if (item.type === "agentMessage") {
        contentLen = item.text?.length ?? 0;
      } else if (item.type === "plan") {
        contentLen = item.text?.length ?? 0;
      } else if (item.type === "commandExecution") {
        contentLen =
          (item.aggregatedOutput?.length ?? 0) +
          (item.exitCode != null ? 1 : 0);
      } else if (item.type === "reasoning") {
        contentLen =
          (item.text?.length ?? 0) +
          (item.summary?.reduce((s, p) => s + p.length, 0) ?? 0);
      } else if (item.type === "fileChange") {
        const fc = item as typeof item & { aggregatedOutput?: string };
        contentLen =
          (fc.aggregatedOutput?.length ?? 0) + item.changes.length;
      }
      return `${item.id}:${item.type}:${(item as { status?: string }).status ?? ""}:${contentLen}`;
    })
    .join(",");

  return `${lastTurn.status}|${items.length}|${itemSig}|${state.requests?.length ?? 0}`;
}

function buildLiveStateSyncSignature(
  state: LiveStateResponse | null | undefined,
): string {
  if (!state) {
    return "";
  }

  const conversationState = state.conversationState;
  return [
    state.threadId,
    state.ownerClientId ?? "",
    String(getConversationStateUpdatedAt(conversationState)),
    String(conversationState?.turns.length ?? -1),
    modeSelectionSignatureFromConversationState(conversationState),
    conversationProgressSignature(conversationState),
    conversationContentSignature(conversationState),
  ].join("|");
}

function buildReadThreadSyncSignature(
  state: ReadThreadResponse | null | undefined,
): string {
  if (!state) {
    return "";
  }

  const conversationState = state.thread;
  return [
    conversationState.id,
    String(getConversationStateUpdatedAt(conversationState)),
    String(conversationState.turns.length),
    modeSelectionSignatureFromConversationState(conversationState),
    conversationProgressSignature(conversationState),
    conversationContentSignature(conversationState),
  ].join("|");
}

function unifiedTurnIdentity(turn: ConversationTurn): string {
  return turn.id ?? turn.turnId ?? "";
}

function applyThreadSnapshotMetadata(
  thread: NonNullable<ReadThreadResponse["thread"]>,
  snapshot: UnifiedThreadDeltaEvent["snapshot"],
): NonNullable<ReadThreadResponse["thread"]> {
  if (!snapshot) {
    return thread;
  }

  return {
    ...thread,
    ...(snapshot.updatedAt !== undefined ? { updatedAt: snapshot.updatedAt } : {}),
    ...(snapshot.title !== undefined ? { title: snapshot.title } : {}),
    ...(snapshot.latestCollaborationMode !== undefined
      ? { latestCollaborationMode: snapshot.latestCollaborationMode }
      : {}),
    ...(snapshot.latestModel !== undefined ? { latestModel: snapshot.latestModel } : {}),
    ...(snapshot.latestReasoningEffort !== undefined
      ? { latestReasoningEffort: snapshot.latestReasoningEffort }
      : {}),
    ...(snapshot.latestTokenUsageInfo !== undefined
      ? { latestTokenUsageInfo: snapshot.latestTokenUsageInfo }
      : {}),
  };
}

function createDeltaPlaceholderItem(
  itemId: string,
  itemType:
    | "agentMessage"
    | "plan"
    | "commandExecution"
    | "reasoningText"
    | "reasoningSummaryText"
    | "fileChange",
  summaryIndex?: number,
): ConversationTurnItem {
  switch (itemType) {
    case "agentMessage":
      return {
        id: itemId,
        type: "agentMessage",
        text: "",
      };
    case "plan":
      return {
        id: itemId,
        type: "plan",
        text: "",
      };
    case "commandExecution":
      return {
        id: itemId,
        type: "commandExecution",
        command: "",
        status: "inProgress",
        aggregatedOutput: "",
      };
    case "reasoningText":
      return {
        id: itemId,
        type: "reasoning",
        text: "",
      };
    case "reasoningSummaryText":
      return {
        id: itemId,
        type: "reasoning",
        summary:
          summaryIndex === undefined
            ? [""]
            : Array.from({ length: summaryIndex + 1 }, () => ""),
      };
    case "fileChange":
      return {
        id: itemId,
        type: "fileChange",
        status: "inProgress",
        aggregatedOutput: "",
        changes: [],
      };
  }
}

function updateTurnItemById(
  turn: ConversationTurn,
  itemId: string,
  updater: (item: ConversationTurnItem) => ConversationTurnItem,
  createItem: () => ConversationTurnItem,
): ConversationTurn {
  const items = [...turn.items];
  const itemIndex = items.findIndex((item) => item.id === itemId);

  if (itemIndex === -1) {
    items.push(updater(createItem()));
    return {
      ...turn,
      items,
    };
  }

  const existingItem = items[itemIndex];
  if (!existingItem) {
    return turn;
  }

  items[itemIndex] = updater(existingItem);
  return {
    ...turn,
    items,
  };
}

function updateThreadTurnById(
  thread: NonNullable<ReadThreadResponse["thread"]>,
  turnId: string,
  updater: (turn: ConversationTurn) => ConversationTurn,
  createTurn: () => ConversationTurn,
): NonNullable<ReadThreadResponse["thread"]> {
  const turns = [...thread.turns];
  const turnIndex = turns.findIndex((turn) => unifiedTurnIdentity(turn) === turnId);

  if (turnIndex === -1) {
    turns.push(updater(createTurn()));
    return {
      ...thread,
      turns,
    };
  }

  const existingTurn = turns[turnIndex];
  if (!existingTurn) {
    return thread;
  }

  turns[turnIndex] = updater(existingTurn);
  return {
    ...thread,
    turns,
  };
}

function applyUnifiedThreadDelta(
  thread: NonNullable<ReadThreadResponse["thread"]>,
  event: UnifiedThreadDeltaEvent,
): NonNullable<ReadThreadResponse["thread"]> {
  const threadWithSnapshot = applyThreadSnapshotMetadata(thread, event.snapshot);
  const delta = event.delta;

  switch (delta.type) {
    case "turnUpdated": {
      const turns = [...threadWithSnapshot.turns];
      const turnId = unifiedTurnIdentity(delta.turn);
      const turnIndex = turns.findIndex((turn) => unifiedTurnIdentity(turn) === turnId);

      if (turnIndex === -1) {
        turns.push(delta.turn);
      } else {
        turns[turnIndex] = delta.turn;
      }

      return {
        ...threadWithSnapshot,
        turns,
      };
    }
    case "turnDiffUpdated":
      return updateThreadTurnById(
        threadWithSnapshot,
        delta.turnId,
        (turn) => ({
          ...turn,
          diff: delta.diff,
        }),
        () => ({
          id: delta.turnId,
          turnId: delta.turnId,
          status: "inProgress",
          items: [],
          diff: delta.diff,
        }),
      );
    case "itemTextDelta":
      return updateThreadTurnById(
        threadWithSnapshot,
        delta.turnId,
        (turn) =>
          updateTurnItemById(
            turn,
            delta.itemId,
            (item) => {
              switch (delta.itemType) {
                case "agentMessage":
                  return item.type === "agentMessage"
                    ? { ...item, text: `${item.text}${delta.delta}` }
                    : item;
                case "plan":
                  return item.type === "plan"
                    ? { ...item, text: `${item.text}${delta.delta}` }
                    : item;
                case "commandExecution":
                  return item.type === "commandExecution"
                    ? {
                        ...item,
                        aggregatedOutput: `${item.aggregatedOutput ?? ""}${delta.delta}`,
                      }
                    : item;
                case "reasoningText":
                  return item.type === "reasoning"
                    ? { ...item, text: `${item.text ?? ""}${delta.delta}` }
                    : item;
                case "reasoningSummaryText":
                  if (item.type !== "reasoning") {
                    return item;
                  }
                  return {
                    ...item,
                    summary: appendReasoningSummaryDelta(
                      item.summary,
                      delta.summaryIndex ?? 0,
                      delta.delta,
                    ),
                  };
                case "fileChange":
                  if (item.type !== "fileChange") {
                    return item;
                  }
                  return {
                    ...item,
                    aggregatedOutput: `${(item as typeof item & { aggregatedOutput?: string }).aggregatedOutput ?? ""}${delta.delta}`,
                  };
              }
            },
            () =>
              createDeltaPlaceholderItem(
                delta.itemId,
                delta.itemType,
                delta.summaryIndex,
              ),
          ),
        () => ({
          id: delta.turnId,
          turnId: delta.turnId,
          status: "inProgress",
          items: [
            createDeltaPlaceholderItem(
              delta.itemId,
              delta.itemType,
              delta.summaryIndex,
            ),
          ],
        }),
      );
    case "reasoningSummaryPartAdded":
      return updateThreadTurnById(
        threadWithSnapshot,
        delta.turnId,
        (turn) =>
          updateTurnItemById(
            turn,
            delta.itemId,
            (item) =>
              item.type === "reasoning"
                ? {
                    ...item,
                    summary: ensureSummaryIndex(
                      item.summary,
                      delta.summaryIndex,
                    ),
                  }
                : item,
            () => ({
              id: delta.itemId,
              type: "reasoning",
              summary: ensureSummaryIndex([], delta.summaryIndex),
            }),
          ),
        () => ({
          id: delta.turnId,
          turnId: delta.turnId,
          status: "inProgress",
          items: [
            {
              id: delta.itemId,
              type: "reasoning",
              summary: ensureSummaryIndex([], delta.summaryIndex),
            },
          ],
        }),
      );
    case "threadTitleUpdated":
      return {
        ...threadWithSnapshot,
        title: delta.title,
      };
    case "tokenUsageUpdated":
      return {
        ...threadWithSnapshot,
        latestTokenUsageInfo: delta.tokenUsage,
      };
  }
}

function ensureSummaryIndex(
  summary: readonly string[] | undefined,
  summaryIndex: number,
): string[] {
  const nextSummary = summary ? [...summary] : [];
  while (nextSummary.length <= summaryIndex) {
    nextSummary.push("");
  }
  return nextSummary;
}

function appendReasoningSummaryDelta(
  summary: readonly string[] | undefined,
  summaryIndex: number,
  delta: string,
): string[] {
  const nextSummary = ensureSummaryIndex(summary, summaryIndex);
  nextSummary[summaryIndex] = `${nextSummary[summaryIndex] ?? ""}${delta}`;
  return nextSummary;
}

function basenameFromPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  if (!normalized) {
    return value;
  }
  const parts = normalized.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? normalized;
}

function normalizeManualGroupOrder(
  manualOrder: readonly string[],
  autoSortedKeys: readonly string[],
): string[] {
  const availableKeys = new Set(autoSortedKeys);
  const legacyKeyMap = new Map<string, string>();
  for (const key of autoSortedKeys) {
    const projectMarker = ":project:";
    const projectIndex = key.indexOf(projectMarker);
    if (projectIndex === -1) {
      continue;
    }
    const projectPath = key.slice(projectIndex + projectMarker.length);
    legacyKeyMap.set(`project:${projectPath}`, key);
  }
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const rawKey of manualOrder) {
    const key = legacyKeyMap.get(rawKey) ?? rawKey;
    if (!availableKeys.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(key);
  }

  for (const key of autoSortedKeys) {
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(key);
  }

  return normalized;
}

function formatResetTimestamp(resetAtSeconds: number | null): string | null {
  if (resetAtSeconds == null) {
    return null;
  }
  const date = new Date(resetAtSeconds * 1000);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function workspaceStatusLabel(
  status: WorkspaceGitStatusResponse["files"][number]["stagedStatus"],
): string {
  switch (status) {
    case "added":
      return "Added";
    case "modified":
      return "Modified";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "copied":
      return "Copied";
    case "unmerged":
      return "Unmerged";
    case "untracked":
      return "Untracked";
    case "typeChanged":
      return "Type changed";
    case null:
      return "Clean";
  }
}

function workspacePreferredMode(
  file: WorkspaceGitStatusResponse["files"][number] | null,
): "diff" | "file" {
  if (!file) {
    return "file";
  }

  return workspaceSupportsDiff(file) ? "diff" : "file";
}

function workspaceDiffKind(
  file: WorkspaceGitStatusResponse["files"][number] | null,
): { type: "create" | "modify" | "delete"; movePath?: string | null } {
  if (file === null) {
    return { type: "modify" };
  }

  const status = file.unstagedStatus ?? file.stagedStatus;
  switch (status) {
    case "added":
    case "untracked":
    case "copied":
      return { type: "create" };
    case "deleted":
      return { type: "delete" };
    case "renamed":
      return file.previousPath
        ? { type: "modify", movePath: file.previousPath }
        : { type: "modify" };
    case "modified":
    case "unmerged":
    case "typeChanged":
    case null:
      return { type: "modify" };
  }
}

function workspaceIsImagePath(pathValue: string): boolean {
  const normalized = pathValue.trim().toLowerCase();
  return (
    normalized.endsWith(".png") ||
    normalized.endsWith(".jpg") ||
    normalized.endsWith(".jpeg") ||
    normalized.endsWith(".gif") ||
    normalized.endsWith(".webp") ||
    normalized.endsWith(".avif") ||
    normalized.endsWith(".svg")
  );
}

function workspaceHasDeletedStatus(
  file: WorkspaceGitStatusResponse["files"][number] | null,
): boolean {
  if (!file) {
    return false;
  }
  return file.stagedStatus === "deleted" || file.unstagedStatus === "deleted";
}

function workspaceSupportsDiff(
  file: WorkspaceGitStatusResponse["files"][number] | null,
): boolean {
  if (!file) {
    return false;
  }
  if (workspaceIsImagePath(file.path)) {
    return false;
  }
  const fileName = basenameFromPath(file.path).toLowerCase();
  return (
    languageFromPath(file.path) !== "text" ||
    file.path.endsWith(".txt") ||
    fileName === "readme" ||
    fileName === "dockerfile"
  );
}

function normalizeWorkspacePath(pathValue: string): string {
  const normalized = pathValue.replaceAll("\\", "/");
  if (normalized === "/") {
    return normalized;
  }
  return normalized.replace(/\/+$/, "");
}

function isWithinWorkspaceRoot(rootPath: string, candidatePath: string): boolean {
  const normalizedRoot = normalizeWorkspacePath(rootPath);
  const normalizedCandidate = normalizeWorkspacePath(candidatePath);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

function getWorkspaceParentPath(
  rootPath: string,
  currentPath: string | null,
  parentPath: string | null,
): string | null {
  if (
    currentPath === null ||
    normalizeWorkspacePath(currentPath) === normalizeWorkspacePath(rootPath)
  ) {
    return null;
  }
  if (parentPath === null) {
    return null;
  }
  return isWithinWorkspaceRoot(rootPath, parentPath) ? parentPath : null;
}

function parseUiStateFromPath(pathname: string): {
  threadId: string | null;
  tab: AppTab;
} {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return { threadId: null, tab: "chat" };
  }

  if (DEBUG_UI_ENABLED && segments.length === 1 && segments[0] === "debug") {
    return { threadId: null, tab: "debug" };
  }

  if (
    segments[0] === "threads" &&
    typeof segments[1] === "string" &&
    segments[1].length > 0
  ) {
    const threadId = decodeURIComponent(segments[1]);
    if (segments[2] === "workspace") {
      return { threadId, tab: "workspace" };
    }
    if (DEBUG_UI_ENABLED && segments[2] === "debug") {
      return { threadId, tab: "debug" };
    }
    return { threadId, tab: "chat" };
  }

  return { threadId: null, tab: "chat" };
}

function buildPathFromUiState(
  threadId: string | null,
  tab: AppTab,
): string {
  if (!threadId) {
    return DEBUG_UI_ENABLED && tab === "debug" ? "/debug" : "/";
  }
  if (tab === "workspace") {
    return `/threads/${encodeURIComponent(threadId)}/workspace`;
  }
  if (DEBUG_UI_ENABLED && tab === "debug") {
    return `/threads/${encodeURIComponent(threadId)}/debug`;
  }
  return `/threads/${encodeURIComponent(threadId)}`;
}

function IconBtn({
  onClick,
  disabled,
  title,
  active,
  children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  const buttonNode = (
    <Button
      type="button"
      onClick={onClick}
      disabled={disabled}
      variant="ghost"
      size="icon"
      className={`h-8 w-8 rounded-lg ${
        active
          ? "bg-muted text-foreground hover:bg-muted"
          : "text-muted-foreground hover:text-foreground hover:bg-muted"
      }`}
    >
      {children}
    </Button>
  );

  if (!title) {
    return buttonNode;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{buttonNode}</TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

function UsageRing({
  percent,
  size = 14,
  strokeWidth = 2,
  className,
}: {
  percent: number | null;
  size?: number;
  strokeWidth?: number;
  className?: string;
}): React.JSX.Element {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const normalizedPercent = clampNumber(percent ?? 0, 0, 100);
  const dashOffset = circumference * (1 - normalizedPercent / 100);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      aria-hidden="true"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        className="text-border/80"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

/* ── Main App ───────────────────────────────────────────────── */
export function App(): React.JSX.Element {
  const { theme, toggle: toggleTheme } = useTheme();
  const initialUiState = useMemo(
    () => parseUiStateFromPath(window.location.pathname),
    [],
  );
  const initialServerBaseUrl = useMemo(() => getServerBaseUrl(), []);
  const initialSavedServerTargets = useMemo(() => listSavedServerTargets(), []);
  const initialActiveSavedServerTarget = useMemo(
    () => getActiveSavedServerTarget(),
    [],
  );
  const initialSnapshot = ENABLE_VIEW_SNAPSHOT_CACHE
    ? appViewSnapshotCache
    : null;
  const initialTab: AppTab = initialSnapshot?.activeTab ?? initialUiState.tab;

  /* State */
  const [error, setError] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [threads, setThreads] = useState<Thread[]>(
    initialSnapshot?.threads ?? [],
  );
  const [threadListErrors, setThreadListErrors] =
    useState<ThreadListProviderErrors>(
      initialSnapshot?.threadListErrors ?? EMPTY_THREAD_LIST_ERRORS,
    );
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
    initialSnapshot?.selectedThreadId ?? initialUiState.threadId,
  );
  const [liveState, setLiveState] = useState<LiveStateResponse | null>(
    initialSnapshot?.liveState ?? null,
  );
  const [readThreadState, setReadThreadState] =
    useState<ReadThreadResponse | null>(
      initialSnapshot?.readThreadState ?? null,
    );
  const [streamEvents, setStreamEvents] = useState<
    StreamEventsResponse["events"]
  >(initialSnapshot?.streamEvents ?? []);
  const [modes, setModes] = useState<ModesResponse["data"]>(
    initialSnapshot?.modes ?? [],
  );
  const [models, setModels] = useState<ModelsResponse["data"]>(
    initialSnapshot?.models ?? [],
  );
  const [selectedModeKey, setSelectedModeKey] = useState("");
  const [selectedModelId, setSelectedModelId] = useState("");
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [traceStatus, setTraceStatus] = useState<TraceStatus | null>(null);
  const [traceLabel, setTraceLabel] = useState("capture");
  const [traceNote, setTraceNote] = useState("");
  const [history, setHistory] = useState<HistoryResponse["history"]>([]);
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [historyDetail, setHistoryDetail] = useState<HistoryDetail | null>(
    null,
  );
  const [selectedRequestId, setSelectedRequestId] =
    useState<PendingRequestId | null>(null);
  const [answerDraft, setAnswerDraft] = useState<
    Record<string, { option: string; freeform: string }>
  >({});
  const [agentDescriptors, setAgentDescriptors] = useState<AgentDescriptor[]>(
    initialSnapshot?.agentDescriptors ?? [],
  );
  const [selectedAgentId, setSelectedAgentId] = useState<AgentId>(
    initialSnapshot?.selectedAgentId ?? "codex",
  );
  const [savedServerTargets, setSavedServerTargets] = useState<
    SavedServerTarget[]
  >(initialSavedServerTargets);
  const [primaryServerTargetId, setPrimaryServerTargetId] = useState<
    string | null
  >(initialActiveSavedServerTarget?.id ?? null);
  const [serverBaseUrl, setServerBaseUrlState] =
    useState<string>(initialServerBaseUrl);
  const [serverLabelDraft, setServerLabelDraft] = useState<string>(
    initialActiveSavedServerTarget?.label ?? "",
  );
  const [serverBaseUrlDraft, setServerBaseUrlDraft] =
    useState<string>(initialServerBaseUrl);
  const [editingServerTargetId, setEditingServerTargetId] = useState<
    string | null
  >(initialActiveSavedServerTarget?.id ?? null);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isNewThreadModalOpen, setIsNewThreadModalOpen] = useState(false);
  const [newThreadModalState, setNewThreadModalState] =
    useState<NewThreadModalState>({
      serverId: "automatic-server",
      agentId: "codex",
      projectPath: "",
    });
  const [newThreadModalAgents, setNewThreadModalAgents] = useState<
    AgentDescriptor[]
  >([]);
  const [isLoadingNewThreadAgents, setIsLoadingNewThreadAgents] =
    useState(false);
  const [isCreatingDirectory, setIsCreatingDirectory] = useState(false);
  const [isLoadingDirectoryBrowser, setIsLoadingDirectoryBrowser] =
    useState(false);
  const [directoryBrowserState, setDirectoryBrowserState] =
    useState<DirectoryBrowserState | null>(null);
  const [workspaceEntriesState, setWorkspaceEntriesState] =
    useState<WorkspaceEntriesState | null>(null);
  const [workspaceEntriesPath, setWorkspaceEntriesPath] =
    useState<string | null>(null);
  const [workspaceGitStatus, setWorkspaceGitStatus] =
    useState<WorkspaceGitStatusResponse | null>(null);
  const [workspaceSelectedPath, setWorkspaceSelectedPath] =
    useState<string | null>(null);
  const [workspaceSelectedMode, setWorkspaceSelectedMode] =
    useState<"diff" | "file">("diff");
  const [workspaceFileContent, setWorkspaceFileContent] =
    useState<WorkspaceFileResponse | null>(null);
  const [workspaceGitDiff, setWorkspaceGitDiff] =
    useState<WorkspaceGitDiffResponse | null>(null);
  const [isWorkspaceLoading, setIsWorkspaceLoading] = useState(false);
  const [isWorkspaceContentLoading, setIsWorkspaceContentLoading] =
    useState(false);
  const [workspaceMobilePane, setWorkspaceMobilePane] =
    useState<"navigator" | "viewer">("navigator");

  /* UI state */
  const [activeTab, setActiveTab] = useState<AppTab>(initialTab);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileSidebarDragOffset, setMobileSidebarDragOffset] = useState<
    number | null
  >(null);
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const [isChatAtBottom, setIsChatAtBottom] = useState(true);
  const [visibleChatItemLimit, setVisibleChatItemLimit] = useState(
    INITIAL_VISIBLE_CHAT_ITEMS,
  );
  const [hasHydratedModeFromLiveState, setHasHydratedModeFromLiveState] =
    useState(false);
  const [isModeSyncing, setIsModeSyncing] = useState(false);
  const [sidebarCollapsedGroups, setSidebarCollapsedGroups] = useState<
    Record<string, boolean>
  >(() => readCollapseMap());
  const [sidebarOrder, setSidebarOrder] = useState<string[]>(() =>
    readSidebarOrder(),
  );
  const [projectColors, setProjectColors] = useState<Record<string, GroupColor>>(
    () => readProjectColors(),
  );
  const [rateLimits, setRateLimits] = useState<
    Awaited<ReturnType<typeof getAccountRateLimits>> | null
  >(null);
  const [eventsConnected, setEventsConnected] = useState(false);
  const [dragOverGroupKey, setDragOverGroupKey] = useState<string | null>(null);
  const [draggedGroupKey, setDraggedGroupKey] = useState<string | null>(null);

  /* Refs */
  const selectedThreadIdRef = useRef<string | null>(null);
  const activeTabRef = useRef<AppTab>(initialTab);
  const refreshTimerRef = useRef<number | null>(null);
  const pendingRefreshFlagsRef = useRef<RefreshFlags>({
    refreshCore: false,
    refreshHistory: false,
    refreshSelectedThread: false,
  });
  const mobileSidebarSwipeRef = useRef<MobileSidebarSwipeGesture | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const chatContentRef = useRef<HTMLDivElement>(null);
  const isChatAtBottomRef = useRef(true);
  const shouldAutoFollowChatRef = useRef(true);
  const lastAppliedModeSignatureRef = useRef("");
  const pendingLocalModeSignatureRef = useRef("");
  const hasHydratedAgentSelectionRef = useRef(false);
  const threadProviderByIdRef = useRef<Map<string, AgentId>>(new Map());
  const optimisticSelectedThreadIdsRef = useRef<Set<string>>(new Set());
  const loadCoreDataRef = useRef<(() => Promise<void>) | null>(null);
  const loadSelectedThreadRef = useRef<
    (
      threadId: string,
      options?: Partial<LoadSelectedThreadOptions>,
    ) => Promise<void>
  >(null);
  const threadViewStateCacheRef = useRef<Map<string, CachedThreadViewState>>(
    initialSnapshot?.selectedThreadId
      ? new Map([
          [
            initialSnapshot.selectedThreadId,
            {
              readThreadState: initialSnapshot.readThreadState,
              liveState: initialSnapshot.liveState,
              streamEvents: initialSnapshot.streamEvents,
            },
          ],
        ])
      : new Map(),
  );
  const agentCacheRef = useRef<AgentCacheEntry | null>(null);
  const providerCatalogCacheRef = useRef<
    Map<string, ProviderCatalogCacheEntry>
  >(new Map());
  const liveStateRef = useRef<LiveStateResponse | null>(initialSnapshot?.liveState ?? null);
  const readThreadStateRef = useRef<ReadThreadResponse | null>(
    initialSnapshot?.readThreadState ?? null,
  );
  const threadsSignatureRef = useRef<string[]>([]);
  const modesSignatureRef = useRef<string[]>([]);
  const modelsSignatureRef = useRef<string[]>([]);
  const historyDetailCacheRef = useRef<Map<string, HistoryDetail>>(new Map());
  const historyDetailRequestIdRef = useRef(0);
  const loadCoreRequestIdRef = useRef(0);

  /* Derived */
  const selectedThread = useMemo(
    () => threads.find((t) => t.id === selectedThreadId) ?? null,
    [threads, selectedThreadId],
  );
  const agentsById = useMemo(() => {
    const map: Partial<Record<AgentId, AgentDescriptor>> = {};
    for (const descriptor of agentDescriptors) {
      map[descriptor.id] = descriptor;
    }
    return map;
  }, [agentDescriptors]);
  const availableAgentIds = useMemo(
    () =>
      agentDescriptors
        .filter((descriptor) => descriptor.enabled)
        .map((descriptor) => descriptor.id),
    [agentDescriptors],
  );
  const serverTargets = useMemo(
    () =>
      buildServerTargetOptions(
        savedServerTargets,
        primaryServerTargetId,
        getDefaultServerBaseUrl(),
      ),
    [primaryServerTargetId, savedServerTargets],
  );
  const primaryServerTarget = useMemo(
    () => serverTargets.find((target) => target.isPrimary) ?? null,
    [serverTargets],
  );
  const selectedNewThreadServer = useMemo(
    () =>
      serverTargets.find((target) => target.id === newThreadModalState.serverId) ??
      primaryServerTarget ??
      serverTargets[0] ??
      null,
    [newThreadModalState.serverId, primaryServerTarget, serverTargets],
  );
  const selectedNewThreadAgent = useMemo(
    () =>
      newThreadModalAgents.find(
        (agent) => agent.id === newThreadModalState.agentId,
      ) ?? null,
    [newThreadModalAgents, newThreadModalState.agentId],
  );
  const newThreadProjectDirectorySuggestions = useMemo(
    () => selectedNewThreadAgent?.projectDirectories ?? [],
    [selectedNewThreadAgent],
  );
  const selectedThreadServerBaseUrl = selectedThread?.serverBaseUrl ?? null;
  const selectedThreadWorkspacePath =
    readThreadState?.thread.id === selectedThreadId
      ? (readThreadState.thread.cwd ?? liveState?.conversationState?.cwd ?? selectedThread?.cwd ?? null)
      : (liveState?.threadId === selectedThreadId
          ? (liveState.conversationState?.cwd ?? selectedThread?.cwd ?? null)
          : (selectedThread?.cwd ?? null));
  const selectedThreadWorkspaceLabel = selectedThreadWorkspacePath
    ? basenameFromPath(selectedThreadWorkspacePath)
    : null;
  const activeServerBaseUrl = selectedThreadServerBaseUrl ?? serverBaseUrl;
  const editingServerTarget = useMemo(
    () =>
      editingServerTargetId === null
        ? null
        : savedServerTargets.find((target) => target.id === editingServerTargetId) ??
          null,
    [editingServerTargetId, savedServerTargets],
  );
  const showProviderIcons = availableAgentIds.length > 1;
  const selectedAgentDescriptor = useMemo(
    () => agentsById[selectedAgentId] ?? null,
    [agentsById, selectedAgentId],
  );
  const threadListErrorMessage = useMemo(
    () => buildThreadListErrorMessage(threadListErrors),
    [threadListErrors],
  );
  const selectedAgentLabel = selectedAgentDescriptor?.label ?? "Agent";
  const reversedHistory = useMemo(() => history.slice().reverse(), [history]);
  const hasServerBaseUrlDraftChanges =
    editingServerTarget !== null
      ? serverBaseUrlDraft.trim() !== editingServerTarget.baseUrl ||
        serverLabelDraft.trim() !== editingServerTarget.label
      : serverBaseUrlDraft.trim() !== "" || serverLabelDraft.trim() !== "";
  const unifiedEventsUrl = useMemo(
    () => getUnifiedEventsUrl(activeServerBaseUrl),
    [activeServerBaseUrl],
  );
  const upsertSidebarThread = useCallback((threadSummary: Thread) => {
    setThreads((previousThreads) => {
      const nextThreads = (() => {
        const existingIndex = previousThreads.findIndex(
          (thread) => thread.id === threadSummary.id,
        );
        if (existingIndex === -1) {
          return sortThreadsByRecency([threadSummary, ...previousThreads]);
        }
        const mergedThread = {
          ...previousThreads[existingIndex],
          ...threadSummary,
        };
        const next = [...previousThreads];
        next[existingIndex] = mergedThread;
        return sortThreadsByRecency(next);
      })();

      const nextSignature = buildThreadsSignature(nextThreads);
      if (signaturesMatch(threadsSignatureRef.current, nextSignature)) {
        return previousThreads;
      }
      threadsSignatureRef.current = nextSignature;
      return nextThreads;
    });
  }, []);
  const groupedThreads = useMemo(() => {
    type Group = {
      key: string;
      label: string;
      projectPath: string | null;
      latestUpdatedAt: number;
      preferredAgentId: AgentId | null;
      threads: Thread[];
      userColor: string | null;
    };
    const groups = new Map<string, Group>();
    const shouldIncludeServerLabel =
      savedServerTargets.length > 1 ||
      new Set(threads.map((thread) => thread.serverId)).size > 1;

    for (const thread of threads) {
      const cwd =
        typeof thread.cwd === "string" && thread.cwd.trim()
          ? thread.cwd.trim()
          : null;
      const projectPath = cwd;
      const key = projectPath
        ? `server:${thread.serverId}:project:${projectPath}`
        : `server:${thread.serverId}:project:unknown`;
      const label = projectPath
        ? shouldIncludeServerLabel
          ? `${basenameFromPath(projectPath)} · ${thread.serverLabel}`
          : basenameFromPath(projectPath)
        : shouldIncludeServerLabel
          ? `Unknown · ${thread.serverLabel}`
          : "Unknown";
      const updatedAt = threadRecencyTimestamp(thread);
      const threadAgentId = thread.provider;
      const projectColor = projectColors[key] ?? null;

      const existing = groups.get(key);
      if (existing) {
        existing.threads.push(thread);
        if (!existing.preferredAgentId) {
          existing.preferredAgentId = threadAgentId;
        }
        if (updatedAt > existing.latestUpdatedAt) {
          existing.latestUpdatedAt = updatedAt;
        }
      } else {
        groups.set(key, {
          key,
          label,
          projectPath,
          latestUpdatedAt: updatedAt,
          preferredAgentId: threadAgentId,
          threads: [thread],
          userColor: projectColor,
        });
      }
    }

    for (const descriptor of agentDescriptors) {
      for (const directory of descriptor.projectDirectories) {
        const normalized = directory.trim();
        if (!normalized) {
          continue;
        }
        const key = `project:${normalized}`;
        const primaryServerKey = primaryServerTarget?.id ?? "automatic-server";
        const scopedKey = `server:${primaryServerKey}:project:${normalized}`;
        if (groups.has(scopedKey)) {
          continue;
        }
        groups.set(scopedKey, {
          key: scopedKey,
          label: basenameFromPath(normalized),
          projectPath: normalized,
          latestUpdatedAt: 0,
          preferredAgentId: descriptor.id,
          threads: [],
          userColor: projectColors[scopedKey] ?? null,
        });
      }
    }

    for (const group of groups.values()) {
      group.threads.sort(compareThreadsByRecency);
    }

    const allGroups = Array.from(groups.values());
    const autoSortedKeys = allGroups
      .slice()
      .sort((left, right) => right.latestUpdatedAt - left.latestUpdatedAt)
      .map((group) => group.key);
    const normalizedOrder = normalizeManualGroupOrder(sidebarOrder, autoSortedKeys);
    const orderIndex = new Map(normalizedOrder.map((key, index) => [key, index]));
    allGroups.sort(
      (left, right) =>
        (orderIndex.get(left.key) ?? Number.MAX_SAFE_INTEGER) -
        (orderIndex.get(right.key) ?? Number.MAX_SAFE_INTEGER),
    );

    return allGroups;
  }, [
    agentDescriptors,
    primaryServerTarget?.id,
    projectColors,
    savedServerTargets.length,
    sidebarOrder,
    threads,
  ]);
  const conversationState = useMemo(() => {
    const liveConversationState = liveState?.conversationState ?? null;
    const readConversationState = readThreadState?.thread ?? null;
    if (!liveConversationState) {
      return readConversationState;
    }
    if (!readConversationState) {
      return liveConversationState;
    }

    if (
      liveConversationState.id === readConversationState.id &&
      readConversationState.turns.length > liveConversationState.turns.length
    ) {
      return {
        ...readConversationState,
        requests:
          liveConversationState.requests.length >
          readConversationState.requests.length
            ? liveConversationState.requests
            : readConversationState.requests,
      };
    }

    return liveConversationState;
  }, [liveState?.conversationState, readThreadState?.thread]);
  const requestSourceState = useMemo(() => {
    const liveConversationState = liveState?.conversationState ?? null;
    const readConversationState = readThreadState?.thread ?? null;
    if (!liveConversationState) {
      return readConversationState;
    }
    if (!readConversationState) {
      return liveConversationState;
    }

    const livePendingRequestCount =
      getPendingThreadRequests(liveConversationState).length;
    const readPendingRequestCount =
      getPendingThreadRequests(readConversationState).length;

    if (
      liveConversationState.id === readConversationState.id &&
      readPendingRequestCount > livePendingRequestCount
    ) {
      return {
        ...liveConversationState,
        requests: readConversationState.requests,
      };
    }

    return liveConversationState;
  }, [liveState?.conversationState, readThreadState?.thread]);

  const pendingRequests = useMemo(() => {
    if (!requestSourceState) return [] as PendingRequest[];
    return getPendingUserInputRequests(requestSourceState);
  }, [requestSourceState]);
  const pendingThreadRequests = useMemo(() => {
    if (!requestSourceState) return [] as PendingThreadRequest[];
    return getPendingThreadRequests(requestSourceState);
  }, [requestSourceState]);
  const pendingApprovalRequests = useMemo(() => {
    if (!requestSourceState) return [] as PendingApprovalRequest[];
    return getPendingApprovalRequests(requestSourceState);
  }, [requestSourceState]);
  const pendingInformationalRequests = useMemo(
    () =>
      pendingThreadRequests.filter(
        (request) =>
          request.method !== "item/tool/requestUserInput" &&
          request.method !== "item/commandExecution/requestApproval" &&
          request.method !== "item/fileChange/requestApproval" &&
          request.method !== "applyPatchApproval" &&
          request.method !== "execCommandApproval",
      ),
    [pendingThreadRequests],
  );
  const activeApprovalRequest = pendingApprovalRequests[0] ?? null;
  const activeInformationalRequest = pendingInformationalRequests[0] ?? null;
  const liveStateStreamError = useMemo(() => {
    const errorState = liveState?.liveStateError;
    if (!errorState) {
      return null;
    }
    return errorState;
  }, [liveState?.liveStateError]);

  const activeRequest = useMemo(() => {
    if (!pendingRequests.length) return null;
    if (selectedRequestId === null) return pendingRequests[0];
    return (
      pendingRequests.find((r) => r.id === selectedRequestId) ??
      pendingRequests[0]
    );
  }, [pendingRequests, selectedRequestId]);
  const selectedThreadWaitingState = useMemo(() => {
    if (!selectedThreadId) {
      return null;
    }
    if (!requestSourceState || requestSourceState.id !== selectedThreadId) {
      return null;
    }
    return {
      waitingOnApproval: pendingApprovalRequests.length > 0,
      waitingOnUserInput: pendingRequests.length > 0,
    };
  }, [
    requestSourceState,
    pendingApprovalRequests.length,
    pendingRequests.length,
    selectedThreadId,
  ]);

  const resolvedSelectedThreadProvider = useMemo((): AgentId | null => {
    if (!selectedThreadId) {
      return null;
    }
    if (selectedThread?.provider) {
      return selectedThread.provider;
    }

    const readProvider =
      readThreadState?.thread.id === selectedThreadId
        ? readThreadState.thread.provider
        : null;
    if (readProvider) {
      return readProvider;
    }

    const liveProvider =
      liveState?.threadId === selectedThreadId
        ? (liveState.conversationState?.provider ?? null)
        : null;
    if (liveProvider) {
      return liveProvider;
    }

    return null;
  }, [
    liveState?.conversationState?.provider,
    liveState?.threadId,
    readThreadState?.thread.id,
    readThreadState?.thread.provider,
    selectedThread?.provider,
    selectedThreadId,
  ]);

  const activeThreadAgentId: AgentId = useMemo(
    () => resolvedSelectedThreadProvider ?? selectedAgentId,
    [resolvedSelectedThreadProvider, selectedAgentId],
  );
  const activeCatalogProviderId = activeThreadAgentId;
  const activeCatalogBaseUrl =
    selectedThreadServerBaseUrl ?? primaryServerTarget?.baseUrl ?? serverBaseUrl;
  const activeCatalogCacheKey = `${activeCatalogBaseUrl}|${activeCatalogProviderId}`;
  const hasResolvedSelectedThreadProvider =
    !selectedThreadId || resolvedSelectedThreadProvider !== null;
  const activeAgentDescriptor = useMemo(
    () => agentsById[activeThreadAgentId] ?? selectedAgentDescriptor,
    [activeThreadAgentId, agentsById, selectedAgentDescriptor],
  );
  const activeAgentLabel = activeAgentDescriptor?.label ?? selectedAgentLabel;
  const canSetCollaborationMode =
    hasResolvedSelectedThreadProvider &&
    canUseFeature(activeAgentDescriptor, "setCollaborationMode");
  const canListModels =
    hasResolvedSelectedThreadProvider &&
    canUseFeature(activeAgentDescriptor, "listModels");
  const canListCollaborationModes =
    hasResolvedSelectedThreadProvider &&
    canUseFeature(activeAgentDescriptor, "listCollaborationModes");
  const canSubmitUserInputForActiveAgent = canUseFeature(
    activeAgentDescriptor,
    "submitUserInput",
  );
  const canSendMessageForActiveAgent = canUseFeature(
    activeAgentDescriptor,
    "sendMessage",
  );
  const canInterruptForActiveAgent = canUseFeature(
    activeAgentDescriptor,
    "interrupt",
  );
  const canCreateThreadForSelectedAgent = canUseFeature(
    selectedAgentDescriptor,
    "createThread",
  );
  const showUsageBadges = activeThreadAgentId === "codex";
  const sessionTokenUsage = useMemo(() => {
    return parseTokenUsageInfo(conversationState?.latestTokenUsageInfo);
  }, [conversationState?.latestTokenUsageInfo]);

  const planModeOption = useMemo(
    () => modes.find((mode) => isPlanModeOption(mode)) ?? null,
    [modes],
  );
  const defaultModeOption = useMemo(
    () => modes.find((mode) => !isPlanModeOption(mode)) ?? modes[0] ?? null,
    [modes],
  );
  const isPlanModeEnabled =
    planModeOption !== null && selectedModeKey === planModeOption.mode;

  const effortOptions = useMemo(() => {
    const vals = new Set<string>(DEFAULT_EFFORT_OPTIONS);
    for (const m of modes) {
      if (m.reasoningEffort) {
        vals.add(m.reasoningEffort);
      }
    }
    const le = conversationState?.latestReasoningEffort;
    if (le) vals.add(le);
    if (selectedReasoningEffort) vals.add(selectedReasoningEffort);
    return sortEffortOptions(Array.from(vals));
  }, [
    conversationState?.latestReasoningEffort,
    modes,
    selectedReasoningEffort,
  ]);
  const sortedModels = useMemo(() => sortModelsByPreference(models), [models]);
  const preferredModel = useMemo(
    () => sortedModels.find((entry) => !entry.hidden) ?? sortedModels[0] ?? null,
    [sortedModels],
  );
  const appDefaultModelId =
    preferredModel?.id ?? assumedDefaultModelIdForAgent(activeThreadAgentId);
  const appDefaultModelLabel = preferredModel
    ? preferredModel.displayName && preferredModel.displayName !== preferredModel.id
      ? `${preferredModel.displayName} (${preferredModel.id})`
      : preferredModel.displayName || preferredModel.id
    : assumedDefaultModelLabelForAgent(activeThreadAgentId);
  const preferredNewThreadModelId =
    selectedModelId || assumedDefaultModelIdForAgent(selectedAgentId);
  const appDefaultEffortLabel = useMemo(() => {
    const activeModeKey = selectedModeKey || defaultModeOption?.mode || "";
    const modeDefaultEffort = normalizeNullableModeValue(
      modes.find((entry) => entry.mode === activeModeKey)?.reasoningEffort ??
        null,
    );
    if (modeDefaultEffort.length > 0) {
      return modeDefaultEffort;
    }

    const activeModelId =
      selectedModelId ||
      normalizeNullableModeValue(conversationState?.latestModel) ||
      appDefaultModelId ||
      "";
    const modelDefaultEffort = normalizeNullableModeValue(
      models.find((entry) => entry.id === activeModelId)
        ?.defaultReasoningEffort ?? null,
    );
    if (modelDefaultEffort.length > 0) {
      return modelDefaultEffort;
    }
    return ASSUMED_APP_DEFAULT_EFFORT;
  }, [
    appDefaultModelId,
    conversationState?.latestModel,
    defaultModeOption?.mode,
    modes,
    models,
    selectedModeKey,
    selectedModelId,
  ]);
  const effortOptionsWithoutAppDefault = useMemo(
    () =>
      effortOptions.filter(
        (option) =>
          option !== appDefaultEffortLabel ||
          selectedReasoningEffort === option,
      ),
    [appDefaultEffortLabel, effortOptions, selectedReasoningEffort],
  );

  const modelOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of sortedModels) {
      const label =
        m.displayName && m.displayName !== m.id
          ? `${m.displayName} (${m.id})`
          : m.displayName || m.id;
      map.set(m.id, label);
    }
    const lm = conversationState?.latestModel;
    if (lm && !map.has(lm)) map.set(lm, lm);
    if (selectedModelId && !map.has(selectedModelId))
      map.set(selectedModelId, selectedModelId);
    return Array.from(map.entries()).map(([id, label]) => ({ id, label }));
  }, [conversationState?.latestModel, selectedModelId, sortedModels]);
  const modelOptionsWithoutAppDefault = useMemo(
    () =>
      modelOptions.filter(
        (option) =>
          option.id !== appDefaultModelId || selectedModelId === option.id,
      ),
    [appDefaultModelId, modelOptions, selectedModelId],
  );
  const activeCollaborationModeDraft = useMemo(() => {
    if (!selectedModeKey) {
      return null;
    }
    const selectedMode = modes.find((entry) => entry.mode === selectedModeKey) ?? null;
    return {
      mode: selectedModeKey,
      settings: {
        ...(selectedModelId ? { model: selectedModelId } : {}),
        ...(selectedReasoningEffort
          ? { reasoningEffort: selectedReasoningEffort }
          : {}),
        ...(selectedMode
          ? {
              developerInstructions:
                selectedMode.developerInstructions ?? null,
            }
          : {}),
      },
    };
  }, [modes, selectedModeKey, selectedModelId, selectedReasoningEffort]);

  const deferredConversationState = useDeferredValue(conversationState);
  const turns = deferredConversationState?.turns ?? [];
  const lastTurn = turns[turns.length - 1];
  const isGenerating = useMemo(() => {
    const liveGenerating =
      liveState?.threadId === selectedThreadId
        ? isThreadGeneratingState(liveState.conversationState)
        : false;
    if (liveGenerating) {
      return true;
    }
    return Boolean(selectedThread?.isGenerating);
  }, [
    liveState?.conversationState,
    liveState?.threadId,
    selectedThread?.isGenerating,
    selectedThreadId,
  ]);
  const selectedThreadStatus = useMemo(
    () =>
      buildThreadStatusSummary({
        isGenerating,
        waitingOnApproval: selectedThreadWaitingState?.waitingOnApproval ?? false,
        waitingOnUserInput: selectedThreadWaitingState?.waitingOnUserInput ?? false,
        lastTurn,
        liveStateError: liveStateStreamError,
        uiErrorMessage: selectedThreadId ? error : null,
      }),
    [
      error,
      isGenerating,
      lastTurn,
      liveStateStreamError,
      selectedThreadId,
      selectedThreadWaitingState?.waitingOnApproval,
      selectedThreadWaitingState?.waitingOnUserInput,
    ],
  );
  const canUseComposer = isGenerating
    ? canInterruptForActiveAgent
    : selectedThreadId
      ? hasResolvedSelectedThreadProvider && canSendMessageForActiveAgent
      : availableAgentIds.length > 0 &&
        canCreateThreadForSelectedAgent &&
        canSendMessageForActiveAgent;
  const canAttachImagesForActiveAgent = true;
  const conversationWindow = useMemo(() => {
    type IndexedConversationItem = {
      key: string;
      item: ConversationTurnItem;
      turnIndex: number;
      turnIsInProgress: boolean;
    };

    const newestFirst: IndexedConversationItem[] = [];
    let hasHidden = false;

    outer: for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
      const turn = turns[turnIndex];
      if (!turn) {
        continue;
      }
      const items = turn.items ?? [];
      const isLastTurn = turnIndex === turns.length - 1;
      const turnInProgress = isLastTurn && isGenerating;

      for (
        let itemIndexInTurn = items.length - 1;
        itemIndexInTurn >= 0;
        itemIndexInTurn -= 1
      ) {
        const item = items[itemIndexInTurn];
        if (!item || !shouldRenderConversationItem(item)) {
          continue;
        }
        if (newestFirst.length >= visibleChatItemLimit) {
          hasHidden = true;
          break outer;
        }
        newestFirst.push({
          key: item.id ?? `${turnIndex}-${itemIndexInTurn}`,
          item,
          turnIndex,
          turnIsInProgress: turnInProgress,
        });
      }
    }

    const chronological = newestFirst.reverse();
    const visibleItems: FlatConversationItem[] = chronological.map(
      (entry, index) => {
        const previousEntry = chronological[index - 1];
        const nextEntry = chronological[index + 1];
        const startsNewTurn = previousEntry?.turnIndex !== entry.turnIndex;
        const spacingTop = index === 0 ? 0 : startsNewTurn ? 16 : 10;

        return {
          key: entry.key,
          item: entry.item,
          isLast: index === chronological.length - 1,
          turnIsInProgress: entry.turnIsInProgress,
          previousItemType: previousEntry?.item.type,
          nextItemType: nextEntry?.item.type,
          spacingTop,
        };
      },
    );

    return {
      hasHidden,
      visibleItems,
    };
  }, [isGenerating, turns, visibleChatItemLimit]);
  const hasHiddenChatItems = conversationWindow.hasHidden;
  const visibleConversationItems = conversationWindow.visibleItems;
  const visibleConversationItemCount = visibleConversationItems.length;
  const workspaceSelectedGitFile = useMemo(
    () =>
      workspaceGitStatus?.files.find((file) => file.path === workspaceSelectedPath) ??
      null,
    [workspaceGitStatus?.files, workspaceSelectedPath],
  );
  const workspacePreviewLanguage = useMemo(
    () => languageFromPath(workspaceSelectedPath ?? ""),
    [workspaceSelectedPath],
  );
  const workspaceSelectedFileMissing = workspaceFileContent?.status === "missing";
  const workspaceSelectedStatusLabel = useMemo(
    () =>
      workspaceSelectedGitFile
        ? workspaceStatusLabel(
            workspaceSelectedGitFile.unstagedStatus ??
              workspaceSelectedGitFile.stagedStatus,
          )
        : null,
    [workspaceSelectedGitFile],
  );
  const workspaceSelectionSupportsDiff = useMemo(
    () => workspaceSupportsDiff(workspaceSelectedGitFile),
    [workspaceSelectedGitFile],
  );
  const workspaceSelectionIsDeleted = useMemo(
    () => workspaceHasDeletedStatus(workspaceSelectedGitFile),
    [workspaceSelectedGitFile],
  );
  const workspaceSelectionIsImage = useMemo(
    () => (workspaceSelectedPath ? workspaceIsImagePath(workspaceSelectedPath) : false),
    [workspaceSelectedPath],
  );
  const workspaceRawFileUrl = useMemo(() => {
    if (!workspaceSelectedPath || !workspaceSelectionIsImage) {
      return null;
    }
    return getFilesystemRawFileUrl({
      path: workspaceSelectedPath,
      baseUrlOverride:
        selectedThreadServerBaseUrl ?? primaryServerTarget?.baseUrl ?? serverBaseUrl,
    });
  }, [
    primaryServerTarget?.baseUrl,
    selectedThreadServerBaseUrl,
    serverBaseUrl,
    workspaceSelectedPath,
    workspaceSelectionIsImage,
  ]);
  const workspaceParentPath = useMemo(() => {
    if (!selectedThreadWorkspacePath) {
      return null;
    }
    return getWorkspaceParentPath(
      selectedThreadWorkspacePath,
      workspaceEntriesState?.path ?? null,
      workspaceEntriesState?.parentPath ?? null,
    );
  }, [
    selectedThreadWorkspacePath,
    workspaceEntriesState?.parentPath,
    workspaceEntriesState?.path,
  ]);
  const commitLabel = health?.state.gitCommit ?? "unknown";
  const topNavOptions: Array<{ value: AppTab; label: string }> = [
    { value: "chat", label: "Chat" },
    ...(selectedThreadId
      ? [{ value: "workspace" as const, label: "Workspace" }]
      : []),
    ...(DEBUG_UI_ENABLED ? [{ value: "debug" as const, label: "Debug" }] : []),
  ];
  const topNavTabs =
    selectedThreadId || DEBUG_UI_ENABLED ? (
      <>
        <Button
          type="button"
          variant={activeTab === "chat" ? "secondary" : "ghost"}
          size="sm"
          className="rounded-full"
          onClick={() => setActiveTab("chat")}
        >
          Chat
        </Button>
        {selectedThreadId && (
          <Button
            type="button"
            variant={activeTab === "workspace" ? "secondary" : "ghost"}
            size="sm"
            className="rounded-full"
            onClick={() => setActiveTab("workspace")}
          >
            Workspace
          </Button>
        )}
        {DEBUG_UI_ENABLED && (
          <Button
            type="button"
            variant={activeTab === "debug" ? "secondary" : "ghost"}
            size="sm"
            className="rounded-full"
            onClick={() => setActiveTab("debug")}
          >
            Debug
          </Button>
        )}
      </>
    ) : null;
  const scrollChatToBottom = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) {
      return;
    }
    scroller.scrollTop = scroller.scrollHeight;
  }, []);
  const closeMobileSidebar = useCallback(() => {
    setMobileSidebarOpen(false);
    setMobileSidebarDragOffset(null);
    mobileSidebarSwipeRef.current = null;
  }, []);
  const openMobileSidebar = useCallback(() => {
    setMobileSidebarOpen(true);
    setMobileSidebarDragOffset(null);
    mobileSidebarSwipeRef.current = null;
  }, []);
  const handleSelectReferencedThread = useCallback(
    (threadId: string) => {
      const nextPath = buildPathFromUiState(threadId, "chat");
      if (window.location.pathname !== nextPath) {
        window.history.pushState(null, "", nextPath);
      }
      setSelectedThreadId(threadId);
      setActiveTab("chat");
      closeMobileSidebar();
    },
    [closeMobileSidebar],
  );
  const mobileSidebarRendered = mobileSidebarOpen || mobileSidebarDragOffset !== null;
  const mobileSidebarOffsetX =
    mobileSidebarDragOffset ?? (mobileSidebarOpen ? 0 : -MOBILE_SIDEBAR_WIDTH_PX);
  const mobileSidebarOpenRatio = clampNumber(
    (mobileSidebarOffsetX + MOBILE_SIDEBAR_WIDTH_PX) / MOBILE_SIDEBAR_WIDTH_PX,
    0,
    1,
  );
  const codexConfigured = agentsById.codex?.enabled === true;
  const codexConnected = agentsById.codex?.connected === true;
  const hasEnabledAgent = agentDescriptors.some((descriptor) => descriptor.enabled);
  const connectedEnabledAgentCount = agentDescriptors.filter(
    (descriptor) => descriptor.enabled && descriptor.connected,
  ).length;
  const visibleHealthError =
    health?.state.lastError === "Codex app-server is not connected"
      ? null
      : health?.state.lastError ?? null;
  const allSystemsReady =
    (codexConfigured ? health?.state.appReady === true : true) &&
    connectedEnabledAgentCount > 0;
  const hasAnySystemFailure =
    (codexConfigured && health?.state.appReady === false) ||
    (connectedEnabledAgentCount === 0 && hasEnabledAgent);
  /* Data loading */
  const loadCoreData = useCallback(async () => {
    const requestId = loadCoreRequestIdRef.current + 1;
    loadCoreRequestIdRef.current = requestId;
    const shouldLoadDebugData = activeTabRef.current === "debug";
    const now = Date.now();
    const cachedAgents = agentCacheRef.current;
    const shouldLoadAgents =
      !cachedAgents ||
      cachedAgents.baseUrl !== activeCatalogBaseUrl ||
      now - cachedAgents.fetchedAt >= AGENT_CACHE_TTL_MS;
    const agentsPromise: Promise<AgentsResponse> =
      shouldLoadAgents || !cachedAgents
      ? listAgentsForBaseUrl(activeCatalogBaseUrl).then((agents) => {
          agentCacheRef.current = {
            value: agents,
            fetchedAt: Date.now(),
            baseUrl: activeCatalogBaseUrl,
          };
          return agents;
        })
      : Promise.resolve(cachedAgents.value);

    const healthPromise = getHealth(activeCatalogBaseUrl);
    const rateLimitsPromise = getAccountRateLimits(activeCatalogBaseUrl).catch(
      () => null,
    );
    const sidebarResultsByTarget = new Map<string, SidebarTargetResult>();
    const applySidebarResults = (
      orderedResults: readonly SidebarTargetResult[],
    ): Thread[] => {
      const mergedSidebar = mergeSidebarTargetResults(
        orderedResults,
        activeCatalogBaseUrl,
      );

      const nextThreadProviders = new Map(threadProviderByIdRef.current);
      for (const thread of mergedSidebar.threads) {
        nextThreadProviders.set(thread.id, thread.provider);
      }
      threadProviderByIdRef.current = nextThreadProviders;

      startTransition(() => {
        setThreadListErrors((prev) =>
          hasSameThreadListErrors(prev, mergedSidebar.errors)
            ? prev
            : mergedSidebar.errors,
        );
        setThreads((previousThreads) => {
          const nextThreads = mergeIncomingThreads(
            mergedSidebar.threads,
            previousThreads,
          );
          const existingIds = new Set(nextThreads.map((thread) => thread.id));
          for (const thread of previousThreads) {
            if (existingIds.has(thread.id)) {
              continue;
            }
            const shouldKeepThread =
              optimisticSelectedThreadIdsRef.current.has(thread.id) ||
              thread.id === selectedThreadIdRef.current;
            if (!shouldKeepThread) {
              continue;
            }
            existingIds.add(thread.id);
            nextThreads.push(thread);
          }
          const sortedThreads = sortThreadsByRecency(nextThreads);
          const nextThreadsSignature = buildThreadsSignature(sortedThreads);
          if (
            signaturesMatch(threadsSignatureRef.current, nextThreadsSignature)
          ) {
            return previousThreads;
          }
          threadsSignatureRef.current = nextThreadsSignature;
          return sortedThreads;
        });
      });

      return mergedSidebar.threads;
    };
    const fetchSidebarTarget = async (
      target: ServerTargetOption,
    ): Promise<SidebarTargetResult> => {
      const result = await listSidebarThreads({
        limit: 80,
        archived: false,
        all: false,
        maxPages: 1,
        baseUrlOverride: target.baseUrl,
      });
      return {
        target,
        result,
      } satisfies SidebarTargetResult;
    };
    const shouldStageSidebarTargets =
      selectedThreadIdRef.current === null && serverTargets.length > 1;
    const prioritizedTargets = shouldStageSidebarTargets
      ? (() => {
          const primaryTarget = primaryServerTarget ?? serverTargets[0] ?? null;
          if (!primaryTarget) {
            return [] as ServerTargetOption[];
          }
          return [
            primaryTarget,
            ...serverTargets.filter((target) => target.id !== primaryTarget.id),
          ];
        })()
      : serverTargets;
    const eagerTargets = shouldStageSidebarTargets
      ? prioritizedTargets.slice(0, 1)
      : prioritizedTargets;
    const deferredTargets = shouldStageSidebarTargets
      ? prioritizedTargets.slice(1)
      : [];
    const eagerSidebarPromises = eagerTargets.map(fetchSidebarTarget);
    for (const sidebarPromise of eagerSidebarPromises) {
      void sidebarPromise.then((sidebarResult) => {
        if (loadCoreRequestIdRef.current !== requestId) {
          return;
        }

        sidebarResultsByTarget.set(sidebarResult.target.id, sidebarResult);
        const orderedResults = prioritizedTargets
          .map((target) => sidebarResultsByTarget.get(target.id))
          .filter(
            (result): result is SidebarTargetResult => result !== undefined,
          );
        applySidebarResults(orderedResults);
      });
    }
    const loadDeferredSidebarTargets = () => {
      for (const target of deferredTargets) {
        void fetchSidebarTarget(target).then((sidebarResult) => {
          if (loadCoreRequestIdRef.current !== requestId) {
            return;
          }

          sidebarResultsByTarget.set(sidebarResult.target.id, sidebarResult);
          const orderedResults = prioritizedTargets
            .map((candidateTarget) =>
              sidebarResultsByTarget.get(candidateTarget.id),
            )
            .filter(
              (result): result is SidebarTargetResult => result !== undefined,
            );
          applySidebarResults(orderedResults);
        });
      }
    };
    if (deferredTargets.length > 0) {
      window.setTimeout(loadDeferredSidebarTargets, 0);
    }
    const tracePromise = shouldLoadDebugData
      ? getTraceStatus()
      : Promise.resolve<TraceStatus | null>(null);
    const historyPromise = shouldLoadDebugData
      ? listDebugHistory(120)
      : Promise.resolve<HistoryResponse | null>(null);

    const sidebarResults = await Promise.allSettled(eagerSidebarPromises);
    if (loadCoreRequestIdRef.current !== requestId) {
      return;
    }
    const successfulSidebarResults = sidebarResults
      .filter(
        (
          result,
        ): result is PromiseFulfilledResult<SidebarTargetResult> =>
          result.status === "fulfilled",
      )
      .map((result) => result.value);
    const incomingThreads =
      successfulSidebarResults.length > 0
        ? applySidebarResults(successfulSidebarResults)
        : [];
    const optimisticSelectedThreadIds = optimisticSelectedThreadIdsRef.current;
    if (optimisticSelectedThreadIds.size > 0) {
      for (const thread of incomingThreads) {
        optimisticSelectedThreadIds.delete(thread.id);
      }
    }

    const [healthResult, agentsResult, traceResult, historyResult, rateLimitsResult] =
      await Promise.allSettled([
        healthPromise,
        agentsPromise,
        tracePromise,
        historyPromise,
        rateLimitsPromise,
      ]);
    if (loadCoreRequestIdRef.current !== requestId) {
      return;
    }

    if (healthResult.status === "rejected") {
      console.error("Failed to load health state", healthResult.reason);
    }
    if (agentsResult.status === "rejected") {
      console.error("Failed to load agent descriptors", agentsResult.reason);
    }
    if (traceResult.status === "rejected") {
      console.error("Failed to load trace status", traceResult.reason);
    }
    if (historyResult.status === "rejected") {
      console.error("Failed to load debug history", historyResult.reason);
    }
    if (rateLimitsResult.status === "rejected") {
      console.error("Failed to load account rate limits", rateLimitsResult.reason);
    }

    const nh = healthResult.status === "fulfilled" ? healthResult.value : null;
    const nag = agentsResult.status === "fulfilled" ? agentsResult.value : null;
    const ntr = traceResult.status === "fulfilled" ? traceResult.value : null;
    const nhist = historyResult.status === "fulfilled" ? historyResult.value : null;
    const nrl = rateLimitsResult.status === "fulfilled" ? rateLimitsResult.value : null;

    const nextAgents = nag?.agents ?? agentDescriptors;
    const nextDefaultAgentId = nag?.defaultAgentId ?? selectedAgentId;
    const enabledAgents = nextAgents
      .filter((agent) => agent.enabled)
      .map((agent) => agent.id);
    const nextDefaultAgent = enabledAgents.includes(nextDefaultAgentId)
      ? nextDefaultAgentId
      : (enabledAgents[0] ?? nextDefaultAgentId);
    const threadForActiveProvider =
      incomingThreads.find(
        (thread) => thread.id === selectedThreadIdRef.current,
      ) ?? null;
    const activeProviderId =
      threadForActiveProvider?.provider ?? activeCatalogProviderId;
    const activeProviderBaseUrl =
      threadForActiveProvider?.serverBaseUrl ?? activeCatalogBaseUrl;
    const activeProviderCacheKey = `${activeProviderBaseUrl}|${activeProviderId}`;
    const activeDescriptor =
      nextAgents.find((agent) => agent.id === activeProviderId) ?? null;

    const canLoadModes = canUseFeature(activeDescriptor, "listCollaborationModes");
    const canLoadModels = canUseFeature(activeDescriptor, "listModels");
    const cachedCatalog =
      providerCatalogCacheRef.current.get(activeProviderCacheKey) ?? null;
    const shouldLoadCatalog =
      !cachedCatalog ||
      cachedCatalog.baseUrl !== activeProviderBaseUrl ||
      now - cachedCatalog.fetchedAt >= PROVIDER_CATALOG_CACHE_TTL_MS;

    let nextModesData: ModesResponse["data"] = [];
    let nextModelsData: ModelsResponse["data"] = [];
    const hasCachedCatalog =
      (canLoadModes || canLoadModels) && !shouldLoadCatalog && cachedCatalog;
    const shouldFetchCatalog =
      (canLoadModes || canLoadModels) && !hasCachedCatalog;

    if (hasCachedCatalog) {
      nextModesData = canLoadModes ? cachedCatalog.modes : [];
      nextModelsData = canLoadModels ? cachedCatalog.models : [];
    }

    let preferredAgentId: AgentId | null = null;
    const nextModesSignature = nextModesData.map((mode) =>
      [mode.mode, mode.name, mode.reasoningEffort ?? ""].join("|"),
    );
    const nextModelsSignature = nextModelsData.map((model) =>
      [model.id, model.displayName ?? ""].join("|"),
    );

    if (nh) {
      setHealth((prev) => {
        if (
          prev &&
          prev.state.appReady === nh.state.appReady &&
          prev.state.gitCommit === nh.state.gitCommit &&
          prev.state.lastError === nh.state.lastError &&
          prev.state.historyCount === nh.state.historyCount &&
          prev.state.threadOwnerCount === nh.state.threadOwnerCount
        ) {
          return prev;
        }
        return nh;
      });
    }
    if (
      hasCachedCatalog &&
      !signaturesMatch(modesSignatureRef.current, nextModesSignature)
    ) {
      modesSignatureRef.current = nextModesSignature;
      setModes(nextModesData);
    }
    if (
      hasCachedCatalog &&
      !signaturesMatch(modelsSignatureRef.current, nextModelsSignature)
    ) {
      modelsSignatureRef.current = nextModelsSignature;
      setModels(nextModelsData);
    }
    if (ntr) {
      setTraceStatus((prev) => {
        if (
          prev &&
          prev.active?.id === ntr.active?.id &&
          prev.active?.eventCount === ntr.active?.eventCount &&
          prev.recent.length === ntr.recent.length &&
          prev.recent[0]?.id === ntr.recent[0]?.id &&
          prev.recent[0]?.eventCount === ntr.recent[0]?.eventCount
        ) {
          return prev;
        }
        return ntr;
      });
    }
    if (nhist) {
      setHistory((prev) => {
        if (
          prev.length === nhist.history.length &&
          prev[prev.length - 1]?.id ===
            nhist.history[nhist.history.length - 1]?.id
        ) {
          return prev;
        }
        return nhist.history;
      });
    }
    if (nrl) {
      setRateLimits(nrl);
    }
    if (nag) {
      setAgentDescriptors((prev) => {
        if (
          prev.length === nag.agents.length &&
          prev.every((agent, index) => {
            const nextAgent = nag.agents[index];
            if (!nextAgent) {
              return false;
            }
            return (
              agent.id === nextAgent.id &&
              agent.enabled === nextAgent.enabled &&
              agent.connected === nextAgent.connected &&
              agent.capabilities.canListModels ===
                nextAgent.capabilities.canListModels &&
              agent.capabilities.canListCollaborationModes ===
                nextAgent.capabilities.canListCollaborationModes &&
              agent.capabilities.canSetCollaborationMode ===
                nextAgent.capabilities.canSetCollaborationMode &&
              agent.capabilities.canSubmitUserInput ===
                nextAgent.capabilities.canSubmitUserInput &&
              agent.capabilities.canReadLiveState ===
                nextAgent.capabilities.canReadLiveState &&
              agent.capabilities.canReadStreamEvents ===
                nextAgent.capabilities.canReadStreamEvents &&
              agent.capabilities.canListProjectDirectories ===
                nextAgent.capabilities.canListProjectDirectories
            );
          })
        ) {
          return prev;
        }
        return nag.agents;
      });
      preferredAgentId = nextDefaultAgent;
      setSelectedAgentId((cur) => {
        if (!hasHydratedAgentSelectionRef.current) {
          hasHydratedAgentSelectionRef.current = true;
          return nextDefaultAgent;
        }
        return enabledAgents.includes(cur) ? cur : nextDefaultAgent;
      });
    }
    setSelectedThreadId((cur) => {
      if (cur) {
        return cur;
      }
      if (selectedThreadIdRef.current) {
        const listedThreadStillExists = incomingThreads.some(
          (threadSummary) => threadSummary.id === selectedThreadIdRef.current,
        );
        const hasOptimisticSelection = optimisticSelectedThreadIdsRef.current.has(
          selectedThreadIdRef.current,
        );
        const hasLoadedThreadState = threadViewStateCacheRef.current.has(
          selectedThreadIdRef.current,
        );
        if (
          listedThreadStillExists ||
          hasOptimisticSelection ||
          hasLoadedThreadState
        ) {
          return selectedThreadIdRef.current;
        }
      }
      if (preferredAgentId) {
        const preferredThread = incomingThreads.find(
          (thread) => thread.provider === preferredAgentId,
        );
        if (preferredThread) {
          return preferredThread.id;
        }
      }
      return incomingThreads[0]?.id ?? null;
    });
    setSelectedModeKey((cur) => {
      if (cur || nextModesData.length === 0) return cur;
      const nonPlanDefault = nextModesData.find(
        (mode) => !isPlanModeOption(mode),
      );
      return nonPlanDefault?.mode ?? nextModesData[0]?.mode ?? "";
    });

    if (!shouldFetchCatalog) {
      return;
    }

    try {
      const [nextModesResult, nextModelsResult] = await Promise.all([
        canLoadModes
          ? listCollaborationModes(activeProviderId, activeProviderBaseUrl)
          : Promise.resolve({ data: [] as ModesResponse["data"] }),
        canLoadModels
          ? listModels(activeProviderId, activeProviderBaseUrl)
          : Promise.resolve({ data: [] as ModelsResponse["data"] }),
      ]);
      nextModesData = nextModesResult.data;
      nextModelsData = nextModelsResult.data;
      providerCatalogCacheRef.current.set(activeProviderCacheKey, {
        modes: nextModesData,
        models: nextModelsData,
        fetchedAt: Date.now(),
        baseUrl: activeProviderBaseUrl,
      });
    } catch (error) {
      console.error("Failed to load provider model catalog", error);
      setError(toErrorMessage(error));
      return;
    }
    if (loadCoreRequestIdRef.current !== requestId) {
      return;
    }

    const fetchedModesSignature = nextModesData.map((mode) =>
      [mode.mode, mode.name, mode.reasoningEffort ?? ""].join("|"),
    );
    const fetchedModelsSignature = nextModelsData.map((model) =>
      [model.id, model.displayName ?? ""].join("|"),
    );

    startTransition(() => {
      if (!signaturesMatch(modesSignatureRef.current, fetchedModesSignature)) {
        modesSignatureRef.current = fetchedModesSignature;
        setModes(nextModesData);
      }
      if (!signaturesMatch(modelsSignatureRef.current, fetchedModelsSignature)) {
        modelsSignatureRef.current = fetchedModelsSignature;
        setModels(nextModelsData);
      }
      setSelectedModeKey((cur) => {
        if (cur || nextModesData.length === 0) {
          return cur;
        }
        const nonPlanDefault = nextModesData.find(
          (mode) => !isPlanModeOption(mode),
        );
        return nonPlanDefault?.mode ?? nextModesData[0]?.mode ?? "";
      });
    });
  }, [
    activeCatalogBaseUrl,
    activeCatalogProviderId,
    agentDescriptors,
    selectedAgentId,
    serverTargets,
  ]);

  const loadSelectedThread = useCallback(
    async (
      threadId: string,
      options?: Partial<LoadSelectedThreadOptions>,
    ) => {
      const includeTurns = options?.includeTurns ?? true;
      const includeStreamEvents = options?.includeStreamEvents ?? includeTurns;
      const targetThread =
        threads.find((thread) => thread.id === threadId) ?? null;
      const baseUrlOverride =
        targetThread?.serverBaseUrl ?? primaryServerTarget?.baseUrl ?? serverBaseUrl;
      let threadAgentId = threadProviderByIdRef.current.get(threadId) ?? null;
      let read =
        threadAgentId === null
          ? await readThread(threadId, {
              includeTurns,
              baseUrlOverride,
            })
          : await readThread(threadId, {
              includeTurns,
              provider: threadAgentId,
              baseUrlOverride,
            });
      threadAgentId = read.thread.provider;
      threadProviderByIdRef.current.set(threadId, threadAgentId);

      const descriptor = agentsById[threadAgentId];
      const canReadLiveState =
        descriptor === undefined
          ? threadAgentId === "codex"
          : canUseFeature(descriptor, "readLiveState");
      const canReadStreamEvents =
        descriptor === undefined
          ? threadAgentId === "codex"
          : canUseFeature(descriptor, "readStreamEvents");
      let shouldReadTurns = includeTurns || !canReadLiveState;

      if (shouldReadTurns && !includeTurns) {
        read = await readThread(threadId, {
          includeTurns: true,
          provider: threadAgentId,
          baseUrlOverride,
        });
      }

      const live = canReadLiveState
        ? await getLiveState(threadId, threadAgentId, baseUrlOverride)
        : {
            ok: true as const,
            threadId,
            ownerClientId: null,
            conversationState: null,
            liveStateError: null,
          };

      if (!shouldReadTurns && live.conversationState === null) {
        read = await readThread(threadId, {
          includeTurns: true,
          provider: threadAgentId,
          baseUrlOverride,
        });
        shouldReadTurns = true;
      }
      const shouldLoadStreamEvents =
        canReadStreamEvents &&
        activeTabRef.current === "debug" &&
        includeStreamEvents;
      const shouldUpdateSelectedThread =
        selectedThreadIdRef.current === threadId;
      const existingCachedState =
        threadViewStateCacheRef.current.get(threadId) ?? null;
      let nextStreamEvents = existingCachedState?.streamEvents ?? [];
      startTransition(() => {
        setThreads((previousThreads) => {
          const nextIsGenerating = live.conversationState
            ? isThreadGeneratingState(live.conversationState)
            : isThreadGeneratingState(read.thread);
          const nextThreads = previousThreads.map((threadSummary) => {
            if (threadSummary.id !== read.thread.id) {
              return threadSummary;
            }

            const nextUpdatedAt =
              typeof read.thread.updatedAt === "number"
                ? Math.max(threadSummary.updatedAt, read.thread.updatedAt)
                : threadSummary.updatedAt;
            const nextTitle =
              read.thread.title !== undefined
                ? read.thread.title
                : threadSummary.title;
            const hadGenerating = threadSummary.isGenerating ?? false;

            if (
              nextUpdatedAt === threadSummary.updatedAt &&
              nextTitle === threadSummary.title &&
              hadGenerating === nextIsGenerating
            ) {
              return threadSummary;
            }

            return {
              ...threadSummary,
              updatedAt: nextUpdatedAt,
              isGenerating: nextIsGenerating,
              ...(nextTitle !== undefined ? { title: nextTitle } : {}),
            };
          });

          const sortedThreads = sortThreadsByRecency(nextThreads);
          const nextSignature = buildThreadsSignature(sortedThreads);
          if (signaturesMatch(threadsSignatureRef.current, nextSignature)) {
            return previousThreads;
          }
          threadsSignatureRef.current = nextSignature;
          return sortedThreads;
        });
        if (!shouldUpdateSelectedThread) {
          return;
        }
        setLiveState((prev) => {
          if (
            buildLiveStateSyncSignature(prev) ===
            buildLiveStateSyncSignature(live)
          ) {
            return prev;
          }
          return live;
        });
        if (shouldReadTurns) {
          setReadThreadState((prev) => {
            if (
              buildReadThreadSyncSignature(prev) ===
              buildReadThreadSyncSignature(read)
            ) {
              return prev;
            }
            return read;
          });
        }
      });

      threadViewStateCacheRef.current.set(threadId, {
        readThreadState: shouldReadTurns
          ? read
          : (existingCachedState?.readThreadState ?? null),
        liveState: live,
        streamEvents: nextStreamEvents,
      });

      if (!shouldLoadStreamEvents) {
        return;
      }

      const stream = await getStreamEvents(
        threadId,
        threadAgentId,
        20,
        baseUrlOverride,
      );
      nextStreamEvents = stream.events;
      threadViewStateCacheRef.current.set(threadId, {
        readThreadState: shouldReadTurns
          ? read
          : (existingCachedState?.readThreadState ?? null),
        liveState: live,
        streamEvents: nextStreamEvents,
      });
      if (selectedThreadIdRef.current !== threadId) {
        return;
      }
      startTransition(() => {
        setStreamEvents((prev) => {
          const prevLast = prev[prev.length - 1];
          const nextLast = stream.events[stream.events.length - 1];
          const prevLastSignature = prevLast ? JSON.stringify(prevLast) : "";
          const nextLastSignature = nextLast ? JSON.stringify(nextLast) : "";
          if (
            prev.length === stream.events.length &&
            prevLastSignature === nextLastSignature
          ) {
            return prev;
          }
          return stream.events;
        });
      });
    },
    [agentsById, primaryServerTarget?.baseUrl, serverBaseUrl, threads],
  );

  const refreshAll = useCallback(async () => {
    try {
      setError("");
      await loadCoreData();
      if (selectedThreadIdRef.current)
        await loadSelectedThread(selectedThreadIdRef.current, {
          includeTurns: true,
          includeStreamEvents: true,
        });
    } catch (e) {
      setError(toErrorMessage(e));
    }
  }, [loadCoreData, loadSelectedThread]);

  const saveServerTarget = useCallback(async () => {
    try {
      setError("");
      const savedTarget = saveNamedServerTarget({
        ...(editingServerTargetId ? { id: editingServerTargetId } : {}),
        label: serverLabelDraft,
        baseUrl: serverBaseUrlDraft,
      });
      setSavedServerTargets(listSavedServerTargets());
      setPrimaryServerTargetId(savedTarget.id);
      setActiveServerTarget(savedTarget.id);
      setEditingServerTargetId(savedTarget.id);
      setServerLabelDraft(savedTarget.label);
      setServerBaseUrlState(savedTarget.baseUrl);
      setServerBaseUrlDraft(savedTarget.baseUrl);
      agentCacheRef.current = null;
      providerCatalogCacheRef.current.clear();
      await refreshAll();
    } catch (e) {
      setError(toErrorMessage(e));
    }
  }, [editingServerTargetId, refreshAll, serverBaseUrlDraft, serverLabelDraft]);

  const useDefaultServerTarget = useCallback(async () => {
    try {
      setError("");
      clearServerBaseUrl();
      const defaultBaseUrl = getDefaultServerBaseUrl();
      setPrimaryServerTargetId(null);
      setServerBaseUrlState(defaultBaseUrl);
      setServerLabelDraft("");
      setServerBaseUrlDraft(defaultBaseUrl);
      setEditingServerTargetId(null);
      agentCacheRef.current = null;
      providerCatalogCacheRef.current.clear();
      await refreshAll();
    } catch (e) {
      setError(toErrorMessage(e));
    }
  }, [refreshAll]);

  const editServerTarget = useCallback((target: SavedServerTarget) => {
    setEditingServerTargetId(target.id);
    setServerLabelDraft(target.label);
    setServerBaseUrlDraft(target.baseUrl);
  }, []);

  const setPrimarySavedServerTarget = useCallback(
    async (targetId: string) => {
      try {
        setError("");
        setActiveServerTarget(targetId);
        setPrimaryServerTargetId(targetId);
        const activeTarget = listSavedServerTargets().find(
          (target) => target.id === targetId,
        );
        if (activeTarget) {
          setServerBaseUrlState(activeTarget.baseUrl);
        }
        agentCacheRef.current = null;
        providerCatalogCacheRef.current.clear();
        await refreshAll();
      } catch (e) {
        setError(toErrorMessage(e));
      }
    },
    [refreshAll],
  );

  const deleteServerTarget = useCallback(
    async (targetId: string) => {
      try {
        setError("");
        removeNamedServerTarget(targetId);
        const nextTargets = listSavedServerTargets();
        setSavedServerTargets(nextTargets);
        if (primaryServerTargetId === targetId) {
          const nextPrimary = nextTargets[0] ?? null;
          const nextPrimaryId = nextPrimary?.id ?? null;
          setPrimaryServerTargetId(nextPrimaryId);
          setActiveServerTarget(nextPrimaryId);
          setServerBaseUrlState(nextPrimary?.baseUrl ?? getDefaultServerBaseUrl());
        }
        if (editingServerTargetId === targetId) {
          setEditingServerTargetId(null);
          setServerLabelDraft("");
          setServerBaseUrlDraft("");
        }
        agentCacheRef.current = null;
        providerCatalogCacheRef.current.clear();
        await refreshAll();
      } catch (e) {
        setError(toErrorMessage(e));
      }
    },
    [editingServerTargetId, primaryServerTargetId, refreshAll],
  );

  const openNewThreadModal = useCallback(
    (options?: { agentId?: AgentId; projectPath?: string; serverId?: string }) => {
      const fallbackServer =
        options?.serverId ??
        primaryServerTarget?.id ??
        serverTargets[0]?.id ??
        "automatic-server";
      const fallbackAgent = options?.agentId ?? selectedAgentId;
      setNewThreadModalState({
        serverId: fallbackServer,
        agentId: fallbackAgent,
        projectPath: options?.projectPath ?? "",
      });
      setIsNewThreadModalOpen(true);
    },
    [primaryServerTarget?.id, selectedAgentId, serverTargets],
  );

  useEffect(() => {
    if (!isNewThreadModalOpen || !selectedNewThreadServer) {
      return;
    }

    let cancelled = false;
    setIsLoadingNewThreadAgents(true);

    void listAgentsForBaseUrl(selectedNewThreadServer.baseUrl)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setNewThreadModalAgents(result.agents);
        const nextAgentId = result.agents.some(
          (agent) => agent.id === newThreadModalState.agentId && agent.enabled,
        )
          ? newThreadModalState.agentId
          : result.defaultAgentId;
        setNewThreadModalState((previous) => ({
          ...previous,
          agentId: nextAgentId,
          projectPath:
            previous.projectPath ||
            result.agents.find((agent) => agent.id === nextAgentId)
              ?.projectDirectories[0] ||
            "",
        }));
      })
      .catch((error) => {
        if (!cancelled) {
          setError(toErrorMessage(error));
          setNewThreadModalAgents([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingNewThreadAgents(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    isNewThreadModalOpen,
    newThreadModalState.agentId,
    selectedNewThreadServer,
  ]);

  const browseDirectory = useCallback(
    async (pathValue?: string) => {
      if (!selectedNewThreadServer) {
        return;
      }
      setIsLoadingDirectoryBrowser(true);
      try {
        const result = await readServerDirectory({
          baseUrlOverride: selectedNewThreadServer.baseUrl,
          ...(pathValue ? { path: pathValue } : {}),
        });
        setDirectoryBrowserState(result);
      } catch (error) {
        setDirectoryBrowserState(null);
        setError(toErrorMessage(error));
      } finally {
        setIsLoadingDirectoryBrowser(false);
      }
    },
    [selectedNewThreadServer],
  );

  useEffect(() => {
    if (!isNewThreadModalOpen || !selectedNewThreadServer) {
      return;
    }

    void browseDirectory(newThreadModalState.projectPath.trim() || undefined);
  }, [browseDirectory, isNewThreadModalOpen, selectedNewThreadServer]);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    const next = new Map(threadProviderByIdRef.current);
    for (const thread of threads) {
      next.set(thread.id, thread.provider);
    }
    threadProviderByIdRef.current = next;
  }, [threads]);

  useEffect(() => {
    loadSelectedThreadRef.current = loadSelectedThread;
  }, [loadSelectedThread]);

  useEffect(() => {
    loadCoreDataRef.current = loadCoreData;
  }, [loadCoreData]);

  useEffect(() => {
    const cachedCatalog =
      providerCatalogCacheRef.current.get(activeCatalogCacheKey) ?? null;
    const nextModes = cachedCatalog?.modes ?? [];
    const nextModels = cachedCatalog?.models ?? [];
    const nextModesSignature = nextModes.map((mode) =>
      [mode.mode, mode.name, mode.reasoningEffort ?? ""].join("|"),
    );
    const nextModelsSignature = nextModels.map((model) =>
      [model.id, model.displayName ?? ""].join("|"),
    );

    if (!signaturesMatch(modesSignatureRef.current, nextModesSignature)) {
      modesSignatureRef.current = nextModesSignature;
      setModes(nextModes);
    }
    if (!signaturesMatch(modelsSignatureRef.current, nextModelsSignature)) {
      modelsSignatureRef.current = nextModelsSignature;
      setModels(nextModels);
    }
  }, [activeCatalogCacheKey]);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    const onPopState = () => {
      const next = parseUiStateFromPath(window.location.pathname);
      setSelectedThreadId(next.threadId);
      setActiveTab(next.tab);
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  useEffect(() => {
    const nextPath = buildPathFromUiState(selectedThreadId, activeTab);
    if (window.location.pathname === nextPath) return;
    window.history.replaceState(null, "", nextPath);
  }, [activeTab, selectedThreadId]);

  useEffect(() => {
    void (async () => {
      try {
        setError("");
        const loadCore = loadCoreDataRef.current;
        if (loadCore) {
          await loadCore();
        }
        if (selectedThreadIdRef.current) {
          const loadThread = loadSelectedThreadRef.current;
          if (loadThread) {
            await loadThread(selectedThreadIdRef.current, {
              includeTurns: true,
              includeStreamEvents: true,
            });
          }
        }
      } catch (error) {
        setError(toErrorMessage(error));
      }
    })();
  }, []);

  useEffect(() => {
    const loadCore = loadCoreDataRef.current;
    if (!loadCore) {
      return;
    }
    void loadCore().catch((error) => setError(toErrorMessage(error)));
  }, [activeCatalogCacheKey, selectedAgentId, selectedThreadId]);

  useEffect(() => {
    const refreshCoreData = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      const loadCore = loadCoreDataRef.current;
      if (!loadCore) {
        return;
      }
      void loadCore().catch((e) => setError(toErrorMessage(e)));
    };
    refreshCoreData();
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      refreshCoreData();
    };
    const onPageShow = () => {
      refreshCoreData();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  useEffect(() => {
    if (!selectedThreadId) {
      setLiveState(null);
      setReadThreadState(null);
      setStreamEvents([]);
      return;
    }
    const cachedState =
      threadViewStateCacheRef.current.get(selectedThreadId) ?? null;
    if (cachedState) {
      setLiveState(cachedState.liveState);
      setReadThreadState(cachedState.readThreadState);
      setStreamEvents(cachedState.streamEvents);
    } else {
      setLiveState(null);
      setReadThreadState(null);
      setStreamEvents([]);
    }
    const load = loadSelectedThreadRef.current;
    if (!load) {
      return;
    }
    const shouldIncludeTurns = cachedState?.readThreadState === null;
    void load(selectedThreadId, {
      includeTurns: shouldIncludeTurns,
      includeStreamEvents: activeTabRef.current === "debug",
    }).catch((e) => setError(toErrorMessage(e)));
  }, [selectedThreadId]);

  useEffect(() => {
    let disposed = false;
    let source: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let reconnectDelayMs = 1000;
    let hasOpenedConnection = false;

    const scheduleRefresh = (
      refreshCore: boolean,
      refreshHistory: boolean,
      refreshSelectedThread: boolean,
    ) => {
      const previousFlags = pendingRefreshFlagsRef.current;
      pendingRefreshFlagsRef.current = {
        refreshCore: previousFlags.refreshCore || refreshCore,
        refreshHistory: previousFlags.refreshHistory || refreshHistory,
        refreshSelectedThread:
          previousFlags.refreshSelectedThread || refreshSelectedThread,
      };

      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
      }
      const refreshDelayMs = refreshSelectedThread ? 50 : 200;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        const flags = pendingRefreshFlagsRef.current;
        pendingRefreshFlagsRef.current = {
          refreshCore: false,
          refreshHistory: false,
          refreshSelectedThread: false,
        };
        void (async () => {
          try {
            if (flags.refreshCore) {
              const loadCore = loadCoreDataRef.current;
              if (loadCore) {
                await loadCore();
              }
            } else if (
              flags.refreshHistory &&
              activeTabRef.current === "debug"
            ) {
              const nextHistory = await listDebugHistory(120);
              startTransition(() => {
                setHistory((prev) => {
                  if (
                    prev.length === nextHistory.history.length &&
                    prev[prev.length - 1]?.id ===
                      nextHistory.history[nextHistory.history.length - 1]?.id
                  ) {
                    return prev;
                  }
                  return nextHistory.history;
                });
              });
            }
            if (flags.refreshSelectedThread && selectedThreadIdRef.current) {
              const loadThread = loadSelectedThreadRef.current;
              if (loadThread) {
                await loadThread(selectedThreadIdRef.current, {
                  includeTurns:
                    threadViewStateCacheRef.current.get(
                      selectedThreadIdRef.current,
                    )?.readThreadState === null,
                  includeStreamEvents: activeTabRef.current === "debug",
                });
              }
            }
          } catch (e) {
            setError(toErrorMessage(e));
          }
        })();
      }, refreshDelayMs);
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== null) {
        return;
      }
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connectEvents();
      }, reconnectDelayMs);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10_000);
    };

    const connectEvents = () => {
      if (disposed || source) {
        return;
      }

      source = new EventSource(unifiedEventsUrl);
      source.onopen = () => {
        setEventsConnected(true);
        reconnectDelayMs = 1000;
        scheduleRefresh(
          true,
          activeTabRef.current === "debug",
          Boolean(selectedThreadIdRef.current),
        );
        if (!hasOpenedConnection) {
          hasOpenedConnection = true;
        }
      };

      source.onmessage = (event: MessageEvent<string>) => {
        let refreshCore = false;
        const refreshHistory = false;
        let refreshSelectedThread = false;

        try {
          const parsedEventResult = UnifiedEventSchema.safeParse(
            JSON.parse(event.data),
          );
          if (!parsedEventResult.success) {
            setError(
              `Invalid unified event payload: ${parsedEventResult.error.issues
                .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                .join(" | ")}`,
            );
            refreshCore = true;
          } else {
            const parsedEvent = parsedEventResult.data;
            if (parsedEvent.kind === "providerStateChanged") {
              agentCacheRef.current = null;
              providerCatalogCacheRef.current.clear();
              refreshCore = true;
            } else if (parsedEvent.kind === "threadDelta") {
              threadProviderByIdRef.current.set(
                parsedEvent.threadId,
                parsedEvent.provider,
              );
              const cachedState =
                threadViewStateCacheRef.current.get(parsedEvent.threadId) ??
                null;
              const currentThreadState =
                cachedState?.liveState?.conversationState ??
                cachedState?.readThreadState?.thread ??
                (parsedEvent.threadId === selectedThreadIdRef.current
                  ? (liveStateRef.current?.conversationState ??
                    readThreadStateRef.current?.thread ??
                    null)
                  : null);

              if (!currentThreadState) {
                if (parsedEvent.threadId === selectedThreadIdRef.current) {
                  refreshSelectedThread = true;
                } else {
                  refreshCore = true;
                }
              } else {
                const nextThreadState = applyUnifiedThreadDelta(
                  currentThreadState,
                  parsedEvent,
                );
                const nextLiveState: LiveStateResponse = {
                  ok: true,
                  threadId: parsedEvent.threadId,
                  ownerClientId: APP_SERVER_OWNER_CLIENT_ID,
                  conversationState: nextThreadState,
                  liveStateError: null,
                };
                const nextReadThreadState: ReadThreadResponse = {
                  thread: nextThreadState,
                };

                threadViewStateCacheRef.current.set(parsedEvent.threadId, {
                  liveState: nextLiveState,
                  readThreadState: nextReadThreadState,
                  streamEvents: cachedState?.streamEvents ?? [],
                });

                // Pure text-content deltas never change sidebar-visible metadata
                // (title, isGenerating, updatedAt). Skip setThreads to avoid
                // scanning and re-sorting the full thread list on every character.
                const isPureTextDelta =
                  parsedEvent.delta.type === "itemTextDelta";

                // Pre-compute signatures outside the setState updaters so React
                // only evaluates them once rather than on every updater invocation.
                const nextLiveSig = buildLiveStateSyncSignature(nextLiveState);
                const nextReadSig =
                  buildReadThreadSyncSignature(nextReadThreadState);

                startTransition(() => {
                  if (!isPureTextDelta) {
                    setThreads((previousThreads) => {
                      const nextThreads = previousThreads.map(
                        (threadSummary) => {
                          if (threadSummary.id !== parsedEvent.threadId) {
                            return threadSummary;
                          }

                          return {
                            ...threadSummary,
                            updatedAt:
                              nextThreadState.updatedAt ??
                              threadSummary.updatedAt,
                            isGenerating:
                              isThreadGeneratingState(nextThreadState),
                            title: nextThreadState.title ?? null,
                          };
                        },
                      );
                      const sortedThreads = sortThreadsByRecency(nextThreads);
                      const nextSignature =
                        buildThreadsSignature(sortedThreads);
                      if (
                        signaturesMatch(
                          threadsSignatureRef.current,
                          nextSignature,
                        )
                      ) {
                        return previousThreads;
                      }
                      threadsSignatureRef.current = nextSignature;
                      return sortedThreads;
                    });
                  }

                  if (parsedEvent.threadId !== selectedThreadIdRef.current) {
                    return;
                  }

                  setLiveState((previousState) =>
                    buildLiveStateSyncSignature(previousState) === nextLiveSig
                      ? previousState
                      : nextLiveState,
                  );
                  setReadThreadState((previousState) =>
                    buildReadThreadSyncSignature(previousState) === nextReadSig
                      ? previousState
                      : nextReadThreadState,
                  );
                });
              }
            } else if (parsedEvent.kind === "threadUpdated") {
              threadProviderByIdRef.current.set(
                parsedEvent.threadId,
                parsedEvent.provider,
              );
              const selectedThreadModeChanged =
                parsedEvent.threadId === selectedThreadIdRef.current &&
                modeSelectionSignatureFromConversationState(
                  (
                    threadViewStateCacheRef.current.get(parsedEvent.threadId)
                      ?.liveState?.conversationState ??
                    liveStateRef.current?.conversationState ??
                    readThreadStateRef.current?.thread ??
                    null
                  ),
                ) !==
                  modeSelectionSignatureFromConversationState(parsedEvent.thread);

              startTransition(() => {
                setThreads((previousThreads) => {
                  const nextIsGenerating = isThreadGeneratingState(
                    parsedEvent.thread,
                  );
                  const nextThreads = previousThreads.map((threadSummary) => {
                    if (threadSummary.id !== parsedEvent.threadId) {
                      return threadSummary;
                    }

                    return {
                      ...threadSummary,
                      updatedAt:
                        parsedEvent.thread.updatedAt ?? threadSummary.updatedAt,
                      isGenerating: nextIsGenerating,
                      title: parsedEvent.thread.title ?? null,
                    };
                  });
                  const nextSignature = buildThreadsSignature(nextThreads);
                  if (
                    signaturesMatch(threadsSignatureRef.current, nextSignature)
                  ) {
                    return previousThreads;
                  }
                  threadsSignatureRef.current = nextSignature;
                  return nextThreads;
                });
              });

              const nextLiveState: LiveStateResponse = {
                ok: true,
                threadId: parsedEvent.threadId,
                ownerClientId: APP_SERVER_OWNER_CLIENT_ID,
                conversationState: parsedEvent.thread,
                liveStateError: null,
              };
              const nextReadThreadState: ReadThreadResponse = {
                thread: parsedEvent.thread,
              };
              const cachedState =
                threadViewStateCacheRef.current.get(parsedEvent.threadId) ??
                null;
              threadViewStateCacheRef.current.set(parsedEvent.threadId, {
                liveState: nextLiveState,
                readThreadState: nextReadThreadState,
                streamEvents: cachedState?.streamEvents ?? [],
              });

              if (parsedEvent.threadId === selectedThreadIdRef.current) {
                refreshSelectedThread = selectedThreadModeChanged;
                startTransition(() => {
                  setLiveState((previousState) =>
                    buildLiveStateSyncSignature(previousState) ===
                    buildLiveStateSyncSignature(nextLiveState)
                      ? previousState
                      : nextLiveState,
                  );
                  setReadThreadState((previousState) =>
                    buildReadThreadSyncSignature(previousState) ===
                    buildReadThreadSyncSignature(nextReadThreadState)
                      ? previousState
                      : nextReadThreadState,
                  );
                });
              }
            } else if (
              parsedEvent.kind === "userInputRequested" ||
              parsedEvent.kind === "userInputResolved"
            ) {
              if (
                selectedThreadIdRef.current &&
                parsedEvent.threadId === selectedThreadIdRef.current
              ) {
                refreshCore = true;
                refreshSelectedThread = true;
              }
            } else if (parsedEvent.kind === "error") {
              refreshCore = true;
            }
          }
        } catch (error) {
          setError(`Invalid unified event payload: ${toErrorMessage(error)}`);
          refreshCore = true;
        }

        scheduleRefresh(refreshCore, refreshHistory, refreshSelectedThread);
      };

      source.onerror = () => {
        setEventsConnected(false);
        if (source) {
          source.close();
          source = null;
        }
        scheduleReconnect();
      };
    };

    const closeEvents = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      pendingRefreshFlagsRef.current = {
        refreshCore: false,
        refreshHistory: false,
        refreshSelectedThread: false,
      };
      if (source) {
        source.close();
        source = null;
      }
      setEventsConnected(false);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        connectEvents();
        return;
      }
      closeEvents();
    };
    const onPageHide = () => {
      closeEvents();
    };
    const onPageShow = () => {
      connectEvents();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    connectEvents();

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      closeEvents();
    };
  }, [unifiedEventsUrl]);

  useEffect(() => {
    if (!activeRequest) {
      setSelectedRequestId(null);
      setAnswerDraft({});
      return;
    }
    setSelectedRequestId((cur) => cur ?? activeRequest.id);
    setAnswerDraft((prev) => {
      const next: Record<string, { option: string; freeform: string }> = {};
      for (const q of activeRequest.params.questions) {
        next[q.id] = prev[q.id] ?? { option: "", freeform: "" };
      }
      return next;
    });
  }, [activeRequest]);

  useEffect(() => {
    const cs = conversationState;
    if (!cs) return;
    const remoteSelection = readModeSelectionFromConversationState(cs);
    const remoteHasExplicitSelection =
      remoteSelection.modeKey.length > 0 ||
      remoteSelection.modelId.length > 0 ||
      remoteSelection.reasoningEffort.length > 0;
    const remoteModeKey =
      remoteSelection.modeKey ||
      selectedModeKey ||
      defaultModeOption?.mode ||
      "";
    const remoteSignature = buildModeSignature(
      remoteModeKey,
      remoteSelection.modelId,
      remoteSelection.reasoningEffort,
    );

    if (!hasHydratedModeFromLiveState) {
      if (remoteModeKey) setSelectedModeKey(remoteModeKey);
      setSelectedModelId(remoteSelection.modelId);
      setSelectedReasoningEffort(remoteSelection.reasoningEffort);
      lastAppliedModeSignatureRef.current = remoteSignature;
      setHasHydratedModeFromLiveState(true);
      return;
    }

    if (!remoteHasExplicitSelection) {
      if (!selectedModeKey && remoteModeKey) {
        setSelectedModeKey(remoteModeKey);
      }
      return;
    }

    const localSignature = buildModeSignature(
      selectedModeKey,
      selectedModelId,
      selectedReasoningEffort,
    );
    if (
      activeThreadAgentId === "codex" &&
      pendingLocalModeSignatureRef.current.length > 0 &&
      localSignature === pendingLocalModeSignatureRef.current &&
      remoteSignature !== pendingLocalModeSignatureRef.current
    ) {
      return;
    }
    if (remoteSignature === localSignature) {
      lastAppliedModeSignatureRef.current = remoteSignature;
      if (pendingLocalModeSignatureRef.current === remoteSignature) {
        pendingLocalModeSignatureRef.current = "";
      }
      if (isModeSyncing) {
        setIsModeSyncing(false);
      }
      return;
    }

    if (
      isModeSyncing &&
      localSignature === lastAppliedModeSignatureRef.current &&
      remoteSignature !== lastAppliedModeSignatureRef.current
    ) {
      return;
    }

    if (remoteSelection.modeKey) {
      setSelectedModeKey(remoteSelection.modeKey);
    } else if (!selectedModeKey && remoteModeKey) {
      setSelectedModeKey(remoteModeKey);
    }
    setSelectedModelId(remoteSelection.modelId);
    setSelectedReasoningEffort(remoteSelection.reasoningEffort);
    lastAppliedModeSignatureRef.current = remoteSignature;
    if (isModeSyncing) {
      setIsModeSyncing(false);
    }
  }, [
    conversationState,
    activeThreadAgentId,
    defaultModeOption?.mode,
    hasHydratedModeFromLiveState,
    isModeSyncing,
    selectedModeKey,
    selectedModelId,
    selectedReasoningEffort,
  ]);

  useEffect(() => {
    lastAppliedModeSignatureRef.current = "";
    pendingLocalModeSignatureRef.current = "";
    setHasHydratedModeFromLiveState(false);
    setIsModeSyncing(false);
  }, [selectedThreadId]);

  useEffect(() => {
    if (!ENABLE_VIEW_SNAPSHOT_CACHE) {
      return;
    }
    appViewSnapshotCache = {
      threads,
      threadListErrors,
      selectedThreadId,
      liveState,
      readThreadState,
      streamEvents,
      modes,
      models,
      agentDescriptors,
      selectedAgentId,
      activeTab,
    };
  }, [
    activeTab,
    agentDescriptors,
    liveState,
    modes,
    models,
    readThreadState,
    selectedAgentId,
    selectedThreadId,
    streamEvents,
    threadListErrors,
    threads,
  ]);

  useEffect(() => {
    writeCollapseMap(sidebarCollapsedGroups);
  }, [sidebarCollapsedGroups]);

  useEffect(() => {
    writeSidebarOrder(sidebarOrder);
  }, [sidebarOrder]);

  useEffect(() => {
    writeProjectColors(projectColors);
  }, [projectColors]);

  useEffect(() => {
    isChatAtBottomRef.current = isChatAtBottom;
  }, [isChatAtBottom]);

  useEffect(() => {
    liveStateRef.current = liveState;
  }, [liveState]);

  useEffect(() => {
    readThreadStateRef.current = readThreadState;
  }, [readThreadState]);

  // Track whether chat view is at the bottom and whether the user still wants auto-follow.
  useEffect(() => {
    if (activeTab !== "chat" || !scrollRef.current) {
      return;
    }

    const scroller = scrollRef.current;
    let rafId: number | null = null;

    const syncBottomState = () => {
      const distanceFromBottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      const nextIsBottom = distanceFromBottom <= 48;
      shouldAutoFollowChatRef.current = nextIsBottom;
      if (nextIsBottom !== isChatAtBottomRef.current) {
        isChatAtBottomRef.current = nextIsBottom;
        setIsChatAtBottom(nextIsBottom);
      }
      rafId = null;
    };

    const handleScroll = () => {
      if (rafId !== null) {
        return;
      }
      rafId = window.requestAnimationFrame(syncBottomState);
    };

    syncBottomState();
    scroller.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", handleScroll);
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [activeTab, selectedThreadId]);

  // Keep chat pinned to bottom while auto-follow remains active.
  useLayoutEffect(() => {
    if (activeTab !== "chat" || !shouldAutoFollowChatRef.current) {
      return;
    }
    scrollChatToBottom();
  }, [
    activeTab,
    conversationContentSignature(conversationState),
    scrollChatToBottom,
    selectedThreadId,
    visibleConversationItemCount,
  ]);

  // Keep bottom pinned when expanded/collapsed blocks change chat height.
  useEffect(() => {
    if (activeTab !== "chat" || !scrollRef.current || !chatContentRef.current)
      return;
    const scroller = scrollRef.current;
    const content = chatContentRef.current;
    let rafId: number | null = null;

    const observer = new ResizeObserver(() => {
      if (!shouldAutoFollowChatRef.current) {
        return;
      }
      if (rafId !== null) {
        return;
      }
      rafId = window.requestAnimationFrame(() => {
        scrollChatToBottom();
        rafId = null;
      });
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [activeTab, scrollChatToBottom, selectedThreadId]);

  // New thread selection starts at the bottom.
  useLayoutEffect(() => {
    if (activeTab !== "chat" || !scrollRef.current) return;
    scrollChatToBottom();
    isChatAtBottomRef.current = true;
    shouldAutoFollowChatRef.current = true;
    setIsChatAtBottom(true);
    setVisibleChatItemLimit(INITIAL_VISIBLE_CHAT_ITEMS);
  }, [activeTab, scrollChatToBottom, selectedThreadId]);

  /* Actions */
  const submitMessage = useCallback(
    async (parts: UnifiedInputPart[]) => {
      if (parts.length === 0) return;
      if (!canSendMessageForActiveAgent) return;
      if (selectedThreadId && !hasResolvedSelectedThreadProvider) {
        setError("Thread provider is still loading");
        return;
      }

      setIsBusy(true);
      try {
        setError("");

        let threadId = selectedThreadId;
        let threadAgentId = activeThreadAgentId;

        // Auto-create a thread if none is selected.
        if (!threadId) {
          const targetServer = primaryServerTarget ?? {
            id: "automatic-server",
            label: "Automatic server",
            baseUrl: serverBaseUrl,
            isPrimary: true,
          };
          const created = await createThread({
            agentId: selectedAgentId,
            baseUrlOverride: targetServer.baseUrl,
            ...(preferredNewThreadModelId
              ? { model: preferredNewThreadModelId }
              : {}),
          });
          const createdModel = created.model ?? created.thread.latestModel;
          if (
            preferredNewThreadModelId &&
            createdModel !== preferredNewThreadModelId
          ) {
            throw new Error(
              `Thread started with unexpected model: requested ${preferredNewThreadModelId}, received ${createdModel || "none"}`,
            );
          }
          threadId = created.threadId;
          threadAgentId = selectedAgentId;
          threadProviderByIdRef.current.set(threadId, threadAgentId);
          optimisticSelectedThreadIdsRef.current.add(threadId);
          upsertSidebarThread(
            buildOptimisticThreadSummary(
              threadId,
              threadAgentId,
              created.thread,
              targetServer,
            ),
          );
          setSelectedThreadId(threadId);
          selectedThreadIdRef.current = threadId;
        }

        await sendMessage({
          provider: threadAgentId,
          threadId,
          parts,
          ...(threadAgentId === "codex" && activeCollaborationModeDraft
            ? { collaborationMode: activeCollaborationModeDraft }
            : {}),
          baseUrlOverride:
            selectedThread?.serverBaseUrl ?? primaryServerTarget?.baseUrl ?? serverBaseUrl,
          ...(liveState?.ownerClientId
            ? { ownerClientId: liveState.ownerClientId }
            : {}),
        });
        if (threadAgentId === "codex") {
          pendingLocalModeSignatureRef.current = "";
        }
        await refreshAll();
      } catch (e) {
        setError(toErrorMessage(e));
      } finally {
        setIsBusy(false);
      }
    },
    [
      activeThreadAgentId,
      activeCollaborationModeDraft,
      canSendMessageForActiveAgent,
      hasResolvedSelectedThreadProvider,
      liveState?.ownerClientId,
      preferredNewThreadModelId,
      refreshAll,
      selectedAgentId,
      selectedThread?.serverBaseUrl,
      selectedThreadId,
      serverBaseUrl,
      primaryServerTarget,
      upsertSidebarThread,
    ],
  );

  const applyModeDraft = useCallback(
    async (draft: {
      modeKey: string;
      modelId: string;
      reasoningEffort: string;
    }) => {
      if (!selectedThreadId) {
        return;
      }
      if (!hasResolvedSelectedThreadProvider) {
        setError("Thread provider is still loading");
        return;
      }
      if (!canSetCollaborationMode || !canListCollaborationModes) {
        return;
      }

      const mode = modes.find((entry) => entry.mode === draft.modeKey) ?? null;
      if (!mode || typeof mode.mode !== "string") {
        return;
      }

      const signature = buildModeSignature(
        draft.modeKey,
        draft.modelId,
        draft.reasoningEffort,
      );
      if (!isModeSyncing && lastAppliedModeSignatureRef.current === signature) {
        return;
      }

      const previousSignature = lastAppliedModeSignatureRef.current;
      lastAppliedModeSignatureRef.current = signature;
      if (activeThreadAgentId === "codex") {
        pendingLocalModeSignatureRef.current = signature;
        setIsModeSyncing(false);
        return;
      }
      setIsModeSyncing(true);
      try {
        setError("");
        await setCollaborationMode({
          provider: activeThreadAgentId,
          threadId: selectedThreadId,
          baseUrlOverride:
            selectedThread?.serverBaseUrl ?? primaryServerTarget?.baseUrl ?? serverBaseUrl,
          ...(liveState?.ownerClientId
            ? { ownerClientId: liveState.ownerClientId }
            : {}),
          collaborationMode: {
            mode: mode.mode,
            settings: {
              model: draft.modelId || null,
              reasoningEffort: draft.reasoningEffort || null,
              developerInstructions: mode.developerInstructions ?? null,
            },
          },
        });
        await loadSelectedThread(selectedThreadId, {
          includeTurns: true,
          includeStreamEvents: activeTabRef.current === "debug",
        });
      } catch (e) {
        lastAppliedModeSignatureRef.current = previousSignature;
        setError(toErrorMessage(e));
      } finally {
        setIsModeSyncing(false);
      }
    },
    [
      activeThreadAgentId,
      canListCollaborationModes,
      canSetCollaborationMode,
      hasResolvedSelectedThreadProvider,
      isModeSyncing,
      liveState?.ownerClientId,
      loadSelectedThread,
      modes,
      selectedThread?.serverBaseUrl,
      selectedThreadId,
      serverBaseUrl,
      primaryServerTarget,
    ],
  );

  const submitPendingRequest = useCallback(async () => {
    if (!selectedThreadId || !activeRequest) return;
    if (!hasResolvedSelectedThreadProvider) {
      setError("Thread provider is still loading");
      return;
    }
    const answers: Record<string, { answers: string[] }> = {};
    for (const q of activeRequest.params.questions) {
      const cur = answerDraft[q.id] ?? { option: "", freeform: "" };
      const text = cur.option || cur.freeform.trim();
      if (text) answers[q.id] = { answers: [text] };
    }
    setIsBusy(true);
    try {
      setError("");
      await submitUserInput({
        provider: activeThreadAgentId,
        threadId: selectedThreadId,
        baseUrlOverride:
          selectedThread?.serverBaseUrl ?? primaryServerTarget?.baseUrl ?? serverBaseUrl,
        requestId: activeRequest.id,
        ...(liveState?.ownerClientId
          ? { ownerClientId: liveState.ownerClientId }
          : {}),
        response: { answers },
      });
      await refreshAll();
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setIsBusy(false);
    }
  }, [
    activeRequest,
    activeThreadAgentId,
    answerDraft,
    hasResolvedSelectedThreadProvider,
    liveState?.ownerClientId,
    selectedThread?.serverBaseUrl,
    refreshAll,
    selectedThreadId,
    serverBaseUrl,
    primaryServerTarget,
  ]);

  const skipPendingRequest = useCallback(async () => {
    if (!selectedThreadId || !activeRequest) return;
    if (!hasResolvedSelectedThreadProvider) {
      setError("Thread provider is still loading");
      return;
    }
    setIsBusy(true);
    try {
      setError("");
      await submitUserInput({
        provider: activeThreadAgentId,
        threadId: selectedThreadId,
        baseUrlOverride:
          selectedThread?.serverBaseUrl ?? primaryServerTarget?.baseUrl ?? serverBaseUrl,
        requestId: activeRequest.id,
        ...(liveState?.ownerClientId
          ? { ownerClientId: liveState.ownerClientId }
          : {}),
        response: { answers: {} },
      });
      await refreshAll();
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setIsBusy(false);
    }
  }, [
    activeRequest,
    activeThreadAgentId,
    hasResolvedSelectedThreadProvider,
    liveState?.ownerClientId,
    selectedThread?.serverBaseUrl,
    refreshAll,
    selectedThreadId,
    serverBaseUrl,
    primaryServerTarget,
  ]);

  const resolvePendingApprovalRequest = useCallback(
    async (action: "approve" | "deny") => {
      if (!selectedThreadId || !activeApprovalRequest) return;
      if (!hasResolvedSelectedThreadProvider) {
        setError("Thread provider is still loading");
        return;
      }

      setIsBusy(true);
      try {
        setError("");
        await submitUserInput({
          provider: activeThreadAgentId,
          threadId: selectedThreadId,
          baseUrlOverride:
            selectedThread?.serverBaseUrl ?? primaryServerTarget?.baseUrl ?? serverBaseUrl,
          requestId: activeApprovalRequest.id,
          ...(liveState?.ownerClientId
            ? { ownerClientId: liveState.ownerClientId }
            : {}),
          response: buildApprovalResponse(activeApprovalRequest, action),
        });
        await refreshAll();
      } catch (e) {
        setError(toErrorMessage(e));
      } finally {
        setIsBusy(false);
      }
    },
    [
      activeApprovalRequest,
      activeThreadAgentId,
      hasResolvedSelectedThreadProvider,
      liveState?.ownerClientId,
      selectedThread?.serverBaseUrl,
      refreshAll,
      selectedThreadId,
      serverBaseUrl,
      primaryServerTarget,
    ],
  );

  const runInterrupt = useCallback(async () => {
    if (!selectedThreadId || !canInterruptForActiveAgent) return;
    if (!hasResolvedSelectedThreadProvider) {
      setError("Thread provider is still loading");
      return;
    }
    setIsBusy(true);
    try {
      setError("");
      await interruptThread({
        provider: activeThreadAgentId,
        threadId: selectedThreadId,
        baseUrlOverride:
          selectedThread?.serverBaseUrl ?? primaryServerTarget?.baseUrl ?? serverBaseUrl,
        ...(liveState?.ownerClientId
          ? { ownerClientId: liveState.ownerClientId }
          : {}),
      });
      await refreshAll();
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setIsBusy(false);
    }
  }, [
    activeThreadAgentId,
    canInterruptForActiveAgent,
    hasResolvedSelectedThreadProvider,
    liveState?.ownerClientId,
    selectedThread?.serverBaseUrl,
    refreshAll,
    selectedThreadId,
    serverBaseUrl,
    primaryServerTarget,
  ]);

  const loadHistoryDetail = useCallback(async (id: string) => {
    if (!id) {
      setHistoryDetail(null);
      return;
    }

    const cached = historyDetailCacheRef.current.get(id);
    if (cached) {
      setHistoryDetail(cached);
      return;
    }

    const requestId = historyDetailRequestIdRef.current + 1;
    historyDetailRequestIdRef.current = requestId;
    const detail = await getHistoryEntry(id);
    historyDetailCacheRef.current.set(id, detail);
    if (historyDetailRequestIdRef.current !== requestId) {
      return;
    }
    setHistoryDetail(detail);
  }, []);

  useEffect(() => {
    void loadHistoryDetail(selectedHistoryId).catch((e) =>
      setError(toErrorMessage(e)),
    );
  }, [loadHistoryDetail, selectedHistoryId]);

  const loadWorkspaceEntries = useCallback(
    async (nextPath: string) => {
      const baseUrlOverride =
        selectedThreadServerBaseUrl ?? primaryServerTarget?.baseUrl ?? serverBaseUrl;
      const result = await readFilesystemEntries({
        path: nextPath,
        baseUrlOverride,
      });
      setWorkspaceEntriesState(result);
      return result;
    },
    [primaryServerTarget?.baseUrl, selectedThreadServerBaseUrl, serverBaseUrl],
  );

  useEffect(() => {
    if (activeTab !== "workspace" || !selectedThreadWorkspacePath) {
      return;
    }

    const baseUrlOverride =
      selectedThreadServerBaseUrl ?? primaryServerTarget?.baseUrl ?? serverBaseUrl;
    let cancelled = false;

    setIsWorkspaceLoading(true);
    setWorkspaceEntriesPath(selectedThreadWorkspacePath);
    setWorkspaceEntriesState(null);
    setWorkspaceGitStatus(null);
    setWorkspaceSelectedPath(null);
    setWorkspaceFileContent(null);
    setWorkspaceGitDiff(null);
    setIsWorkspaceContentLoading(false);
    setWorkspaceMobilePane("navigator");

    void (async () => {
      try {
        const [gitStatusResult, entriesResult] = await Promise.all([
          getWorkspaceGitStatus({
            cwd: selectedThreadWorkspacePath,
            baseUrlOverride,
          }),
          readFilesystemEntries({
            path: selectedThreadWorkspacePath,
            baseUrlOverride,
          }),
        ]);
        if (cancelled) {
          return;
        }
        setWorkspaceGitStatus(gitStatusResult);
        setWorkspaceEntriesState(entriesResult);
        const currentSelection =
          workspaceSelectedPath !== null
            ? gitStatusResult.files.find((file) => file.path === workspaceSelectedPath) ??
              gitStatusResult.files[0] ??
              null
            : gitStatusResult.files[0] ?? null;
        if (currentSelection) {
          setWorkspaceSelectedPath(currentSelection.path);
          setWorkspaceSelectedMode(workspacePreferredMode(currentSelection));
          return;
        }
        const firstFileEntry =
          entriesResult.entries.find((entry) => entry.kind === "file") ?? null;
        setWorkspaceSelectedPath(firstFileEntry?.path ?? null);
        setWorkspaceSelectedMode("file");
      } catch (error) {
        if (!cancelled) {
          setError(toErrorMessage(error));
        }
      } finally {
        if (!cancelled) {
          setIsWorkspaceLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeTab,
    primaryServerTarget?.baseUrl,
    selectedThreadId,
    selectedThreadServerBaseUrl,
    selectedThreadWorkspacePath,
    serverBaseUrl,
  ]);

  useEffect(() => {
    if (activeTab !== "workspace" || !workspaceEntriesPath) {
      return;
    }
    if (workspaceEntriesState?.path === workspaceEntriesPath) {
      return;
    }

    void loadWorkspaceEntries(workspaceEntriesPath).catch((error) => {
      setError(toErrorMessage(error));
    });
  }, [activeTab, loadWorkspaceEntries, workspaceEntriesPath, workspaceEntriesState?.path]);

  useEffect(() => {
    if (
      activeTab !== "workspace" ||
      !selectedThreadWorkspacePath ||
      !workspaceSelectedPath
    ) {
      setWorkspaceFileContent(null);
      setWorkspaceGitDiff(null);
      setIsWorkspaceContentLoading(false);
      return;
    }

    const baseUrlOverride =
      selectedThreadServerBaseUrl ?? primaryServerTarget?.baseUrl ?? serverBaseUrl;
    let cancelled = false;

    setIsWorkspaceContentLoading(true);
    setWorkspaceFileContent(null);
    setWorkspaceGitDiff(null);

    void (async () => {
      try {
        const shouldLoadDiff = workspaceSelectedMode === "diff" && workspaceSelectionSupportsDiff;
        const shouldLoadImagePreview =
          workspaceSelectedMode === "file" && workspaceSelectionIsImage;
        const shouldLoadTextFile =
          workspaceSelectedMode === "file" &&
          !workspaceSelectionIsImage &&
          !workspaceSelectionIsDeleted;
        const fileContentResult =
          shouldLoadTextFile
            ? await readFilesystemFile({
                path: workspaceSelectedPath,
                baseUrlOverride,
              })
            : null;
        const diffResult =
          shouldLoadDiff
            ? await getWorkspaceGitDiff({
                cwd: selectedThreadWorkspacePath,
                path: workspaceSelectedPath,
                baseUrlOverride,
              })
            : null;
        if (cancelled) {
          return;
        }
        setWorkspaceFileContent(fileContentResult);
        setWorkspaceGitDiff(diffResult);
        if (shouldLoadImagePreview || workspaceSelectionIsDeleted) {
          setWorkspaceFileContent(null);
        }
      } catch (error) {
        if (!cancelled) {
          setError(toErrorMessage(error));
        }
      } finally {
        if (!cancelled) {
          setIsWorkspaceContentLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeTab,
    primaryServerTarget?.baseUrl,
    selectedThreadServerBaseUrl,
    selectedThreadWorkspacePath,
    serverBaseUrl,
    workspaceSelectedMode,
    workspaceSelectedPath,
    workspaceSelectionIsDeleted,
    workspaceSelectionIsImage,
    workspaceSelectionSupportsDiff,
  ]);

  const handleAnswerChange = useCallback(
    (questionId: string, field: "option" | "freeform", value: string) => {
      setAnswerDraft((prev) => ({
        ...prev,
        [questionId]: {
          ...(prev[questionId] ?? { option: "", freeform: "" }),
          [field]: value,
        },
      }));
    },
    [],
  );

  const createNewThread = useCallback(
    async (
      projectPath: string,
      agentId?: AgentId,
      targetServerOverride?: ServerTargetOption | null,
    ) => {
      const trimmedProjectPath = projectPath.trim();
      const targetAgentId = agentId ?? selectedAgentId;
      if (!trimmedProjectPath) {
        setError("Cannot create thread: missing project path");
        return;
      }
      if (!canUseFeature(agentsById[targetAgentId], "createThread")) {
        setError(
          `Cannot create thread: ${targetAgentId} does not support thread creation`,
        );
        return;
      }
      setIsBusy(true);
      try {
        setError("");
        const targetServer = targetServerOverride ?? primaryServerTarget ?? {
          id: "automatic-server",
          label: "Automatic server",
          baseUrl: serverBaseUrl,
          isPrimary: true,
        };
        const created = await createThread({
          cwd: trimmedProjectPath,
          agentId: targetAgentId,
          baseUrlOverride: targetServer.baseUrl,
          ...(preferredNewThreadModelId
            ? { model: preferredNewThreadModelId }
            : {}),
          ...(targetAgentId === "codex"
            ? {
                approvalPolicy: DEFAULT_CODEX_APPROVAL_POLICY,
                sandbox: DEFAULT_CODEX_SANDBOX,
              }
            : {}),
        });
        const createdModel = created.model ?? created.thread.latestModel;
        if (
          preferredNewThreadModelId &&
          createdModel !== preferredNewThreadModelId
        ) {
          throw new Error(
            `Thread started with unexpected model: requested ${preferredNewThreadModelId}, received ${createdModel || "none"}`,
          );
        }
        threadProviderByIdRef.current.set(created.threadId, targetAgentId);
        optimisticSelectedThreadIdsRef.current.add(created.threadId);
        upsertSidebarThread(
          buildOptimisticThreadSummary(
            created.threadId,
            targetAgentId,
            created.thread,
            targetServer,
          ),
        );
        setSelectedThreadId(created.threadId);
        selectedThreadIdRef.current = created.threadId;
        closeMobileSidebar();
        await refreshAll();
      } catch (e) {
        setError(toErrorMessage(e));
      } finally {
        setIsBusy(false);
      }
    },
    [
      agentsById,
      closeMobileSidebar,
      primaryServerTarget,
      preferredNewThreadModelId,
      refreshAll,
      selectedAgentId,
      serverBaseUrl,
      upsertSidebarThread,
    ],
  );

  const submitNewThreadModal = useCallback(async () => {
    const projectPath = newThreadModalState.projectPath.trim();
    if (!selectedNewThreadServer) {
      setError("Cannot create thread: missing target server");
      return;
    }
    if (!projectPath) {
      setError("Cannot create thread: missing project path");
      return;
    }

    await createNewThread(
      projectPath,
      newThreadModalState.agentId,
      selectedNewThreadServer,
    );
    setIsNewThreadModalOpen(false);
  }, [createNewThread, newThreadModalState, selectedNewThreadServer]);

  const createDirectoryForNewThread = useCallback(async () => {
    const projectPath = newThreadModalState.projectPath.trim();
    if (!selectedNewThreadServer) {
      setError("Cannot create directory: missing target server");
      return;
    }
    if (!projectPath) {
      setError("Cannot create directory: missing path");
      return;
    }

    setIsCreatingDirectory(true);
    try {
      setError("");
      const result = await createServerDirectory({
        path: projectPath,
        createParents: true,
        baseUrlOverride: selectedNewThreadServer.baseUrl,
      });
      setNewThreadModalState((previous) => ({
        ...previous,
        projectPath: result.path,
      }));
      await browseDirectory(result.path);
    } catch (error) {
      setError(toErrorMessage(error));
    } finally {
      setIsCreatingDirectory(false);
    }
  }, [browseDirectory, newThreadModalState.projectPath, selectedNewThreadServer]);

  const useBrowsedDirectoryForNewThread = useCallback((pathValue: string) => {
    setNewThreadModalState((previous) => ({
      ...previous,
      projectPath: pathValue,
    }));
  }, []);

  const beginOpenSidebarSwipe = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      if (mobileSidebarOpen) {
        return;
      }
      const touch = event.touches[0];
      if (!touch) {
        return;
      }
      mobileSidebarSwipeRef.current = {
        mode: "open",
        startX: touch.clientX,
        startY: touch.clientY,
      };
      setMobileSidebarDragOffset(-MOBILE_SIDEBAR_WIDTH_PX);
    },
    [mobileSidebarOpen],
  );

  const updateOpenSidebarSwipe = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const gesture = mobileSidebarSwipeRef.current;
      if (!gesture || gesture.mode !== "open") {
        return;
      }
      const touch = event.touches[0];
      if (!touch) {
        return;
      }

      const deltaX = touch.clientX - gesture.startX;
      const deltaY = Math.abs(touch.clientY - gesture.startY);
      if (deltaY > Math.abs(deltaX) && deltaY > 12) {
        mobileSidebarSwipeRef.current = null;
        setMobileSidebarDragOffset(null);
        return;
      }
      if (deltaX <= 0) {
        setMobileSidebarDragOffset(-MOBILE_SIDEBAR_WIDTH_PX);
        return;
      }

      event.preventDefault();
      const revealPx = clampNumber(deltaX, 0, MOBILE_SIDEBAR_WIDTH_PX);
      setMobileSidebarDragOffset(revealPx - MOBILE_SIDEBAR_WIDTH_PX);
    },
    [],
  );

  const endOpenSidebarSwipe = useCallback(() => {
    const gesture = mobileSidebarSwipeRef.current;
    if (!gesture || gesture.mode !== "open") {
      return;
    }
    const revealPx =
      MOBILE_SIDEBAR_WIDTH_PX +
      (mobileSidebarDragOffset ?? -MOBILE_SIDEBAR_WIDTH_PX);
    const shouldOpen = revealPx >= MOBILE_SIDEBAR_TOGGLE_THRESHOLD_PX;
    mobileSidebarSwipeRef.current = null;
    setMobileSidebarDragOffset(null);
    if (shouldOpen) {
      setMobileSidebarOpen(true);
    }
  }, [mobileSidebarDragOffset]);

  const beginCloseSidebarSwipe = useCallback(
    (event: React.TouchEvent<HTMLElement>) => {
      if (!mobileSidebarOpen) {
        return;
      }
      const touch = event.touches[0];
      if (!touch) {
        return;
      }
      mobileSidebarSwipeRef.current = {
        mode: "close",
        startX: touch.clientX,
        startY: touch.clientY,
      };
      setMobileSidebarDragOffset(0);
    },
    [mobileSidebarOpen],
  );

  const updateCloseSidebarSwipe = useCallback(
    (event: React.TouchEvent<HTMLElement>) => {
      const gesture = mobileSidebarSwipeRef.current;
      if (!gesture || gesture.mode !== "close") {
        return;
      }
      const touch = event.touches[0];
      if (!touch) {
        return;
      }

      const deltaX = gesture.startX - touch.clientX;
      const deltaY = Math.abs(touch.clientY - gesture.startY);
      if (deltaY > Math.abs(deltaX) && deltaY > 12) {
        mobileSidebarSwipeRef.current = null;
        setMobileSidebarDragOffset(null);
        return;
      }

      event.preventDefault();
      const hidePx = clampNumber(deltaX, 0, MOBILE_SIDEBAR_WIDTH_PX);
      setMobileSidebarDragOffset(-hidePx);
    },
    [],
  );

  const endCloseSidebarSwipe = useCallback(() => {
    const gesture = mobileSidebarSwipeRef.current;
    if (!gesture || gesture.mode !== "close") {
      return;
    }
    const hiddenPx = -(mobileSidebarDragOffset ?? 0);
    const shouldClose = hiddenPx >= MOBILE_SIDEBAR_TOGGLE_THRESHOLD_PX;
    mobileSidebarSwipeRef.current = null;
    setMobileSidebarDragOffset(null);
    setMobileSidebarOpen(!shouldClose);
  }, [mobileSidebarDragOffset]);

  const renderSidebarContent = (
    viewport: "desktop" | "mobile",
  ): React.JSX.Element => (
    <>
      <div className="relative z-20 h-14 shrink-0 px-4">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 -bottom-3 bg-gradient-to-b from-sidebar from-58% via-sidebar/88 via-80% to-transparent to-100%"
        />
        <div className="relative z-10 flex items-center justify-between h-full">
          <span className="text-sm font-semibold">Chresmus</span>
          <div className="flex items-center gap-1">
            {viewport === "desktop" && (
              <IconBtn
                onClick={() => setDesktopSidebarOpen(false)}
                title="Hide sidebar"
              >
                <PanelLeft size={15} />
              </IconBtn>
            )}
            {viewport === "mobile" && (
              <IconBtn
                onClick={closeMobileSidebar}
                title="Close sidebar"
              >
                <X size={14} />
              </IconBtn>
            )}
          </div>
        </div>
      </div>

      <div className="relative flex-1 min-h-0">
        <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden py-2 pl-2 pr-0">
          {threads.length === 0 && (
            <div className="px-4 py-6 text-xs text-muted-foreground text-center space-y-3">
              <div>No threads</div>
              {availableAgentIds.length > 0 &&
                (availableAgentIds.length === 1 ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    disabled={isBusy || !canCreateThreadForSelectedAgent}
                    onClick={() => {
                      openNewThreadModal({
                        agentId: availableAgentIds[0] ?? selectedAgentId,
                      });
                    }}
                  >
                    <Plus size={13} className="mr-1.5" />
                    New {selectedAgentLabel} thread
                  </Button>
                ) : (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="rounded-full"
                        disabled={
                          isBusy ||
                          !availableAgentIds.some((agentId) =>
                            canUseFeature(agentsById[agentId], "createThread"),
                          )
                        }
                      >
                        <Plus size={13} className="mr-1.5" />
                        New thread
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="center" sideOffset={6}>
                      {availableAgentIds.map((agentId) => (
                        <DropdownMenuItem
                          key={agentId}
                          disabled={
                            !canUseFeature(agentsById[agentId], "createThread")
                          }
                          onSelect={() => {
                            if (
                              !canUseFeature(
                                agentsById[agentId],
                                "createThread",
                              )
                            ) {
                              return;
                            }
                            openNewThreadModal({ agentId });
                          }}
                        >
                          <span className="shrink-0 h-4 w-4 rounded-sm bg-muted/30 ring-1 ring-border/60 flex items-center justify-center overflow-hidden">
                            <AgentFavicon
                              agentId={agentId}
                              label={agentsById[agentId]?.label ?? "Agent"}
                              className="h-3.5 w-3.5"
                            />
                          </span>
                          New {agentsById[agentId]?.label ?? agentId} thread
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ))}
            </div>
          )}
          <div className="space-y-2 pr-2">
            {groupedThreads.map((group) => {
              const hasSelectedThread = group.threads.some(
                (thread) => thread.id === selectedThreadId,
              );
              const hasExplicitState = group.key in sidebarCollapsedGroups;
              const isCollapsed = hasSelectedThread
                ? false
                : hasExplicitState
                  ? Boolean(sidebarCollapsedGroups[group.key])
                  : true;
              const nextAgentId = group.preferredAgentId ?? selectedAgentId;
              const nextAgentLabel =
                agentsById[nextAgentId]?.label ?? nextAgentId;
              const colorAccent = group.userColor;
              return (
                <div
                  key={group.key}
                  className={`space-y-1 ${dragOverGroupKey === group.key ? "ring-1 ring-primary/40 rounded-lg" : ""}`}
                  draggable
                  onDragStart={(event) => {
                    setDraggedGroupKey(group.key);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", group.key);
                  }}
                  onDragEnd={() => {
                    setDraggedGroupKey(null);
                    setDragOverGroupKey(null);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    if (draggedGroupKey && draggedGroupKey !== group.key) {
                      setDragOverGroupKey(group.key);
                    }
                  }}
                  onDragLeave={() => setDragOverGroupKey(null)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragOverGroupKey(null);
                    const sourceKey = draggedGroupKey;
                    if (!sourceKey || sourceKey === group.key) {
                      return;
                    }
                    setSidebarOrder((previous) => {
                      const keys = normalizeManualGroupOrder(
                        previous,
                        groupedThreads.map((entry) => entry.key),
                      );
                      const sourceIndex = keys.indexOf(sourceKey);
                      const targetIndex = keys.indexOf(group.key);
                      if (sourceIndex === -1) {
                        keys.push(sourceKey);
                      }
                      if (targetIndex === -1) {
                        keys.push(group.key);
                      }
                      const normalizedSourceIndex = keys.indexOf(sourceKey);
                      keys.splice(normalizedSourceIndex, 1);
                      const normalizedTargetIndex = keys.indexOf(group.key);
                      keys.splice(normalizedTargetIndex, 0, sourceKey);
                      return keys;
                    });
                  }}
                >
                  <div className="flex items-center gap-0.5">
                    <span className="shrink-0 cursor-grab text-muted-foreground/30 hover:text-muted-foreground/60">
                      <GripVertical size={11} />
                    </span>
                    {colorAccent && (
                      <span
                        className="shrink-0 w-1.5 h-4 rounded-full"
                        style={{ backgroundColor: colorAccent }}
                      />
                    )}
                    <Button
                      type="button"
                      onClick={() =>
                        setSidebarCollapsedGroups((prev) => ({
                          ...prev,
                          [group.key]: !isCollapsed,
                        }))
                      }
                      variant="ghost"
                      className="h-6 flex-1 justify-start gap-1.5 rounded-lg px-1.5 py-1 text-left text-[13px] tracking-tight font-normal text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    >
                      {isCollapsed ? (
                        <Folder size={13} className="shrink-0" />
                      ) : (
                        <FolderOpen size={13} className="shrink-0" />
                      )}
                      <span className="min-w-0 truncate">{group.label}</span>
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 rounded-lg text-muted-foreground/40 hover:text-foreground hover:bg-muted"
                        >
                          <Palette size={11} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        sideOffset={6}
                        className="w-48"
                      >
                        <div className="px-2 py-1.5 text-[11px] text-muted-foreground font-medium">
                          Project color
                        </div>
                        <div className="flex gap-1 px-2 pb-1.5">
                          {groupColors.map((color) => (
                            <button
                              key={color}
                              type="button"
                              onClick={() => {
                                setProjectColors((prev) => ({
                                  ...prev,
                                  [group.key]: color as GroupColor,
                                }));
                              }}
                              className="w-5 h-5 rounded-full ring-1 ring-border/40 hover:ring-2 hover:ring-foreground/50 transition-all"
                              style={{ backgroundColor: color }}
                            />
                          ))}
                        </div>
                        {colorAccent && (
                          <DropdownMenuItem
                            onSelect={() => {
                              setProjectColors((prev) => {
                                const next = { ...prev };
                                delete next[group.key];
                                return next;
                              });
                            }}
                          >
                            Remove color
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {availableAgentIds.length <= 1 ? (
                      <IconBtn
                        onClick={() => {
                          if (!group.projectPath) {
                            return;
                          }
                          openNewThreadModal({
                            agentId: availableAgentIds[0] ?? selectedAgentId,
                            projectPath: group.projectPath,
                          });
                        }}
                        title={
                          group.projectPath
                            ? `New ${nextAgentLabel} thread in ${group.label}`
                            : "Cannot create thread: missing project path"
                        }
                        disabled={
                          isBusy ||
                          !group.projectPath ||
                          !canCreateThreadForSelectedAgent
                        }
                      >
                        <Plus size={14} />
                      </IconBtn>
                    ) : (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            disabled={
                              isBusy ||
                              !group.projectPath ||
                              !availableAgentIds.some((agentId) =>
                                canUseFeature(
                                  agentsById[agentId],
                                  "createThread",
                                ),
                              )
                            }
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted"
                            title={
                              group.projectPath
                                ? `New thread in ${group.label}`
                                : "Cannot create thread: missing project path"
                            }
                          >
                            <Plus size={14} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" sideOffset={6}>
                          {availableAgentIds.map((agentId) => (
                            <DropdownMenuItem
                              key={agentId}
                              disabled={
                                !canUseFeature(
                                  agentsById[agentId],
                                  "createThread",
                                )
                              }
                              onSelect={() => {
                                if (!group.projectPath) {
                                  return;
                                }
                                if (
                                  !canUseFeature(
                                    agentsById[agentId],
                                    "createThread",
                                  )
                                ) {
                                  return;
                                }
                                openNewThreadModal({
                                  agentId,
                                  projectPath: group.projectPath,
                                });
                              }}
                            >
                              <span className="shrink-0 h-4 w-4 rounded-sm bg-muted/30 ring-1 ring-border/60 flex items-center justify-center overflow-hidden">
                                <AgentFavicon
                                  agentId={agentId}
                                  label={agentsById[agentId]?.label ?? "Agent"}
                                  className="h-3.5 w-3.5"
                                />
                              </span>
                              New {agentsById[agentId]?.label ?? agentId} thread
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                  {!isCollapsed && (
                    <div className="space-y-1 pl-5 pt-0.5">
                      {group.threads.length === 0 && (
                        <div className="px-2.5 py-1 text-[11px] text-muted-foreground/70">
                          No threads yet
                        </div>
                      )}
                      {group.threads.map((thread) => {
                        const isSelected = thread.id === selectedThreadId;
                        const threadIsGenerating =
                          Boolean(thread.isGenerating) ||
                          (isSelected && isGenerating);
                        const waitingOnApproval =
                          isSelected && selectedThreadWaitingState
                            ? selectedThreadWaitingState.waitingOnApproval
                            : Boolean(thread.waitingOnApproval);
                        const waitingOnUserInput =
                          isSelected && selectedThreadWaitingState
                            ? selectedThreadWaitingState.waitingOnUserInput
                            : Boolean(thread.waitingOnUserInput);
                        const hasWaitingIndicator =
                          waitingOnApproval || waitingOnUserInput;
                        const sidebarStatus =
                          isSelected && selectedThreadStatus
                            ? selectedThreadStatus
                            : buildThreadStatusSummary({
                                isGenerating: threadIsGenerating,
                                waitingOnApproval,
                                waitingOnUserInput,
                                lastTurn: undefined,
                                liveStateError: null,
                                uiErrorMessage: null,
                              });
                        return (
                          <Button
                            key={thread.id}
                            type="button"
                            onClick={() => {
                              setSelectedThreadId(thread.id);
                              closeMobileSidebar();
                            }}
                            variant="ghost"
                            className={`w-full min-w-0 h-auto flex items-center justify-between gap-2 rounded-xl px-2.5 py-1.5 text-left text-[13px] tracking-tight font-normal transition-colors ${
                              isSelected
                                ? "bg-muted/90 text-foreground shadow-sm"
                                : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                            }`}
                          >
                            <span className="min-w-0 flex-1 flex items-center gap-1.5 truncate leading-5">
                              {colorAccent && (
                                <span
                                  className="shrink-0 w-1 h-3.5 rounded-full"
                                  style={{ backgroundColor: colorAccent }}
                                />
                              )}
                              {showProviderIcons && (
                                <span className="shrink-0 h-4 w-4 rounded-sm bg-muted/30 ring-1 ring-border/60 flex items-center justify-center overflow-hidden">
                                  <AgentFavicon
                                    agentId={thread.provider}
                                    label={
                                      agentsById[thread.provider]?.label ??
                                      "Agent"
                                    }
                                    className="h-3.5 w-3.5"
                                  />
                                </span>
                              )}
                              <span className="min-w-0 flex-1 truncate">
                                <span className="block truncate">
                                  {threadLabel(thread)}
                                </span>
                                <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground/60">
                                  <span className="truncate">
                                    {sidebarStatus?.label ?? thread.serverLabel}
                                  </span>
                                  <span className="shrink-0">·</span>
                                  <span className="truncate">
                                    {thread.serverLabel}
                                  </span>
                                </span>
                              </span>
                            </span>
                            <span className="shrink-0 flex items-center gap-1.5">
                              <SidebarThreadWaitingIndicators
                                waitingOnApproval={waitingOnApproval}
                                waitingOnUserInput={waitingOnUserInput}
                              />
                              {!hasWaitingIndicator && threadIsGenerating && (
                                <Loader2
                                  size={11}
                                  className="animate-spin text-muted-foreground/70"
                                />
                              )}
                              {thread.updatedAt && (
                                <span className="text-[10px] text-muted-foreground/50">
                                  {formatCompactRelativeTime(thread.updatedAt)}
                                </span>
                              )}
                            </span>
                          </Button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="relative z-20 shrink-0 p-3">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-3 bottom-0 bg-gradient-to-t from-sidebar from-58% via-sidebar/88 via-80% to-transparent to-100%"
        />
        <div className="relative z-10 flex items-center justify-between gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setIsSettingsModalOpen(true)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/40 transition-colors cursor-pointer min-w-0 text-left"
              >
                <span
                  className={`h-2 w-2 rounded-full shrink-0 ${
                    allSystemsReady
                      ? "bg-success"
                      : hasAnySystemFailure
                        ? "bg-danger"
                      : "bg-muted-foreground/40"
                  }`}
                />
                <span className="font-mono truncate">{commitLabel}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              align="start"
              className="space-y-1 text-xs"
            >
              <div className="font-mono text-[11px]">{commitLabel}</div>
              {agentDescriptors
                .filter((descriptor) => descriptor.enabled)
                .map((descriptor) => (
                  <div key={descriptor.id}>
                    {descriptor.label}:{" "}
                    {descriptor.connected ? "connected" : "disconnected"}
                  </div>
                ))}
              {codexConnected ? (
                <div>App: {health?.state.appReady ? "ok" : "not ready"}</div>
              ) : null}
              {visibleHealthError && (
                <div className="max-w-64 break-words text-destructive">
                  Error: {visibleHealthError}
                </div>
              )}
              <div className="text-muted-foreground">
                Click to open settings
              </div>
            </TooltipContent>
          </Tooltip>
          <div className="flex items-center gap-1 shrink-0">
            {DEBUG_UI_ENABLED ? (
              <IconBtn
                onClick={() => {
                  setActiveTab((currentTab) =>
                    currentTab === "debug" ? "chat" : "debug",
                  );
                  if (viewport === "mobile") {
                    closeMobileSidebar();
                  }
                }}
                active={activeTab === "debug"}
                title="Debug"
              >
                <Bug size={14} />
              </IconBtn>
            ) : null}
            <IconBtn onClick={toggleTheme} title="Toggle theme">
              {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
            </IconBtn>
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href="https://github.com/yuercl/Chresmus"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="h-8 w-8 rounded-lg inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
                >
                  <Github size={14} />
                </a>
              </TooltipTrigger>
              <TooltipContent side="top" align="end">
                GitHub
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </>
  );

  /* ── Render ─────────────────────────────────────────────── */
  return (
    <TooltipProvider delayDuration={120}>
      <div className="app-shell flex bg-background text-foreground font-sans overscroll-x-none">
        <div
          className="md:hidden fixed left-0 top-0 bottom-0 z-30"
          style={{ width: `${MOBILE_SWIPE_EDGE_PX}px`, touchAction: "pan-y" }}
          onTouchStart={beginOpenSidebarSwipe}
          onTouchMove={updateOpenSidebarSwipe}
          onTouchEnd={endOpenSidebarSwipe}
          onTouchCancel={endOpenSidebarSwipe}
        />
        {/* Mobile sidebar backdrop */}
        <AnimatePresence>
          {mobileSidebarRendered && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: mobileSidebarOpenRatio }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="md:hidden fixed inset-0 bg-black/50 z-40"
              onClick={closeMobileSidebar}
            />
          )}
        </AnimatePresence>

        {/* Desktop sidebar */}
        <AnimatePresence initial={false}>
          {desktopSidebarOpen && (
            <motion.aside
              key="desktop-sidebar"
              initial={{ x: -280, opacity: 0.94 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -280, opacity: 0.94 }}
              transition={{
                type: "spring",
                stiffness: 380,
                damping: 36,
                mass: 0.7,
              }}
              className="hidden md:flex fixed left-0 top-[env(safe-area-inset-top)] bottom-[env(safe-area-inset-bottom)] z-30 w-64 flex-col border-r border-sidebar-border bg-sidebar/78 supports-[backdrop-filter]:bg-sidebar/62 backdrop-blur-xl shadow-xl"
            >
              {renderSidebarContent("desktop")}
            </motion.aside>
          )}
        </AnimatePresence>

        {/* Mobile sidebar */}
        <AnimatePresence initial={false}>
          {mobileSidebarRendered && (
            <motion.aside
              key="mobile-sidebar"
              initial={{ x: -MOBILE_SIDEBAR_WIDTH_PX }}
              animate={{ x: mobileSidebarOffsetX }}
              exit={{ x: -MOBILE_SIDEBAR_WIDTH_PX }}
              transition={{
                duration: mobileSidebarDragOffset !== null ? 0 : 0.2,
                ease: mobileSidebarDragOffset !== null ? "linear" : "easeOut",
              }}
              className="md:hidden fixed left-0 top-[env(safe-area-inset-top)] bottom-[env(safe-area-inset-bottom)] z-50 w-64 flex flex-col border-r border-sidebar-border bg-sidebar/82 supports-[backdrop-filter]:bg-sidebar/68 backdrop-blur-xl shadow-xl"
              style={{ touchAction: "pan-y" }}
              onTouchStart={beginCloseSidebarSwipe}
              onTouchMove={updateCloseSidebarSwipe}
              onTouchEnd={endCloseSidebarSwipe}
              onTouchCancel={endCloseSidebarSwipe}
            >
              {renderSidebarContent("mobile")}
            </motion.aside>
          )}
        </AnimatePresence>

        {/* ── Main area ───────────────────────────────────────── */}
        <div
          className={`relative flex-1 flex flex-col min-w-0 transition-[margin] duration-200 ${
            desktopSidebarOpen ? "md:ml-64" : "md:ml-0"
          }`}
        >
          {/* Header */}
          <header
            className={`flex items-center justify-between px-3 h-14 shrink-0 gap-2 ${
              activeTab === "chat"
                ? "absolute inset-x-0 top-0 z-20 bg-transparent"
                : "border-b border-border"
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className="md:hidden">
                <IconBtn
                  onClick={openMobileSidebar}
                  title="Threads"
                >
                  <Menu size={15} />
                </IconBtn>
              </div>
              {!desktopSidebarOpen && (
                <div className="hidden md:block">
                  <IconBtn
                    onClick={() => setDesktopSidebarOpen(true)}
                    title="Show sidebar"
                  >
                    <PanelLeft size={15} />
                  </IconBtn>
                </div>
              )}
              <div className="min-w-0">
                <div className="text-sm font-medium truncate leading-5 flex items-center gap-1.5">
                  {selectedThread
                    ? threadLabel(selectedThread)
                    : "No thread selected"}
                  {selectedThread && activeAgentLabel && showProviderIcons && (
                    <span className="shrink-0 h-5 w-5 rounded-md bg-muted/30 ring-1 ring-border/60 flex items-center justify-center overflow-hidden">
                      <AgentFavicon
                        agentId={activeThreadAgentId}
                        label={activeAgentLabel}
                        className="h-4 w-4"
                      />
                    </span>
                  )}
                </div>
                {selectedThreadWorkspacePath && (
                  <div className="flex items-center gap-1.5 min-w-0 text-[11px] leading-4 text-muted-foreground/75">
                    <span className="shrink-0 rounded-md bg-muted/50 px-1.5 py-0.5 font-medium text-foreground/80">
                      {selectedThreadWorkspaceLabel}
                    </span>
                    <span className="truncate">{selectedThreadWorkspacePath}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-0.5 shrink-0">
              {topNavTabs && (
                <div className="md:hidden mr-1">
                  <Select
                    value={activeTab}
                    onValueChange={(value) => setActiveTab(AppTabSchema.parse(value))}
                  >
                    <SelectTrigger className="h-8 w-[118px] rounded-full border-border/70 bg-muted/40 px-3 text-xs shadow-none focus-visible:ring-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      {topNavOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {showUsageBadges && rateLimits && (() => {
                const windows: Array<{
                  label: string;
                  usedPct: number;
                  resetAt: number | null;
                }> = [];
                if (rateLimits.rateLimits.primary) {
                  windows.push({
                    label: "5h",
                    usedPct: rateLimits.rateLimits.primary.usedPercent,
                    resetAt: rateLimits.rateLimits.primary.resetsAt ?? null,
                  });
                }
                if (rateLimits.rateLimits.secondary) {
                  windows.push({
                    label: "Week",
                    usedPct: rateLimits.rateLimits.secondary.usedPercent,
                    resetAt: rateLimits.rateLimits.secondary.resetsAt ?? null,
                  });
                }
                if (windows.length === 0) {
                  return null;
                }
                return (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="mr-1 inline-flex h-5 items-center overflow-hidden rounded-full border border-border/70 bg-muted/50">
                        {windows.slice(0, 2).map((windowEntry, index) => {
                          const colorClass =
                            windowEntry.usedPct > 85
                              ? "text-danger"
                              : windowEntry.usedPct > 60
                                ? "text-amber-500 dark:text-amber-400"
                                : "text-muted-foreground/70";
                          return (
                            <span
                              key={windowEntry.label}
                              className="inline-flex h-full items-center"
                            >
                              {index > 0 && (
                                <span className="h-full w-px bg-border/60" />
                              )}
                              <span
                                className={`inline-flex h-full items-center gap-1 px-2 text-[10px] font-mono ${colorClass}`}
                              >
                                <span>{windowEntry.label}</span>
                                <span>{windowEntry.usedPct}%</span>
                              </span>
                            </span>
                          );
                        })}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="end">
                      <div className="space-y-0.5 text-xs">
                        {windows.map((windowEntry) => {
                          const resetLabel = formatResetTimestamp(windowEntry.resetAt);
                          return (
                            <div key={`quota-tip-${windowEntry.label}`}>
                              <span className="font-medium">{windowEntry.label}</span>:{" "}
                              {windowEntry.usedPct}% used
                              {resetLabel && (
                                <span className="text-muted-foreground">
                                  {" "}
                                  (resets {resetLabel})
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                );
              })()}
              {showUsageBadges && sessionTokenUsage && (() => {
                const { contextTokens, sessionTotalTokens, contextWindow } =
                  sessionTokenUsage;
                const usedPct =
                  contextWindow && contextWindow > 0
                    ? Math.round((contextTokens / contextWindow) * 100)
                    : null;
                const colorClass =
                  usedPct !== null && usedPct > 85
                    ? "text-danger"
                    : usedPct !== null && usedPct > 60
                      ? "text-amber-500 dark:text-amber-400"
                      : "text-muted-foreground/60";
                const contextLabel =
                  contextTokens >= 1000
                    ? `${(contextTokens / 1000).toFixed(0)}k`
                    : String(contextTokens);
                const windowLabel = contextWindow
                  ? contextWindow >= 1000
                    ? `${(contextWindow / 1000).toFixed(0)}k`
                    : String(contextWindow)
                  : null;
                const sessionTotalLabel =
                  sessionTotalTokens >= 1000
                    ? `${(sessionTotalTokens / 1000).toFixed(0)}k`
                    : String(sessionTotalTokens);

                return (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className={`mr-1 inline-flex h-5 items-center gap-1 rounded-full border border-border/70 bg-muted/50 px-2 text-[10px] font-mono ${colorClass}`}
                      >
                        <UsageRing
                          percent={usedPct}
                          size={11}
                          strokeWidth={1.75}
                          className={colorClass}
                        />
                        <span className="hidden sm:inline">
                          {windowLabel
                            ? `${contextLabel}/${windowLabel}`
                            : contextLabel}
                        </span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="end">
                      <div className="text-xs space-y-0.5">
                        <div className="font-medium">Current chat</div>
                        <div>{contextLabel} tokens in current context</div>
                        {windowLabel && (
                          <div className="text-muted-foreground">
                            {windowLabel} token context window
                          </div>
                        )}
                        {usedPct !== null && (
                          <div className="text-muted-foreground">
                            {usedPct}% of context used
                          </div>
                        )}
                        <div className="text-muted-foreground">
                          Session total: {sessionTotalLabel} tokens
                        </div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                );
              })()}
            </div>
          </header>

          <div
            className={
              activeTab === "chat"
                ? "flex-1 min-h-0 flex flex-col pt-14"
                : "flex-1 min-h-0 flex flex-col"
            }
          >
            {/* Error bar */}
            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden shrink-0"
                >
                  <div className="flex items-center justify-between px-4 py-2 bg-destructive/10 border-b border-destructive/20 text-sm text-destructive">
                    <span className="truncate">{error}</span>
                    <Button
                      type="button"
                      onClick={() => setError("")}
                      variant="ghost"
                      size="icon"
                      className="ml-3 h-6 w-6 shrink-0 opacity-60 hover:opacity-100"
                    >
                      <X size={13} />
                    </Button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            <AnimatePresence>
              {threadListErrorMessage && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden shrink-0"
                >
                  <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-sm text-amber-200">
                    {threadListErrorMessage}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            <AnimatePresence>
              {liveStateStreamError && activeTab === "chat" && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden shrink-0"
                >
                  <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-sm text-amber-200">
                    Live updates failed for this thread.
                    {liveStateStreamError.eventIndex !== null && (
                      <span className="ml-2 text-xs text-amber-300/90">
                        event {liveStateStreamError.eventIndex}
                      </span>
                    )}
                    {liveStateStreamError.patchIndex !== null && (
                      <span className="ml-1 text-xs text-amber-300/90">
                        patch {liveStateStreamError.patchIndex}
                      </span>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {topNavTabs && (
              <div className="hidden md:block shrink-0 border-b border-border px-3 py-2">
                <div className="overflow-visible py-1">
                  <div className="overflow-x-auto px-1 py-0.5">
                    <div className="flex w-max items-center gap-1">{topNavTabs}</div>
                  </div>
                </div>
              </div>
            )}

            {/* ── Chat tab ──────────────────────────────────────── */}
            {activeTab === "chat" && (
              <div className="relative flex-1 flex flex-col min-h-0">
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 -top-4 z-10 h-10 bg-gradient-to-b from-background from-20% via-background/60 via-60% to-transparent to-100%"
                />

                {/* Conversation */}
                <ChatTimeline
                  selectedThreadId={selectedThreadId}
                  turnsLength={turns.length}
                  hasAnyAgent={availableAgentIds.length > 0}
                  hasHiddenChatItems={hasHiddenChatItems}
                  visibleConversationItems={visibleConversationItems}
                  isChatAtBottom={isChatAtBottom}
                  onSelectThread={handleSelectReferencedThread}
                  onShowOlder={() => {
                    shouldAutoFollowChatRef.current = false;
                    isChatAtBottomRef.current = false;
                    setIsChatAtBottom(false);
                    setVisibleChatItemLimit(
                      (limit) => limit + VISIBLE_CHAT_ITEMS_STEP,
                    );
                  }}
                  onScrollToBottom={() => {
                    scrollChatToBottom();
                    isChatAtBottomRef.current = true;
                    shouldAutoFollowChatRef.current = true;
                    setIsChatAtBottom(true);
                  }}
                  scrollRef={scrollRef}
                  chatContentRef={chatContentRef}
                />

                {/* Input area */}
                <div className="relative z-10 -mt-6 px-4 pt-6 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] md:pb-6 shrink-0">
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-transparent via-background/85 to-background"
                  />
                  <div className="relative max-w-3xl mx-auto space-y-2">
                    <AnimatePresence mode="wait">
                      {activeRequest &&
                      canSubmitUserInputForActiveAgent &&
                      hasResolvedSelectedThreadProvider ? (
                        <PendingRequestCard
                          key="pending"
                          request={activeRequest}
                          answerDraft={answerDraft}
                          onDraftChange={handleAnswerChange}
                          onSubmit={() => void submitPendingRequest()}
                          onSkip={() => void skipPendingRequest()}
                          isBusy={isBusy}
                        />
                      ) : activeApprovalRequest &&
                        canSubmitUserInputForActiveAgent &&
                        hasResolvedSelectedThreadProvider ? (
                        <PendingApprovalCard
                          request={activeApprovalRequest}
                          isBusy={isBusy}
                          onDeny={() => void resolvePendingApprovalRequest("deny")}
                          onApprove={() =>
                            void resolvePendingApprovalRequest("approve")
                          }
                        />
                      ) : activeInformationalRequest ? (
                        <PendingInformationalRequestCard
                          method={activeInformationalRequest.method}
                        />
                      ) : (
                        <motion.div
                          key="composer"
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, y: 8 }}
                          transition={{ duration: 0.15 }}
                          className="flex flex-col gap-2"
                        >
                          <AnimatePresence initial={false}>
                            {selectedThreadStatus && (
                              <motion.div
                                initial={{ opacity: 0, y: 4 }}
                                animate={{ opacity: 1, height: "auto" }}
                                exit={{ opacity: 0, y: 4 }}
                                transition={{ duration: 0.15 }}
                                className="px-1"
                              >
                                <div
                                  className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${threadStatusClasses(selectedThreadStatus.tone).container}`}
                                >
                                  <span
                                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                      selectedThreadStatus.tone === "progress"
                                        ? "animate-pulse"
                                        : ""
                                    } ${threadStatusClasses(selectedThreadStatus.tone).dot}`}
                                  />
                                  <span
                                    className={`min-w-0 truncate font-medium ${
                                      selectedThreadStatus.tone === "progress"
                                        ? "reasoning-shimmer"
                                        : ""
                                    }`}
                                  >
                                    {selectedThreadStatus.detail
                                      ? `${selectedThreadStatus.label}: ${selectedThreadStatus.detail}`
                                      : selectedThreadStatus.label}
                                  </span>
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>

                          <ChatComposer
                            canSend={canUseComposer}
                            canAttachImages={canAttachImagesForActiveAgent}
                            isBusy={isBusy}
                            isGenerating={isGenerating}
                            placeholder={
                              selectedThreadId
                                ? `Message ${activeAgentLabel}…`
                                : `Message ${selectedAgentLabel}…`
                            }
                            onInterrupt={runInterrupt}
                            onSend={submitMessage}
                          />

                          {/* Toolbar */}
                          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                            {canSetCollaborationMode &&
                              canListCollaborationModes && (
                                <Button
                                  type="button"
                                  onClick={() => {
                                    if (!planModeOption) return;
                                    const nextModeKey = isPlanModeEnabled
                                      ? (defaultModeOption?.mode ??
                                        selectedModeKey)
                                      : planModeOption.mode;
                                    if (!nextModeKey) return;
                                    setSelectedModeKey(nextModeKey);
                                    void applyModeDraft({
                                      modeKey: nextModeKey,
                                      modelId: selectedModelId,
                                      reasoningEffort: selectedReasoningEffort,
                                    });
                                  }}
                                  variant="ghost"
                                  size="sm"
                                  className={`h-8 shrink-0 rounded-full px-2 text-xs ${
                                    isPlanModeEnabled
                                      ? "bg-blue-500/15 text-blue-600 hover:bg-blue-500/20 dark:text-blue-300"
                                      : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                                  }`}
                                  disabled={
                                    !selectedThreadId || !planModeOption
                                  }
                                >
                                  {isPlanModeEnabled ? (
                                    <CircleDot size={10} />
                                  ) : (
                                    <Circle size={10} />
                                  )}
                                  Plan
                                </Button>
                              )}
                            {canSetCollaborationMode && canListModels && (
                              <Select
                                value={selectedModelId || APP_DEFAULT_VALUE}
                                onValueChange={(value) => {
                                  const nextModelId =
                                    value === APP_DEFAULT_VALUE ? "" : value;
                                  setSelectedModelId(nextModelId);
                                  void applyModeDraft({
                                    modeKey: selectedModeKey,
                                    modelId: nextModelId,
                                    reasoningEffort: selectedReasoningEffort,
                                  });
                                }}
                                disabled={!selectedThreadId || !selectedModeKey}
                              >
                                <SelectTrigger className="h-8 w-[132px] sm:w-[176px] shrink-0 rounded-full border-0 bg-transparent dark:bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:text-foreground focus-visible:ring-0">
                                  <SelectValue placeholder="Model" />
                                </SelectTrigger>
                                <SelectContent position="popper">
                                  <SelectItem value={APP_DEFAULT_VALUE}>
                                    {appDefaultModelLabel}
                                  </SelectItem>
                                  {modelOptionsWithoutAppDefault.map(
                                    (option) => (
                                      <SelectItem
                                        key={option.id}
                                        value={option.id}
                                      >
                                        {option.label}
                                      </SelectItem>
                                    ),
                                  )}
                                </SelectContent>
                              </Select>
                            )}
                            {canSetCollaborationMode &&
                              canListCollaborationModes && (
                                <Select
                                  value={
                                    selectedReasoningEffort || APP_DEFAULT_VALUE
                                  }
                                  onValueChange={(value) => {
                                    const nextReasoningEffort =
                                      value === APP_DEFAULT_VALUE ? "" : value;
                                    setSelectedReasoningEffort(
                                      nextReasoningEffort,
                                    );
                                    void applyModeDraft({
                                      modeKey: selectedModeKey,
                                      modelId: selectedModelId,
                                      reasoningEffort: nextReasoningEffort,
                                    });
                                  }}
                                  disabled={
                                    !selectedThreadId || !selectedModeKey
                                  }
                                >
                                  <SelectTrigger className="h-8 w-[104px] sm:w-[148px] shrink-0 rounded-full border-0 bg-transparent dark:bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:text-foreground focus-visible:ring-0">
                                    <SelectValue placeholder="Effort" />
                                  </SelectTrigger>
                                  <SelectContent position="popper">
                                    <SelectItem value={APP_DEFAULT_VALUE}>
                                      {appDefaultEffortLabel}
                                    </SelectItem>
                                    {effortOptionsWithoutAppDefault.map(
                                      (option) => (
                                        <SelectItem key={option} value={option}>
                                          {option}
                                        </SelectItem>
                                      ),
                                    )}
                                  </SelectContent>
                                </Select>
                              )}
                            {canSetCollaborationMode && (
                              <span
                                className={`inline-flex w-3 items-center justify-center text-xs text-muted-foreground transition-opacity ${
                                  isModeSyncing ? "opacity-100" : "opacity-0"
                                }`}
                              >
                                <Loader2
                                  size={10}
                                  className={
                                    isModeSyncing ? "animate-spin" : ""
                                  }
                                />
                              </span>
                            )}
                            {pendingThreadRequests.length > 0 && (
                              <span className="shrink-0 text-xs text-amber-500 dark:text-amber-400">
                                {pendingThreadRequests.length} pending
                              </span>
                            )}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "workspace" && (
              <div className="flex-1 min-h-0 overflow-hidden">
                {!selectedThreadWorkspacePath ? (
                  <div className="h-full flex items-center justify-center px-6 text-sm text-muted-foreground">
                    This thread does not have a workspace path.
                  </div>
                ) : (
                  <>
                    <div className="hidden md:grid h-full min-h-0 md:grid-cols-[320px_minmax(0,1fr)] divide-x divide-border">
                      <div className="min-h-0 overflow-y-auto p-3 space-y-3">
                        <div className="rounded-xl border border-border bg-card/50 p-3 space-y-1">
                          <div className="text-xs text-muted-foreground">Project</div>
                          <div className="font-medium truncate">{selectedThreadWorkspaceLabel}</div>
                          <div className="text-xs text-muted-foreground break-all">{selectedThreadWorkspacePath}</div>
                          <div className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
                            <span>Branch: {workspaceGitStatus?.branch ?? "unknown"}</span>
                            <span>Changed: {workspaceGitStatus?.files.length ?? 0}</span>
                          </div>
                        </div>

                        <div className="rounded-xl border border-border overflow-hidden">
                          <div className="px-3 py-2 border-b border-border bg-muted/30 text-xs font-medium">Changed Files</div>
                          <div className="max-h-64 overflow-y-auto">
                            {workspaceGitStatus?.files.length ? workspaceGitStatus.files.map((file) => (
                              <Button
                                key={file.path}
                                type="button"
                                variant="ghost"
                                className={`h-auto w-full rounded-none justify-start px-3 py-2 text-left ${workspaceSelectedPath === file.path ? "bg-muted" : ""}`}
                                onClick={() => {
                                  setWorkspaceSelectedPath(file.path);
                                  setWorkspaceSelectedMode(workspacePreferredMode(file));
                                }}
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="truncate font-mono text-xs">{basenameFromPath(file.path)}</div>
                                  <div className="truncate text-[11px] text-muted-foreground">{file.path}</div>
                                </div>
                                <div className="shrink-0 text-[10px] text-muted-foreground">
                                  {workspaceStatusLabel(file.unstagedStatus ?? file.stagedStatus)}
                                </div>
                              </Button>
                            )) : (
                              <div className="px-3 py-3 text-xs text-muted-foreground">No changed files</div>
                            )}
                          </div>
                        </div>

                        <div className="rounded-xl border border-border overflow-hidden">
                          <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-muted/30">
                            <span className="text-xs font-medium">Files</span>
                            <div className="flex items-center gap-1">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 rounded-lg px-2"
                                disabled={workspaceParentPath === null}
                                onClick={() => {
                                  if (!workspaceParentPath) {
                                    return;
                                  }
                                  setWorkspaceEntriesPath(workspaceParentPath);
                                }}
                              >
                                Up
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 rounded-lg px-2"
                                onClick={() => {
                                  if (!selectedThreadWorkspacePath) {
                                    return;
                                  }
                                  setWorkspaceEntriesPath(selectedThreadWorkspacePath);
                                }}
                              >
                                Root
                              </Button>
                            </div>
                          </div>
                          <div className="px-3 py-2 text-[11px] text-muted-foreground border-b border-border truncate">
                            {workspaceEntriesState?.path ?? selectedThreadWorkspacePath}
                          </div>
                          <div className="max-h-72 overflow-y-auto">
                            {workspaceEntriesState?.entries.length ? workspaceEntriesState.entries.map((entry) => (
                              <Button
                                key={entry.path}
                                type="button"
                                variant="ghost"
                                className={`h-auto w-full rounded-none justify-start gap-2 px-3 py-2 text-left ${workspaceSelectedPath === entry.path ? "bg-muted" : ""}`}
                                onClick={() => {
                                  if (entry.kind === "directory") {
                                    setWorkspaceEntriesPath(entry.path);
                                    return;
                                  }
                                  setWorkspaceSelectedPath(entry.path);
                                  setWorkspaceSelectedMode("file");
                                }}
                              >
                                {entry.kind === "directory" ? (
                                  <FolderOpen size={13} />
                                ) : (
                                  <FileText size={13} />
                                )}
                                <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.name}</span>
                              </Button>
                            )) : (
                              <div className="px-3 py-3 text-xs text-muted-foreground">No files</div>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="min-h-0 overflow-y-auto p-4 space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="font-medium truncate">
                              {workspaceSelectedPath ? basenameFromPath(workspaceSelectedPath) : "Select a file"}
                            </div>
                            <div className="text-xs text-muted-foreground truncate">
                              {workspaceSelectedPath ?? "Choose a changed file or browse the project"}
                            </div>
                          </div>
                          {workspaceSelectedPath && (
                            <div className="flex items-center gap-1">
                              <Button
                                type="button"
                                variant={workspaceSelectedMode === "diff" ? "secondary" : "ghost"}
                                size="sm"
                                className="rounded-full"
                                disabled={!workspaceSelectionSupportsDiff}
                                onClick={() => setWorkspaceSelectedMode("diff")}
                              >
                                Diff
                              </Button>
                              <Button
                                type="button"
                                variant={workspaceSelectedMode === "file" ? "secondary" : "ghost"}
                                size="sm"
                                className="rounded-full"
                                onClick={() => setWorkspaceSelectedMode("file")}
                              >
                                File
                              </Button>
                            </div>
                          )}
                        </div>

                        <div className="grid gap-2 sm:grid-cols-3">
                          <div className="rounded-xl border border-border bg-card/40 px-3 py-2">
                            <div className="text-[11px] text-muted-foreground">Workspace</div>
                            <div className="truncate text-sm font-medium">
                              {selectedThreadWorkspaceLabel ?? "Unknown"}
                            </div>
                          </div>
                          <div className="rounded-xl border border-border bg-card/40 px-3 py-2">
                            <div className="text-[11px] text-muted-foreground">Branch</div>
                            <div className="truncate text-sm font-medium">
                              {workspaceGitStatus?.branch ?? "unknown"}
                            </div>
                          </div>
                          <div className="rounded-xl border border-border bg-card/40 px-3 py-2">
                            <div className="text-[11px] text-muted-foreground">Selection</div>
                            <div className="truncate text-sm font-medium">
                              {workspaceSelectedStatusLabel ?? "Browsing files"}
                            </div>
                          </div>
                        </div>

                        {(isWorkspaceLoading || isWorkspaceContentLoading) && (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Loader2 size={14} className="animate-spin" />
                            {isWorkspaceLoading
                              ? "Loading workspace…"
                              : "Loading file…"}
                          </div>
                        )}

                        {workspaceSelectedPath ? (
                          workspaceSelectedMode === "diff" ? (
                            workspaceGitDiff?.diff ? (
                              <DiffBlock
                                layout="split"
                                changes={[
                                  {
                                    path: workspaceSelectedPath,
                                    kind: workspaceDiffKind(workspaceSelectedGitFile),
                                    diff: workspaceGitDiff.diff,
                                  },
                                ]}
                              />
                            ) : (
                              <div className="rounded-xl border border-border bg-card/40 px-4 py-6 text-sm text-muted-foreground">
                                No diff available for this file.
                              </div>
                            )
                          ) : workspaceSelectionIsImage && workspaceRawFileUrl ? (
                            <div className="rounded-xl border border-border bg-card/30 p-3">
                              <img
                                src={workspaceRawFileUrl}
                                alt={basenameFromPath(workspaceSelectedPath)}
                                className="max-h-[70vh] w-full rounded-lg object-contain"
                                loading="lazy"
                              />
                            </div>
                          ) : workspaceSelectedFileMissing ? (
                            <div className="rounded-xl border border-border bg-card/40 px-4 py-6 text-sm text-muted-foreground">
                              This file is no longer available in the workspace. It may have been deleted or moved.
                            </div>
                          ) : workspaceSelectionIsDeleted ? (
                            <div className="rounded-xl border border-border bg-card/40 px-4 py-6 text-sm text-muted-foreground">
                              Deleted files can only be previewed in diff mode.
                            </div>
                          ) : workspaceFileContent?.status === "available" &&
                            workspaceFileContent.isBinary ? (
                            <div className="rounded-xl border border-border bg-card/40 px-4 py-6 text-sm text-muted-foreground">
                              Binary files cannot be previewed here.
                            </div>
                          ) : (
                            <CodeSnippet
                              code={
                                workspaceFileContent?.status === "available"
                                  ? workspaceFileContent.content
                                  : ""
                              }
                              language={workspacePreviewLanguage}
                              className="[&>pre]:border [&>pre]:border-border [&>pre]:bg-muted/20"
                            />
                          )
                        ) : (
                          <div className="rounded-xl border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">
                            Select a changed file or browse the workspace tree.
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="md:hidden h-full min-h-0 flex flex-col">
                      {workspaceMobilePane === "navigator" ? (
                        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
                          <div className="rounded-xl border border-border bg-card/50 p-3 space-y-2">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="font-medium truncate">{selectedThreadWorkspaceLabel}</div>
                                <div className="text-xs text-muted-foreground break-all">{selectedThreadWorkspacePath}</div>
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-8 shrink-0 rounded-full px-3"
                                onClick={() => {
                                  if (workspaceSelectedPath) {
                                    setWorkspaceMobilePane("viewer");
                                  }
                                }}
                                disabled={workspaceSelectedPath === null}
                              >
                                Open
                              </Button>
                            </div>
                            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                              <span>Branch: {workspaceGitStatus?.branch ?? "unknown"}</span>
                              <span>Changed: {workspaceGitStatus?.files.length ?? 0}</span>
                              <span>
                                Viewing: {workspaceEntriesState?.path ?? selectedThreadWorkspacePath}
                              </span>
                            </div>
                          </div>
                          <div className="rounded-xl border border-border overflow-hidden">
                            <div className="px-3 py-2 border-b border-border bg-muted/30 text-xs font-medium">Changed Files</div>
                            {workspaceGitStatus?.files.length ? workspaceGitStatus.files.map((file) => (
                              <Button
                                key={file.path}
                                type="button"
                                variant="ghost"
                                className={`h-auto w-full rounded-none justify-start px-3 py-2 text-left ${workspaceSelectedPath === file.path ? "bg-muted" : ""}`}
                                onClick={() => {
                                  setWorkspaceSelectedPath(file.path);
                                  setWorkspaceSelectedMode(workspacePreferredMode(file));
                                  setWorkspaceMobilePane("viewer");
                                }}
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="truncate font-mono text-xs">{basenameFromPath(file.path)}</div>
                                  <div className="truncate text-[11px] text-muted-foreground">{workspaceStatusLabel(file.unstagedStatus ?? file.stagedStatus)}</div>
                                </div>
                              </Button>
                            )) : <div className="px-3 py-3 text-xs text-muted-foreground">No changed files</div>}
                          </div>
                          <div className="rounded-xl border border-border overflow-hidden">
                            <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-muted/30">
                              <span className="text-xs font-medium">Files</span>
                              <div className="flex items-center gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 rounded-lg px-2"
                                  disabled={workspaceParentPath === null}
                                  onClick={() => {
                                    if (!workspaceParentPath) {
                                      return;
                                    }
                                    setWorkspaceEntriesPath(workspaceParentPath);
                                  }}
                                >
                                  Up
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 rounded-lg px-2"
                                  onClick={() => {
                                    if (!selectedThreadWorkspacePath) {
                                      return;
                                    }
                                    setWorkspaceEntriesPath(selectedThreadWorkspacePath);
                                  }}
                                >
                                  Root
                                </Button>
                              </div>
                            </div>
                            <div className="px-3 py-2 text-[11px] text-muted-foreground border-b border-border truncate">
                              {workspaceEntriesState?.path ?? selectedThreadWorkspacePath}
                            </div>
                            {workspaceEntriesState?.entries.length ? workspaceEntriesState.entries.map((entry) => (
                              <Button
                                key={entry.path}
                                type="button"
                                variant="ghost"
                                className={`h-auto w-full rounded-none justify-start gap-2 px-3 py-2 text-left ${workspaceSelectedPath === entry.path ? "bg-muted" : ""}`}
                                onClick={() => {
                                  if (entry.kind === "directory") {
                                    setWorkspaceEntriesPath(entry.path);
                                    return;
                                  }
                                  setWorkspaceSelectedPath(entry.path);
                                  setWorkspaceSelectedMode("file");
                                  setWorkspaceMobilePane("viewer");
                                }}
                              >
                                {entry.kind === "directory" ? (
                                  <FolderOpen size={13} />
                                ) : (
                                  <FileText size={13} />
                                )}
                                <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.name}</span>
                              </Button>
                            )) : (
                              <div className="px-3 py-3 text-xs text-muted-foreground">No files</div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
                          <div className="flex items-center justify-between gap-2">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="rounded-full"
                              onClick={() => setWorkspaceMobilePane("navigator")}
                            >
                              Back
                            </Button>
                            <div className="flex items-center gap-1">
                              <Button
                                type="button"
                                variant={workspaceSelectedMode === "diff" ? "secondary" : "ghost"}
                                size="sm"
                                className="rounded-full"
                                disabled={!workspaceSelectionSupportsDiff}
                                onClick={() => setWorkspaceSelectedMode("diff")}
                              >
                                Diff
                              </Button>
                              <Button
                                type="button"
                                variant={workspaceSelectedMode === "file" ? "secondary" : "ghost"}
                                size="sm"
                                className="rounded-full"
                                onClick={() => setWorkspaceSelectedMode("file")}
                              >
                                File
                              </Button>
                            </div>
                          </div>
                          <div>
                            <div className="font-medium truncate">{workspaceSelectedPath ? basenameFromPath(workspaceSelectedPath) : "Select a file"}</div>
                            <div className="text-xs text-muted-foreground break-all">{workspaceSelectedPath ?? "No file selected"}</div>
                          </div>
                          <div className="grid gap-2 grid-cols-2">
                            <div className="rounded-xl border border-border bg-card/40 px-3 py-2">
                              <div className="text-[11px] text-muted-foreground">Branch</div>
                              <div className="truncate text-sm font-medium">
                                {workspaceGitStatus?.branch ?? "unknown"}
                              </div>
                            </div>
                            <div className="rounded-xl border border-border bg-card/40 px-3 py-2">
                              <div className="text-[11px] text-muted-foreground">Selection</div>
                              <div className="truncate text-sm font-medium">
                                {workspaceSelectedStatusLabel ?? "Browsing files"}
                              </div>
                            </div>
                          </div>
                          {isWorkspaceContentLoading && (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                              <Loader2 size={14} className="animate-spin" />
                              Loading file…
                            </div>
                          )}
                          {workspaceSelectedPath ? (
                            workspaceSelectedMode === "diff" ? (
                              workspaceGitDiff?.diff ? (
                                <DiffBlock
                                  layout="split"
                                  changes={[
                                    {
                                      path: workspaceSelectedPath,
                                      kind: workspaceDiffKind(workspaceSelectedGitFile),
                                      diff: workspaceGitDiff.diff,
                                    },
                                  ]}
                                />
                              ) : (
                                <div className="rounded-xl border border-border bg-card/40 px-4 py-6 text-sm text-muted-foreground">No diff available for this file.</div>
                              )
                            ) : workspaceSelectionIsImage && workspaceRawFileUrl ? (
                              <div className="rounded-xl border border-border bg-card/30 p-3">
                                <img
                                  src={workspaceRawFileUrl}
                                  alt={basenameFromPath(workspaceSelectedPath)}
                                  className="max-h-[70vh] w-full rounded-lg object-contain"
                                  loading="lazy"
                                />
                              </div>
                            ) : workspaceSelectedFileMissing ? (
                              <div className="rounded-xl border border-border bg-card/40 px-4 py-6 text-sm text-muted-foreground">This file is no longer available in the workspace. It may have been deleted or moved.</div>
                            ) : workspaceSelectionIsDeleted ? (
                              <div className="rounded-xl border border-border bg-card/40 px-4 py-6 text-sm text-muted-foreground">Deleted files can only be previewed in diff mode.</div>
                            ) : workspaceFileContent?.status === "available" &&
                              workspaceFileContent.isBinary ? (
                              <div className="rounded-xl border border-border bg-card/40 px-4 py-6 text-sm text-muted-foreground">Binary files cannot be previewed here.</div>
                            ) : (
                              <CodeSnippet code={workspaceFileContent?.status === "available" ? workspaceFileContent.content : ""} language={workspacePreviewLanguage} className="[&>pre]:border [&>pre]:border-border [&>pre]:bg-muted/20" />
                            )
                          ) : (
                            <div className="rounded-xl border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">Select a file first.</div>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ── Debug tab ─────────────────────────────────────── */}
            {activeTab === "debug" && (
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                <div className="flex-1 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_300px] min-h-0 divide-y md:divide-y-0 md:divide-x divide-border overflow-hidden">
                  {/* Left: History */}
                  <div className="flex flex-col min-h-0 overflow-hidden">
                    <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
                      <Activity size={13} className="text-muted-foreground" />
                      <span className="text-sm font-medium">History</span>
                      <span className="text-xs text-muted-foreground/60">
                        {history.length} entries
                      </span>
                    </div>

                    <div className="flex-1 grid grid-cols-[200px_minmax(0,1fr)] min-h-0 divide-x divide-border overflow-hidden">
                      {/* Entry list */}
                      <div className="overflow-y-auto py-1">
                        {reversedHistory.map((entry) => (
                          <Button
                            key={entry.id}
                            type="button"
                            onClick={() => setSelectedHistoryId(entry.id)}
                            variant="ghost"
                            className={`w-full h-auto flex-col items-start justify-start gap-0 rounded-none px-3 py-2 text-left transition-colors ${
                              selectedHistoryId === entry.id
                                ? "bg-muted text-foreground"
                                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                            }`}
                          >
                            <div className="flex items-center gap-1.5 mb-0.5">
                              <span
                                className={`text-[9px] px-1.5 py-0.5 rounded font-mono uppercase leading-4 ${
                                  entry.direction === "in"
                                    ? "bg-success/15 text-success"
                                    : entry.direction === "out"
                                      ? "bg-blue-500/15 text-blue-400"
                                      : "bg-muted text-muted-foreground"
                                }`}
                              >
                                {entry.source} {entry.direction}
                              </span>
                            </div>
                            <div className="text-[10px] text-muted-foreground/50 font-mono truncate">
                              {entry.at}
                            </div>
                          </Button>
                        ))}
                      </div>

                      {/* Payload detail */}
                      <div className="overflow-y-auto p-3 space-y-3">
                        {!historyDetail ? (
                          <div className="text-xs text-muted-foreground py-4">
                            Select an entry
                          </div>
                        ) : (
                          <CodeSnippet
                            code={historyDetail.fullPayloadJson}
                            language="json"
                            className="[&>pre]:border [&>pre]:border-border [&>pre]:bg-muted/20 [&>pre]:text-[11px] [&>pre]:leading-5"
                          />
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Right: Trace + Stream Events */}
                  <div className="flex flex-col min-h-0 overflow-hidden divide-y divide-border">
                    {/* Trace controls */}
                    <div className="p-4 space-y-3 shrink-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">Trace</span>
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                            traceStatus?.active
                              ? "bg-success/15 text-success"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {traceStatus?.active ? "recording" : "idle"}
                        </span>
                      </div>
                      <Input
                        value={traceLabel}
                        onChange={(e) => setTraceLabel(e.target.value)}
                        placeholder="label"
                        className="h-7 text-base md:text-xs"
                      />
                      <Input
                        value={traceNote}
                        onChange={(e) => setTraceNote(e.target.value)}
                        placeholder="marker note"
                        className="h-7 text-base md:text-xs"
                      />
                      <div className="flex gap-1.5">
                        {(["Start", "Mark", "Stop"] as const).map((btn) => (
                          <Button
                            key={btn}
                            type="button"
                            onClick={() => {
                              const action =
                                btn === "Start"
                                  ? startTrace(traceLabel)
                                  : btn === "Mark"
                                    ? markTrace(traceNote)
                                    : stopTrace();
                              void action.then(refreshAll);
                            }}
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                          >
                            {btn}
                          </Button>
                        ))}
                      </div>
                    </div>

                    {/* Stream events */}
                    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
                        <span className="text-xs font-medium">
                          Stream Events
                        </span>
                        <span className="text-xs text-muted-foreground/60">
                          {streamEvents.length}
                        </span>
                      </div>
                      <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
                        {streamEvents
                          .slice()
                          .reverse()
                          .map((evt, i) => (
                            <StreamEventCard key={i} event={evt} />
                          ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <AnimatePresence>
        {isNewThreadModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[1px] p-4 md:p-8 flex items-center justify-center"
            onClick={() => setIsNewThreadModalOpen(false)}
          >
            <motion.div
              initial={{ scale: 0.98, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.98, opacity: 0 }}
              transition={{ duration: 0.16 }}
              onClick={(event) => event.stopPropagation()}
              className="w-full max-w-xl rounded-xl border border-border bg-background shadow-2xl overflow-hidden"
            >
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <div>
                  <div className="text-sm font-semibold">New Thread</div>
                  <div className="text-xs text-muted-foreground">
                    Choose the server, agent, and working directory.
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setIsNewThreadModalOpen(false)}
                  title="Close new thread"
                >
                  <X size={14} />
                </Button>
              </div>

              <div className="p-4 space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Server</Label>
                  <Select
                    value={newThreadModalState.serverId}
                    onValueChange={(value) => {
                      setNewThreadModalState((previous) => ({
                        ...previous,
                        serverId: value,
                      }));
                    }}
                  >
                    <SelectTrigger className="h-9 text-sm">
                      <SelectValue placeholder="Choose server" />
                    </SelectTrigger>
                    <SelectContent>
                      {serverTargets.map((target) => (
                        <SelectItem key={target.id} value={target.id}>
                          {target.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Agent</Label>
                  <Select
                    value={newThreadModalState.agentId}
                    onValueChange={(value) => {
                      const nextAgentId = parseAgentId(value);
                      if (!nextAgentId) {
                        return;
                      }
                      setNewThreadModalState((previous) => ({
                        ...previous,
                        agentId: nextAgentId,
                      }));
                    }}
                    disabled={isLoadingNewThreadAgents}
                  >
                    <SelectTrigger className="h-9 text-sm">
                      <SelectValue placeholder="Choose agent" />
                    </SelectTrigger>
                    <SelectContent>
                      {newThreadModalAgents
                        .filter((agent) => agent.enabled)
                        .map((agent) => (
                          <SelectItem key={agent.id} value={agent.id}>
                            <span className="flex items-center gap-2">
                              <span className="shrink-0 h-4 w-4 rounded-sm bg-muted/30 ring-1 ring-border/60 flex items-center justify-center overflow-hidden">
                                <AgentFavicon
                                  agentId={agent.id}
                                  label={agent.label}
                                  className="h-3.5 w-3.5"
                                />
                              </span>
                              <span>{agent.label}</span>
                            </span>
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">
                    Working Directory
                  </Label>
                  <Input
                    list="new-thread-project-directories"
                    value={newThreadModalState.projectPath}
                    onChange={(event) => {
                      setNewThreadModalState((previous) => ({
                        ...previous,
                        projectPath: event.target.value,
                      }));
                    }}
                    placeholder="/srv/project or ./relative/path"
                    className="h-9 text-sm"
                  />
                  <datalist id="new-thread-project-directories">
                    {newThreadProjectDirectorySuggestions.map((directory) => (
                      <option key={directory} value={directory} />
                    ))}
                  </datalist>
                  <div className="text-xs text-muted-foreground">
                    Existing directories appear as suggestions. You can also type
                    a new path.
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium">
                      Browse Directories
                    </Label>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-7 px-2 text-[11px]"
                        disabled={
                          isLoadingDirectoryBrowser ||
                          directoryBrowserState?.parentPath === null
                        }
                        onClick={() => {
                          if (!directoryBrowserState?.parentPath) {
                            return;
                          }
                          void browseDirectory(directoryBrowserState.parentPath);
                        }}
                      >
                        Up
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => {
                          void browseDirectory(
                            newThreadModalState.projectPath.trim() || undefined,
                          );
                        }}
                        disabled={isLoadingDirectoryBrowser}
                      >
                        Browse Path
                      </Button>
                    </div>
                  </div>

                  <div className="rounded-lg border border-border">
                    <div className="border-b border-border px-3 py-2 text-[11px] text-muted-foreground break-all">
                      {directoryBrowserState?.path ?? "No directory loaded"}
                    </div>
                    <div className="max-h-48 overflow-y-auto">
                      {isLoadingDirectoryBrowser ? (
                        <div className="px-3 py-4 text-xs text-muted-foreground">
                          Loading directories...
                        </div>
                      ) : directoryBrowserState?.entries.length ? (
                        directoryBrowserState.entries.map((entry) => (
                          <div
                            key={entry.path}
                            className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2 last:border-b-0"
                          >
                            <button
                              type="button"
                              className="min-w-0 flex-1 truncate text-left text-sm text-foreground hover:text-primary"
                              onClick={() => {
                                void browseDirectory(entry.path);
                              }}
                            >
                              {entry.name}
                            </button>
                            <Button
                              type="button"
                              variant="outline"
                              className="h-7 px-2 text-[11px]"
                              onClick={() => {
                                useBrowsedDirectoryForNewThread(entry.path);
                              }}
                            >
                              Use
                            </Button>
                          </div>
                        ))
                      ) : (
                        <div className="px-3 py-4 text-xs text-muted-foreground">
                          No subdirectories found.
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={
                      isCreatingDirectory ||
                      newThreadModalState.projectPath.trim().length === 0
                    }
                    onClick={() => {
                      void createDirectoryForNewThread();
                    }}
                  >
                    Create Directory
                  </Button>
                  <Button
                    type="button"
                    className="h-8 text-xs"
                    disabled={
                      isBusy ||
                      isLoadingNewThreadAgents ||
                      newThreadModalState.projectPath.trim().length === 0
                    }
                    onClick={() => {
                      void submitNewThreadModal();
                    }}
                  >
                    Create Thread
                  </Button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
        {isSettingsModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[1px] p-4 md:p-8 flex items-center justify-center"
            onClick={() => setIsSettingsModalOpen(false)}
          >
            <motion.div
              initial={{ scale: 0.98, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.98, opacity: 0 }}
              transition={{ duration: 0.16 }}
              onClick={(event) => event.stopPropagation()}
              className="w-full max-w-xl rounded-xl border border-border bg-background shadow-2xl overflow-hidden"
            >
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <div>
                  <div className="text-sm font-semibold">Settings</div>
                  <div className="text-xs text-muted-foreground">
                    Configure how this frontend connects to your server.
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setIsSettingsModalOpen(false)}
                  title="Close settings"
                >
                  <X size={14} />
                </Button>
              </div>

              <div className="p-4 space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Saved Servers</Label>
                  <div className="text-xs text-muted-foreground">
                    Aggregate thread lists from multiple Chresmus servers.
                  </div>
                  <div className="space-y-2">
                    {savedServerTargets.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                        No saved servers yet.
                      </div>
                    ) : (
                      savedServerTargets.map((target) => (
                        <div
                          key={target.id}
                          className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">
                                {target.label}
                              </span>
                              {primaryServerTargetId === target.id && (
                                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                                  Default
                                </span>
                              )}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {target.baseUrl}
                            </div>
                          </div>
                          <div className="flex shrink-0 gap-1">
                            <Button
                              type="button"
                              variant="outline"
                              className="h-7 px-2 text-[11px]"
                              onClick={() => {
                                void setPrimarySavedServerTarget(target.id);
                              }}
                            >
                              Set default
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              className="h-7 px-2 text-[11px]"
                              onClick={() => {
                                editServerTarget(target);
                              }}
                            >
                              Edit
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              className="h-7 px-2 text-[11px]"
                              onClick={() => {
                                void deleteServerTarget(target.id);
                              }}
                            >
                              Delete
                            </Button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Label</Label>
                  <Input
                    value={serverLabelDraft}
                    onChange={(e) => setServerLabelDraft(e.target.value)}
                    placeholder="Workstation"
                    className="h-9 text-sm"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Server URL</Label>
                  <Input
                    value={serverBaseUrlDraft}
                    onChange={(e) => setServerBaseUrlDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void saveServerTarget();
                      }
                    }}
                    placeholder="https://your-vpn-server.example.com"
                    className="h-9 text-sm"
                  />
                </div>

                <div className="flex gap-2">
                  <Button
                    type="button"
                    onClick={() => {
                      void saveServerTarget();
                    }}
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={
                      serverLabelDraft.trim().length === 0 ||
                      serverBaseUrlDraft.trim().length === 0 ||
                      !hasServerBaseUrlDraftChanges
                    }
                  >
                    {editingServerTarget ? "Update" : "Save"}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => {
                      setEditingServerTargetId(null);
                      setServerLabelDraft("");
                      setServerBaseUrlDraft("");
                    }}
                    variant="outline"
                    className="h-8 text-xs"
                  >
                    New
                  </Button>
                  <Button
                    type="button"
                    onClick={() => {
                      void useDefaultServerTarget();
                    }}
                    variant="outline"
                    className="h-8 text-xs"
                  >
                    Use automatic
                  </Button>
                </div>

                <div className="text-xs text-muted-foreground break-all">
                  Default server: {primaryServerTarget?.baseUrl ?? serverBaseUrl}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </TooltipProvider>
  );
}

export default App;
