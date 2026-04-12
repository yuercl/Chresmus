import {
  AppServerClient,
  AppServerRpcError,
  AppServerTransportError,
  ChildProcessAppServerTransport,
  WebSocketAppServerTransport
} from "@chresmus/api";
import {
  parseCommandExecutionRequestApprovalResponse,
  parseFileChangeRequestApprovalResponse,
  parseThreadConversationState,
  parseToolRequestUserInputResponsePayload,
  parseUserInputResponsePayload,
  type AppServerGetAccountRateLimitsResponse,
  type AppServerServerRequest,
  type AppServerSupportedServerNotification,
  type ClientEventEnvelope,
  type ThreadConversationRequest,
  type ThreadConversationState,
  type UserInputRequestId
} from "@chresmus/protocol";
import { logger } from "../../logger.js";
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
  AgentSubmitUserInputInput,
  AgentThreadLiveState,
  AgentThreadStreamEvents
} from "../types.js";

type ThreadTurn = ThreadConversationState["turns"][number];
type ThreadItem = ThreadTurn["items"][number];
type AgentMessageItem = Extract<ThreadItem, { type: "agentMessage" }>;
type PlanItem = Extract<ThreadItem, { type: "plan" }>;
type ReasoningItem = Extract<ThreadItem, { type: "reasoning" }>;
type CommandExecutionItem = Extract<ThreadItem, { type: "commandExecution" }>;
type FileChangeItem = Extract<ThreadItem, { type: "fileChange" }> & {
  aggregatedOutput?: string;
};

const SERVER_OVERLOADED_ERROR_CODE = -32001;
const MAX_BACKPRESSURE_RETRIES = 4;
const BACKPRESSURE_BASE_DELAY_MS = 1_000;

export interface CodexAgentRuntimeState {
  appReady: boolean;
  transportConnected: boolean;
  transportInitialized: boolean;
  codexAvailable: boolean;
  lastError: string | null;
}

export interface CodexAppEvent {
  direction: "in";
  payload: AppServerServerRequest | AppServerSupportedServerNotification;
  method: string;
  threadId: string | null;
}

export interface CodexThreadRealtimeEvent {
  threadId: string;
  thread: ThreadConversationState;
}

export interface CodexThreadRealtimeDeltaEvent {
  threadId: string;
  notification: AppServerSupportedServerNotification;
  thread: ThreadConversationState;
}

export interface CodexAgentOptions {
  appExecutable: string;
  workspaceDir: string;
  userAgent: string;
  appServerUrl?: string;
  onStateChange?: () => void;
}

const ANSI_ESCAPE_REGEX = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const APP_SERVER_OWNER_CLIENT_ID = "app-server";
const MAX_STREAM_EVENTS = 400;

export function normalizeCodexRuntimeErrorMessage(message: string): string {
  const normalized = message.trim().toLowerCase();
  if (
    normalized.includes("authentication required") &&
    normalized.includes("read rate limits")
  ) {
    return "Rate limits unavailable until ChatGPT authentication is connected.";
  }

  return message;
}

export class CodexAgentAdapter implements AgentAdapter {
  public readonly id = "codex";
  public readonly label = "Codex";
  public readonly capabilities: AgentCapabilities = {
    canListModels: true,
    canListCollaborationModes: true,
    canSetCollaborationMode: false,
    canSubmitUserInput: true,
    canReadLiveState: true,
    canReadStreamEvents: true,
    canReadRateLimits: true
  };

  private readonly appClient: AppServerClient;
  private readonly onStateChange: (() => void) | null;

  private readonly threadOwnerById = new Map<string, string>();
  private readonly streamEventsByThreadId = new Map<string, ClientEventEnvelope[]>();
  private readonly streamSnapshotByThreadId = new Map<
    string,
    ThreadConversationState
  >();
  private readonly threadTitleById = new Map<string, string | null>();
  private readonly appEventListeners = new Set<(event: CodexAppEvent) => void>();
  private readonly realtimeThreadListeners = new Set<
    (event: CodexThreadRealtimeEvent) => void
  >();
  private readonly realtimeThreadDeltaListeners = new Set<
    (event: CodexThreadRealtimeDeltaEvent) => void
  >();

  private runtimeState: CodexAgentRuntimeState = {
    appReady: false,
    transportConnected: true,
    transportInitialized: true,
    codexAvailable: true,
    lastError: null
  };

  private bootstrapInFlight: Promise<void> | null = null;
  private started = false;

  public constructor(options: CodexAgentOptions) {
    this.onStateChange = options.onStateChange ?? null;

    this.appClient = new AppServerClient(
      options.appServerUrl
        ? new WebSocketAppServerTransport({
            url: options.appServerUrl,
            userAgent: options.userAgent
          })
        : new ChildProcessAppServerTransport({
            executablePath: options.appExecutable,
            userAgent: options.userAgent,
            cwd: options.workspaceDir,
            onStderr: (line) => {
              const normalized = normalizeStderrLine(line);
              logger.error({ line: normalized }, "codex-app-server-stderr");
            }
          })
    );

    this.appClient.onServerRequest((request) => {
      this.handleServerRequest(request);
    });
    this.appClient.onSupportedServerNotification((notification) => {
      this.handleSupportedServerNotification(notification);
    });
  }

  public onAppEvent(listener: (event: CodexAppEvent) => void): () => void {
    this.appEventListeners.add(listener);
    return () => {
      this.appEventListeners.delete(listener);
    };
  }

  public onRealtimeThreadUpdate(
    listener: (event: CodexThreadRealtimeEvent) => void
  ): () => void {
    this.realtimeThreadListeners.add(listener);
    return () => {
      this.realtimeThreadListeners.delete(listener);
    };
  }

  public onRealtimeThreadDelta(
    listener: (event: CodexThreadRealtimeDeltaEvent) => void
  ): () => void {
    this.realtimeThreadDeltaListeners.add(listener);
    return () => {
      this.realtimeThreadDeltaListeners.delete(listener);
    };
  }

  public getRuntimeState(): CodexAgentRuntimeState {
    return { ...this.runtimeState };
  }

  public getThreadOwnerCount(): number {
    return this.threadOwnerById.size;
  }

  public isEnabled(): boolean {
    return true;
  }

  public isConnected(): boolean {
    return this.runtimeState.codexAvailable && this.runtimeState.appReady;
  }

  public async start(): Promise<void> {
    this.started = true;
    await this.bootstrapConnections();
  }

  public async stop(): Promise<void> {
    this.started = false;
    await this.appClient.close();
  }

