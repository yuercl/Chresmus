import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  JsonValue,
  UnifiedFeatureAvailability,
  UnifiedFeatureId,
  UnifiedItem,
  UnifiedThread,
} from "@chresmus/unified-surface";
import { App } from "../src/App";

class MockEventSource {
  private static instances: MockEventSource[] = [];
  public onmessage: ((event: MessageEvent<string>) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;

  public constructor(_url: string) {
    MockEventSource.instances.push(this);
  }

  public close(): void {
    MockEventSource.instances = MockEventSource.instances.filter(
      (instance) => instance !== this,
    );
  }

  public static emit(
    payload: Record<
      string,
      object | string | number | boolean | null | undefined
    >,
  ): void {
    const event = new MessageEvent<string>("message", {
      data: JSON.stringify(payload),
    });
    for (const instance of MockEventSource.instances) {
      instance.onmessage?.(event);
    }
  }

  public static reset(): void {
    MockEventSource.instances = [];
  }
}

vi.stubGlobal("EventSource", MockEventSource);

Element.prototype.scrollTo = vi.fn();
window.scrollTo = vi.fn();
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

vi.stubGlobal(
  "matchMedia",
  vi.fn((query: string) => ({
    matches: query === "(prefers-color-scheme: dark)",
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
);

const localStorageBacking = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: vi.fn((key: string): string | null => {
    return localStorageBacking.get(key) ?? null;
  }),
  setItem: vi.fn((key: string, value: string): void => {
    localStorageBacking.set(key, value);
  }),
  removeItem: vi.fn((key: string): void => {
    localStorageBacking.delete(key);
  }),
  clear: vi.fn((): void => {
    localStorageBacking.clear();
  }),
  key: vi.fn((index: number): string | null => {
    const keys = [...localStorageBacking.keys()];
    return keys[index] ?? null;
  }),
  get length(): number {
    return localStorageBacking.size;
  },
});

const FEATURE_IDS: UnifiedFeatureId[] = [
  "listThreads",
  "createThread",
  "readThread",
  "sendMessage",
  "interrupt",
  "listModels",
  "listCollaborationModes",
  "setCollaborationMode",
  "submitUserInput",
  "readLiveState",
  "readStreamEvents",
  "listProjectDirectories",
];

type ProviderId = "codex" | "opencode" | "claude" | "qwen";

type CapabilityFixture = {
  canListModels: boolean;
  canListCollaborationModes: boolean;
  canSetCollaborationMode: boolean;
  canSubmitUserInput: boolean;
  canReadLiveState: boolean;
  canReadStreamEvents: boolean;
  canListProjectDirectories: boolean;
};

type FeatureSet = Record<UnifiedFeatureId, UnifiedFeatureAvailability>;

function buildEmptyThreadListCursors(): {
  codex: null;
  opencode: null;
  claude: null;
  qwen: null;
} {
  return {
    codex: null,
    opencode: null,
    claude: null,
    qwen: null,
  };
}

function buildEmptyThreadListErrors(): {
  codex: null;
  opencode: null;
  claude: null;
  qwen: null;
} {
  return {
    codex: null,
    opencode: null,
    claude: null,
    qwen: null,
  };
}

const codexCapabilities: CapabilityFixture = {
  canListModels: true,
  canListCollaborationModes: true,
  canSetCollaborationMode: true,
  canSubmitUserInput: true,
  canReadLiveState: true,
  canReadStreamEvents: true,
  canListProjectDirectories: true,
};

const opencodeCapabilities: CapabilityFixture = {
  canListModels: false,
  canListCollaborationModes: false,
  canSetCollaborationMode: false,
  canSubmitUserInput: false,
  canReadLiveState: false,
  canReadStreamEvents: false,
  canListProjectDirectories: true,
};

function buildFeatureSet(
  capabilities: CapabilityFixture,
  options?: { enabled?: boolean; connected?: boolean },
): FeatureSet {
  const enabled = options?.enabled ?? true;
  const connected = options?.connected ?? true;

  const unavailableReason: UnifiedFeatureAvailability = {
    status: "unavailable",
    reason: enabled ? "providerDisconnected" : "providerDisabled",
  };

  const available: UnifiedFeatureAvailability = {
    status: "available",
  };

  const features: FeatureSet = {
    listThreads: enabled && connected ? available : unavailableReason,
    createThread: enabled && connected ? available : unavailableReason,
    readThread: enabled && connected ? available : unavailableReason,
    sendMessage: enabled && connected ? available : unavailableReason,
    interrupt: enabled && connected ? available : unavailableReason,
    listModels:
      enabled && connected && capabilities.canListModels
        ? available
        : {
            status: "unavailable",
            reason:
              enabled && connected
                ? "unsupportedByProvider"
                : unavailableReason.reason,
          },
    listCollaborationModes:
      enabled && connected && capabilities.canListCollaborationModes
        ? available
        : {
            status: "unavailable",
            reason:
              enabled && connected
                ? "unsupportedByProvider"
                : unavailableReason.reason,
          },
    setCollaborationMode:
      enabled && connected && capabilities.canSetCollaborationMode
        ? available
        : {
            status: "unavailable",
            reason:
              enabled && connected
                ? "unsupportedByProvider"
                : unavailableReason.reason,
          },
    submitUserInput:
      enabled && connected && capabilities.canSubmitUserInput
        ? available
        : {
            status: "unavailable",
            reason:
              enabled && connected
                ? "unsupportedByProvider"
                : unavailableReason.reason,
          },
    readLiveState:
      enabled && connected && capabilities.canReadLiveState
        ? available
        : {
            status: "unavailable",
            reason:
              enabled && connected
                ? "unsupportedByProvider"
                : unavailableReason.reason,
          },
    readStreamEvents:
      enabled && connected && capabilities.canReadStreamEvents
        ? available
        : {
            status: "unavailable",
            reason:
              enabled && connected
                ? "unsupportedByProvider"
                : unavailableReason.reason,
          },
    listProjectDirectories:
      enabled && connected && capabilities.canListProjectDirectories
        ? available
        : {
            status: "unavailable",
            reason:
              enabled && connected
                ? "unsupportedByProvider"
                : unavailableReason.reason,
          },
  };

  return features;
}

type ThreadSummary = {
  id: string;
  provider: ProviderId;
  preview: string;
  title?: string | null;
  isGenerating?: boolean;
  waitingOnApproval?: boolean;
  waitingOnUserInput?: boolean;
  createdAt: number;
  updatedAt: number;
  cwd?: string;
  source?: string;
};

type UnifiedThreadFixture = UnifiedThread;

let featureMatrixFixture: {
  ok: true;
  features: Record<ProviderId, FeatureSet>;
};

let projectDirectoriesFixture: Record<ProviderId, string[]>;

let threadsFixture: {
  ok: true;
  data: ThreadSummary[];
  cursors: {
    codex: string | null;
    opencode: string | null;
    claude: string | null;
    qwen: string | null;
  };
  errors: {
    codex: null;
    opencode: null;
    claude: null;
    qwen: null;
  };
};

let collaborationModesFixture: Record<
  ProviderId,
  Array<{
    name: string;
    mode: string;
    model: string | null;
    reasoningEffort: string | null;
    developerInstructions: string | null;
  }>
>;

let modelsFixture: Record<
  ProviderId,
  Array<{
    id: string;
    displayName: string;
    description: string;
    defaultReasoningEffort: string | null;
    supportedReasoningEfforts: string[];
    hidden: boolean;
    isDefault: boolean;
  }>
>;

let sendMessageErrorFixture: string | null;

let readThreadResolver: (
  threadId: string,
  provider: ProviderId | null,
) => {
  ok: true;
  thread: UnifiedThreadFixture;
} | null;

let liveStateResolver: (
  threadId: string,
  provider: ProviderId,
) => {
  kind: "readLiveState";
  threadId: string;
  ownerClientId: string | null;
  conversationState: UnifiedThreadFixture | null;
  liveStateError: {
    kind: "reductionFailed";
    message: string;
    eventIndex: number | null;
    patchIndex: number | null;
  } | null;
};

function buildConversationStateFixture(
  threadId: string,
  modelId: string,
  options?: {
    updatedAt?: number;
    includePendingRequest?: boolean;
    customRequests?: UnifiedThreadFixture["requests"];
    provider?: ProviderId;
    latestReasoningEffort?: string | null;
    collaborationModeReasoningEffort?: string | null;
    turnItems?: UnifiedItem[];
  },
): UnifiedThreadFixture {
  const includePendingRequest = options?.includePendingRequest ?? false;
  const updatedAt = options?.updatedAt ?? 1700000000;
  const provider = options?.provider ?? "codex";
  const latestReasoningEffort = options?.latestReasoningEffort ?? "medium";
  const collaborationModeReasoningEffort =
    options?.collaborationModeReasoningEffort ?? "medium";
  return {
    id: threadId,
    provider,
    turns: [
      {
        id: "turn-1",
        status: "completed",
        items: options?.turnItems ?? [],
      },
    ],
    requests:
      options?.customRequests ??
      (includePendingRequest
        ? [
            {
              id: "request-1",
              method: "item/tool/requestUserInput",
              params: {
                threadId,
                turnId: "turn-1",
                itemId: "item-1",
                questions: [
                  {
                    id: "question-1",
                    header: "Question",
                    question: "Pick one option",
                    isOther: false,
                    isSecret: false,
                    options: [
                      { label: "Option A", description: "Use option A" },
                      { label: "Option B", description: "Use option B" },
                    ],
                  },
                ],
              },
            },
          ]
        : []),
    updatedAt,
    latestModel: modelId,
    latestReasoningEffort,
    latestCollaborationMode: {
      mode: "default",
      settings: {
        model: modelId,
        reasoningEffort: collaborationModeReasoningEffort,
        developerInstructions: null,
      },
    },
  };
}

function jsonResponse(
  payload: Record<
    string,
    object | string | number | boolean | null | undefined
  >,
): Response {
  return {
    ok: true,
    json: async () => payload,
  } as Response;
}

function jsonErrorResponse(
  payload: Record<
    string,
    object | string | number | boolean | null | undefined
  >,
): Response {
  return {
    ok: false,
    json: async () => payload,
  } as Response;
}

beforeEach(() => {
  MockEventSource.reset();
  window.history.replaceState(null, "", "/");
  localStorageBacking.clear();

  featureMatrixFixture = {
    ok: true,
    features: {
      codex: buildFeatureSet(codexCapabilities, {
        enabled: true,
        connected: true,
      }),
      opencode: buildFeatureSet(opencodeCapabilities, {
        enabled: false,
        connected: false,
      }),
      claude: buildFeatureSet(codexCapabilities, {
        enabled: false,
        connected: false,
      }),
      qwen: buildFeatureSet(codexCapabilities, {
        enabled: false,
        connected: false,
      }),
    },
  };

  projectDirectoriesFixture = {
    codex: ["/tmp/project"],
    opencode: [],
    claude: [],
    qwen: [],
  };

  threadsFixture = {
    ok: true,
    data: [],
    cursors: buildEmptyThreadListCursors(),
    errors: buildEmptyThreadListErrors(),
  };

  collaborationModesFixture = {
    codex: [
      {
        name: "Default",
        mode: "default",
        model: null,
        reasoningEffort: "medium",
        developerInstructions: null,
      },
      {
        name: "Plan",
        mode: "plan",
        model: null,
        reasoningEffort: "medium",
        developerInstructions: "x",
      },
    ],
    opencode: [],
    claude: [],
    qwen: [],
  };

  modelsFixture = {
    codex: [
      {
        id: "gpt-5.3-codex",
        displayName: "gpt-5.3-codex",
        description: "Test model",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium"],
        hidden: false,
        isDefault: true,
      },
    ],
    opencode: [],
    claude: [],
    qwen: [],
  };

  sendMessageErrorFixture = null;
  readThreadResolver = (_threadId: string, _provider: ProviderId | null) =>
    null;
  liveStateResolver = (threadId: string, _provider: ProviderId) => ({
    kind: "readLiveState",
    threadId,
    ownerClientId: null,
    conversationState: null,
    liveStateError: null,
  });
});

afterEach(() => {
  cleanup();
});

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const parsedUrl = new URL(url, "http://localhost");
    const pathname = parsedUrl.pathname;

    if (pathname === "/api/health") {
      return jsonResponse({
        ok: true,
        state: {
          appReady: true,
          transportConnected: true,
          transportInitialized: true,
          lastError: null,
          historyCount: 0,
          threadOwnerCount: 0,
        },
      });
    }

    if (pathname === "/api/unified/features") {
      return jsonResponse(featureMatrixFixture);
    }

    if (pathname === "/api/unified/threads") {
      return jsonResponse(threadsFixture);
    }

    if (pathname === "/api/unified/sidebar") {
      return jsonResponse({
        ok: true,
        rows: threadsFixture.data,
        errors: threadsFixture.errors,
      });
    }

    if (pathname.startsWith("/api/unified/thread/")) {
      const segments = pathname
        .split("/")
        .filter((segment) => segment.length > 0);
      const threadId = segments[3] ? decodeURIComponent(segments[3]) : "";
      const providerParam = parsedUrl.searchParams.get("provider");
      const provider =
        providerParam === "opencode" || providerParam === "codex"
          ? providerParam
          : null;
      const readThread = readThreadResolver(threadId, provider);
      if (readThread) {
        return jsonResponse(readThread);
      }
      return jsonErrorResponse({
        ok: false,
        error: {
          code: "threadNotFound",
          message: `Thread ${threadId} is not registered`,
        },
      });
    }

    if (pathname === "/api/unified/command") {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as {
            kind: string;
            provider: ProviderId;
            threadId?: string;
          })
        : { kind: "unknown", provider: "codex" as const };

      if (body.kind === "listProjectDirectories") {
        return jsonResponse({
          ok: true,
          result: {
            kind: "listProjectDirectories",
            directories: projectDirectoriesFixture[body.provider],
          },
        });
      }

      if (body.kind === "listCollaborationModes") {
        return jsonResponse({
          ok: true,
          result: {
            kind: "listCollaborationModes",
            data: collaborationModesFixture[body.provider],
          },
        });
      }

      if (body.kind === "listModels") {
        return jsonResponse({
          ok: true,
          result: {
            kind: "listModels",
            data: modelsFixture[body.provider],
          },
        });
      }

      if (body.kind === "readLiveState") {
        return jsonResponse({
          ok: true,
          result: liveStateResolver(body.threadId ?? "", body.provider),
        });
      }

      if (body.kind === "readStreamEvents") {
        return jsonResponse({
          ok: true,
          result: {
            kind: "readStreamEvents",
            threadId: body.threadId ?? "",
            ownerClientId: null,
            events: [],
          },
        });
      }

      if (body.kind === "sendMessage" && sendMessageErrorFixture) {
        return jsonErrorResponse({
          ok: false,
          error: {
            code: "sendMessageFailed",
            message: sendMessageErrorFixture,
          },
        });
      }

      return jsonResponse({
        ok: true,
        result: {
          kind: body.kind,
        },
      });
    }

