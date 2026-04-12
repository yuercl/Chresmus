import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import type { AppServerClientRequestMethod } from "@chresmus/protocol";
import { z } from "zod";
import {
  AppServerRpcError,
  AppServerTransportError
} from "./errors.js";
import { JsonRpcRequestSchema, parseJsonRpcIncomingMessage } from "./json-rpc.js";

export type AppServerRequestId = string | number;

export interface AppServerServerRequestMessage {
  id: AppServerRequestId;
  method: string;
  params: unknown;
}

export interface AppServerServerNotificationMessage {
  method: string;
  params: unknown;
}

export interface AppServerTransport {
  request(method: AppServerClientRequestMethod, params: unknown, timeoutMs?: number): Promise<unknown>;
  respond(requestId: AppServerRequestId, result: unknown): Promise<void>;
  setServerRequestHandler?(handler: ((request: AppServerServerRequestMessage) => void) | null): void;
  setServerNotificationHandler?(
    handler: ((notification: AppServerServerNotificationMessage) => void) | null
  ): void;
  close(): Promise<void>;
}

interface PendingRequest {
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface ChildProcessAppServerTransportOptions {
  executablePath: string;
  userAgent: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onStderr?: (line: string) => void;
}

export interface WebSocketAppServerTransportOptions {
  url: string;
  userAgent: string;
  requestTimeoutMs?: number;
}

export class ChildProcessAppServerTransport implements AppServerTransport {
  private readonly executablePath: string;
  private readonly userAgent: string;
  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly requestTimeoutMs: number;
  private readonly onStderr: ((line: string) => void) | undefined;
  private serverRequestHandler: ((request: AppServerServerRequestMessage) => void) | null = null;
  private serverNotificationHandler:
    | ((notification: AppServerServerNotificationMessage) => void)
    | null = null;
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private requestId = 0;
  private initialized = false;
  private initializeInFlight: Promise<void> | null = null;

  public constructor(options: ChildProcessAppServerTransportOptions) {
    this.executablePath = options.executablePath;
    this.userAgent = options.userAgent;
    this.cwd = options.cwd;
    this.env = options.env;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.onStderr = options.onStderr;
  }

  private ensureStarted(): void {
    if (this.process) {
      return;
    }

    const child = spawn(
      this.executablePath,
      ["--dangerously-bypass-approvals-and-sandbox", "app-server"],
      {
      cwd: this.cwd,
      env: {
        ...process.env,
        ...this.env,
        CODEX_USER_AGENT: this.userAgent,
        CODEX_CLIENT_ID: `chresmus-${randomUUID()}`
      },
      stdio: ["pipe", "pipe", "pipe"]
      }
    );

    child.on("exit", (code, signal) => {
      const reason = `app-server exited (code=${String(code)}, signal=${String(signal)})`;
      this.rejectAll(new AppServerTransportError(reason));
      this.process = null;
      this.initialized = false;
      this.initializeInFlight = null;
    });

    child.on("error", (error) => {
      this.rejectAll(new AppServerTransportError(`app-server process error: ${error.message}`));
      this.process = null;
      this.initialized = false;
      this.initializeInFlight = null;
    });

    const lineReader = readline.createInterface({ input: child.stdout });
    lineReader.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      const raw = JSON.parse(trimmed);
      const message = parseJsonRpcIncomingMessage(raw);

      if (message.kind === "notification") {
        this.serverNotificationHandler?.({
          method: message.value.method,
          params: message.value.params
        });
        return;
      }

      if (message.kind === "request") {
        this.serverRequestHandler?.({
          id: message.value.id,
          method: message.value.method,
          params: message.value.params
        });
        return;
      }

      const pending = this.pending.get(message.value.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.value.id);
      clearTimeout(pending.timer);

      if (message.value.error) {
        pending.reject(
          new AppServerRpcError(
            message.value.error.code,
            message.value.error.message,
            message.value.error.data
          )
        );
        return;
      }

      pending.resolve(message.value.result);
    });