  public async listThreads(
    input: AgentListThreadsInput
  ): Promise<AgentListThreadsResult> {
    this.ensureCodexAvailable();

    const result = await this.runAppServerCall(() =>
      input.all
        ? this.appClient.listThreadsAll(
            input.cursor
              ? {
                  limit: input.limit,
                  archived: input.archived,
                  cursor: input.cursor,
                  maxPages: input.maxPages
                }
              : {
                  limit: input.limit,
                  archived: input.archived,
                  maxPages: input.maxPages
                }
          )
        : this.appClient.listThreads(
            input.cursor
              ? {
                  limit: input.limit,
                  archived: input.archived,
                  cursor: input.cursor
                }
              : {
                  limit: input.limit,
                  archived: input.archived
                }
          )
    );

    const data = result.data.map((thread) => {
      const title = this.resolveThreadTitle(thread.id, thread.title);
      const snapshot = this.streamSnapshotByThreadId.get(thread.id);
      const isGenerating = snapshot
        ? isThreadStateGenerating(snapshot)
        : undefined;
      const waitingState = snapshot ? deriveThreadWaitingState(snapshot) : null;
      const waitingFlags = waitingState
        ? {
            ...(waitingState.waitingOnApproval
              ? { waitingOnApproval: true }
              : {}),
            ...(waitingState.waitingOnUserInput
              ? { waitingOnUserInput: true }
              : {})
          }
        : {};

      if (title === undefined) {
        if (
          isGenerating === undefined &&
          Object.keys(waitingFlags).length === 0
        ) {
          return thread;
        }

        return {
          ...thread,
          ...(isGenerating !== undefined ? { isGenerating } : {}),
          ...waitingFlags
        };
      }

      return {
        ...thread,
        title,
        ...(isGenerating !== undefined ? { isGenerating } : {}),
        ...waitingFlags
      };
    });

    return {
      data,
      nextCursor: result.nextCursor ?? null,
      ...(typeof result.pages === "number" ? { pages: result.pages } : {}),
      ...(typeof result.truncated === "boolean"
        ? { truncated: result.truncated }
        : {})
    };
  }

  public async createThread(
    input: AgentCreateThreadInput
  ): Promise<AgentCreateThreadResult> {
    this.ensureCodexAvailable();

    const cwd = input.cwd;
    if (!cwd || cwd.trim().length === 0) {
      throw new Error("Codex thread creation requires cwd");
    }

    const result = await this.runAppServerCall(() =>
      this.appClient.startThread({
        cwd,
        ...(input.model ? { model: input.model } : {}),
        ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
        ...(input.personality ? { personality: input.personality } : {}),
        sandbox: input.sandbox ?? "danger-full-access",
        approvalPolicy: input.approvalPolicy ?? "never",
        ...(input.serviceName ? { serviceName: input.serviceName } : {}),
        ephemeral: input.ephemeral ?? false
      })
    );

    this.threadOwnerById.set(result.thread.id, APP_SERVER_OWNER_CLIENT_ID);
    this.setThreadTitle(result.thread.id, result.thread.title);

    return {
      threadId: result.thread.id,
      thread: result.thread,
      model: result.model,
      modelProvider: result.modelProvider,
      cwd: result.cwd,
      approvalPolicy: result.approvalPolicy,
      sandbox: result.sandbox,
      reasoningEffort: result.reasoningEffort
    };
  }

  public async readThread(
    input: AgentReadThreadInput
  ): Promise<AgentReadThreadResult> {
    this.ensureCodexAvailable();

    const readThreadWithOption = async (includeTurns: boolean) =>
      this.runAppServerCall(() =>
        this.appClient.readThread(input.threadId, includeTurns)
      );

    let result: Awaited<ReturnType<typeof readThreadWithOption>>;
    try {
      result = await readThreadWithOption(input.includeTurns);
    } catch (error) {
      const typedError = error instanceof Error ? error : null;
      const shouldTryResume =
        isThreadNotLoadedAppServerRpcError(typedError) ||
        (input.includeTurns &&
          (isThreadNotMaterializedIncludeTurnsAppServerRpcError(typedError) ||
            isThreadNoRolloutIncludeTurnsAppServerRpcError(typedError)));
      if (!shouldTryResume) {
        throw error;
      }

      try {
        await this.resumeThread(input.threadId);
        result = await readThreadWithOption(input.includeTurns);
      } catch (resumeRetryError) {
        const typedResumeRetryError =
          resumeRetryError instanceof Error ? resumeRetryError : null;
        const shouldRetryWithoutTurns =
          input.includeTurns &&
          (isThreadNotMaterializedIncludeTurnsAppServerRpcError(
            typedResumeRetryError
          ) ||
            isThreadNoRolloutIncludeTurnsAppServerRpcError(
              typedResumeRetryError
            ));
        if (!shouldRetryWithoutTurns) {
          throw resumeRetryError;
        }
        result = await readThreadWithOption(false);
      }
    }

    const parsedThread = parseThreadConversationState(result.thread);
    const existingSnapshot = this.streamSnapshotByThreadId.get(input.threadId);
    const shouldStoreSnapshot =
      input.includeTurns ||
      parsedThread.turns.length > 0 ||
      existingSnapshot === undefined;
    if (shouldStoreSnapshot) {
      this.storeSnapshot(input.threadId, parsedThread);
    } else {
      this.setThreadTitle(input.threadId, parsedThread.title);
    }

    return {
      thread: parsedThread
    };
  }

  public async sendMessage(input: AgentSendMessageInput): Promise<void> {
    this.ensureCodexAvailable();
    if (input.parts.length === 0) {
      throw new Error("Message input is required");
    }

    this.threadOwnerById.set(input.threadId, APP_SERVER_OWNER_CLIENT_ID);

    const sendTurn = async (): Promise<void> => {
      if (input.isSteering === true) {
        const activeTurnId = await this.getActiveTurnId(input.threadId);
        if (!activeTurnId) {
          throw new Error("Cannot steer because there is no active turn");
        }

        await this.appClient.steerTurn({
          threadId: input.threadId,
          expectedTurnId: activeTurnId,
          input: input.parts
        });
        return;
      }

      await this.appClient.startTurn({
        threadId: input.threadId,
        input: input.parts,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        attachments: []
      });
    };

    await this.runThreadOperationWithResumeRetry(input.threadId, sendTurn);
  }