    if (pathname === "/api/debug/trace/status") {
      return jsonResponse({
        ok: true,
        active: null,
        recent: [],
      });
    }

    if (pathname === "/api/debug/history") {
      return jsonResponse({
        ok: true,
        history: [],
      });
    }

    return jsonResponse({ ok: true });
  }),
);

describe("App", () => {
  it("renders core sections", async () => {
    render(<App />);
    expect((await screen.findAllByText("Chresmus")).length).toBeGreaterThan(0);
    expect(await screen.findByText("No thread selected")).toBeTruthy();
  });

  it("uses local colored assets for provider icons", async () => {
    featureMatrixFixture.features.claude = buildFeatureSet(codexCapabilities, {
      enabled: true,
      connected: true,
    });
    featureMatrixFixture.features.qwen = buildFeatureSet(codexCapabilities, {
      enabled: true,
      connected: true,
    });
    threadsFixture = {
      ok: true,
      data: [
        {
          id: "thread-codex-icon",
          provider: "codex",
          preview: "codex icon thread",
          createdAt: 1700000000,
          updatedAt: 1700000001,
          cwd: "/tmp/project",
          source: "codex",
        },
        {
          id: "thread-claude-icon",
          provider: "claude",
          preview: "claude icon thread",
          createdAt: 1700000000,
          updatedAt: 1700000000,
          cwd: "/tmp/project",
          source: "claude",
        },
        {
          id: "thread-qwen-icon",
          provider: "qwen",
          preview: "qwen icon thread",
          createdAt: 1700000000,
          updatedAt: 1699999999,
          cwd: "/tmp/project",
          source: "qwen",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    render(<App />);

    const codexIcons = await screen.findAllByAltText("Codex");
    expect(codexIcons.length).toBeGreaterThan(0);
    for (const codexIcon of codexIcons) {
      expect(codexIcon.getAttribute("src")).toBe("/agent-icons/codex.png");
    }

    const claudeIcons = await screen.findAllByAltText("Claude Code");
    expect(claudeIcons.length).toBeGreaterThan(0);
    for (const claudeIcon of claudeIcons) {
      expect(claudeIcon.getAttribute("src")).toBe("/agent-icons/claude.png");
    }

    const qwenIcons = await screen.findAllByAltText("Qwen Code");
    expect(qwenIcons.length).toBeGreaterThan(0);
    for (const qwenIcon of qwenIcons) {
      expect(qwenIcon.getAttribute("src")).toBe("/agent-icons/qwen.png");
    }
  });

  it("reloads provider-specific models when switching between provider threads", async () => {
    featureMatrixFixture.features.claude = buildFeatureSet(codexCapabilities, {
      enabled: true,
      connected: true,
    });
    featureMatrixFixture.features.qwen = buildFeatureSet(codexCapabilities, {
      enabled: true,
      connected: true,
    });

    threadsFixture = {
      ok: true,
      data: [
        {
          id: "thread-codex-models",
          provider: "codex",
          preview: "codex thread",
          createdAt: 1700000000,
          updatedAt: 1700000003,
          cwd: "/tmp/project",
          source: "codex",
        },
        {
          id: "thread-claude-models",
          provider: "claude",
          preview: "claude thread",
          createdAt: 1700000000,
          updatedAt: 1700000002,
          cwd: "/tmp/project",
          source: "claude",
        },
        {
          id: "thread-qwen-models",
          provider: "qwen",
          preview: "qwen thread",
          createdAt: 1700000000,
          updatedAt: 1700000001,
          cwd: "/tmp/project",
          source: "qwen",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    collaborationModesFixture = {
      codex: [
        {
          name: "Default",
          mode: "default",
          model: null,
          reasoningEffort: "medium",
          developerInstructions: null,
        },
      ],
      opencode: [],
      claude: [
        {
          name: "Default",
          mode: "default",
          model: null,
          reasoningEffort: "medium",
          developerInstructions: null,
        },
      ],
      qwen: [
        {
          name: "Default",
          mode: "default",
          model: null,
          reasoningEffort: "medium",
          developerInstructions: null,
        },
      ],
    };

    modelsFixture = {
      codex: [
        {
          id: "gpt-5.3-codex",
          displayName: "gpt-5.3-codex",
          description: "Codex model",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["medium"],
          hidden: false,
          isDefault: true,
        },
      ],
      opencode: [],
      claude: [
        {
          id: "default",
          displayName: "Claude Default",
          description: "Claude default model",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["medium"],
          hidden: false,
          isDefault: true,
        },
      ],
      qwen: [
        {
          id: "coder-model",
          displayName: "Qwen Coder Model",
          description: "Qwen coder model",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["medium"],
          hidden: false,
          isDefault: true,
        },
      ],
    };

    readThreadResolver = (threadId: string, provider: ProviderId | null) => {
      const resolvedProvider = provider ?? "codex";
      const modelId =
        resolvedProvider === "claude"
          ? "default"
          : resolvedProvider === "qwen"
            ? "coder-model"
            : "gpt-5.3-codex";
      return {
        ok: true,
        thread: buildConversationStateFixture(threadId, modelId, {
          provider: resolvedProvider,
        }),
      };
    };

    liveStateResolver = (threadId: string, provider: ProviderId) => {
      const modelId =
        provider === "claude"
          ? "default"
          : provider === "qwen"
            ? "coder-model"
            : "gpt-5.3-codex";
      return {
        kind: "readLiveState",
        threadId,
        ownerClientId: "client-1",
        conversationState: buildConversationStateFixture(threadId, modelId, {
          provider,
        }),
        liveStateError: null,
      };
    };

    const listModelProviders = (): ProviderId[] =>
      vi
        .mocked(fetch)
        .mock.calls.flatMap((call) => {
          const [requestUrl, requestInit] = call;
          if (typeof requestUrl !== "string") {
            return [];
          }
          if (!requestUrl.endsWith("/api/unified/command")) {
            return [];
          }
          if (typeof requestInit?.body !== "string") {
            return [];
          }
          const parsed = JSON.parse(requestInit.body) as {
            kind?: string;
            provider?: ProviderId;
          };
          if (parsed.kind !== "listModels" || !parsed.provider) {
            return [];
          }
          return [parsed.provider];
        });

    render(<App />);

    await waitFor(() => {
      expect(listModelProviders()).toContain("codex");
    });

    fireEvent.click(await screen.findByText("claude thread"));
    await waitFor(() => {
      expect(listModelProviders()).toContain("claude");
    });

    fireEvent.click(await screen.findByText("qwen thread"));
    await waitFor(() => {
      expect(listModelProviders()).toContain("qwen");
    });
  });

  it("sends codex collaboration mode with the next message instead of calling setCollaborationMode on toggle", async () => {
    const threadId = "thread-codex-mode-send";
    window.history.replaceState(null, "", `/threads/${threadId}`);

    threadsFixture = {
      ok: true,
      data: [
        {
          id: threadId,
          provider: "codex",
          preview: "codex thread",
          title: "codex thread",
          createdAt: 1700000000,
          updatedAt: 1700000001,
          cwd: "/tmp/project",
          source: "codex",
          isGenerating: false,
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    readThreadResolver = (targetThreadId: string) => ({
      ok: true,
      thread: buildConversationStateFixture(targetThreadId, "gpt-5.3-codex"),
    });

    liveStateResolver = (targetThreadId: string, _provider: ProviderId) => ({
      kind: "readLiveState",
      threadId: targetThreadId,
      ownerClientId: "client-1",
      conversationState: buildConversationStateFixture(
        targetThreadId,
        "gpt-5.3-codex",
      ),
      liveStateError: null,
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Plan" }));

    const setModeCallsAfterToggle = vi
      .mocked(fetch)
      .mock.calls.filter(([, requestInit]) => {
        if (!requestInit || typeof requestInit.body !== "string") {
          return false;
        }
        const parsed = JSON.parse(requestInit.body) as { kind?: string };
        return parsed.kind === "setCollaborationMode";
      });
    expect(setModeCallsAfterToggle).toHaveLength(0);

    const composer = await screen.findByPlaceholderText("Message Codex…");
    fireEvent.change(composer, { target: { value: "continue" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(
        vi.mocked(fetch).mock.calls.some(([, requestInit]) => {
          if (!requestInit || typeof requestInit.body !== "string") {
            return false;
          }
          const parsed = JSON.parse(requestInit.body) as {
            kind?: string;
            collaborationMode?: {
              mode?: string;
            };
          };
          return (
            parsed.kind === "sendMessage" &&
            parsed.collaborationMode?.mode === "plan"
          );
        }),
      ).toBe(true);
    });

    expect(
      screen.queryByText(/Feature setCollaborationMode is unavailable for codex/),
    ).toBeNull();
  });

  it("does not call setCollaborationMode when switching to a provider that does not support it", async () => {
    threadsFixture = {
      ok: true,
      data: [
        {
          id: "thread-codex-mode",
          provider: "codex",
          preview: "codex thread",
          title: "codex thread",
          createdAt: 1700000000,
          updatedAt: 1700000001,
          cwd: "/tmp/project",
          source: "codex",
        },
        {
          id: "thread-opencode-mode",
          provider: "opencode",
          preview: "opencode thread",
          title: "opencode thread",
          createdAt: 1700000000,
          updatedAt: 1700000000,
          cwd: "/tmp/project",
          source: "opencode",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    readThreadResolver = (threadId: string, provider: ProviderId | null) => {
      const resolvedProvider = provider ?? "codex";
      const modelId =
        resolvedProvider === "opencode" ? "openai/gpt-4.1" : "gpt-5.3-codex";
      return {
        ok: true,
        thread: buildConversationStateFixture(threadId, modelId, {
          provider: resolvedProvider,
        }),
      };
    };

    render(<App />);

    fireEvent.click((await screen.findAllByText("codex thread"))[0]!);
    fireEvent.click((await screen.findAllByText("opencode thread"))[0]!);

    await waitFor(() => {
      expect(
        vi.mocked(fetch).mock.calls.some(([, requestInit]) => {
          if (!requestInit || typeof requestInit.body !== "string") {
            return false;
          }
          const parsed = JSON.parse(requestInit.body) as { kind?: string };
          return parsed.kind === "setCollaborationMode";
        }),
      ).toBe(false);
    });

    expect(
      screen.queryByText(/Feature setCollaborationMode is unavailable for/),
    ).toBeNull();
  });

  it("keeps image attachments enabled for non-codex threads", async () => {
    threadsFixture = {
      ok: true,
      data: [
        {
          id: "thread-codex-images",
          provider: "codex",
          preview: "codex thread",
          title: "codex thread",
          createdAt: 1700000000,
          updatedAt: 1700000001,
          cwd: "/tmp/project",
          source: "codex",
        },
        {
          id: "thread-claude-images",
          provider: "claude",
          preview: "claude thread",
          title: "claude thread",
          createdAt: 1700000000,
          updatedAt: 1700000000,
          cwd: "/tmp/project",
          source: "claude",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    featureMatrixFixture.features.claude = buildFeatureSet(codexCapabilities, {
      enabled: true,
      connected: true,
    });

    readThreadResolver = (threadId: string, provider: ProviderId | null) => {
      const resolvedProvider = provider ?? "codex";
      const modelId =
        resolvedProvider === "claude" ? "default" : "gpt-5.3-codex";
      return {
        ok: true,
        thread: buildConversationStateFixture(threadId, modelId, {
          provider: resolvedProvider,
        }),
      };
    };

    liveStateResolver = (threadId: string, provider: ProviderId) => {
      const modelId = provider === "claude" ? "default" : "gpt-5.3-codex";
      return {
        kind: "readLiveState",
        threadId,
        ownerClientId: "client-1",
        conversationState: buildConversationStateFixture(threadId, modelId, {
          provider,
        }),
        liveStateError: null,
      };
    };

    render(<App />);

    fireEvent.click((await screen.findAllByText("codex thread"))[0]!);

    const attachButton = await screen.findByRole("button", {
      name: "Attach images",
    });
    expect(attachButton.hasAttribute("disabled")).toBe(false);

    fireEvent.click((await screen.findAllByText("claude thread"))[0]!);

    await waitFor(() => {
      expect(
        screen
          .getByRole("button", {
            name: "Attach images",
          })
          .hasAttribute("disabled"),
      ).toBe(false);
    });
  });

  it("allows pasted images for non-codex threads", async () => {
    const threadId = "thread-claude-images";
    window.history.replaceState(null, "", `/threads/${threadId}`);

    threadsFixture = {
      ok: true,
      data: [
        {
          id: threadId,
          provider: "claude",
          preview: "claude thread",
          title: "claude thread",
          createdAt: 1700000000,
          updatedAt: 1700000000,
          cwd: "/tmp/project",
          source: "claude",
          isGenerating: false,
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    featureMatrixFixture.features.claude = buildFeatureSet(codexCapabilities, {
      enabled: true,
      connected: true,
    });

    readThreadResolver = (targetThreadId: string, provider: ProviderId | null) => ({
      ok: true,
      thread: buildConversationStateFixture(targetThreadId, "default", {
        provider: provider ?? "claude",
      }),
    });

    liveStateResolver = (targetThreadId: string, provider: ProviderId) => ({
      kind: "readLiveState",
      threadId: targetThreadId,
      ownerClientId: "client-1",
      conversationState: buildConversationStateFixture(targetThreadId, "default", {
        provider,
      }),
      liveStateError: null,
    });

    render(<App />);

    const composer = await screen.findByPlaceholderText("Message Claude Code…");
    const imageFile = new File(["binary"], "example.png", {
      type: "image/png",
    });

    fireEvent.paste(composer, {
      clipboardData: {
        files: [imageFile],
      },
    });

    expect(await screen.findByAltText("example.png")).toBeTruthy();
  });

  it("shows waiting indicators in the sidebar from thread summaries", async () => {
    threadsFixture = {
      ok: true,
      data: [
        {
          id: "thread-waiting",
          provider: "codex",
          preview: "thread preview",
          createdAt: 1700000000,
          updatedAt: 1700000000,
          cwd: "/tmp/project",
          source: "codex",
          waitingOnApproval: true,
          waitingOnUserInput: true,
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    render(<App />);

    expect(await screen.findByTitle("Waiting for approval")).toBeTruthy();
    expect(await screen.findByTitle("Waiting for user input")).toBeTruthy();
  });

  it("shows waiting indicators in the sidebar for selected thread live requests", async () => {
    const threadId = "thread-live-waiting";
    const approvalRequest: UnifiedThreadFixture["requests"][number] = {
      id: "approval-live-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId,
        turnId: "turn-1",
        itemId: "item-approval-live-1",
        reason: "Need approval",
      },
    };
    const userInputRequest: UnifiedThreadFixture["requests"][number] = {
      id: "request-user-input-live-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId,
        turnId: "turn-1",
        itemId: "item-user-input-live-1",
        questions: [
          {
            id: "question-live-1",
            header: "Question",
            question: "Choose",
            isOther: false,
            isSecret: false,
            options: [
              { label: "A", description: "Pick A" },
              { label: "B", description: "Pick B" },
            ],
          },
        ],
      },
    };

    threadsFixture = {
      ok: true,
      data: [
        {
          id: threadId,
          provider: "codex",
          preview: "thread preview",
          createdAt: 1700000000,
          updatedAt: 1700000000,
          cwd: "/tmp/project",
          source: "codex",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    readThreadResolver = (targetThreadId: string) => ({
      ok: true,
      thread: buildConversationStateFixture(targetThreadId, "gpt-old-codex", {
        customRequests: [approvalRequest, userInputRequest],
      }),
    });

    liveStateResolver = (targetThreadId: string, _provider: ProviderId) => ({
      kind: "readLiveState",
      threadId: targetThreadId,
      ownerClientId: "client-1",
      conversationState: buildConversationStateFixture(
        targetThreadId,
        "gpt-old-codex",
        {
          customRequests: [approvalRequest, userInputRequest],
        },
      ),
      liveStateError: null,
    });

    render(<App />);

    expect(await screen.findByTitle("Waiting for approval")).toBeTruthy();
    expect(await screen.findByTitle("Waiting for user input")).toBeTruthy();
  });

  it("shows a runtime status banner while a thread is responding", async () => {
    const threadId = "thread-responding";
    const respondingThread: UnifiedThreadFixture = {
      id: threadId,
      provider: "codex",
      turns: [
        {
          id: "turn-1",
          status: "inProgress",
          items: [],
        },
      ],
      requests: [],
      updatedAt: 1700000000,
      latestModel: "gpt-5.3-codex",
      latestReasoningEffort: "medium",
      latestCollaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoningEffort: "medium",
          developerInstructions: null,
        },
      },
    };

    threadsFixture = {
      ok: true,
      data: [
        {
          id: threadId,
          provider: "codex",
          preview: "thread preview",
          createdAt: 1700000000,
          updatedAt: 1700000000,
          cwd: "/tmp/project",
          source: "codex",
          isGenerating: true,
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    readThreadResolver = (targetThreadId: string) => ({
      ok: true,
      thread: {
        ...respondingThread,
        id: targetThreadId,
      },
    });

    liveStateResolver = (targetThreadId: string, _provider: ProviderId) => ({
      kind: "readLiveState",
      threadId: targetThreadId,
      ownerClientId: "client-1",
      conversationState: {
        ...respondingThread,
        id: targetThreadId,
      },
      liveStateError: null,
    });

    render(<App />);

    expect(await screen.findAllByText("Responding")).toHaveLength(2);
  });

  it("does not show responding for an old thread when only read history is stuck in progress", async () => {
    const threadId = "thread-stale-progress";
    window.history.replaceState(null, "", `/threads/${threadId}`);

    threadsFixture = {
      ok: true,
      data: [
        {
          id: threadId,
          provider: "codex",
          preview: "thread preview",
          createdAt: 1700000000,
          updatedAt: 1700000000,
          cwd: "/tmp/project",
          source: "codex",
          isGenerating: false,
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    readThreadResolver = (targetThreadId: string) => ({
      ok: true,
      thread: {
        id: targetThreadId,
        provider: "codex",
        turns: [
          {
            id: "turn-1",
            status: "inProgress",
            items: [],
          },
        ],
        requests: [],
        updatedAt: 1700000000,
        latestModel: "gpt-5.3-codex",
        latestReasoningEffort: "medium",
        latestCollaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
            developerInstructions: null,
          },
        },
      },
    });

    liveStateResolver = (targetThreadId: string, _provider: ProviderId) => ({
      kind: "readLiveState",
      threadId: targetThreadId,
      ownerClientId: null,
      conversationState: null,
      liveStateError: null,
    });

    render(<App />);

    await waitFor(() => {
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([requestUrl]) =>
            String(requestUrl).includes(`/api/unified/thread/${threadId}`),
          ),
      ).toBe(true);
    });
    expect(screen.queryByText("Responding")).toBeNull();
  });

  it("shows send-message errors in the compact chat status line", async () => {
    const threadId = "thread-send-error";
    window.history.replaceState(null, "", `/threads/${threadId}`);

    threadsFixture = {
      ok: true,
      data: [
        {
          id: threadId,
          provider: "codex",
          preview: "thread preview",
          createdAt: 1700000000,
          updatedAt: 1700000000,
          cwd: "/tmp/project",
          source: "codex",
          isGenerating: false,
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    readThreadResolver = (targetThreadId: string) => ({
      ok: true,
      thread: buildConversationStateFixture(targetThreadId, "gpt-5.3-codex"),
    });

    liveStateResolver = (targetThreadId: string, _provider: ProviderId) => ({
      kind: "readLiveState",
      threadId: targetThreadId,
      ownerClientId: "client-1",
      conversationState: buildConversationStateFixture(
        targetThreadId,
        "gpt-5.3-codex",
      ),
      liveStateError: null,
    });

    sendMessageErrorFixture = "Network request failed";

    render(<App />);

    const composer = await screen.findByPlaceholderText("Message Codex…");
    fireEvent.change(composer, { target: { value: "continue" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(
      await screen.findByText(
        "Error: Request failed. Check network/server, then send again.",
      ),
    ).toBeTruthy();
  });

  it("shows actionable model-call errors in the compact chat status line", async () => {
    const threadId = "thread-model-error";
    window.history.replaceState(null, "", `/threads/${threadId}`);

    threadsFixture = {
      ok: true,
      data: [
        {
          id: threadId,
          provider: "codex",
          preview: "thread preview",
          createdAt: 1700000000,
          updatedAt: 1700000000,
          cwd: "/tmp/project",
          source: "codex",
          isGenerating: false,
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    readThreadResolver = (targetThreadId: string) => ({
      ok: true,
      thread: buildConversationStateFixture(targetThreadId, "gpt-5.3-codex"),
    });

    liveStateResolver = (targetThreadId: string, _provider: ProviderId) => ({
      kind: "readLiveState",
      threadId: targetThreadId,
      ownerClientId: "client-1",
      conversationState: buildConversationStateFixture(
        targetThreadId,
        "gpt-5.3-codex",
      ),
      liveStateError: null,
    });

    sendMessageErrorFixture = "Model call failed";

    render(<App />);

    const composer = await screen.findByPlaceholderText("Message Codex…");
    fireEvent.change(composer, { target: { value: "continue" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(
      await screen.findByText(
        "Error: Model call failed. Send again. If it keeps failing, switch model or check the provider/server status.",
      ),
    ).toBeTruthy();
  });

  it("uses metadata-only refresh when revisiting a cached thread", async () => {
    threadsFixture = {
      ok: true,
      data: [
        {
          id: "thread-a",
          provider: "codex",
          preview: "thread a",
          title: "Thread A",
          createdAt: 1700000000,
          updatedAt: 1700000001,
          cwd: "/tmp/project",
          source: "codex",
        },
        {
          id: "thread-b",
          provider: "codex",
          preview: "thread b",
          title: "Thread B",
          createdAt: 1700000000,
          updatedAt: 1700000002,
          cwd: "/tmp/project",
          source: "codex",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    readThreadResolver = (targetThreadId: string) => ({
      ok: true,
      thread: buildConversationStateFixture(targetThreadId, "gpt-5.3-codex"),
    });

    liveStateResolver = (targetThreadId: string, _provider: ProviderId) => ({
      kind: "readLiveState",
      threadId: targetThreadId,
      ownerClientId: "client-1",
      conversationState: buildConversationStateFixture(
        targetThreadId,
        "gpt-5.3-codex",
      ),
      liveStateError: null,
    });

    render(<App />);

    await screen.findAllByText("Thread B");

    fireEvent.click(screen.getAllByText("Thread A")[0]!);
    await waitFor(() => {
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([requestUrl]) =>
            String(requestUrl).includes("/api/unified/thread/thread-a"),
          ),
      ).toBe(true);
    });

    fireEvent.click(screen.getAllByText("Thread B")[0]!);
    await waitFor(() => {
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([requestUrl]) =>
            String(requestUrl).includes("/api/unified/thread/thread-b"),
          ),
      ).toBe(true);
    });

    fireEvent.click(screen.getAllByText("Thread A")[0]!);
    await waitFor(() => {
      expect(
        vi.mocked(fetch).mock.calls.some(([requestUrl]) => {
          const url = String(requestUrl);
          return (
            url.includes("/api/unified/thread/thread-a") &&
            url.includes("includeTurns=0")
          );
        }),
      ).toBe(true);
    });
  });

  it("prefers live-state requests when read thread is newer but has no pending requests", async () => {
    const threadId = "thread-live-approval-preferred";
    const approvalRequest: UnifiedThreadFixture["requests"][number] = {
      id: "approval-live-priority-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId,
        turnId: "turn-1",
        itemId: "item-approval-live-priority-1",
        reason: "Need approval from live state",
      },
    };

    threadsFixture = {
      ok: true,
      data: [
        {
          id: threadId,
          provider: "codex",
          preview: "thread preview",
          createdAt: 1700000000,
          updatedAt: 1700000002,
          cwd: "/tmp/project",
          source: "codex",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    readThreadResolver = (targetThreadId: string) => ({
      ok: true,
      thread: buildConversationStateFixture(targetThreadId, "gpt-old-codex", {
        updatedAt: 1700000002,
        customRequests: [],
      }),
    });

    liveStateResolver = (targetThreadId: string, _provider: ProviderId) => ({
      kind: "readLiveState",
      threadId: targetThreadId,
      ownerClientId: "client-1",
      conversationState: buildConversationStateFixture(
        targetThreadId,
        "gpt-old-codex",
        {
          updatedAt: 1700000001,
          customRequests: [approvalRequest],
        },
      ),
      liveStateError: null,
    });

    render(<App />);

    expect(await screen.findByText("Approval Needed")).toBeTruthy();
    expect(await screen.findByText("Need approval from live state")).toBeTruthy();
    expect(await screen.findByTitle("Waiting for approval")).toBeTruthy();
  });

  it("keeps a direct thread route selected when it is readable but not in current thread list page", async () => {
    const threadId = "thread-direct-route";
    window.history.replaceState(null, "", `/threads/${threadId}`);

    threadsFixture = {
      ok: true,
      data: [
        {
          id: "thread-listed",
          provider: "codex",
          preview: "listed thread",
          createdAt: 1700000000,
          updatedAt: 1700000001,
          cwd: "/tmp/project",
          source: "codex",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    readThreadResolver = (
      targetThreadId: string,
      provider: ProviderId | null,
    ) => {
      if (targetThreadId === threadId) {
        return {
          ok: true,
          thread: buildConversationStateFixture(targetThreadId, "gpt-old-codex", {
            provider: provider ?? "codex",
            turnItems: [
              {
                id: "agent-hello-1",
                type: "agentMessage",
                text: "direct-route-loaded",
              },
            ],
          }),
        };
      }
      if (targetThreadId === "thread-listed") {
        return {
          ok: true,
          thread: buildConversationStateFixture(targetThreadId, "gpt-old-codex", {
            provider: provider ?? "codex",
            turnItems: [
              {
                id: "agent-listed-1",
                type: "agentMessage",
                text: "listed-thread-loaded",
              },
            ],
          }),
        };
      }
      return null;
    };

    render(<App />);

    expect(await screen.findByText("direct-route-loaded")).toBeTruthy();
    await waitFor(() =>
      expect(window.location.pathname).toBe(`/threads/${threadId}`),
    );
    expect(screen.queryByText("listed-thread-loaded")).toBeNull();
  });

  it("does not auto-switch to another listed thread when route thread is missing", async () => {
    const missingThreadId = "thread-missing-route";
    const listedThreadId = "thread-listed";
    window.history.replaceState(null, "", `/threads/${missingThreadId}`);

    threadsFixture = {
      ok: true,
      data: [
        {
          id: listedThreadId,
          provider: "codex",
          preview: "listed thread",
          createdAt: 1700000000,
          updatedAt: 1700000001,
          cwd: "/tmp/project",
          source: "codex",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    readThreadResolver = (
      targetThreadId: string,
      provider: ProviderId | null,
    ) => {
      if (targetThreadId !== listedThreadId) {
        return null;
      }
      return {
        ok: true,
        thread: buildConversationStateFixture(
          listedThreadId,
          "gpt-old-codex",
          {
            provider: provider ?? "codex",
            turnItems: [
              {
                id: "agent-listed-1",
                type: "agentMessage",
                text: "listed-thread-loaded",
              },
            ],
          },
        ),
      };
    };

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "project" }));
    expect(await screen.findByText("listed thread")).toBeTruthy();
    await waitFor(() =>
      expect(window.location.pathname).toBe(`/threads/${missingThreadId}`),
    );
    expect(screen.queryByText("listed-thread-loaded")).toBeNull();
  });

  it("hides mode controls when capability is disabled", async () => {
    featureMatrixFixture = {
      ok: true,
      features: {
        codex: buildFeatureSet(codexCapabilities, {
          enabled: false,
          connected: false,
        }),
        opencode: buildFeatureSet(opencodeCapabilities, {
          enabled: true,
          connected: true,
        }),
        claude: buildFeatureSet(codexCapabilities, {
          enabled: false,
          connected: false,
        }),
        qwen: buildFeatureSet(codexCapabilities, {
          enabled: false,
          connected: false,
        }),
      },
    };

    render(<App />);
    await screen.findAllByText("Chresmus");
    expect(screen.queryByText("Plan")).toBeNull();
  });

  it("shows mode controls when capability is enabled", async () => {
    render(<App />);
    expect(await screen.findByText("Plan")).toBeTruthy();
  });

  it("shows project group labels from cwd basename", async () => {
    threadsFixture = {
      ok: true,
      data: [
        {
          id: "thread-site",
          provider: "codex",
          preview: "thread in renamed project",
          createdAt: 1700000000,
          updatedAt: 1700000001,
          cwd: "/tmp/site",
          source: "codex",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    render(<App />);
    expect(await screen.findByRole("button", { name: "site" })).toBeTruthy();
  });

  it("keeps manual group order over automatic recency sort", async () => {
    localStorageBacking.set(
      "chresmus.sidebar.order.v1",
      JSON.stringify(["project:/tmp/proj-b", "project:/tmp/proj-a"]),
    );

    threadsFixture = {
      ok: true,
      data: [
        {
          id: "thread-a",
          provider: "codex",
          preview: "alpha thread",
          createdAt: 1700000000,
          updatedAt: 1700000100,
          cwd: "/tmp/proj-a",
          source: "codex",
        },
        {
          id: "thread-b",
          provider: "codex",
          preview: "beta thread",
          createdAt: 1700000000,
          updatedAt: 1700000005,
          cwd: "/tmp/proj-b",
          source: "codex",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    render(<App />);

    const projA = await screen.findByRole("button", { name: "proj-a" });
    const projB = await screen.findByRole("button", { name: "proj-b" });

    expect(
      projB.compareDocumentPosition(projA) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows thread title when provided", async () => {
    threadsFixture = {
      ok: true,
      data: [
        {
          id: "thread-title",
          provider: "codex",
          preview: "preview text",
          title: "Pretty Thread Name",
          createdAt: 1700000000,
          updatedAt: 1700000001,
          cwd: "/tmp/project",
          source: "codex",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    render(<App />);
    const matches = await screen.findAllByText("Pretty Thread Name");
    expect(matches.length).toBeGreaterThan(0);
  });

  it("orders threads by recency and shows spinner for non-selected running thread", async () => {
    threadsFixture = {
      ok: true,
      data: [
        {
          id: "thread-old",
          provider: "codex",
          preview: "older thread",
          createdAt: 1700000000,
          updatedAt: 1700000001,
          isGenerating: true,
          cwd: "/tmp/project",
          source: "codex",
        },
        {
          id: "thread-new",
          provider: "codex",
          preview: "newer thread",
          createdAt: 1700000000,
          updatedAt: 1700000010,
          cwd: "/tmp/project",
          source: "codex",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    render(<App />);

    const newer = (await screen.findAllByText("newer thread"))[0];
    const older = (await screen.findAllByText("older thread"))[0];
    if (!newer || !older) {
      throw new Error("Missing thread labels");
    }
    const newerButton = newer.closest("button");
    const olderButton = older.closest("button");

    expect(newerButton).toBeTruthy();
    expect(olderButton).toBeTruthy();
    if (!newerButton || !olderButton) {
      throw new Error("Missing thread buttons in sidebar");
    }
    expect(
      newerButton.compareDocumentPosition(olderButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(olderButton.querySelector("svg.animate-spin")).toBeTruthy();
  });

  it("updates the picker when remote model changes with same updatedAt and turns", async () => {
    const threadId = "thread-1";
    let modelId = "gpt-old-codex";
    let liveStateCallCount = 0;
    let readThreadCallCount = 0;
    let latestObservedModel = "";

    threadsFixture = {
      ok: true,
      data: [
        {
          id: threadId,
          provider: "codex",
          preview: "thread preview",
          createdAt: 1700000000,
          updatedAt: 1700000000,
          cwd: "/tmp/project",
          source: "codex",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    modelsFixture = {
      codex: [
        {
          id: "gpt-old-codex",
          displayName: "gpt-old-codex",
          description: "Old model",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["medium"],
          hidden: false,
          isDefault: false,
        },
        {
          id: "gpt-new-codex",
          displayName: "gpt-new-codex",
          description: "New model",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["medium"],
          hidden: false,
          isDefault: true,
        },
      ],
      opencode: [],
      claude: [],
      qwen: [],
    };

    readThreadResolver = (targetThreadId: string) => ({
      ok: true,
      thread: (() => {
        readThreadCallCount += 1;
        latestObservedModel = modelId;
        return buildConversationStateFixture(targetThreadId, modelId);
      })(),
    });

    liveStateResolver = (targetThreadId: string, _provider: ProviderId) => ({
      kind: "readLiveState",
      threadId: targetThreadId,
      ownerClientId: "client-1",
      conversationState: (() => {
        liveStateCallCount += 1;
        latestObservedModel = modelId;
        return buildConversationStateFixture(targetThreadId, modelId);
      })(),
      liveStateError: null,
    });

    render(<App />);
    await waitFor(() => {
      expect(liveStateCallCount + readThreadCallCount).toBeGreaterThan(0);
    });
    expect(latestObservedModel).toBe("gpt-old-codex");

    modelId = "gpt-new-codex";

    MockEventSource.emit({
      kind: "threadUpdated",
      threadId,
      provider: "codex",
      thread: buildConversationStateFixture(threadId, modelId),
    });

    await waitFor(
      () => {
        expect(latestObservedModel).toBe("gpt-new-codex");
      },
      { timeout: 5000 },
    );
    expect(latestObservedModel).toBe("gpt-new-codex");
  }, 15000);

  it("uses live pending requests when live reduction fails", async () => {
    const threadId = "thread-with-request";

    threadsFixture = {
      ok: true,
      data: [
        {
          id: threadId,
          provider: "codex",
          preview: "thread preview",
          createdAt: 1700000000,
          updatedAt: 1700000000,
          cwd: "/tmp/project",
          source: "codex",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    readThreadResolver = (targetThreadId: string) => ({
      ok: true,
      thread: buildConversationStateFixture(targetThreadId, "gpt-old-codex", {
        updatedAt: 1700000000,
        includePendingRequest: true,
      }),
    });

    liveStateResolver = (targetThreadId: string, _provider: ProviderId) => ({
      kind: "readLiveState",
      threadId: targetThreadId,
      ownerClientId: "client-1",
      conversationState: buildConversationStateFixture(
        targetThreadId,
        "gpt-old-codex",
        {
          updatedAt: 1700000500,
          includePendingRequest: false,
        },
      ),
      liveStateError: {
        kind: "reductionFailed",
        message: "failed to reduce",
        eventIndex: 2,
        patchIndex: 0,
      },
    });

    render(<App />);

    expect(
      await screen.findByText("Live updates failed for this thread."),
    ).toBeTruthy();
    expect(screen.queryByText("Pick one option")).toBeNull();
    expect(screen.queryByText("Option A")).toBeNull();
    expect(screen.queryByText("Option B")).toBeNull();
  });

  it("uses live thread requests when live and read timestamps match", async () => {
    const threadId = "thread-stale-live-request";
    const approvalRequest: UnifiedThreadFixture["requests"][number] = {
      id: "approval-stale-live-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId,
        turnId: "turn-1",
        itemId: "item-approval-stale-live-1",
        reason: "stale request",
      },
    };

    threadsFixture = {
      ok: true,
      data: [
        {
          id: threadId,
          provider: "codex",
          preview: "thread preview",
          waitingOnApproval: false,
          waitingOnUserInput: false,
          createdAt: 1700000000,
          updatedAt: 1700000000,
          cwd: "/tmp/project",
          source: "codex",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    readThreadResolver = (targetThreadId: string) => ({
      ok: true,
      thread: buildConversationStateFixture(targetThreadId, "gpt-old-codex", {
        updatedAt: 1700000000,
        customRequests: [],
      }),
    });

    liveStateResolver = (targetThreadId: string, _provider: ProviderId) => ({
      kind: "readLiveState",
      threadId: targetThreadId,
      ownerClientId: "client-1",
      conversationState: buildConversationStateFixture(
        targetThreadId,
        "gpt-old-codex",
        {
          updatedAt: 1700000000,
          customRequests: [approvalRequest],
        },
      ),
      liveStateError: null,
    });

    render(<App />);

    expect((await screen.findAllByText("thread preview")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Approval Needed")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("uses live thread requests when live and read timestamps match and sidebar is waiting", async () => {
    const threadId = "thread-live-request-while-waiting";
    const approvalRequest: UnifiedThreadFixture["requests"][number] = {
      id: "approval-live-while-waiting-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId,
        turnId: "turn-1",
        itemId: "item-approval-live-while-waiting-1",
        reason: "needs approval",
      },
    };

    threadsFixture = {
      ok: true,
      data: [
        {
          id: threadId,
          provider: "codex",
          preview: "thread preview",
          waitingOnApproval: true,
          waitingOnUserInput: false,
          createdAt: 1700000000,
          updatedAt: 1700000000,
          cwd: "/tmp/project",
          source: "codex",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    readThreadResolver = (targetThreadId: string) => ({
      ok: true,
      thread: buildConversationStateFixture(targetThreadId, "gpt-old-codex", {
        updatedAt: 1700000000,
        customRequests: [],
      }),
    });

    liveStateResolver = (targetThreadId: string, _provider: ProviderId) => ({
      kind: "readLiveState",
      threadId: targetThreadId,
      ownerClientId: "client-1",
      conversationState: buildConversationStateFixture(
        targetThreadId,
        "gpt-old-codex",
        {
          updatedAt: 1700000000,
          customRequests: [approvalRequest],
        },
      ),
      liveStateError: null,
    });

    render(<App />);

    expect(await screen.findByText("Approval Needed")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("shows approval requests from thread state and submits approve decisions", async () => {
    const threadId = "thread-with-approval-request";
    const approvalRequest: UnifiedThreadFixture["requests"][number] = {
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId,
        turnId: "turn-1",
        itemId: "item-approval-1",
        reason: "Need elevated permission",
      },
    };

    threadsFixture = {
      ok: true,
      data: [
        {
          id: threadId,
          provider: "codex",
          preview: "thread preview",
          createdAt: 1700000000,
          updatedAt: 1700000000,
          cwd: "/tmp/project",
          source: "codex",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    readThreadResolver = (targetThreadId: string) => ({
      ok: true,
      thread: buildConversationStateFixture(targetThreadId, "gpt-old-codex", {
        customRequests: [approvalRequest],
      }),
    });

    liveStateResolver = (targetThreadId: string, _provider: ProviderId) => ({
      kind: "readLiveState",
      threadId: targetThreadId,
      ownerClientId: "client-1",
      conversationState: buildConversationStateFixture(
        targetThreadId,
        "gpt-old-codex",
        {
          customRequests: [approvalRequest],
        },
      ),
      liveStateError: null,
    });

    render(<App />);

    expect(await screen.findByText("Approval Needed")).toBeTruthy();
    expect(
      await screen.findByText("item/commandExecution/requestApproval"),
    ).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Deny" })).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    type UnifiedCommandPayload = {
      kind?: string;
      ownerClientId?: string;
      requestId?: string | number;
      response?: {
        decision?: JsonValue;
      };
    };

    await waitFor(() => {
      const payloads = vi
        .mocked(fetch)
        .mock
        .calls
        .filter(([input]) => String(input).includes("/api/unified/command"))
        .map(([, init]) =>
          JSON.parse(String(init?.body ?? "{}")) as UnifiedCommandPayload,
        );

      const submitCommand =
        payloads.find(
          (payload) =>
            payload.kind === "submitUserInput" &&
            payload.requestId === "approval-1",
        ) ?? null;

      expect(submitCommand).not.toBeNull();
      expect(submitCommand?.ownerClientId).toBe("client-1");
      expect(submitCommand?.response?.decision).toBe("accept");
    });
  });

  it("submits structured approval decisions from available decisions", async () => {
    const threadId = "thread-with-structured-approval";
    const approvalDecision = {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ["uv run"],
      },
    };
    const approvalRequest: UnifiedThreadFixture["requests"][number] = {
      id: "approval-structured-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId,
        turnId: "turn-1",
        itemId: "item-approval-structured-1",
        reason: "Need policy approval",
        availableDecisions: [approvalDecision, "decline", "cancel"],
      },
    };

    threadsFixture = {
      ok: true,
      data: [
        {
          id: threadId,
          provider: "codex",
          preview: "thread preview",
          createdAt: 1700000000,
          updatedAt: 1700000000,
          cwd: "/tmp/project",
          source: "codex",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    readThreadResolver = (targetThreadId: string) => ({
      ok: true,
      thread: buildConversationStateFixture(targetThreadId, "gpt-old-codex", {
        customRequests: [approvalRequest],
      }),
    });

    liveStateResolver = (targetThreadId: string, _provider: ProviderId) => ({
      kind: "readLiveState",
      threadId: targetThreadId,
      ownerClientId: "client-1",
      conversationState: buildConversationStateFixture(
        targetThreadId,
        "gpt-old-codex",
        {
          customRequests: [approvalRequest],
        },
      ),
      liveStateError: null,
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    type UnifiedCommandPayload = {
      kind?: string;
      ownerClientId?: string;
      requestId?: string | number;
      response?: {
        decision?: JsonValue;
      };
    };

    await waitFor(() => {
      const payloads = vi
        .mocked(fetch)
        .mock
        .calls
        .filter(([input]) => String(input).includes("/api/unified/command"))
        .map(([, init]) =>
          JSON.parse(String(init?.body ?? "{}")) as UnifiedCommandPayload,
        );

      const submitCommand =
        payloads.find(
          (payload) =>
            payload.kind === "submitUserInput" &&
            payload.requestId === "approval-structured-1",
        ) ?? null;

      expect(submitCommand).not.toBeNull();
      expect(submitCommand?.ownerClientId).toBe("client-1");
      expect(submitCommand?.response?.decision).toEqual(approvalDecision);
    });
  });

  it("uses live turn items when live reduction fails", async () => {
    const threadId = "thread-missing-commands";
    const commandItem: UnifiedItem = {
      id: "command-1",
      type: "commandExecution",
      command: "npm run test",
      status: "completed",
      aggregatedOutput: "ok",
      exitCode: 0,
      durationMs: 123,
    };

    threadsFixture = {
      ok: true,
      data: [
        {
          id: threadId,
          provider: "codex",
          preview: "thread preview",
          createdAt: 1700000000,
          updatedAt: 1700000500,
          cwd: "/tmp/project",
          source: "codex",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    readThreadResolver = (targetThreadId: string) => ({
      ok: true,
      thread: buildConversationStateFixture(targetThreadId, "gpt-old-codex", {
        updatedAt: 1700000000,
        turnItems: [commandItem],
      }),
    });

    liveStateResolver = (targetThreadId: string, _provider: ProviderId) => ({
      kind: "readLiveState",
      threadId: targetThreadId,
      ownerClientId: "client-1",
      conversationState: buildConversationStateFixture(
        targetThreadId,
        "gpt-old-codex",
        {
          updatedAt: 1700000500,
          turnItems: [],
        },
      ),
      liveStateError: {
        kind: "reductionFailed",
        message: "failed to reduce",
        eventIndex: 3,
        patchIndex: 1,
      },
    });

    render(<App />);

    expect(
      await screen.findByText("Live updates failed for this thread."),
    ).toBeTruthy();
    expect(screen.queryByText("npm run test")).toBeNull();
  });

  it("renders thread items from live state when live state is healthy", async () => {
    const threadId = "thread-live-extends-turn";

    threadsFixture = {
      ok: true,
      data: [
        {
          id: threadId,
          provider: "codex",
          preview: "thread preview",
          createdAt: 1700000000,
          updatedAt: 1700000500,
          cwd: "/tmp/project",
          source: "codex",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    readThreadResolver = (targetThreadId: string) => ({
      ok: true,
      thread: buildConversationStateFixture(targetThreadId, "gpt-old-codex", {
        updatedAt: 1700000000,
        turnItems: [
          {
            id: "agent-read-1",
            type: "agentMessage",
            text: "read-canonical-item",
          },
        ],
      }),
    });

    liveStateResolver = (targetThreadId: string, _provider: ProviderId) => ({
      kind: "readLiveState",
      threadId: targetThreadId,
      ownerClientId: "client-1",
      conversationState: buildConversationStateFixture(
        targetThreadId,
        "gpt-old-codex",
        {
          updatedAt: 1700000500,
          turnItems: [
            {
              id: "command-live-1",
              type: "commandExecution",
              command: "npm run lint",
              status: "inProgress",
              aggregatedOutput: "",
              exitCode: null,
              durationMs: null,
            },
          ],
        },
      ),
      liveStateError: null,
    });

    render(<App />);

    expect((await screen.findAllByText("npm run lint")).length).toBeGreaterThan(0);
    expect(screen.queryByText("read-canonical-item")).toBeNull();
  });

  it("does not restore read command items when live reduction fails", async () => {
    const threadId = "thread-live-longer-but-missing-command";
    const commandItem: UnifiedItem = {
      id: "command-keep-1",
      type: "commandExecution",
      command: "git status --short",
      status: "completed",
      aggregatedOutput: " M apps/web/src/App.tsx",
      exitCode: 0,
      durationMs: 44,
    };

    threadsFixture = {
      ok: true,
      data: [
        {
          id: threadId,
          provider: "codex",
          preview: "thread preview",
          createdAt: 1700000000,
          updatedAt: 1700000500,
          cwd: "/tmp/project",
          source: "codex",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    readThreadResolver = (targetThreadId: string) => ({
      ok: true,
      thread: buildConversationStateFixture(targetThreadId, "gpt-old-codex", {
        updatedAt: 1700000000,
        turnItems: [commandItem],
      }),
    });

    liveStateResolver = (targetThreadId: string, _provider: ProviderId) => ({
      kind: "readLiveState",
      threadId: targetThreadId,
      ownerClientId: "client-1",
      conversationState: buildConversationStateFixture(
        targetThreadId,
        "gpt-old-codex",
        {
          updatedAt: 1700000500,
          turnItems: [
            {
              id: "agent-1",
              type: "agentMessage",
              text: "Update 1",
            },
            {
              id: "agent-2",
              type: "agentMessage",
              text: "Update 2",
            },
          ],
        },
      ),
      liveStateError: {
        kind: "reductionFailed",
        message: "failed to reduce",
        eventIndex: 5,
        patchIndex: 2,
      },
    });

    render(<App />);

    expect(
      await screen.findByText("Live updates failed for this thread."),
    ).toBeTruthy();
    expect(screen.queryByText("git status --short")).toBeNull();
  });

  it("does not duplicate items when read and live contain the same content with different item ids", async () => {
    const threadId = "thread-no-duplicate-id-drift";

    threadsFixture = {
      ok: true,
      data: [
        {
          id: threadId,
          provider: "codex",
          preview: "thread preview",
          createdAt: 1700000000,
          updatedAt: 1700000500,
          cwd: "/tmp/project",
          source: "codex",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    readThreadResolver = (targetThreadId: string) => ({
      ok: true,
      thread: buildConversationStateFixture(targetThreadId, "gpt-old-codex", {
        updatedAt: 1700000000,
        turnItems: [
          {
            id: "read-user-1",
            type: "userMessage",
            content: [{ type: "text", text: "duplicate-check-user" }],
          },
          {
            id: "read-agent-1",
            type: "agentMessage",
            text: "duplicate-check-agent",
          },
        ],
      }),
    });

    liveStateResolver = (targetThreadId: string, _provider: ProviderId) => ({
      kind: "readLiveState",
      threadId: targetThreadId,
      ownerClientId: "client-1",
      conversationState: buildConversationStateFixture(
        targetThreadId,
        "gpt-old-codex",
        {
          updatedAt: 1700000500,
          turnItems: [
            {
              id: "live-user-1",
              type: "userMessage",
              content: [{ type: "text", text: "duplicate-check-user" }],
            },
            {
              id: "live-agent-1",
              type: "agentMessage",
              text: "duplicate-check-agent",
            },
          ],
        },
      ),
      liveStateError: null,
    });

    render(<App />);

    expect(await screen.findByText("duplicate-check-user")).toBeTruthy();
    expect(await screen.findByText("duplicate-check-agent")).toBeTruthy();
    expect(screen.getAllByText("duplicate-check-user").length).toBe(1);
    expect(screen.getAllByText("duplicate-check-agent").length).toBe(1);
  });

  it("shows model default effort when thread effort fields are unset", async () => {
    const threadId = "thread-effort-default";
    const modelId = "gpt-5.3-codex";

    threadsFixture = {
      ok: true,
      data: [
        {
          id: threadId,
          provider: "codex",
          preview: "thread preview",
          createdAt: 1700000000,
          updatedAt: 1700000000,
          cwd: "/tmp/project",
          source: "codex",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    collaborationModesFixture = {
      codex: [
        {
          name: "Default",
          mode: "default",
          model: null,
          reasoningEffort: null,
          developerInstructions: null,
        },
      ],
      opencode: [],
      claude: [],
      qwen: [],
    };

    modelsFixture = {
      codex: [
        {
          id: modelId,
          displayName: modelId,
          description: "Default model",
          defaultReasoningEffort: "xhigh",
          supportedReasoningEfforts: [
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
          ],
          hidden: false,
          isDefault: true,
        },
      ],
      opencode: [],
      claude: [],
      qwen: [],
    };

    readThreadResolver = (targetThreadId: string) => ({
      ok: true,
      thread: buildConversationStateFixture(targetThreadId, modelId, {
        latestReasoningEffort: null,
        collaborationModeReasoningEffort: null,
      }),
    });

    liveStateResolver = (targetThreadId: string, _provider: ProviderId) => ({
      kind: "readLiveState",
      threadId: targetThreadId,
      ownerClientId: "client-1",
      conversationState: buildConversationStateFixture(
        targetThreadId,
        modelId,
        {
          latestReasoningEffort: null,
          collaborationModeReasoningEffort: null,
        },
      ),
      liveStateError: null,
    });

    render(<App />);
    expect(await screen.findByText("xhigh")).toBeTruthy();
  });

  it("prefers selected mode default effort over model default when thread effort is unset", async () => {
    const threadId = "thread-mode-default-effort";
    const modelId = "gpt-5.3-codex";

    threadsFixture = {
      ok: true,
      data: [
        {
          id: threadId,
          provider: "codex",
          preview: "thread preview",
          createdAt: 1700000000,
          updatedAt: 1700000000,
          cwd: "/tmp/project",
          source: "codex",
        },
      ],
      cursors: buildEmptyThreadListCursors(),
      errors: buildEmptyThreadListErrors(),
    };

    collaborationModesFixture = {
      codex: [
        {
          name: "Default",
          mode: "default",
          model: null,
          reasoningEffort: "xhigh",
          developerInstructions: null,
        },
      ],
      opencode: [],
      claude: [],
      qwen: [],
    };

    modelsFixture = {
      codex: [
        {
          id: modelId,
          displayName: modelId,
          description: "Default model",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
          ],
          hidden: false,
          isDefault: true,
        },
      ],
      opencode: [],
      claude: [],
      qwen: [],
    };

    readThreadResolver = (targetThreadId: string) => ({
      ok: true,
      thread: buildConversationStateFixture(targetThreadId, modelId, {
        latestReasoningEffort: null,
        collaborationModeReasoningEffort: null,
      }),
    });

    liveStateResolver = (targetThreadId: string, _provider: ProviderId) => ({
      kind: "readLiveState",
      threadId: targetThreadId,
      ownerClientId: "client-1",
      conversationState: buildConversationStateFixture(
        targetThreadId,
        modelId,
        {
          latestReasoningEffort: null,
          collaborationModeReasoningEffort: null,
        },
      ),
      liveStateError: null,
    });

    render(<App />);
    expect(await screen.findByText("xhigh")).toBeTruthy();
  });
});
