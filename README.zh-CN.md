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
pnpm install
pnpm run server
```

`pnpm run server` 会在 `0.0.0.0:4311` 启动后端。

如有需要，可以显式指定 provider：

```bash
pnpm run server -- --agents=opencode
pnpm run server -- --agents=codex,claude,qwen
pnpm run server -- --agents=all
```

如果你只使用 Codex CLI，需要先启动 Codex app-server：

```bash
# terminal 1
codex app-server --listen ws://127.0.0.1:4320

# terminal 2
CODEX_APP_SERVER_URL=ws://127.0.0.1:4320 pnpm run server
```

> Warning: 这会把 Chresmus server 暴露到你的网络中。只在可信网络下使用。

## 本地开发

如果你要开发 Chresmus 本身，或者想同时运行前后端：

```bash
pnpm install
pnpm run dev
```

前端会运行在 `http://localhost:4312`。

常用变体：

```bash
pnpm run dev -- --agents=opencode
pnpm run dev -- --agents=codex,claude,qwen
pnpm run dev -- --agents=all
pnpm run dev:remote
pnpm run dev:remote -- --agents=opencode
```

如果你要对接 Codex app-server 开发：

```bash
# terminal 1
codex app-server --listen ws://127.0.0.1:4320

# terminal 2
CODEX_APP_SERVER_URL=ws://127.0.0.1:4320 pnpm run dev
```

如果需要在局域网内暴露本地开发环境：

```bash
CODEX_APP_SERVER_URL=ws://127.0.0.1:4320 pnpm run dev:remote
```

> Warning: `dev:remote` 会在没有认证的情况下暴露 Chresmus。只在可信网络中使用。

## 生产预览

构建并以生产模式运行：

```bash
pnpm run build
pnpm run start
```

打开 `http://127.0.0.1:4312`。

默认绑定：

- backend: `127.0.0.1:4311`
- frontend preview: `127.0.0.1:4312`

如果你需要自定义后端 origin 用于 API 代理：

```bash
CHRESMUS_API_ORIGIN=http://127.0.0.1:4311 pnpm run start
```

## 构建选项

前端支持两个比较实用的构建标志：

- `REACT_COMPILER=0`：关闭 React Compiler transform
- `REACT_PROFILING=1`：使用 React profiling build，便于在生产预览中使用 React DevTools Profiler

示例：

```bash
# 默认生产构建
pnpm --filter @chresmus/web build

# 关闭 compiler
REACT_COMPILER=0 pnpm --filter @chresmus/web build

# profiling 构建
REACT_PROFILING=1 pnpm --filter @chresmus/web build

# profiling + 关闭 compiler
REACT_PROFILING=1 REACT_COMPILER=0 pnpm --filter @chresmus/web build
```

对接同一个后端并行对比两种前端构建：

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

## 移动端应用（iOS / Android）via Tauri 2.0

Chresmus 提供了一个 Tauri 2.0 封装（`apps/tauri`），可以将 Web UI 打包成原生 iOS 或 Android 应用。
移动端应用作为瘦客户端运行——它连接到你电脑上运行的 Chresmus 服务端，设备本身不运行任何 agent。

### 前置条件 — iOS（仅限 macOS）

- macOS + Xcode 15+
- Rust iOS 编译目标：`rustup target add aarch64-apple-ios`
- Apple 开发者账号（免费账号即可用于侧载安装）
- [Sideloadly](https://sideloadly.io/) 或 AltStore（用于安装 IPA）

### 前置条件 — Android

- Android SDK + NDK
- Rust Android 编译目标：`rustup target add aarch64-linux-android`

### 首次初始化

```bash
pnpm install

# 从源 SVG 生成所有尺寸的应用图标
pnpm --filter @chresmus/tauri icon

# 初始化 iOS Xcode 工程（生成 src-tauri/gen/apple/）
pnpm run ios:init

# 初始化 Android Gradle 工程（生成 src-tauri/gen/android/）
pnpm run android:init
```

### 构建

```bash
# 构建 iOS IPA
pnpm run ios:build
# 输出：apps/tauri/src-tauri/gen/apple/build/arm64/*.ipa

# 构建 Android APK
pnpm run android:build
# 输出：apps/tauri/src-tauri/gen/android/app/build/outputs/apk/
```

从仓库根目录使用快捷命令：

```bash
pnpm run ios:build
pnpm run android:build
```

### 用 Sideloadly 安装到 iOS

1. 执行 `pnpm run ios:build` 构建 IPA 包。
2. 打开 Sideloadly，把 `.ipa` 文件拖入。
3. 输入你的 Apple ID 并按提示操作。
4. 在设备上信任开发者证书（设置 → 通用 → VPN 与设备管理）。

### 移动端连接服务端

首次启动时 App 无法访问 `127.0.0.1`（那是手机自己，不是你的电脑）。
在 App 的 Settings 中输入 Chresmus server 的局域网地址，例如：

```
http://192.168.1.x:4311
```

确保服务端以网络暴露模式启动：

```bash
HOST=0.0.0.0 PORT=4311 pnpm --filter @chresmus/server dev
```

## 环境要求

- Node.js 20+
- 本地至少安装一个支持的 agent
- 如果使用 Codex app-server 模式：本地可用 `codex`
- 移动端构建：Rust + 对应平台工具链（见上方移动端章节）

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
HOST=0.0.0.0 PORT=4311 pnpm --filter @chresmus/server dev
```

快速健康检查：

```bash
curl http://127.0.0.1:4311/api/health
```