  public async interrupt(input: AgentInterruptInput): Promise<void> {
    this.ensureCodexAvailable();

    const interruptTurn = async (): Promise<void> => {
      const activeTurnId = await this.getActiveTurnId(input.threadId);
      if (!activeTurnId) {
        return;
      }
      await this.appClient.interruptTurn(input.threadId, activeTurnId);
    };

    await this.runThreadOperationWithResumeRetry(input.threadId, interruptTurn);
  }

  public async listModels(limit: number) {
    this.ensureCodexAvailable();
    return this.runAppServerCall(() => this.appClient.listModels(limit));
  }

  public async listCollaborationModes() {
    this.ensureCodexAvailable();
    return this.runAppServerCall(() => this.appClient.listCollaborationModes());
  }

  public async readRateLimits(): Promise<AppServerGetAccountRateLimitsResponse> {
    this.ensureCodexAvailable();
    try {
      const result = await this.appClient.readAccountRateLimits();
      this.patchRuntimeState({
        appReady: true,
        lastError: null
      });
      return result;
    } catch (error) {
      if (
        isAuthenticationRequiredToReadRateLimitsAppServerRpcError(
          error instanceof Error ? error : null
        )
      ) {
        this.patchRuntimeState({
          appReady: true,
          lastError: null
        });
        return {
          rateLimits: {},
          rateLimitsByLimitId: null
        };
      }

      this.patchRuntimeState({
        appReady: !(error instanceof AppServerTransportError),
        lastError: normalizeCodexRuntimeErrorMessage(toErrorMessage(error))
      });
      throw error;
    }
  }

  public async submitUserInput(
    input: AgentSubmitUserInputInput
  ): Promise<{ ownerClientId: string; requestId: UserInputRequestId }> {
    this.ensureCodexAvailable();

    const parsedResponse = parseUserInputResponsePayload(input.response);
    const ownerClientId =
      this.threadOwnerById.get(input.threadId) ?? APP_SERVER_OWNER_CLIENT_ID;
    this.threadOwnerById.set(input.threadId, ownerClientId);

    const threadForRouting = await this.runThreadOperationWithResumeRetry(
      input.threadId,
      () => this.appClient.readThread(input.threadId, false)
    );
    const parsedRoutingThread = parseThreadConversationState(
      threadForRouting.thread
    );
    const routingPendingRequest = findPendingRequestWithId(
      parsedRoutingThread,
      input.requestId
    );
    if (!routingPendingRequest) {
      throw new Error(
        `Unable to find pending request ${String(input.requestId)} for thread ${input.threadId}`
      );
    }

    switch (routingPendingRequest.method) {
      case "item/commandExecution/requestApproval":
        parseCommandExecutionRequestApprovalResponse(parsedResponse);
        break;
      case "item/fileChange/requestApproval":
        parseFileChangeRequestApprovalResponse(parsedResponse);
        break;
      case "item/tool/requestUserInput":
        parseToolRequestUserInputResponsePayload(parsedResponse);
        break;
      case "execCommandApproval":
      case "applyPatchApproval":
      case "account/chatgptAuthTokens/refresh":
      case "item/tool/call":
      case "item/plan/requestImplementation":
        throw new Error(
          `Unsupported pending request method ${routingPendingRequest.method} for submitUserInput on thread ${input.threadId}`
        );
    }

    await this.runAppServerCall(() =>
      this.appClient.submitUserInput(input.requestId, parsedResponse)
    );

    const currentSnapshot = this.streamSnapshotByThreadId.get(input.threadId);
    if (currentSnapshot) {
      const updatedRequests = currentSnapshot.requests.map((request) =>
        requestIdsMatch(request.id, input.requestId)
          ? {
              ...request,
              completed: true
            }
          : request
      );
      this.storeSnapshot(input.threadId, {
        ...currentSnapshot,
        requests: updatedRequests
      });
      this.emitRealtimeThreadUpdate(input.threadId, this.getThreadState(input.threadId));
    }

    return {
      ownerClientId,
      requestId: input.requestId
    };
  }

  public async readLiveState(threadId: string): Promise<AgentThreadLiveState> {
    return {
      ownerClientId:
        this.threadOwnerById.get(threadId) ?? APP_SERVER_OWNER_CLIENT_ID,
      conversationState: this.streamSnapshotByThreadId.get(threadId) ?? null,
      liveStateError: null
    };
  }

  public async readStreamEvents(
    threadId: string,
    limit: number
  ): Promise<AgentThreadStreamEvents> {
    return {
      ownerClientId:
        this.threadOwnerById.get(threadId) ?? APP_SERVER_OWNER_CLIENT_ID,
      events: (this.streamEventsByThreadId.get(threadId) ?? []).slice(-limit)
    };
  }

  private handleServerRequest(request: AppServerServerRequest): void {
    const threadId = readThreadIdFromRequest(request);
    this.emitAppEvent({
      direction: "in",
      payload: request,
      method: request.method,
      threadId
    });

    if (!threadId) {
      return;
    }

    this.threadOwnerById.set(threadId, APP_SERVER_OWNER_CLIENT_ID);
    const current = this.getThreadState(threadId);
    const next = upsertThreadRequest(current, request);
    this.storeSnapshot(threadId, next);
    this.emitRealtimeThreadUpdate(threadId, next);
  }

