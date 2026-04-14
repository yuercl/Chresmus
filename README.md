# Chresmus

Unified local UI for coding-agent threads.

[中文文档](./README.zh-CN.md)

Chresmus gives you one web interface to browse conversations, switch models and collaboration modes, inspect workspaces, handle approvals, and monitor agent activity across multiple local coding agents.

Currently supports:

- [Codex](https://openai.com/codex)
- [Claude Code](https://www.anthropic.com/claude-code)
- [Qwen Code](https://github.com/QwenLM/qwen-code)
- [OpenCode](https://opencode.ai)

<img src="./screenshot.png" alt="Chresmus screenshot" width="500" />

## What It Can Do

- Unified thread browser across providers, grouped by workspace/project
- Chat UI with model, collaboration mode, and reasoning-effort controls
- Workspace tab with changed files, git diff view, file preview, image preview, and project tree browsing
- Live agent monitoring with running state, interrupts, pending approvals, and request-for-input cards when supported by the provider
- Multi-agent visibility for spawned/sub-agent activity inside the thread timeline
- Debug tools for trace status, stream events, and app history
- Direct browser-to-server architecture for self-hosted remote use

## Provider Coverage

Feature coverage differs by provider.

- Codex: full chat controls, collaboration modes, live state, stream events, approvals, and workspace-aware UX
- Claude Code: chat controls, collaboration modes, live state, stream events, and workspace-aware UX
- Qwen Code: chat controls, collaboration modes, live state, stream events, and workspace-aware UX
- OpenCode: thread browsing/messaging plus project-directory support, with fewer live-control features today

## Quick Start

Start the Chresmus server:

```bash
npx -y @chresmus/server@latest
```

This starts the backend on `127.0.0.1:4311`.

By default the server enables:

- `codex`
- `claude`
- `qwen`

If you want OpenCode too, or want to explicitly choose providers:

```bash
npx -y @chresmus/server@latest -- --agents=opencode
npx -y @chresmus/server@latest -- --agents=codex,claude,qwen
npx -y @chresmus/server@latest -- --agents=codex,claude,qwen,opencode
npx -y @chresmus/server@latest -- --agents=all
```

If you are using Codex through `codex app-server`, start that separately and point Chresmus at it:

```bash
# terminal 1
codex app-server --listen ws://127.0.0.1:4320

# terminal 2
CODEX_APP_SERVER_URL=ws://127.0.0.1:4320 npx -y @chresmus/server@latest
```

Chresmus connects to Codex through `CODEX_APP_SERVER_URL`.

Run the frontend locally from this repo, or deploy `apps/web` yourself. Then open Settings in the UI and point it at your Chresmus server.

## Running From Source

Install dependencies and start the backend:

```bash
pnpm install
pnpm run server
```

`pnpm run server` runs the backend on `0.0.0.0:4311`.

Select providers explicitly if needed:

```bash
pnpm run server -- --agents=opencode
pnpm run server -- --agents=codex,claude,qwen
pnpm run server -- --agents=all
```

If you are using Codex CLI only, start Codex app-server first:

```bash
# terminal 1
codex app-server --listen ws://127.0.0.1:4320

# terminal 2
CODEX_APP_SERVER_URL=ws://127.0.0.1:4320 pnpm run server
```

> Warning: this exposes the Chresmus server on your network. Use only on trusted networks.

## Local Development

Use this when working on Chresmus itself, or when running frontend and backend together:

```bash
pnpm install
pnpm run dev
```

This opens the frontend at `http://localhost:4312`.

Useful variants:

```bash
pnpm run dev -- --agents=opencode
pnpm run dev -- --agents=codex,claude,qwen
pnpm run dev -- --agents=all
pnpm run dev:remote
pnpm run dev:remote -- --agents=opencode
```

If you are developing against Codex app-server:

```bash
# terminal 1
codex app-server --listen ws://127.0.0.1:4320

# terminal 2
CODEX_APP_SERVER_URL=ws://127.0.0.1:4320 pnpm run dev
```

For network-exposed local development:

```bash
CODEX_APP_SERVER_URL=ws://127.0.0.1:4320 pnpm run dev:remote
```

> Warning: `dev:remote` exposes Chresmus without authentication. Use only on trusted networks.

## Production Preview

Build once and run in production mode:

```bash
pnpm run build
pnpm run start
```

Open `http://127.0.0.1:4312`.

Default bindings:

- backend: `127.0.0.1:4311`
- frontend preview: `127.0.0.1:4312`

If you need a custom backend origin for API proxying:

```bash
CHRESMUS_API_ORIGIN=http://127.0.0.1:4311 pnpm run start
```

## Build Options

The frontend supports two useful build flags:

- `REACT_COMPILER=0` disables the React Compiler transform
- `REACT_PROFILING=1` uses the React profiling build so React DevTools Profiler works in production preview

Examples:

```bash
# default production build
pnpm --filter @chresmus/web build

# compiler disabled
REACT_COMPILER=0 pnpm --filter @chresmus/web build

# profiling build
REACT_PROFILING=1 pnpm --filter @chresmus/web build

# profiling build with compiler disabled
REACT_PROFILING=1 REACT_COMPILER=0 pnpm --filter @chresmus/web build
```

Compare two frontend builds side-by-side against one backend:

```bash
# backend
pnpm --filter @chresmus/server start

# baseline UI
REACT_PROFILING=1 REACT_COMPILER=0 pnpm --filter @chresmus/web build -- --outDir dist-baseline
pnpm --filter @chresmus/web preview -- --host 127.0.0.1 --port 4312 --strictPort --outDir dist-baseline

# compiler UI
REACT_PROFILING=1 pnpm --filter @chresmus/web build -- --outDir dist-compiler
pnpm --filter @chresmus/web preview -- --host 127.0.0.1 --port 4313 --strictPort --outDir dist-compiler
```

## Mobile App (iOS / Android) via Tauri 2.0

Chresmus ships a Tauri 2.0 wrapper (`apps/tauri`) that packages the web UI as a native iOS or Android app.
The mobile app is a thin client — it connects to a Chresmus server running on your machine.
No agent binaries run on the device.

### Prerequisites — iOS (macOS only)

- macOS with Xcode 15+
- Rust iOS target: `rustup target add aarch64-apple-ios`
- Apple Developer account (free account works for sideloading)
- [Sideloadly](https://sideloadly.io/) or AltStore to install the IPA

### Prerequisites — Android

- Android SDK + NDK
- Rust Android target: `rustup target add aarch64-linux-android`

### First-time setup

```bash
pnpm install

# Generate app icons from the source SVG
pnpm --filter @chresmus/tauri icon

# Initialise the iOS Xcode project (creates src-tauri/gen/apple/)
pnpm run ios:init

# Initialise the Android Gradle project (creates src-tauri/gen/android/)
pnpm run android:init
```

### Building

```bash
# Build iOS IPA
pnpm run ios:build
# Output: apps/tauri/src-tauri/gen/apple/build/arm64/*.ipa

# Build Android APK
pnpm run android:build
# Output: apps/tauri/src-tauri/gen/android/app/build/outputs/apk/
```

Shorthand from the repo root:

```bash
pnpm run ios:build
pnpm run android:build
```

### Installing on iOS with Sideloadly

1. Build the IPA with `pnpm run ios:build`.
2. Open Sideloadly and drag the `.ipa` file onto it.
3. Enter your Apple ID and follow the prompts.
4. Trust the developer certificate on the device (Settings → General → VPN & Device Management).

### Connecting to your server from the mobile app

On first launch the app cannot reach `127.0.0.1` (that's your phone, not your Mac).
Open Settings in the app and enter the address of your Chresmus server, for example:

```
http://192.168.1.x:4311
```

Make sure the server is started in network-exposed mode:

```bash
HOST=0.0.0.0 PORT=4311 pnpm --filter @chresmus/server dev
```

## Requirements

- Node.js 20+
- At least one supported agent installed locally
- For Codex app-server mode: `codex` available locally
- For mobile builds: Rust + platform toolchain (see Mobile section above)

Useful Codex environment variables:

- `CODEX_APP_SERVER_URL`: WebSocket URL for a separately started Codex app-server, for example `ws://127.0.0.1:4320`
- `CODEX_CLI_PATH`: path to the `codex` executable if it is not on `PATH`

## Remote Access With Tailscale

Recommended setup:

- self-host the Chresmus frontend
- run the Chresmus server on your machine
- expose only the server through a private Tailscale HTTPS URL

Start the server:

```bash
HOST=0.0.0.0 PORT=4311 pnpm --filter @chresmus/server dev
```

Quick health check:

```bash
curl http://127.0.0.1:4311/api/health
```

Put Tailscale HTTPS in front of port `4311`:

```bash
tailscale serve --https=443 http://127.0.0.1:4311
tailscale serve status
```

This gives you a URL like:

```text
https://<machine>.<tailnet>.ts.net
```

Check it from another device on your tailnet:

```bash
curl https://<machine>.<tailnet>.ts.net/api/health
```

Then in Chresmus:

1. Open the frontend on your other device.
2. Click the lower-left status pill to open Settings.
3. Enter the Tailscale HTTPS URL in the server field.

Notes:

- If you use `tailscale serve --https=443`, do not include `:4311` in the URL you enter in Settings.
- Choosing automatic in Settings clears the saved server URL and returns to the built-in default behavior.