    const stderrReader = readline.createInterface({ input: child.stderr });
    stderrReader.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      this.onStderr?.(trimmed);
    });

    this.process = child;
  }

  private rejectAll(error: Error): void {
    for (const { timer, reject } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  private async sendRequest(
    method: AppServerClientRequestMethod,
    params: unknown,
    timeoutMs?: number
  ): Promise<unknown> {
    const processHandle = this.process;
    if (!processHandle) {
      throw new AppServerTransportError("app-server failed to start");
    }

    const id = ++this.requestId;
    const timeout = timeoutMs ?? this.requestTimeoutMs;
    const requestPayload = JsonRpcRequestSchema.parse({
      jsonrpc: "2.0",
      id,
      method,
      params
    });
    const encoded = JSON.stringify(requestPayload) + "\n";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerTransportError(`app-server request timed out: ${method}`));
      }, timeout);

      this.pending.set(id, { timer, resolve, reject });

      processHandle.stdin.write(encoded, (error) => {
        if (!error) {
          return;
        }

        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }

        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new AppServerTransportError(`failed to write app-server request: ${error.message}`));
      });
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initializeInFlight) {
      return this.initializeInFlight;
    }

    this.initializeInFlight = (async () => {
      const result = await this.sendRequest(
        "initialize",
        {
          clientInfo: {
            name: "chresmus",
            version: "0.2.0"
          },
          capabilities: {
            experimentalApi: true
          }
        },
        this.requestTimeoutMs
      );

      if (!result || typeof result !== "object") {
        throw new AppServerTransportError("app-server initialize returned invalid result");
      }

      this.initialized = true;
    })().finally(() => {
      this.initializeInFlight = null;
    });

    return this.initializeInFlight;
  }

  public async request(
    method: AppServerClientRequestMethod,
    params: unknown,
    timeoutMs?: number
  ): Promise<unknown> {
    this.ensureStarted();

    if (method !== "initialize") {
      await this.ensureInitialized();
    }

    const result = await this.sendRequest(method, params, timeoutMs);
    if (method === "initialize") {
      this.initialized = true;
    }
    return result;
  }

  public setServerRequestHandler(
    handler: ((request: AppServerServerRequestMessage) => void) | null
  ): void {
    this.serverRequestHandler = handler;
  }

  public setServerNotificationHandler(
    handler: ((notification: AppServerServerNotificationMessage) => void) | null
  ): void {
    this.serverNotificationHandler = handler;
  }

  public async respond(requestId: AppServerRequestId, result: unknown): Promise<void> {
    this.ensureStarted();
    await this.ensureInitialized();

    const processHandle = this.process;
    if (!processHandle) {
      throw new AppServerTransportError("app-server failed to start");
    }

    const encoded =
      JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        result
      }) + "\n";

    await new Promise<void>((resolve, reject) => {
      processHandle.stdin.write(encoded, (error) => {
        if (!error) {
          resolve();
          return;
        }
        reject(new AppServerTransportError(`failed to write app-server response: ${error.message}`));
      });
    });
  }

  public async close(): Promise<void> {
    const processHandle = this.process;
    if (!processHandle) {
      return;
    }

    this.process = null;
    this.initialized = false;
    this.initializeInFlight = null;
    this.rejectAll(new AppServerTransportError("app-server transport closed"));

    processHandle.kill("SIGTERM");
  }
}

export class WebSocketAppServerTransport implements AppServerTransport {
  private readonly url: string;
  private readonly userAgent: string;
  private readonly requestTimeoutMs: number;
  private serverRequestHandler: ((request: AppServerServerRequestMessage) => void) | null = null;
  private serverNotificationHandler:
    | ((notification: AppServerServerNotificationMessage) => void)
    | null = null;
  private socket: WebSocket | null = null;
  private readonly pending = new Map<AppServerRequestId, PendingRequest>();
  private requestId = 0;
  private initialized = false;
  private connectInFlight: Promise<void> | null = null;
  private initializeInFlight: Promise<void> | null = null;