  private handleSupportedServerNotification(
    notification: AppServerSupportedServerNotification
  ): void {
    const threadId = readThreadIdFromNotification(notification);
    this.emitAppEvent({
      direction: "in",
      payload: notification,
      method: notification.method,
      threadId
    });

    switch (notification.method) {
      case "thread/started": {
        const thread = parseThreadConversationState(notification.params.thread);
        this.threadOwnerById.set(thread.id, APP_SERVER_OWNER_CLIENT_ID);
        this.storeSnapshot(thread.id, thread);
        this.emitRealtimeThreadDelta(thread.id, notification, thread);
        return;
      }

      case "thread/name/updated": {
        const current = this.getThreadState(notification.params.threadId);
        this.storeSnapshot(notification.params.threadId, {
          ...current,
          title: notification.params.threadName ?? null
        });
        this.emitRealtimeThreadDelta(
          notification.params.threadId,
          notification,
          this.getThreadState(notification.params.threadId)
        );
        return;
      }

      case "thread/tokenUsage/updated": {
        const current = this.getThreadState(notification.params.threadId);
        this.storeSnapshot(notification.params.threadId, {
          ...current,
          latestTokenUsageInfo: notification.params.tokenUsage
        });
        this.emitRealtimeThreadDelta(
          notification.params.threadId,
          notification,
          this.getThreadState(notification.params.threadId)
        );
        return;
      }

      case "turn/started":
      case "turn/completed": {
        const current = this.getThreadState(notification.params.threadId);
        const next = upsertTurn(current, notification.params.turn);
        this.storeSnapshot(notification.params.threadId, next);
        this.emitRealtimeThreadDelta(notification.params.threadId, notification, next);
        return;
      }

      case "turn/diff/updated": {
        const current = this.getThreadState(notification.params.threadId);
        const next = updateTurnById(
          current,
          notification.params.turnId,
          (turn) => ({
            ...turn,
            diff: notification.params.diff
          }),
          () => ({
            id: notification.params.turnId,
            turnId: notification.params.turnId,
            status: "inProgress",
            items: [],
            diff: notification.params.diff
          })
        );
        this.storeSnapshot(notification.params.threadId, next);
        this.emitRealtimeThreadDelta(notification.params.threadId, notification, next);
        return;
      }

      case "turn/plan/updated": {
        const current = this.getThreadState(notification.params.threadId);
        const next = updateTurnById(
          current,
          notification.params.turnId,
          (turn) => upsertItemIntoTurn(turn, buildPlanSummaryItem(
            turn,
            notification.params.turnId,
            notification.params.explanation ?? null,
            notification.params.plan
          )),
          () => ({
            id: notification.params.turnId,
            turnId: notification.params.turnId,
            status: "inProgress",
            items: [
              buildPlanSummaryItem(
                null,
                notification.params.turnId,
                notification.params.explanation ?? null,
                notification.params.plan
              )
            ]
          })
        );
        this.storeSnapshot(notification.params.threadId, next);
        this.emitRealtimeThreadDelta(notification.params.threadId, notification, next);
        return;
      }

      case "item/started":
      case "item/completed": {
        const current = this.getThreadState(notification.params.threadId);
        const next = updateTurnById(
          current,
          notification.params.turnId,
          (turn) => upsertItemIntoTurn(turn, notification.params.item),
          () => ({
            id: notification.params.turnId,
            turnId: notification.params.turnId,
            status: "inProgress",
            items: [notification.params.item]
          })
        );
        this.storeSnapshot(notification.params.threadId, next);
        this.emitRealtimeThreadDelta(notification.params.threadId, notification, next);
        return;
      }

      case "item/agentMessage/delta": {
        this.applyItemTextDelta(
          notification.params.threadId,
          notification.params.turnId,
          notification.params.itemId,
          "agentMessage",
          notification.params.delta
        );
        this.emitRealtimeThreadDelta(
          notification.params.threadId,
          notification,
          this.getThreadState(notification.params.threadId)
        );
        return;
      }

      case "item/plan/delta": {
        this.applyItemTextDelta(
          notification.params.threadId,
          notification.params.turnId,
          notification.params.itemId,
          "plan",
          notification.params.delta
        );
        this.emitRealtimeThreadDelta(
          notification.params.threadId,
          notification,
          this.getThreadState(notification.params.threadId)
        );
        return;
      }

      case "item/commandExecution/outputDelta": {
        const current = this.getThreadState(notification.params.threadId);
        const next = updateTurnById(
          current,
          notification.params.turnId,
          (turn) =>
            updateCommandExecutionOutput(
              turn,
              notification.params.itemId,
              notification.params.delta
            ),
          () => ({
            id: notification.params.turnId,
            turnId: notification.params.turnId,
            status: "inProgress",
            items: [
              createEmptyCommandExecutionItem(notification.params.itemId)
            ]
          })
        );
        this.storeSnapshot(notification.params.threadId, next);
        this.emitRealtimeThreadDelta(notification.params.threadId, notification, next);
        return;
      }

      case "item/fileChange/outputDelta": {
        const current = this.getThreadState(notification.params.threadId);
        const next = updateTurnById(
          current,
          notification.params.turnId,
          (turn) =>
            updateFileChangeOutput(
              turn,
              notification.params.itemId,
              notification.params.delta
            ),
          () => ({
            id: notification.params.turnId,
            turnId: notification.params.turnId,
            status: "inProgress",
            items: [createEmptyFileChangeItem(notification.params.itemId)]
          })
        );
        this.storeSnapshot(notification.params.threadId, next);
        this.emitRealtimeThreadDelta(notification.params.threadId, notification, next);
        return;
      }

      case "item/reasoning/summaryPartAdded": {
        const current = this.getThreadState(notification.params.threadId);
        const next = updateTurnById(
          current,
          notification.params.turnId,
          (turn) =>
            ensureReasoningSummaryIndex(
              turn,
              notification.params.itemId,
              notification.params.summaryIndex
            ),
          () => ({
            id: notification.params.turnId,
            turnId: notification.params.turnId,
            status: "inProgress",
            items: [createEmptyReasoningItem(notification.params.itemId)]
          })
        );
        this.storeSnapshot(notification.params.threadId, next);
        this.emitRealtimeThreadDelta(notification.params.threadId, notification, next);
        return;
      }

      case "item/reasoning/summaryTextDelta": {
        const current = this.getThreadState(notification.params.threadId);
        const next = updateTurnById(
          current,
          notification.params.turnId,
          (turn) =>
            appendReasoningSummaryDelta(
              turn,
              notification.params.itemId,
              notification.params.summaryIndex,
              notification.params.delta
            ),
          () => ({
            id: notification.params.turnId,
            turnId: notification.params.turnId,
            status: "inProgress",
            items: [createEmptyReasoningItem(notification.params.itemId)]
          })
        );
        this.storeSnapshot(notification.params.threadId, next);
        this.emitRealtimeThreadDelta(notification.params.threadId, notification, next);
        return;
      }

      case "item/reasoning/textDelta": {
        const current = this.getThreadState(notification.params.threadId);
        const next = updateTurnById(
          current,
          notification.params.turnId,
          (turn) =>
            appendReasoningTextDelta(
              turn,
              notification.params.itemId,
              notification.params.delta
            ),
          () => ({
            id: notification.params.turnId,
            turnId: notification.params.turnId,
            status: "inProgress",
            items: [createEmptyReasoningItem(notification.params.itemId)]
          })
        );
        this.storeSnapshot(notification.params.threadId, next);
        this.emitRealtimeThreadDelta(notification.params.threadId, notification, next);
        return;
      }

      case "item/mcpToolCall/progress": {
        return;
      }
    }
  }

