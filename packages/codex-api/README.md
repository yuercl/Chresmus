# @chresmus/api

Typed client layer for the Codex app-server.

## Goals

- Provide a clean TypeScript interface for bidirectional Codex interaction.
- Validate every untrusted payload with strict schemas.
- Fail fast on protocol drift.

## Main Pieces

- `AppServerClient`
  - Typed requests to `codex app-server`.
  - Strict response validation.
- `reduceThreadStreamEvents`
  - Strict reducer for thread stream snapshots and patches.

## Fail-Fast Rules

- No fallback parsers.
- No retry loops.
- Unknown shapes throw immediately.
- Invalid patch operations throw immediately.

## Example

```ts
import {
  AppServerClient,
  WebSocketAppServerTransport
} from "@chresmus/api";
import { parseThreadConversationState } from "@chresmus/protocol";

const client = new AppServerClient(
  new WebSocketAppServerTransport({
    url: "ws://127.0.0.1:4320",
    userAgent: "chresmus/dev"
  })
);

const thread = await client.readThread("thread-id", true);
const conversationState = parseThreadConversationState(thread.thread);
await client.sendTurn({
  threadId: conversationState.id,
  input: [{ type: "text", text: "hello" }],
  attachments: []
});
```
