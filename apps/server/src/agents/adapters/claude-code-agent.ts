import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  AppServerCollaborationModeListResponseSchema,
  AppServerListModelsResponseSchema,
  AppServerThreadListItemSchema,
  type ClientEventEnvelope,
  ThreadConversationStateSchema,
  parseThreadConversationState,
  type ThreadConversationState,
} from "@chresmus/protocol";
import { z } from "zod";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentCreateThreadInput,
  AgentCreateThreadResult,
  AgentInterruptInput,
  AgentListThreadsInput,
  AgentListThreadsResult,
  AgentReadThreadInput,
  AgentReadThreadResult,
  AgentSendMessageInput,
  AgentSetCollaborationModeInput,
  AgentThreadLiveState,
  AgentThreadStreamEvents,
} from "../types.js";

const ClaudeCliJsonOutputSchema = z
  .object({
    result: z.string(),
    session_id: z.string().min(1).optional(),
  })
  .passthrough();

const ClaudeThreadStoreSchema = z
  .object({
    version: z.literal(1),
    threads: z.array(ThreadConversationStateSchema),
  })
  .strict();

type ClaudeThreadStore = z.infer<typeof ClaudeThreadStoreSchema>;

interface RunningClaudeProcess {
  child: ChildProcessWithoutNullStreams;
  interrupted: boolean;
}

const CLAUDE_OWNER_CLIENT_ID = "claude-cli";
const MAX_STREAM_EVENTS = 400;

const CLAUDE_MODEL_OPTIONS = [
  {
    id: "default",
    displayName: "Claude Default",
    description: "Use Claude Code default model selection.",
    isDefault: true,
  },
  {
    id: "best",
    displayName: "Claude Best",
    description: "Ask Claude Code to select its best available model.",
  },
  {
    id: "sonnet",
    displayName: "Claude Sonnet",
    description: "Balanced Claude Sonnet alias.",
  },
  {
    id: "opus",
    displayName: "Claude Opus",
    description: "Higher-capability Claude Opus alias.",
  },
  {
    id: "haiku",
    displayName: "Claude Haiku",
    description: "Lower-latency Claude Haiku alias.",
  },
  {
    id: "sonnet[1m]",
    displayName: "Claude Sonnet 1M",
    description: "Claude Sonnet alias with 1M context.",
  },
  {
    id: "opus[1m]",
    displayName: "Claude Opus 1M",
    description: "Claude Opus alias with 1M context.",
  },
  {
    id: "opusplan",
    displayName: "Claude Opus Plan",
    description: "Plan-oriented Claude Opus alias.",
  },
] as const;

const CLAUDE_COLLABORATION_MODES = [
  {
    name: "Default",
    mode: "default",
    model: null,
    reasoning_effort: "medium",
    developer_instructions: null,
  },
  {
    name: "Plan",
    mode: "plan",
    model: "opusplan",
    reasoning_effort: "high",
    developer_instructions:
      "Work plan-first, then execute after the plan is clear.",
  },
] as const;

export interface ClaudeCodeAgentOptions {
  executablePath: string;
  workspaceDir: string;
  permissionMode?: string;
}

export class ClaudeCodeAgentAdapter implements AgentAdapter {
  public readonly id = "claude";
  public readonly label = "Claude Code";
  public readonly capabilities: AgentCapabilities = {
    canListModels: true,
    canListCollaborationModes: true,
    canSetCollaborationMode: true,
    canSubmitUserInput: false,
    canReadLiveState: true,
    canReadStreamEvents: true,
    canReadRateLimits: false,
  };

  private readonly executablePath: string;
  private readonly workspaceDir: string;
  private readonly permissionMode: string;
  private readonly storePath: string;
  private readonly threadById = new Map<string, ThreadConversationState>();
  private readonly streamEventsByThreadId = new Map<string, ClientEventEnvelope[]>();
  private readonly streamVersionByThreadId = new Map<string, number>();
  private readonly runningProcessByThreadId = new Map<string, RunningClaudeProcess>();
  private connected = false;
  private lastError: string | null = null;

  public constructor(options: ClaudeCodeAgentOptions) {
    this.executablePath = options.executablePath;
    this.workspaceDir = options.workspaceDir;
    this.permissionMode = options.permissionMode ?? "bypassPermissions";
    this.storePath = path.join(
      this.workspaceDir,
      ".chresmus",
      "claude-code-threads.json",
    );
  }