  private applyItemTextDelta(
    threadId: string,
    turnId: string,
    itemId: string,
    itemType: "agentMessage" | "plan",
    delta: string
  ): void {
    const current = this.getThreadState(threadId);
    const next = updateTurnById(
      current,
      turnId,
      (turn) => appendTextDeltaToTurnItem(turn, itemId, itemType, delta),
      () => ({
        id: turnId,
        turnId,
        status: "inProgress",
        items: [
          itemType === "agentMessage"
            ? createEmptyAgentMessageItem(itemId)
            : createEmptyPlanItem(itemId)
        ]
      })
    );
    this.storeSnapshot(threadId, next);
  }

  private emitAppEvent(event: CodexAppEvent): void {
    for (const listener of this.appEventListeners) {
      listener(event);
    }
  }

  private emitRealtimeThreadUpdate(threadId: string, thread: ThreadConversationState): void {
    for (const listener of this.realtimeThreadListeners) {
      listener({
        threadId,
        thread
      });
    }
  }

  private emitRealtimeThreadDelta(
    threadId: string,
    notification: AppServerSupportedServerNotification,
    thread: ThreadConversationState
  ): void {
    for (const listener of this.realtimeThreadDeltaListeners) {
      listener({
        threadId,
        notification,
        thread
      });
    }
  }

  private notifyStateChanged(): void {
    if (this.onStateChange) {
      this.onStateChange();
    }
  }

  private setRuntimeState(next: CodexAgentRuntimeState): void {
    const isSameState =
      this.runtimeState.appReady === next.appReady &&
      this.runtimeState.transportConnected === next.transportConnected &&
      this.runtimeState.transportInitialized === next.transportInitialized &&
      this.runtimeState.codexAvailable === next.codexAvailable &&
      this.runtimeState.lastError === next.lastError;

    if (isSameState) {
      return;
    }

    this.runtimeState = next;
    this.notifyStateChanged();
  }

  private patchRuntimeState(patch: Partial<CodexAgentRuntimeState>): void {
    this.setRuntimeState({
      ...this.runtimeState,
      ...patch
    });
  }

  private ensureCodexAvailable(): void {
    if (!this.runtimeState.codexAvailable) {
      throw new Error("Codex backend is not available");
    }
  }

  private async runAppServerCall<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        const result = await operation();
        this.patchRuntimeState({
          appReady: true,
          lastError: null
        });
        return result;
      } catch (error) {
        const isOverloaded =
          error instanceof AppServerRpcError &&
          error.code === SERVER_OVERLOADED_ERROR_CODE;

        if (isOverloaded && attempt < MAX_BACKPRESSURE_RETRIES) {
          attempt += 1;
          const jitter = Math.random() * 0.3 + 0.85; // 0.85–1.15
          const delayMs = Math.min(
            BACKPRESSURE_BASE_DELAY_MS * Math.pow(2, attempt - 1) * jitter,
            30_000
          );
          logger.warn(
            { attempt, delayMs: Math.round(delayMs) },
            "app-server-overloaded-retry"
          );
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        this.patchRuntimeState({
          appReady: !(error instanceof AppServerTransportError),
          lastError: normalizeCodexRuntimeErrorMessage(toErrorMessage(error))
        });
        throw error;
      }
    }
  }

  private async bootstrapConnections(): Promise<void> {
    if (this.bootstrapInFlight) {
      return this.bootstrapInFlight;
    }

    this.bootstrapInFlight = (async () => {
      try {
        await this.runAppServerCall(() =>
          this.appClient.listThreads({ limit: 1, archived: false })
        );
      } catch (error) {
        const message = toErrorMessage(error);
        const isSpawnError =
          message.includes("ENOENT") ||
          message.includes("not found") ||
          (error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT");

        if (isSpawnError) {
          this.patchRuntimeState({
            codexAvailable: false,
            lastError: normalizeCodexRuntimeErrorMessage(message)
          });
          logger.warn({ error: message }, "codex-not-found");
        }
      } finally {
        this.bootstrapInFlight = null;
      }
    })();

    return this.bootstrapInFlight;
  }

  private async getActiveTurnId(threadId: string): Promise<string | null> {
    const readResult = await this.runAppServerCall(() =>
      this.appClient.readThread(threadId, true)
    );
    const turns = readResult.thread.turns;

    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (!turn) {
        continue;
      }

      const status = turn.status.trim().toLowerCase();
      const isTerminal =
        status === "completed" ||
        status === "failed" ||
        status === "error" ||
        status === "cancelled" ||
        status === "canceled";
      if (isTerminal) {
        continue;
      }

      const turnId = getTurnIdentifier(turn);
      if (turnId) {
        return turnId;
      }
    }

    return null;
  }

  private async resumeThread(threadId: string): Promise<void> {
    await this.runAppServerCall(() =>
      this.appClient.resumeThread(threadId, {
        persistExtendedHistory: true
      })
    );
  }

  private async isThreadLoaded(threadId: string): Promise<boolean> {
    let cursor: string | null = null;

    while (true) {
      const response = await this.runAppServerCall(() =>
        this.appClient.listLoadedThreads({
          limit: 200,
          ...(cursor ? { cursor } : {})
        })
      );
      if (response.data.some((loadedThreadId) => loadedThreadId === threadId)) {
        return true;
      }

      const nextCursor = response.nextCursor ?? null;
      if (!nextCursor) {
        return false;
      }
      cursor = nextCursor;
    }
  }

  private async ensureThreadLoaded(threadId: string): Promise<void> {
    if (await this.isThreadLoaded(threadId)) {
      return;
    }

    await this.resumeThread(threadId);
  }

  private async runThreadOperationWithResumeRetry<T>(
    threadId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    await this.ensureThreadLoaded(threadId);

    try {
      return await this.runAppServerCall(operation);
    } catch (error) {
      const typedError = error instanceof Error ? error : null;
      if (!isInvalidRequestAppServerRpcError(typedError)) {
        throw error;
      }

      const stillLoaded = await this.isThreadLoaded(threadId);
      if (stillLoaded) {
        throw error;
      }
    }

    await this.resumeThread(threadId);
    return this.runAppServerCall(operation);
  }

  private getThreadState(threadId: string): ThreadConversationState {
    return (
      this.streamSnapshotByThreadId.get(threadId) ?? {
        id: threadId,
        turns: [],
        requests: []
      }
    );
  }

  private storeSnapshot(
    threadId: string,
    thread: ThreadConversationState
  ): void {
    this.streamSnapshotByThreadId.set(threadId, thread);
    this.setThreadTitle(threadId, thread.title);
    this.threadOwnerById.set(threadId, APP_SERVER_OWNER_CLIENT_ID);
    appendSyntheticSnapshotEvent(
      this.streamEventsByThreadId,
      threadId,
      thread
    );
  }

  private resolveThreadTitle(
    threadId: string,
    directTitle: string | null | undefined
  ): string | null | undefined {
    if (directTitle !== undefined) {
      return directTitle;
    }

    if (this.threadTitleById.has(threadId)) {
      return this.threadTitleById.get(threadId);
    }

    const snapshot = this.streamSnapshotByThreadId.get(threadId);
    if (!snapshot) {
      return undefined;
    }

    return snapshot.title;
  }

  private setThreadTitle(
    threadId: string,
    title: string | null | undefined
  ): void {
    if (title === undefined) {
      this.threadTitleById.delete(threadId);
      return;
    }

    if (title === null) {
      this.threadTitleById.set(threadId, null);
      return;
    }

    const normalized = title.trim();
    this.threadTitleById.set(threadId, normalized.length > 0 ? title : null);
  }
}

