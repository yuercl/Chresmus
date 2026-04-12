import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  UnifiedFeatureAvailability,
  UnifiedItem,
  UnifiedThread,
} from "@chresmus/unified-surface";
import { App } from "../src/App";

class MockEventSource {
  public onmessage: ((event: MessageEvent<string>) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;

  public constructor(_url: string) {}
  public close(): void {}
}

type ProviderId = "codex" | "opencode";

interface ThreadSummary {
  id: string;
  provider: ProviderId;
  preview: string;
  title?: string | null;
  createdAt: number;
  updatedAt: number;
  cwd?: string;
  source?: string;
}

type WorkspaceFileState =
  | {
      status: "available";
      path: string;
      content: string;
      isBinary: boolean;
      truncated: boolean;
    }
  | {
      status: "missing";
      path: string;
    };

interface WorkspaceDiffState {
  path: string;
  diff: string;
  truncated: boolean;
}

type FeatureSet = Record<
  | "listThreads"
  | "createThread"
  | "readThread"
  | "sendMessage"
  | "interrupt"
  | "listModels"
  | "listCollaborationModes"
  | "setCollaborationMode"
  | "submitUserInput"
  | "readLiveState"
  | "readStreamEvents"
  | "listProjectDirectories",
  UnifiedFeatureAvailability
>;

function buildFeatureSet(): FeatureSet {
  const available: UnifiedFeatureAvailability = { status: "available" };
  return {
    listThreads: available,
    createThread: available,
    readThread: available,
    sendMessage: available,
    interrupt: available,
    listModels: available,
    listCollaborationModes: available,
    setCollaborationMode: available,
    submitUserInput: available,
    readLiveState: available,
    readStreamEvents: available,
    listProjectDirectories: available,
  };
}

function buildConversationState(threadId: string, cwd: string): UnifiedThread {
  const items: UnifiedItem[] = [
    {
      id: "agent-1",
      type: "agentMessage",
      text: "workspace thread ready",
    },
  ];
  return {
    id: threadId,
    provider: "codex",
    turns: [
      {
        id: "turn-1",
        status: "completed",
        items,
      },
    ],
    requests: [],
    updatedAt: 1700000000,
    cwd,
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
}

function jsonResponse(payload: object): Response {
  return {
    ok: true,
    json: async () => payload,
  } as Response;
}

const threadId = "thread-workspace";
const threadCwd = "/tmp/project";
const changedFilePath = "/tmp/project/src/app.ts";
const untrackedFilePath = "/tmp/project/README.md";
const imageFilePath = "/tmp/project/screenshot.png";

let threadsFixture: ThreadSummary[] = [];
let workspaceFilesFixture: Record<string, WorkspaceFileState> = {};
let workspaceDiffFixture: Record<string, WorkspaceDiffState> = {};

vi.stubGlobal("EventSource", MockEventSource);
Element.prototype.scrollTo = vi.fn();
window.scrollTo = vi.fn();
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
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

vi.stubGlobal(
  "localStorage",
  {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    key: vi.fn(() => null),
    length: 0,
  },
);

beforeEach(() => {
  window.history.replaceState(null, "", "/threads/thread-workspace");
  threadsFixture = [
    {
      id: threadId,
      provider: "codex",
      preview: "workspace preview",
      title: "Workspace Thread",
      createdAt: 1700000000,
      updatedAt: 1700000001,
      cwd: threadCwd,
      source: "codex",
    },
  ];
  workspaceFilesFixture = {
    [changedFilePath]: {
      status: "available",
      path: changedFilePath,
      content: "export const value = 2;\n",
      isBinary: false,
      truncated: false,
    },
    [untrackedFilePath]: {
      status: "available",
      path: untrackedFilePath,
      content: "# Project\n",
      isBinary: false,
      truncated: false,
    },
  };
  workspaceDiffFixture = {
    [changedFilePath]: {
      path: changedFilePath,
      diff: "diff --git a/src/app.ts b/src/app.ts\n+export const value = 2;",
      truncated: false,
    },
    [untrackedFilePath]: {
      path: untrackedFilePath,
      diff: "diff --git a/README.md b/README.md\nnew file mode 100644\n--- /dev/null\n+++ b/README.md\n@@ -0,0 +1 @@\n+# Project",
      truncated: false,
    },
  };
});

afterEach(() => {
  cleanup();
});

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const parsed = new URL(url, "http://localhost");
    const pathname = parsed.pathname;

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
      return jsonResponse({
        ok: true,
        features: {
          codex: buildFeatureSet(),
          opencode: buildFeatureSet(),
        },
      });
    }

    if (pathname === "/api/unified/threads") {
      return jsonResponse({
        ok: true,
        data: threadsFixture,
        cursors: { codex: null, opencode: null },
        errors: { codex: null, opencode: null },
      });
    }

    if (pathname === "/api/unified/sidebar") {
      return jsonResponse({
        ok: true,
        rows: threadsFixture,
        errors: { codex: null, opencode: null },
      });
    }

    if (pathname.startsWith("/api/unified/thread/")) {
      return jsonResponse({
        ok: true,
        thread: buildConversationState(threadId, threadCwd),
      });
    }

    if (pathname === "/api/unified/command") {
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as { kind: string; threadId?: string })
          : { kind: "unknown", threadId: threadId };

      if (body.kind === "listProjectDirectories") {
        return jsonResponse({
          ok: true,
          result: {
            kind: "listProjectDirectories",
            directories: [threadCwd],
          },
        });
      }