  public getLastError(): string | null {
    return this.lastError;
  }

  public isEnabled(): boolean {
    return true;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public async start(): Promise<void> {
    this.loadStore();
    this.verifyExecutable();
  }

  public async stop(): Promise<void> {
    for (const running of this.runningProcessByThreadId.values()) {
      running.interrupted = true;
      running.child.kill("SIGTERM");
    }
    this.runningProcessByThreadId.clear();
    this.connected = false;
  }

  public async listThreads(
    input: AgentListThreadsInput,
  ): Promise<AgentListThreadsResult> {
    this.ensureConnected();

    const offset = parseCursorOffset(input.cursor);
    const sortedThreads = Array.from(this.threadById.values()).sort(
      compareThreadsByUpdatedAtDescending,
    );
    const page = sortedThreads.slice(offset, offset + input.limit);
    const nextOffset = offset + page.length;
    const nextCursor =
      nextOffset < sortedThreads.length ? String(nextOffset) : null;

    return {
      data: page.map((thread) =>
        AppServerThreadListItemSchema.parse(buildThreadListItem(thread)),
      ),
      nextCursor,
    };
  }

  public async createThread(
    input: AgentCreateThreadInput,
  ): Promise<AgentCreateThreadResult> {
    this.ensureConnected();

    const now = nowSeconds();
    const threadId = randomUUID();
    const thread = parseThreadConversationState({
      id: threadId,
      turns: [],
      requests: [],
      createdAt: now,
      updatedAt: now,
      title: null,
      ...(input.model ? { latestModel: input.model } : {}),
      ...(input.cwd ? { cwd: normalizeDirectoryInput(input.cwd) } : {}),
      source: "claude",
    });

    this.setThread(thread);

    const threadListItem = AppServerThreadListItemSchema.parse(
      buildThreadListItem(thread),
    );

    return {
      threadId,
      thread: threadListItem,
      ...(thread.cwd ? { cwd: thread.cwd } : {}),
      ...(thread.latestModel ? { model: thread.latestModel } : {}),
    };
  }

  public async readThread(
    input: AgentReadThreadInput,
  ): Promise<AgentReadThreadResult> {
    this.ensureConnected();
    const thread = this.getThread(input.threadId);
    return {
      thread,
    };
  }

  public async listModels(limit: number) {
    this.ensureConnected();
    return AppServerListModelsResponseSchema.parse({
      data: CLAUDE_MODEL_OPTIONS.slice(0, Math.max(1, limit)).map((model) => ({
        id: model.id,
        model: model.id,
        displayName: model.displayName,
        description: model.description,
        hidden: false,
        isDefault: model.id === "default",
        inputModalities: ["text"],
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Low effort" },
          { reasoningEffort: "medium", description: "Medium effort" },
          { reasoningEffort: "high", description: "High effort" },
          { reasoningEffort: "xhigh", description: "Max effort" },
        ],
        defaultReasoningEffort: "medium",
        supportsPersonality: false,
        upgrade: null,
      })),
      nextCursor: null,
    });
  }

  public async listCollaborationModes() {
    this.ensureConnected();
    return AppServerCollaborationModeListResponseSchema.parse({
      data: CLAUDE_COLLABORATION_MODES,
    });
  }

  public async setCollaborationMode(
    input: AgentSetCollaborationModeInput,
  ): Promise<{ ownerClientId: string }> {
    this.ensureConnected();
    const thread = this.getThread(input.threadId);
    const nextThread = parseThreadConversationState({
      ...thread,
      latestCollaborationMode: input.collaborationMode,
      ...(input.collaborationMode.settings.model !== undefined
        ? { latestModel: input.collaborationMode.settings.model }
        : {}),
      ...(input.collaborationMode.settings.reasoning_effort !== undefined
        ? {
            latestReasoningEffort:
              input.collaborationMode.settings.reasoning_effort,
          }
        : {}),
    });
    this.setThread(nextThread);
    return {
      ownerClientId: CLAUDE_OWNER_CLIENT_ID,
    };
  }

  public async readLiveState(threadId: string): Promise<AgentThreadLiveState> {
    this.ensureConnected();
    return {
      ownerClientId: CLAUDE_OWNER_CLIENT_ID,
      conversationState: this.getThread(threadId),
      liveStateError: null,
    };
  }