  public constructor(options: WebSocketAppServerTransportOptions) {
    this.url = options.url;
    this.userAgent = options.userAgent;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  private rejectAll(error: Error): void {
    for (const { timer, reject } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectInFlight) {
      return this.connectInFlight;
    }

    this.connectInFlight = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);

      const cleanup = (): void => {
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("error", handleInitialError);
      };

      const handleOpen = (): void => {
        cleanup();
        resolve();
      };

      const handleInitialError = (): void => {
        cleanup();
        reject(new AppServerTransportError(`app-server websocket connection failed: ${this.url}`));
      };

      socket.addEventListener("open", handleOpen, { once: true });
      socket.addEventListener("error", handleInitialError, { once: true });
      socket.addEventListener("message", (event) => {
        void this.handleMessage(event);
      });
      socket.addEventListener("close", () => {
        this.rejectAll(new AppServerTransportError("app-server websocket transport closed"));
        this.socket = null;
        this.initialized = false;
        this.initializeInFlight = null;
      });

      this.socket = socket;
    }).finally(() => {
      this.connectInFlight = null;
    });

    return this.connectInFlight;
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    const raw = JSON.parse(z.string().parse(event.data));
    const message = parseJsonRpcIncomingMessage(raw);

    if (message.kind === "notification") {
      this.serverNotificationHandler?.({
        method: message.value.method,
        params: message.value.params
      });
      return;
    }

    if (message.kind === "request") {
      this.serverRequestHandler?.({
        id: message.value.id,
        method: message.value.method,
        params: message.value.params
      });
      return;
    }

    const pending = this.pending.get(message.value.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.value.id);
    clearTimeout(pending.timer);

    if (message.value.error) {
      pending.reject(
        new AppServerRpcError(
          message.value.error.code,
          message.value.error.message,
          message.value.error.data
        )
      );
      return;
    }

    pending.resolve(message.value.result);
  }

  private async sendRequest(
    method: AppServerClientRequestMethod,
    params: unknown,
    timeoutMs?: number
  ): Promise<unknown> {
    await this.ensureConnected();

    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new AppServerTransportError("app-server websocket is not connected");
    }

    const id = ++this.requestId;
    const timeout = timeoutMs ?? this.requestTimeoutMs;
    const requestPayload = JsonRpcRequestSchema.parse({
      jsonrpc: "2.0",
      id,
      method,
      params
    });
    const encoded = JSON.stringify(requestPayload);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerTransportError(`app-server request timed out: ${method}`));
      }, timeout);

      this.pending.set(id, { timer, resolve, reject });

      try {
        socket.send(encoded);
      } catch (error) {
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }

        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(
          new AppServerTransportError(
            `failed to write app-server websocket request: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      }
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initializeInFlight) {
      return this.initializeInFlight;
    }

    this.initializeInFlight = (async () => {
      const result = await this.sendRequest(
        "initialize",
        {
          clientInfo: {
            name: "chresmus",
            version: "0.2.0"
          },
          capabilities: {
            experimentalApi: true
          }
        },
        this.requestTimeoutMs
      );

      if (!result || typeof result !== "object") {
        throw new AppServerTransportError("app-server initialize returned invalid result");
      }

      this.initialized = true;
    })().finally(() => {
      this.initializeInFlight = null;
    });

    return this.initializeInFlight;
  }

  public async request(
    method: AppServerClientRequestMethod,
    params: unknown,
    timeoutMs?: number
  ): Promise<unknown> {
    await this.ensureConnected();

    if (method !== "initialize") {
      await this.ensureInitialized();
    }

    const result = await this.sendRequest(method, params, timeoutMs);
    if (method === "initialize") {
      this.initialized = true;
    }
    return result;
  }

  public setServerRequestHandler(
    handler: ((request: AppServerServerRequestMessage) => void) | null
  ): void {
    this.serverRequestHandler = handler;
  }

  public setServerNotificationHandler(
    handler: ((notification: AppServerServerNotificationMessage) => void) | null
  ): void {
    this.serverNotificationHandler = handler;
  }

  public async respond(requestId: AppServerRequestId, result: unknown): Promise<void> {
    await this.ensureConnected();
    await this.ensureInitialized();

    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new AppServerTransportError("app-server websocket is not connected");
    }

    const encoded = JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      result
    });

    try {
      socket.send(encoded);
    } catch (error) {
      throw new AppServerTransportError(
        `failed to write app-server websocket response: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async close(): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return;
    }

    this.socket = null;
    this.initialized = false;
    this.connectInFlight = null;
    this.initializeInFlight = null;
    this.rejectAll(new AppServerTransportError("app-server websocket transport closed"));
    socket.close();
  }
}