      if (body.kind === "listModels") {
        return jsonResponse({
          ok: true,
          result: {
            kind: "listModels",
            data: [
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
          },
        });
      }

      if (body.kind === "listCollaborationModes") {
        return jsonResponse({
          ok: true,
          result: {
            kind: "listCollaborationModes",
            data: [
              {
                name: "Default",
                mode: "default",
                model: null,
                reasoningEffort: "medium",
                developerInstructions: null,
              },
            ],
          },
        });
      }

      if (body.kind === "readLiveState") {
        return jsonResponse({
          ok: true,
          result: {
            kind: "readLiveState",
            threadId: body.threadId ?? threadId,
            ownerClientId: null,
            conversationState: buildConversationState(threadId, threadCwd),
            liveStateError: null,
          },
        });
      }

      if (body.kind === "readStreamEvents") {
        return jsonResponse({
          ok: true,
          result: {
            kind: "readStreamEvents",
            threadId: body.threadId ?? threadId,
            ownerClientId: null,
            events: [],
          },
        });
      }

      return jsonResponse({
        ok: true,
        result: { kind: body.kind },
      });
    }

    if (pathname === "/api/filesystem/entries") {
      return jsonResponse({
        ok: true,
        path: threadCwd,
        parentPath: "/tmp",
        entries: [
          { name: "src", path: "/tmp/project/src", kind: "directory" },
          { name: "app.ts", path: changedFilePath, kind: "file" },
          { name: "README.md", path: untrackedFilePath, kind: "file" },
          { name: "screenshot.png", path: imageFilePath, kind: "file" },
        ],
      });
    }

    if (pathname === "/api/workspace/git/status") {
      return jsonResponse({
        ok: true,
        cwd: threadCwd,
        branch: "main",
        hasUncommittedChanges: true,
        files: [
          {
            path: changedFilePath,
            stagedStatus: null,
            unstagedStatus: "modified",
          },
          {
            path: untrackedFilePath,
            stagedStatus: null,
            unstagedStatus: "untracked",
          },
        ],
      });
    }

    if (pathname === "/api/filesystem/file") {
      const pathParam = parsed.searchParams.get("path");
      if (!pathParam || !workspaceFilesFixture[pathParam]) {
        return jsonResponse({
          ok: true,
          status: "missing",
          path: pathParam ?? "",
        });
      }
      return jsonResponse({
        ok: true,
        ...workspaceFilesFixture[pathParam],
      });
    }

    if (pathname === "/api/workspace/git/diff") {
      const pathParam = parsed.searchParams.get("path");
      if (!pathParam || !workspaceDiffFixture[pathParam]) {
        return jsonResponse({
          ok: true,
          cwd: threadCwd,
          path: pathParam ?? "",
          diff: "",
          truncated: false,
        });
      }
      return jsonResponse({
        ok: true,
        cwd: threadCwd,
        ...workspaceDiffFixture[pathParam],
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

describe("workspace UI", () => {
  it("shows workspace path metadata in thread header", async () => {
    render(<App />);

    expect((await screen.findAllByText("Workspace Thread")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("project")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("/tmp/project")).length).toBeGreaterThan(0);
  });

  it("loads changed files and switches between diff and file views", async () => {
    window.history.replaceState(null, "", `/threads/${threadId}/workspace`);
    render(<App />);

    expect((await screen.findAllByText("Changed Files")).length).toBeGreaterThan(0);
    expect(
      (await screen.findAllByText("diff --git a/src/app.ts b/src/app.ts")).length,
    ).toBeGreaterThan(0);

    fireEvent.click(await screen.findByRole("button", { name: "File" }));
    await waitFor(() => {
      const fetchMock = vi.mocked(fetch);
      const calledUrls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(
        calledUrls.some((url) => url.includes("/api/workspace/git/status")),
      ).toBe(true);
      expect(
        calledUrls.some((url) => url.includes("/api/workspace/git/diff")),
      ).toBe(true);
      expect(
        calledUrls.some((url) => url.includes("/api/filesystem/file")),
      ).toBe(true);
    });
  });

  it("supports mobile navigator to viewer transition in workspace tab", async () => {
    window.history.replaceState(null, "", `/threads/${threadId}/workspace`);
    render(<App />);

    expect((await screen.findAllByText("Changed Files")).length).toBeGreaterThan(0);
    const fileButtons = await screen.findAllByRole("button", { name: /app\.ts/ });
    for (const button of fileButtons) {
      fireEvent.click(button);
      if (screen.queryByRole("button", { name: "Back" })) {
        break;
      }
    }

    expect(await screen.findByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("renders diff for untracked text files and previews images in file mode", async () => {
    window.history.replaceState(null, "", `/threads/${threadId}/workspace`);
    render(<App />);

    fireEvent.click((await screen.findAllByRole("button", { name: /README\.md/ }))[0]!);
    expect(
      (await screen.findAllByText("diff --git a/README.md b/README.md")).length,
    ).toBeGreaterThan(0);

    fireEvent.click((await screen.findAllByRole("button", { name: /screenshot\.png/ }))[0]!);
    const image = await screen.findByRole("img", { name: "screenshot.png" });
    expect(image.getAttribute("src")).toContain("/api/filesystem/file/raw");
    expect(image.getAttribute("src")).toContain(
      encodeURIComponent(imageFilePath),
    );
  });

});