  public async readStreamEvents(
    threadId: string,
    limit: number,
  ): Promise<AgentThreadStreamEvents> {
    this.ensureConnected();
    const events = this.streamEventsByThreadId.get(threadId) ?? [];
    return {
      ownerClientId: CLAUDE_OWNER_CLIENT_ID,
      events: events.slice(-Math.max(1, limit)),
    };
  }

  public async listProjectDirectories(): Promise<string[]> {
    this.ensureConnected();
    const directories = new Set<string>([this.workspaceDir]);
    for (const thread of this.threadById.values()) {
      if (thread.cwd) {
        directories.add(thread.cwd);
      }
    }
    return Array.from(directories).filter((directory) =>
      fs.existsSync(directory),
    );
  }

  public async sendMessage(input: AgentSendMessageInput): Promise<void> {
    this.ensureConnected();
    if (input.parts.some((part) => part.type === "image")) {
      throw new Error("Claude Code does not support image messages");
    }
    if (this.runningProcessByThreadId.has(input.threadId)) {
      throw new Error(`Claude Code thread ${input.threadId} is already running`);
    }

    const thread = this.getThread(input.threadId);
    const text = input.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text.length === 0) {
      throw new Error("Message text is required");
    }

    const cwd = input.cwd
      ? normalizeDirectoryInput(input.cwd)
      : thread.cwd
        ? normalizeDirectoryInput(thread.cwd)
        : this.workspaceDir;
    const startedAtMs = Date.now();
    const turnId = randomUUID();
    const updatedThread = parseThreadConversationState({
      ...thread,
      cwd,
      updatedAt: Math.floor(startedAtMs / 1000),
      title: thread.title ?? summarizeText(text),
      turns: [
        ...thread.turns,
        {
          id: turnId,
          turnId,
          status: "in-progress",
          turnStartedAtMs: startedAtMs,
          items: [
            input.isSteering
              ? {
                  id: randomUUID(),
                  type: "steeringUserMessage",
                  content: input.parts
                    .filter((part) => part.type === "text")
                    .map((part) => ({
                      type: "text" as const,
                      text: part.text,
                    })),
                }
              : {
                  id: randomUUID(),
                  type: "userMessage",
                  content: input.parts
                    .filter((part) => part.type === "text")
                    .map((part) => ({
                      type: "text" as const,
                      text: part.text,
                    })),
                },
          ],
          ...(thread.latestModel ? { params: { threadId: thread.id, input: input.parts, model: thread.latestModel } } : { params: { threadId: thread.id, input: input.parts } }),
        },
      ],
      source: "claude",
    });

    this.setThread(updatedThread);

