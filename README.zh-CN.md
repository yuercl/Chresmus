# Chresmus

面向编码代理线程的统一本地 UI。

[English README](./README.md)

Chresmus 提供一个统一的 Web 界面，用来浏览对话、切换模型和协作模式、查看工作区、处理审批，以及监控多个本地编码代理的活动。

当前支持：

- [Codex](https://openai.com/codex)
- [Claude Code](https://www.anthropic.com/claude-code)
- [Qwen Code](https://github.com/QwenLM/qwen-code)
- [OpenCode](https://opencode.ai)

<img src="./screenshot.png" alt="Chresmus screenshot" width="500" />

## 功能概览

- 跨 provider 的统一线程浏览，按工作区/项目分组
- 带模型、协作模式、reasoning effort 控制的聊天界面
- `Workspace` 标签页，支持 changed files、git diff、文件预览、图片预览和项目树浏览
- 实时代理监控，包括运行状态、中断、待审批请求，以及 provider 支持时的用户输入卡片
- 在线程时间线中查看 spawned/sub-agent 活动
- Trace 状态、stream events 和 app history 等调试工具
- 适合自托管远程使用的浏览器直连服务端架构

## Provider 覆盖范围

不同 provider 的功能覆盖程度不同。

- Codex：完整聊天控制、协作模式、live state、stream events、审批，以及 workspace-aware UX
- Claude Code：聊天控制、协作模式、live state、stream events，以及 workspace-aware UX
- Qwen Code：聊天控制、协作模式、live state、stream events，以及 workspace-aware UX
- OpenCode：线程浏览/发消息和项目目录支持，目前 live-control 能力较少

## 快速开始

启动 Chresmus 服务端：

```bash
npx -y @chresmus/server@latest
```

这会在 `127.0.0.1:4311` 启动后端。

默认启用：

- `codex`
- `claude`
- `qwen`

如果你也想启用 OpenCode，或者想显式选择 provider：

```bash
npx -y @chresmus/server@latest -- --agents=opencode
npx -y @chresmus/server@latest -- --agents=codex,claude,qwen
npx -y @chresmus/server@latest -- --agents=codex,claude,qwen,opencode
npx -y @chresmus/server@latest -- --agents=all
```

如果你通过 `codex app-server` 使用 Codex，需要单独启动它，并让 Chresmus 指向该地址：

```bash
# terminal 1
codex app-server --listen ws://127.0.0.1:4320

# terminal 2
CODEX_APP_SERVER_URL=ws://127.0.0.1:4320 npx -y @chresmus/server@latest
```

Chresmus 会通过 `CODEX_APP_SERVER_URL` 连接到 Codex。

前端可以直接从当前仓库本地运行，也可以自行部署 `apps/web`。启动后，在 UI 的 Settings 中把地址指向你的 Chresmus server。

## 从源码运行

安装依赖并启动后端：

```bash
npm install
npm run server
```

`npm run server` 会在 `0.0.0.0:4311` 启动后端。

如有需要，可以显式指定 provider：

```bash
npm run server -- --agents=opencode
npm run server -- --agents=codex,claude,qwen
npm run server -- --agents=all
```

如果你只使用 Codex CLI，需要先启动 Codex app-server：

```bash
# terminal 1
codex app-server --listen ws://127.0.0.1:4320

# terminal 2
CODEX_APP_SERVER_URL=ws://127.0.0.1:4320 npm run server
```

> Warning: 这会把 Chresmus server 暴露到你的网络中。只在可信网络下使用。

## 本地开发

如果你要开发 Chresmus 本身，或者想同时运行前后端：

```bash
npm install
npm run dev
```

前端会运行在 `http://localhost:4312`。

常用变体：

```bash
npm run dev -- --agents=opencode
npm run dev -- --agents=codex,claude,qwen
npm run dev -- --agents=all
npm run dev:remote
npm run dev:remote -- --agents=opencode
```

如果你要对接 Codex app-server 开发：

```bash
# terminal 1
codex app-server --listen ws://127.0.0.1:4320

# terminal 2
CODEX_APP_SERVER_URL=ws://127.0.0.1:4320 npm run dev
```

如果需要在局域网内暴露本地开发环境：

```bash
CODEX_APP_SERVER_URL=ws://127.0.0.1:4320 npm run dev:remote
```

> Warning: `dev:remote` 会在没有认证的情况下暴露 Chresmus。只在可信网络中使用。

## 生产预览

构建并以生产模式运行：

```bash
npm run build
npm run start
```

打开 `http://127.0.0.1:4312`。

默认绑定：

- backend: `127.0.0.1:4311`
- frontend preview: `127.0.0.1:4312`

如果你需要自定义后端 origin 用于 API 代理：

```bash
CHRESMUS_API_ORIGIN=http://127.0.0.1:4311 npm run start
```

## 构建选项

前端支持两个比较实用的构建标志：

- `REACT_COMPILER=0`：关闭 React Compiler transform
- `REACT_PROFILING=1`：使用 React profiling build，便于在生产预览中使用 React DevTools Profiler

示例：

```bash
# 默认生产构建
npm run build --workspace @chresmus/web

# 关闭 compiler
REACT_COMPILER=0 npm run build --workspace @chresmus/web

# profiling 构建
REACT_PROFILING=1 npm run build --workspace @chresmus/web

# profiling + 关闭 compiler
REACT_PROFILING=1 REACT_COMPILER=0 npm run build --workspace @chresmus/web
```

对接同一个后端并行对比两种前端构建：

```bash
# backend
npm run start --workspace @chresmus/server

# baseline UI
REACT_PROFILING=1 REACT_COMPILER=0 npm run build --workspace @chresmus/web -- --outDir dist-baseline
npm run preview --workspace @chresmus/web -- --host 127.0.0.1 --port 4312 --strictPort --outDir dist-baseline

# compiler UI
REACT_PROFILING=1 npm run build --workspace @chresmus/web -- --outDir dist-compiler
npm run preview --workspace @chresmus/web -- --host 127.0.0.1 --port 4313 --strictPort --outDir dist-compiler
```

## 环境要求

- Node.js 20+
- 本地至少安装一个支持的 agent
- 如果使用 Codex app-server 模式：本地可用 `codex`

常用 Codex 环境变量：

- `CODEX_APP_SERVER_URL`：单独启动的 Codex app-server 的 WebSocket 地址，例如 `ws://127.0.0.1:4320`
- `CODEX_CLI_PATH`：如果 `codex` 不在 `PATH` 中，可显式指定其可执行文件路径

## 通过 Tailscale 远程访问

推荐方式：

- 自托管 Chresmus 前端
- 在你的机器上运行 Chresmus server
- 只通过私有 Tailscale HTTPS URL 暴露 server

启动 server：

```bash
HOST=0.0.0.0 PORT=4311 npm run dev --workspace @chresmus/server
```

快速健康检查：

```bash
curl http://127.0.0.1:4311/api/health
```
