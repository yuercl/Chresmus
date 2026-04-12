# Chresmus

Remote control for AI coding agents — read conversations, send messages, switch models, and monitor agent activity from a clean web UI.

Supports [Codex](https://openai.com/codex) and [OpenCode](https://opencode.ai).

Built by [@anshuchimala](https://x.com/anshuchimala).

This is an independent project and is not affiliated with, endorsed by, or sponsored by OpenAI or the OpenCode team.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=000000)](https://buymeacoffee.com/achimalap)

<img src="./screenshot.png" alt="Chresmus screenshot" width="500" />

## Features

- Thread browser grouped by project
- Chat view with model/reasoning controls
- Plan mode toggle
- Live agent monitoring and interrupts
- Debug tab with full app event history

## Quick start (recommended)

Start the Chresmus server:

```bash
npx -y @chresmus/server@latest
```

This runs the backend on `127.0.0.1:4311` by default.

Start Codex app-server separately and point Chresmus at it:

```bash
# terminal 1
codex app-server --listen ws://127.0.0.1:4320

# terminal 2
CODEX_APP_SERVER_URL=ws://127.0.0.1:4320 npx -y @chresmus/server@latest
```

Chresmus connects to Codex through `CODEX_APP_SERVER_URL`.

You can pass server flags too to customize the agents (default is only Codex):

```bash
npx -y @chresmus/server@latest -- --agents=opencode
npx -y @chresmus/server@latest -- --agents=codex,opencode
npx -y @chresmus/server@latest -- --agents=all
```

Run the Chresmus frontend locally from this repo, or deploy `apps/web` yourself. Then use Settings in the web UI to point it at your Chresmus server.

You will need to make port 4311 remotely accessible via HTTPS and give the public URL to the Chresmus frontend you are using. None of this routes through an external server. The app runs entirely in your browser and connects directly to the Chresmus server you started above.

The securest way to open the port for remote access is by putting all devices involved in a private VPN. Tailscale is a free option that works.

Doing this with Tailscale is as simple as installing Tailscale on your phone, computer, etc., and running this command on the device hosting the Chresmus server:
```bash
tailscale serve --https=443 http://127.0.0.1:4311
```

We are working on easier options. Stay tuned!

## Running from source

Clone the repo and do this:

```bash
npm install
npm run server
```

`npm run server` runs only the backend on `0.0.0.0:4311`.

If you are using Codex CLI only, start Codex app-server first and then launch Chresmus against it:

```bash
# terminal 1
codex app-server --listen ws://127.0.0.1:4320

# terminal 2
CODEX_APP_SERVER_URL=ws://127.0.0.1:4320 npm run server
```

If you need to pick agent providers:

```bash
npm run server -- --agents=opencode
npm run server -- --agents=codex,opencode
npm run server -- --agents=all
```

> **Warning:** This exposes the Chresmus server on your network. Only use on trusted networks. See below for how to configure Tailscale as a VPN for secure remote access.

## Local development and self-hosted frontend

Use this if you are working on Chresmus itself, or if you want to run both frontend and backend locally.

```bash
npm install
npm run dev
```

Opens local frontend at `http://localhost:4312`. By default `dev` does not expose the port, it's only accessible on your device.

More local dev options:

```bash
npm run dev -- --agents=opencode             # OpenCode only
npm run dev -- --agents=codex,opencode       # both
npm run dev -- --agents=all                  # expands to codex,opencode
npm run dev:remote                           # exposes frontend + backend on your network
npm run dev:remote -- --agents=opencode      # remote mode with OpenCode only
```

If you are developing against Codex CLI only, use the same app-server setup in another terminal:

```bash
# terminal 1
codex app-server --listen ws://127.0.0.1:4320

# terminal 2
CODEX_APP_SERVER_URL=ws://127.0.0.1:4320 npm run dev
```

Or for network-exposed local development:

```bash
CODEX_APP_SERVER_URL=ws://127.0.0.1:4320 npm run dev:remote
```

> **Warning:** `dev:remote` exposes Chresmus with no authentication. Only use on trusted networks.

## Production Mode (No Extra Proxy)

Build once and run in production mode with two commands:

```bash
npm run build
npm run start
```

Open `http://127.0.0.1:4312`.

By default, this is local-only:
- backend on `127.0.0.1:4311`
- frontend preview on `127.0.0.1:4312`

If you need a custom backend origin for API proxying:

```bash
CHRESMUS_API_ORIGIN=http://127.0.0.1:4311 npm run start
```

### React Compiler and production profiling

Frontend build supports two optional flags:

- `REACT_COMPILER=0` disables React Compiler transform (compiler is enabled by default for `vite build`).
- `REACT_PROFILING=1` uses React profiling build so React DevTools Profiler works in production preview.

Example A/B commands:

```bash
# default production build (compiler enabled)
npm run build --workspace @chresmus/web

# baseline production build (compiler disabled)
REACT_COMPILER=0 npm run build --workspace @chresmus/web

# production profiling build (compiler enabled)
REACT_PROFILING=1 npm run build --workspace @chresmus/web

# production profiling build (compiler disabled)
REACT_PROFILING=1 REACT_COMPILER=0 npm run build --workspace @chresmus/web
```

Run two UIs side-by-side against one backend:

```bash
# backend (terminal 1)
npm run start --workspace @chresmus/server

# baseline UI (terminal 2, compiler disabled)
REACT_PROFILING=1 REACT_COMPILER=0 npm run build --workspace @chresmus/web -- --outDir dist-baseline
npm run preview --workspace @chresmus/web -- --host 127.0.0.1 --port 4312 --strictPort --outDir dist-baseline

# compiler UI (terminal 3, compiler enabled by default)
REACT_PROFILING=1 npm run build --workspace @chresmus/web -- --outDir dist-compiler
npm run preview --workspace @chresmus/web -- --host 127.0.0.1 --port 4313 --strictPort --outDir dist-compiler
```

## Requirements

- Node.js 20+
- Codex or OpenCode installed locally

### Codex modes

Chresmus uses Codex through `codex app-server`.

Useful environment variables:

- `CODEX_APP_SERVER_URL`: WebSocket URL for a separately started Codex app-server, for example `ws://127.0.0.1:4320`
- `CODEX_CLI_PATH`: path to the `codex` executable if it is not on `PATH`

## More details on Tailscale setup

This is the detailed setup for the recommended model:

- Self-hosted Chresmus frontend
- Local Chresmus server running on your machine
- Secure VPN path using Tailscale

You still need to run the server locally so it can talk to your coding agent.

### 1) Start the Chresmus server on your machine

```bash
HOST=0.0.0.0 PORT=4311 npm run dev --workspace @chresmus/server
```

Quick local check:

```bash
curl http://127.0.0.1:4311/api/health
```

### 2) Put Tailscale HTTPS in front of port 4311

On the same machine:

```bash
tailscale serve --https=443 http://127.0.0.1:4311
tailscale serve status
```

This gives you a URL like:

```text
https://<machine>.<tailnet>.ts.net
```

Check it from a device on your tailnet:

```bash
curl https://<machine>.<tailnet>.ts.net/api/health
```

### 3) Pair the Chresmus frontend to your server

1. Open your deployed Chresmus frontend on your other device
2. Click the status pill in the lower-left corner (green/red dot + commit hash) to open **Settings**.
3. In **Server**, enter your Tailscale HTTPS URL, for example:

```text
https://<machine>.<tailnet>.ts.net
(note: no port)
```

4. Click **Save**.

Chresmus stores this in browser storage and uses it for API calls and live event stream.

### Notes

- Do not use raw tailnet IPs with `https://` (for example `https://100.x.x.x:4311`) in the browser; this won't work.
- If you use `tailscale serve --https=443`, do not include `:4311` in the URL you enter in Settings.
- **Use automatic** in Settings clears the saved server URL and returns to built-in default behavior.

## License

MIT