function toErrorMessage(error: Error | string | unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}

const INVALID_REQUEST_ERROR_CODE = -32600;

export function isInvalidRequestAppServerRpcError(
  error: Error | null
): boolean {
  if (!(error instanceof AppServerRpcError)) {
    return false;
  }
  return error.code === INVALID_REQUEST_ERROR_CODE;
}

export function isThreadNotMaterializedIncludeTurnsAppServerRpcError(
  error: Error | null
): boolean {
  if (!isInvalidRequestAppServerRpcError(error) || !error) {
    return false;
  }
  const normalized = error.message.trim().toLowerCase();
  return (
    normalized.includes("not materialized yet") &&
    normalized.includes("includeturns")
  );
}

export function isThreadNotLoadedAppServerRpcError(
  error: Error | null
): boolean {
  if (!isInvalidRequestAppServerRpcError(error) || !error) {
    return false;
  }
  return error.message.trim().toLowerCase().includes("thread not loaded");
}

export function isThreadNoRolloutIncludeTurnsAppServerRpcError(
  error: Error | null
): boolean {
  if (!isInvalidRequestAppServerRpcError(error) || !error) {
    return false;
  }
  const normalized = error.message.trim().toLowerCase();
  return (
    normalized.includes("no rollout found for thread id") &&
    normalized.includes("app-server error -32600")
  );
}

export function isAuthenticationRequiredToReadRateLimitsAppServerRpcError(
  error: Error | null
): boolean {
  if (!isInvalidRequestAppServerRpcError(error) || !error) {
    return false;
  }
  const normalized = error.message.trim().toLowerCase();
  return (
    normalized.includes("authentication required") &&
    normalized.includes("read rate limits")
  );
}

function normalizeStderrLine(line: string): string {
  return line.replace(ANSI_ESCAPE_REGEX, "").trim();
}

function isThreadStateGenerating(state: ThreadConversationState): boolean {
  for (let index = state.turns.length - 1; index >= 0; index -= 1) {
    const turn = state.turns[index];
    if (!turn) {
      continue;
    }

    const status = turn.status.trim().toLowerCase();
    const isTerminal =
      status === "completed" ||
      status === "failed" ||
      status === "error" ||
      status === "cancelled" ||
      status === "canceled" ||
      status === "interrupted" ||
      status === "aborted";
    if (isTerminal) {
      continue;
    }
    return true;
  }

  return false;
}

function deriveThreadWaitingState(
  state: ThreadConversationState
): {
  waitingOnApproval: boolean;
  waitingOnUserInput: boolean;
} {
  let waitingOnApproval = false;
  let waitingOnUserInput = false;

  for (const request of state.requests) {
    if (request.completed === true) {
      continue;
    }

    switch (request.method) {
      case "item/tool/requestUserInput":
        waitingOnUserInput = true;
        break;
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "applyPatchApproval":
      case "execCommandApproval":
        waitingOnApproval = true;
        break;
      case "item/tool/call":
      case "account/chatgptAuthTokens/refresh":
      case "item/plan/requestImplementation":
        break;
    }
  }

  return {
    waitingOnApproval,
    waitingOnUserInput
  };
}

function requestIdsMatch(left: UserInputRequestId, right: UserInputRequestId): boolean {
  return `${left}` === `${right}`;
}

function findPendingRequestWithId(
  state: ThreadConversationState,
  requestId: UserInputRequestId
): ThreadConversationRequest | null {
  for (const request of state.requests) {
    if (request.completed === true) {
      continue;
    }
    if (requestIdsMatch(request.id, requestId)) {
      return request;
    }
  }
  return null;
}

function appendSyntheticSnapshotEvent(
  store: Map<string, ClientEventEnvelope[]>,
  threadId: string,
  conversationState: ThreadConversationState
): void {
  const events = store.get(threadId) ?? [];
  events.push(buildSyntheticSnapshotEvent(threadId, conversationState));
  if (events.length > MAX_STREAM_EVENTS) {
    events.splice(0, events.length - MAX_STREAM_EVENTS);
  }
  store.set(threadId, events);
}

function buildSyntheticSnapshotEvent(
  threadId: string,
  conversationState: ThreadConversationState
): ClientEventEnvelope {
  return {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: APP_SERVER_OWNER_CLIENT_ID,
    version: 0,
    params: {
      conversationId: threadId,
      change: {
        type: "snapshot",
        conversationState
      },
      version: 0,
      type: "thread-stream-state-changed"
    }
  };
}

function readThreadIdFromRequest(request: AppServerServerRequest): string | null {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
    case "item/tool/requestUserInput":
    case "item/tool/call":
      return request.params.threadId;
    case "account/chatgptAuthTokens/refresh":
    case "execCommandApproval":
    case "applyPatchApproval":
    case "item/plan/requestImplementation":
      return null;
  }
  return null;
}

function readThreadIdFromNotification(
  notification: AppServerSupportedServerNotification
): string | null {
  switch (notification.method) {
    case "thread/started":
      return notification.params.thread.id;
    case "thread/name/updated":
    case "thread/tokenUsage/updated":
    case "turn/started":
    case "turn/completed":
    case "turn/diff/updated":
    case "turn/plan/updated":
    case "item/started":
    case "item/completed":
    case "item/agentMessage/delta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/plan/delta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
    case "item/mcpToolCall/progress":
      return notification.params.threadId;
  }
  return null;
}

function getTurnIdentifier(turn: ThreadTurn): string | null {
  if (turn.turnId && turn.turnId.trim().length > 0) {
    return turn.turnId.trim();
  }
  if (turn.id && turn.id.trim().length > 0) {
    return turn.id.trim();
  }
  return null;
}

