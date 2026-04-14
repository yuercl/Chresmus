## Unified Architecture

Chresmus now routes both providers through one strict unified surface.

- Server entrypoints for the web app are under `/api/unified/*`.
- Codex runs through native app-server methods only.
- OpenCode runs through SDK type mappings only.
- Web UI consumes unified schemas and does not import provider SDK/protocol types.
- Feature gating comes from typed unified feature availability, not provider-specific conditionals in UI logic.

## Mobile (Tauri 2.0)

`apps/tauri` is an npm workspace that wraps the web frontend as a native iOS/Android app via Tauri 2.0.

- `apps/tauri/src-tauri/` — Rust backend (minimal; no agent logic).
- `apps/tauri/src-tauri/tauri.conf.json` — points `frontendDist` at `apps/web/dist`.
- `apps/tauri/src-tauri/capabilities/default.json` — grants `core:default` and `shell:allow-open`; CSP allows `connect-src http: https:` so the WebView can reach any user-configured server.
- `apps/web/src/main.tsx` — detects `window.__TAURI_INTERNALS__` and skips PWA service-worker registration inside Tauri.
- `apps/web/package.json` `build:tauri` script — builds with `PWA_ENABLED=0` (no service worker injected).

The mobile app is a thin client. Agents run on the desktop server; the phone only renders the UI and makes HTTP/SSE requests to the configured server address.

### Unified Endpoints

- `POST /api/unified/command`
- `GET /api/unified/features`
- `GET /api/unified/threads`
- `GET /api/unified/thread/:id`
- `GET /api/unified/events` (SSE)

## Strict Checks

Run this before pushing:

```bash
npm run verify:strict
```

This runs:

- `verify:no-cheats`
- `verify:no-provider-ui-imports`
- workspace `typecheck`
- workspace `test`
- generated artifact cleanliness checks for Codex and OpenCode manifests

## Codex Schema Sync

Chresmus now vendors official Codex app-server schemas and generates protocol Zod validators from them.

```bash
npm run generate:codex-schema
```

This command updates:

- `packages/codex-protocol/vendor/codex-app-server-schema/` (stable + experimental TypeScript and JSON Schema)
- `packages/codex-protocol/src/generated/app-server/` (generated Zod schema modules used by the app)

## OpenCode Manifest Sync

Chresmus also generates an OpenCode manifest from SDK unions used by the mapper layer.

```bash
npm run generate:opencode-manifest
```

## Provider Schema Update Flow

When Codex or OpenCode updates protocol/SDK shapes:

1. Run `npm run generate:codex-schema`
2. Run `npm run generate:opencode-manifest`
3. Run `npm run verify:strict`
4. Commit generated changes together with any mapper updates

## Release Checklist

1. Run `npm run verify:strict`
2. Confirm `npm run generate:codex-schema` produces no uncommitted changes
3. Confirm `npm run generate:opencode-manifest` produces no uncommitted changes
4. Review `git status` for only intended files
5. Ship only after all workspace tests pass
