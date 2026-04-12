import { describe, expect, it } from "vitest";
import { AppServerRpcError } from "@chresmus/api";
import {
  isAuthenticationRequiredToReadRateLimitsAppServerRpcError,
  isInvalidRequestAppServerRpcError,
  isThreadNotLoadedAppServerRpcError,
  isThreadNoRolloutIncludeTurnsAppServerRpcError,
  isThreadNotMaterializedIncludeTurnsAppServerRpcError,
  normalizeCodexRuntimeErrorMessage,
} from "../src/agents/adapters/codex-agent.js";

describe("isInvalidRequestAppServerRpcError", () => {
  it("returns true for invalid-request rpc errors", () => {
    expect(
      isInvalidRequestAppServerRpcError(
        new AppServerRpcError(-32600, "conversation not found"),
      ),
    ).toBe(true);
    expect(
      isInvalidRequestAppServerRpcError(
        new AppServerRpcError(-32600, "thread not found"),
      ),
    ).toBe(true);
    expect(
      isInvalidRequestAppServerRpcError(
        new AppServerRpcError(-32600, "thread not loaded"),
      ),
    ).toBe(true);
    expect(
      isInvalidRequestAppServerRpcError(
        new AppServerRpcError(-32600, "ThReAd NoT FoUnD"),
      ),
    ).toBe(true);
  });

  it("returns false for other rpc errors", () => {
    expect(
      isInvalidRequestAppServerRpcError(
        new AppServerRpcError(-32603, "thread not found"),
      ),
    ).toBe(false);
    expect(
      isInvalidRequestAppServerRpcError(
        new AppServerRpcError(-32600, "validation failed"),
      ),
    ).toBe(true);
  });

  it("returns false for non-rpc errors", () => {
    expect(
      isInvalidRequestAppServerRpcError(new Error("thread not found")),
    ).toBe(false);
    expect(isInvalidRequestAppServerRpcError(null)).toBe(false);
  });
});

describe("isThreadNotMaterializedIncludeTurnsAppServerRpcError", () => {
  it("returns true for includeTurns materialization errors", () => {
    expect(
      isThreadNotMaterializedIncludeTurnsAppServerRpcError(
        new AppServerRpcError(
          -32600,
          "thread abc is not materialized yet; includeTurns is unavailable before first user message",
        ),
      ),
    ).toBe(true);
  });

  it("returns false for other invalid-request errors", () => {
    expect(
      isThreadNotMaterializedIncludeTurnsAppServerRpcError(
        new AppServerRpcError(-32600, "thread not found"),
      ),
    ).toBe(false);
    expect(
      isThreadNotMaterializedIncludeTurnsAppServerRpcError(
        new AppServerRpcError(-32603, "thread abc is not materialized yet"),
      ),
    ).toBe(false);
    expect(
      isThreadNotMaterializedIncludeTurnsAppServerRpcError(
        new Error("thread abc is not materialized yet"),
      ),
    ).toBe(false);
  });
});

describe("isThreadNoRolloutIncludeTurnsAppServerRpcError", () => {
  it("returns true for includeTurns no-rollout errors", () => {
    expect(
      isThreadNoRolloutIncludeTurnsAppServerRpcError(
        new AppServerRpcError(
          -32600,
          "no rollout found for thread id 019ca7d4-7a37-7761-b29f-3ca43fc35d87",
        ),
      ),
    ).toBe(true);
  });

  it("returns false for other invalid-request errors", () => {
    expect(
      isThreadNoRolloutIncludeTurnsAppServerRpcError(
        new AppServerRpcError(-32600, "thread not found"),
      ),
    ).toBe(false);
    expect(
      isThreadNoRolloutIncludeTurnsAppServerRpcError(
        new AppServerRpcError(-32603, "no rollout found for thread id abc"),
      ),
    ).toBe(false);
    expect(
      isThreadNoRolloutIncludeTurnsAppServerRpcError(
        new Error("no rollout found for thread id abc"),
      ),
    ).toBe(false);
  });
});

describe("isThreadNotLoadedAppServerRpcError", () => {
  it("returns true for thread-not-loaded errors", () => {
    expect(
      isThreadNotLoadedAppServerRpcError(
        new AppServerRpcError(
          -32600,
          "thread not loaded: 019ca7d4-7a37-7761-b29f-3ca43fc35d87",
        ),
      ),
    ).toBe(true);
  });

  it("returns false for other errors", () => {
    expect(
      isThreadNotLoadedAppServerRpcError(
        new AppServerRpcError(-32600, "thread not found"),
      ),
    ).toBe(false);
    expect(
      isThreadNotLoadedAppServerRpcError(
        new AppServerRpcError(-32603, "thread not loaded"),
      ),
    ).toBe(false);
    expect(
      isThreadNotLoadedAppServerRpcError(new Error("thread not loaded")),
    ).toBe(false);
  });
});

describe("isAuthenticationRequiredToReadRateLimitsAppServerRpcError", () => {
  it("returns true for rate-limits authentication errors", () => {
    expect(
      isAuthenticationRequiredToReadRateLimitsAppServerRpcError(
        new AppServerRpcError(
          -32600,
          "chatgpt authentication required to read rate limits",
        ),
      ),
    ).toBe(true);
  });

  it("returns false for other errors", () => {
    expect(
      isAuthenticationRequiredToReadRateLimitsAppServerRpcError(
        new AppServerRpcError(-32600, "thread not found"),
      ),
    ).toBe(false);
    expect(
      isAuthenticationRequiredToReadRateLimitsAppServerRpcError(
        new AppServerRpcError(
          -32603,
          "chatgpt authentication required to read rate limits",
        ),
      ),
    ).toBe(false);
    expect(
      isAuthenticationRequiredToReadRateLimitsAppServerRpcError(
        new Error("chatgpt authentication required to read rate limits"),
      ),
    ).toBe(false);
  });
});

describe("normalizeCodexRuntimeErrorMessage", () => {
  it("rewrites rate-limits authentication errors", () => {
    expect(
      normalizeCodexRuntimeErrorMessage(
        "app-server error -32600: chatgpt authentication required to read rate limits",
      ),
    ).toBe(
      "Rate limits unavailable until ChatGPT authentication is connected.",
    );
  });

  it("preserves unrelated errors", () => {
    expect(normalizeCodexRuntimeErrorMessage("thread not found")).toBe(
      "thread not found",
    );
  });
});