function findTurnIndex(turns: ThreadTurn[], turnId: string): number {
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (!turn) {
      continue;
    }
    if (getTurnIdentifier(turn) === turnId) {
      return index;
    }
  }
  return -1;
}

function upsertTurn(state: ThreadConversationState, incoming: ThreadTurn): ThreadConversationState {
  const turnId = getTurnIdentifier(incoming);
  if (!turnId) {
    return state;
  }

  const turns = [...state.turns];
  const existingIndex = findTurnIndex(turns, turnId);
  if (existingIndex === -1) {
    turns.push(incoming);
  } else {
    const existing = turns[existingIndex];
    turns[existingIndex] = existing
      ? mergeTurns(existing, incoming)
      : incoming;
  }

  return {
    ...state,
    turns
  };
}

function mergeTurns(existing: ThreadTurn, incoming: ThreadTurn): ThreadTurn {
  return {
    ...existing,
    ...incoming,
    params: incoming.params ?? existing.params,
    turnStartedAtMs: incoming.turnStartedAtMs ?? existing.turnStartedAtMs,
    finalAssistantStartedAtMs:
      incoming.finalAssistantStartedAtMs ?? existing.finalAssistantStartedAtMs,
    error: incoming.error ?? existing.error,
    diff: incoming.diff ?? existing.diff,
    items: incoming.items.length > 0 ? incoming.items : existing.items
  };
}

function updateTurnById(
  state: ThreadConversationState,
  turnId: string,
  updater: (turn: ThreadTurn) => ThreadTurn,
  createTurn: () => ThreadTurn
): ThreadConversationState {
  const turns = [...state.turns];
  const existingIndex = findTurnIndex(turns, turnId);
  if (existingIndex === -1) {
    turns.push(updater(createTurn()));
  } else {
    const existing = turns[existingIndex];
    turns[existingIndex] = existing ? updater(existing) : updater(createTurn());
  }

  return {
    ...state,
    turns
  };
}

function upsertItemIntoTurn(turn: ThreadTurn, item: ThreadItem): ThreadTurn {
  const items = [...turn.items];
  const itemIndex = items.findIndex((existingItem) => existingItem.id === item.id);
  if (itemIndex === -1) {
    items.push(item);
  } else {
    const existingItem = items[itemIndex];
    items[itemIndex] = existingItem ? mergeItems(existingItem, item) : item;
  }

  return {
    ...turn,
    items
  };
}

function mergeItems(existing: ThreadItem, incoming: ThreadItem): ThreadItem {
  if (existing.type !== incoming.type) {
    return incoming;
  }

  if (
    incoming.type === "agentMessage" &&
    isAgentMessageItem(existing)
  ) {
    return mergeAgentMessageItems(existing, incoming);
  }
  if (incoming.type === "plan" && isPlanItem(existing)) {
    return mergePlanItems(existing, incoming);
  }
  if (incoming.type === "reasoning" && isReasoningItem(existing)) {
    return mergeReasoningItems(existing, incoming);
  }
  if (
    incoming.type === "commandExecution" &&
    isCommandExecutionItem(existing)
  ) {
    return mergeCommandExecutionItems(existing, incoming);
  }
  if (incoming.type === "fileChange" && isFileChangeItem(existing)) {
    return mergeFileChangeItems(existing, incoming);
  }

  return incoming;
}

function mergeAgentMessageItems(
  existing: AgentMessageItem,
  incoming: AgentMessageItem
): AgentMessageItem {
  return {
    ...incoming,
    text: incoming.text.length > 0 ? incoming.text : existing.text
  };
}

function mergePlanItems(existing: PlanItem, incoming: PlanItem): PlanItem {
  return {
    ...incoming,
    text: incoming.text.length > 0 ? incoming.text : existing.text
  };
}

function mergeReasoningItems(
  existing: ReasoningItem,
  incoming: ReasoningItem
): ReasoningItem {
  return {
    ...incoming,
    summary:
      incoming.summary !== undefined && incoming.summary.length > 0
        ? incoming.summary
        : existing.summary,
    text:
      incoming.text !== undefined && incoming.text.length > 0
        ? incoming.text
        : existing.text,
    content:
      incoming.content !== undefined && incoming.content.length > 0
        ? incoming.content
        : existing.content
  };
}

function mergeCommandExecutionItems(
  existing: CommandExecutionItem,
  incoming: CommandExecutionItem
): CommandExecutionItem {
  return {
    ...existing,
    ...incoming,
    aggregatedOutput:
      incoming.aggregatedOutput !== undefined &&
      incoming.aggregatedOutput !== null &&
      incoming.aggregatedOutput.length > 0
        ? incoming.aggregatedOutput
        : existing.aggregatedOutput
  };
}

function mergeFileChangeItems(
  existing: FileChangeItem,
  incoming: Extract<ThreadItem, { type: "fileChange" }>
): FileChangeItem {
  const merged: FileChangeItem = {
    ...existing,
    ...incoming,
    changes: incoming.changes.length > 0 ? incoming.changes : existing.changes
  };

  if (incoming.changes.length === 0 && existing.aggregatedOutput !== undefined) {
    merged.aggregatedOutput = existing.aggregatedOutput;
  }

  return merged;
}

function appendTextDeltaToTurnItem(
  turn: ThreadTurn,
  itemId: string,
  itemType: "agentMessage" | "plan",
  delta: string
): ThreadTurn {
  const items = [...turn.items];
  const itemIndex = items.findIndex((item) => item.id === itemId);
  const existingItem = items[itemIndex];

  let nextItem: ThreadItem;
  if (itemType === "agentMessage") {
    const baseItem = ensureAgentMessageItem(existingItem, itemId);
    if (!baseItem) {
      return turn;
    }
    const nextAgentMessageItem: AgentMessageItem = {
      ...baseItem,
      text: baseItem.text + delta
    };
    nextItem = nextAgentMessageItem;
  } else {
    const baseItem = ensurePlanItem(existingItem, itemId);
    if (!baseItem) {
      return turn;
    }
    const nextPlanItem: PlanItem = {
      ...baseItem,
      text: baseItem.text + delta
    };
    nextItem = nextPlanItem;
  }

  if (itemIndex === -1) {
    items.push(nextItem);
  } else {
    items[itemIndex] = nextItem;
  }

  return {
    ...turn,
    items
  };
}