    try {
      const commandConfig = resolveClaudeCommandConfig(updatedThread);
      const output = await this.runClaudeCommand({
        threadId: thread.id,
        text,
        cwd,
        model: commandConfig.model,
        effort: commandConfig.effort,
        hasPriorTurns: thread.turns.length > 0,
      });
      const completedAtMs = Date.now();
      this.updateThreadTurn(thread.id, turnId, (currentTurn) => ({
        ...currentTurn,
        status: "completed",
        finalAssistantStartedAtMs: completedAtMs,
        items: [
          ...currentTurn.items,
          {
            id: randomUUID(),
            type: "agentMessage",
            text: output.result,
          },
        ],
      }));
      this.updateThreadMetadata(thread.id, {
        updatedAt: Math.floor(completedAtMs / 1000),
        ...(output.session_id ? { resumeState: output.session_id } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedAtMs = Date.now();
      this.updateThreadTurn(thread.id, turnId, (currentTurn) => ({
        ...currentTurn,
        status: "failed",
        items: [
          ...currentTurn.items,
          {
            id: randomUUID(),
            type: "error",
            message,
          },
        ],
      }));
      this.updateThreadMetadata(thread.id, {
        updatedAt: Math.floor(failedAtMs / 1000),
      });
      throw error;
    }
  }

  public async interrupt(input: AgentInterruptInput): Promise<void> {
    this.ensureConnected();
    const running = this.runningProcessByThreadId.get(input.threadId) ?? null;
    if (!running) {
      return;
    }
    running.interrupted = true;
    running.child.kill("SIGTERM");
  }

  private verifyExecutable(): void {
    const result = spawnSync(this.executablePath, ["--version"], {
      cwd: this.workspaceDir,
      encoding: "utf8",
    });

    if (result.error) {
      this.connected = false;
      this.lastError = result.error.message;
      throw result.error;
    }

    if (result.status !== 0) {
      this.connected = false;
      this.lastError = result.stderr.trim() || "Claude Code CLI is unavailable";
      throw new Error(this.lastError);
    }

    this.connected = true;
    this.lastError = null;
  }

  private loadStore(): void {
    const directory = path.dirname(this.storePath);
    fs.mkdirSync(directory, { recursive: true });
    if (!fs.existsSync(this.storePath)) {
      this.persistStore();
      return;
    }

    const raw = fs.readFileSync(this.storePath, "utf8");
    if (raw.trim().length === 0) {
      this.persistStore();
      return;
    }

    const parsed = ClaudeThreadStoreSchema.parse(JSON.parse(raw));
    this.threadById.clear();
    for (const thread of parsed.threads) {
      this.threadById.set(thread.id, thread);
      this.recordSnapshotEvent(thread);
    }
  }

  private persistStore(): void {
    const store: ClaudeThreadStore = {
      version: 1,
      threads: Array.from(this.threadById.values()).map((thread) =>
        parseThreadConversationState(thread),
      ),
    };
    fs.writeFileSync(this.storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error(this.lastError ?? "Claude Code CLI is not connected");
    }
  }

  private getThread(threadId: string): ThreadConversationState {
    const thread = this.threadById.get(threadId) ?? null;
    if (!thread) {
      throw new Error(`Claude Code thread ${threadId} was not found`);
    }
    return thread;
  }

  private setThread(thread: ThreadConversationState): void {
    this.threadById.set(thread.id, thread);
    this.persistStore();
    this.recordSnapshotEvent(thread);
  }

  private updateThreadTurn(
    threadId: string,
    turnId: string,
    update: (
      turn: ThreadConversationState["turns"][number],
    ) => ThreadConversationState["turns"][number],
  ): void {
    const thread = this.getThread(threadId);
    const nextTurns = thread.turns.map((turn) =>
      turn.id === turnId ? update(turn) : turn,
    );
    const nextThread = parseThreadConversationState({
      ...thread,
      turns: nextTurns,
    });
    this.setThread(nextThread);
  }

  private updateThreadMetadata(
    threadId: string,
    input: {
      updatedAt: number;
      resumeState?: string;
    },
  ): void {
    const thread = this.getThread(threadId);
    const nextThread = parseThreadConversationState({
      ...thread,
      updatedAt: input.updatedAt,
      ...(input.resumeState ? { resumeState: input.resumeState } : {}),
    });
    this.setThread(nextThread);
  }

  private async runClaudeCommand(input: {
    threadId: string;
    text: string;
    cwd: string;
    model: string | null;
    effort: string | null;
    hasPriorTurns: boolean;
  }): Promise<z.infer<typeof ClaudeCliJsonOutputSchema>> {
    const args = [
      "-p",
      input.text,
      "--output-format",
      "json",
      "--permission-mode",
      this.permissionMode,
      ...(input.effort ? ["--effort", normalizeClaudeEffort(input.effort)] : []),
      ...(input.hasPriorTurns
        ? ["--resume", input.threadId]
        : ["--session-id", input.threadId]),
      ...(input.model ? ["--model", input.model] : []),
    ];

    const child = spawn(this.executablePath, args, {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const running: RunningClaudeProcess = {
      child,
      interrupted: false,
    };
    this.runningProcessByThreadId.set(input.threadId, running);

    return await new Promise((resolve, reject) => {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      child.stdin.end();

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutChunks.push(chunk);
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrChunks.push(chunk);
      });

      child.on("error", (error) => {
        this.runningProcessByThreadId.delete(input.threadId);
        this.lastError = error.message;
        reject(error);
      });

      child.on("close", (code, signal) => {
        this.runningProcessByThreadId.delete(input.threadId);

        if (running.interrupted) {
          reject(new Error(`Claude Code thread ${input.threadId} was interrupted`));
          return;
        }

        if (code !== 0) {
          const stderr = stderrChunks.join("").trim();
          const signalText = signal ? ` (signal ${signal})` : "";
          const message =
            stderr.length > 0
              ? stderr
              : `Claude Code exited with status ${String(code)}${signalText}`;
          this.lastError = message;
          reject(new Error(message));
          return;
        }

        try {
          const parsed = ClaudeCliJsonOutputSchema.parse(
            JSON.parse(stdoutChunks.join("").trim()),
          );
          this.lastError = null;
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  private recordSnapshotEvent(thread: ThreadConversationState): void {
    const version = (this.streamVersionByThreadId.get(thread.id) ?? 0) + 1;
    this.streamVersionByThreadId.set(thread.id, version);
    const nextEvent: ClientEventEnvelope = {
      type: "broadcast",
      method: "thread-stream-state-changed",
      sourceClientId: CLAUDE_OWNER_CLIENT_ID,
      version,
      params: {
        type: "thread-stream-state-changed",
        conversationId: thread.id,
        version,
        change: {
          type: "snapshot",
          conversationState: thread,
        },
      },
    };
    const existing = this.streamEventsByThreadId.get(thread.id) ?? [];
    const nextEvents = [...existing, nextEvent].slice(-MAX_STREAM_EVENTS);
    this.streamEventsByThreadId.set(thread.id, nextEvents);
  }
}

function buildThreadListItem(
  thread: ThreadConversationState,
): {
  id: string;
  preview: string;
  title?: string | null;
  isGenerating?: boolean;
  createdAt: number;
  updatedAt: number;
  cwd?: string;
  source: "claude";
} {
  return {
    id: thread.id,
    preview: buildThreadPreview(thread),
    ...(thread.title !== undefined ? { title: thread.title } : {}),
    isGenerating: isThreadGenerating(thread),
    createdAt: thread.createdAt ?? nowSeconds(),
    updatedAt: thread.updatedAt ?? thread.createdAt ?? nowSeconds(),
    ...(thread.cwd ? { cwd: thread.cwd } : {}),
    source: "claude",
  };
}

function buildThreadPreview(thread: ThreadConversationState): string {
  const lastTurn = thread.turns[thread.turns.length - 1] ?? null;
  if (!lastTurn) {
    return "New Claude thread";
  }

  const lastAgentMessage = [...lastTurn.items]
    .reverse()
    .find((item) => item.type === "agentMessage");
  if (lastAgentMessage) {
    return summarizeText(lastAgentMessage.text);
  }

  const lastUserMessage = [...lastTurn.items]
    .reverse()
    .find(
      (item) =>
        item.type === "userMessage" || item.type === "steeringUserMessage",
    );
  if (!lastUserMessage) {
    return "New Claude thread";
  }

  return summarizeText(
    lastUserMessage.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  );
}

function isThreadGenerating(thread: ThreadConversationState): boolean {
  const lastTurn = thread.turns[thread.turns.length - 1] ?? null;
  return lastTurn?.status === "in-progress";
}

function summarizeText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 80) {
    return compact;
  }
  return `${compact.slice(0, 77).trimEnd()}...`;
}

function normalizeClaudeEffort(value: string): "low" | "medium" | "high" | "max" {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return "max";
}

function resolveClaudeCommandConfig(thread: ThreadConversationState): {
  model: string | null;
  effort: string | null;
} {
  const collaborationMode = thread.latestCollaborationMode ?? null;
  const settings = collaborationMode?.settings;
  const mode = collaborationMode?.mode ?? null;
  const modeModel =
    mode === "plan"
      ? "opusplan"
      : mode === "default" || mode === null
        ? null
        : mode;

  return {
    model: settings?.model ?? modeModel ?? thread.latestModel ?? null,
    effort:
      settings?.reasoning_effort ??
      thread.latestReasoningEffort ??
      null,
  };
}

function parseCursorOffset(cursor: string | null): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number(cursor);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid Claude cursor: ${cursor}`);
  }
  return parsed;
}

function compareThreadsByUpdatedAtDescending(
  left: ThreadConversationState,
  right: ThreadConversationState,
): number {
  const leftUpdatedAt = left.updatedAt ?? left.createdAt ?? 0;
  const rightUpdatedAt = right.updatedAt ?? right.createdAt ?? 0;
  return rightUpdatedAt - leftUpdatedAt;
}

function normalizeDirectoryInput(value: string): string {
  return path.resolve(value);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