function updateCommandExecutionOutput(
  turn: ThreadTurn,
  itemId: string,
  delta: string
): ThreadTurn {
  const items = [...turn.items];
  const itemIndex = items.findIndex((item) => item.id === itemId);
  const existingItem = items[itemIndex];
  const baseItem = ensureCommandExecutionItem(existingItem, itemId);
  if (!baseItem) {
    return turn;
  }

  const existingOutput = baseItem.aggregatedOutput ?? "";
  const nextItem: CommandExecutionItem = {
    ...baseItem,
    aggregatedOutput: existingOutput + delta
  };
  if (itemIndex === -1) {
    items.push(nextItem);
  } else {
    items[itemIndex] = nextItem;
  }

  return {
    ...turn,
    items
  };
}

function ensureReasoningSummaryIndex(
  turn: ThreadTurn,
  itemId: string,
  summaryIndex: number
): ThreadTurn {
  return updateReasoningItem(turn, itemId, (item) => {
    const summary = [...(item.summary ?? [])];
    while (summary.length <= summaryIndex) {
      summary.push("");
    }
    return {
      ...item,
      summary
    };
  });
}

function appendReasoningSummaryDelta(
  turn: ThreadTurn,
  itemId: string,
  summaryIndex: number,
  delta: string
): ThreadTurn {
  return updateReasoningItem(turn, itemId, (item) => {
    const summary = [...(item.summary ?? [])];
    while (summary.length <= summaryIndex) {
      summary.push("");
    }
    summary[summaryIndex] = (summary[summaryIndex] ?? "") + delta;
    return {
      ...item,
      summary
    };
  });
}

function appendReasoningTextDelta(
  turn: ThreadTurn,
  itemId: string,
  delta: string
): ThreadTurn {
  return updateReasoningItem(turn, itemId, (item) => ({
    ...item,
    text: (item.text ?? "") + delta
  }));
}

function updateReasoningItem(
  turn: ThreadTurn,
  itemId: string,
  updater: (item: ReasoningItem) => ReasoningItem
): ThreadTurn {
  const items = [...turn.items];
  const itemIndex = items.findIndex((item) => item.id === itemId);
  const existingItem = items[itemIndex];
  const baseItem = ensureReasoningItem(existingItem, itemId);
  if (!baseItem) {
    return turn;
  }

  const nextItem = updater(baseItem);
  if (itemIndex === -1) {
    items.push(nextItem);
  } else {
    items[itemIndex] = nextItem;
  }

  return {
    ...turn,
    items
  };
}

function createEmptyAgentMessageItem(
  itemId: string
): AgentMessageItem {
  return {
    id: itemId,
    type: "agentMessage",
    text: ""
  };
}

function ensureAgentMessageItem(
  item: ThreadItem | undefined,
  itemId: string
): AgentMessageItem | null {
  if (!item) {
    return createEmptyAgentMessageItem(itemId);
  }
  return isAgentMessageItem(item) ? item : null;
}

function createEmptyPlanItem(itemId: string): PlanItem {
  return {
    id: itemId,
    type: "plan",
    text: ""
  };
}

function ensurePlanItem(item: ThreadItem | undefined, itemId: string): PlanItem | null {
  if (!item) {
    return createEmptyPlanItem(itemId);
  }
  return isPlanItem(item) ? item : null;
}

function createEmptyReasoningItem(itemId: string): ReasoningItem {
  return {
    id: itemId,
    type: "reasoning",
    summary: [],
    text: ""
  };
}

function ensureReasoningItem(
  item: ThreadItem | undefined,
  itemId: string
): ReasoningItem | null {
  if (!item) {
    return createEmptyReasoningItem(itemId);
  }
  return isReasoningItem(item) ? item : null;
}

function createEmptyCommandExecutionItem(itemId: string): CommandExecutionItem {
  return {
    id: itemId,
    type: "commandExecution",
    command: "",
    status: "inProgress",
    aggregatedOutput: ""
  };
}

function ensureCommandExecutionItem(
  item: ThreadItem | undefined,
  itemId: string
): CommandExecutionItem | null {
  if (!item) {
    return createEmptyCommandExecutionItem(itemId);
  }
  return isCommandExecutionItem(item) ? item : null;
}

function createEmptyFileChangeItem(itemId: string): FileChangeItem {
  return {
    id: itemId,
    type: "fileChange",
    changes: [],
    status: "inProgress",
    aggregatedOutput: ""
  };
}

function isFileChangeItem(item: ThreadItem): item is FileChangeItem {
  return item.type === "fileChange";
}

function updateFileChangeOutput(
  turn: ThreadTurn,
  itemId: string,
  delta: string
): ThreadTurn {
  const items = [...turn.items];
  const itemIndex = items.findIndex((item) => item.id === itemId);
  const existingItem = items[itemIndex];
  const baseItem: FileChangeItem =
    existingItem !== undefined && isFileChangeItem(existingItem)
      ? existingItem
      : createEmptyFileChangeItem(itemId);

  const nextItem: FileChangeItem = {
    ...baseItem,
    aggregatedOutput: (baseItem.aggregatedOutput ?? "") + delta
  };

  if (itemIndex === -1) {
    items.push(nextItem);
  } else {
    items[itemIndex] = nextItem;
  }

  return { ...turn, items };
}

function isAgentMessageItem(item: ThreadItem): item is AgentMessageItem {
  return item.type === "agentMessage";
}

function isPlanItem(item: ThreadItem): item is PlanItem {
  return item.type === "plan";
}

function isReasoningItem(item: ThreadItem): item is ReasoningItem {
  return item.type === "reasoning";
}

function isCommandExecutionItem(item: ThreadItem): item is CommandExecutionItem {
  return item.type === "commandExecution";
}

function upsertThreadRequest(
  state: ThreadConversationState,
  request: AppServerServerRequest
): ThreadConversationState {
  const requestId = `${request.id}`;
  const requests = [...state.requests];
  const existingIndex = requests.findIndex(
    (existingRequest) => `${existingRequest.id}` === requestId
  );
  if (existingIndex === -1) {
    requests.push(request);
  } else {
    requests[existingIndex] = request;
  }

  return {
    ...state,
    requests
  };
}

function buildPlanSummaryItem(
  turn: ThreadTurn | null,
  turnId: string,
  explanation: string | null,
  plan: Array<{ step: string; status: string }>
): Extract<ThreadItem, { type: "plan" }> {
  const existingPlanItem =
    turn?.items.find((item) => item.type === "plan") ?? null;
  const lines = plan.map((step, index) => {
    return `${index + 1}. [${step.status}] ${step.step}`;
  });
  const text = [
    ...(explanation && explanation.length > 0 ? [explanation] : []),
    ...lines
  ].join("\n");

  return {
    id: existingPlanItem?.id ?? `stream-plan-${turnId}`,
    type: "plan",
    text
  };
}
