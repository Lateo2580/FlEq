#!/usr/bin/env node

import { spawn } from "child_process";
import { resolve, relative, sep } from "path";

type JsonRpcId = string | number;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface ToolCallArgs {
  prompt?: unknown;
  cwd?: unknown;
  timeoutMs?: unknown;
  maxOutputChars?: unknown;
}

interface ServerConfig {
  claudeCommand: string;
  claudeArgsPrefix: string[];
  allowedDirs: string[];
  defaultTimeoutMs: number;
  defaultMaxOutputChars: number;
}

const SERVER_NAME = "claude-bridge-mcp";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2024-11-05";

const config: ServerConfig = {
  claudeCommand: process.env.CLAUDE_BRIDGE_COMMAND || "claude",
  claudeArgsPrefix: parseArgsPrefix(process.env.CLAUDE_BRIDGE_ARGS_PREFIX),
  allowedDirs: parseAllowedDirs(process.env.CLAUDE_BRIDGE_ALLOWED_DIRS),
  defaultTimeoutMs: parsePositiveInt(process.env.CLAUDE_BRIDGE_TIMEOUT_MS, 120000),
  defaultMaxOutputChars: parsePositiveInt(process.env.CLAUDE_BRIDGE_MAX_OUTPUT_CHARS, 20000),
};

let inputBuffer = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  parseIncomingBuffer();
});

process.stdin.on("error", (err: Error) => {
  logToStderr(`stdin error: ${err.message}`);
});

process.on("uncaughtException", (err: Error) => {
  logToStderr(`uncaught exception: ${err.stack || err.message}`);
});

process.on("unhandledRejection", (reason: unknown) => {
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
  logToStderr(`unhandled rejection: ${message}`);
});

function parseIncomingBuffer(): void {
  while (true) {
    const headerEnd = inputBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return;
    }

    const headerText = inputBuffer.subarray(0, headerEnd).toString("utf8");
    const contentLength = readContentLength(headerText);
    if (contentLength == null) {
      logToStderr("invalid message: missing Content-Length header");
      inputBuffer = Buffer.alloc(0);
      return;
    }

    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + contentLength;
    if (inputBuffer.length < messageEnd) {
      return;
    }

    const messageBody = inputBuffer.subarray(messageStart, messageEnd).toString("utf8");
    inputBuffer = inputBuffer.subarray(messageEnd);

    void handleRawMessage(messageBody);
  }
}

function readContentLength(headers: string): number | null {
  const lines = headers.split("\r\n");
  for (const line of lines) {
    const parts = line.split(":");
    if (parts.length < 2) {
      continue;
    }

    const key = parts[0].trim().toLowerCase();
    if (key !== "content-length") {
      continue;
    }

    const valueText = parts.slice(1).join(":").trim();
    const value = Number.parseInt(valueText, 10);
    if (!Number.isFinite(value) || value < 0) {
      return null;
    }

    return value;
  }

  return null;
}

async function handleRawMessage(raw: string): Promise<void> {
  let message: JsonRpcRequest;

  try {
    message = JSON.parse(raw) as JsonRpcRequest;
  } catch (err) {
    logToStderr(`invalid json: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    if (message.id != null) {
      sendError(message.id, -32600, "Invalid Request");
    }
    return;
  }

  if (message.id == null) {
    return;
  }

  try {
    switch (message.method) {
      case "initialize": {
        sendResult(message.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
          },
        });
        return;
      }
      case "tools/list": {
        sendResult(message.id, {
          tools: [
            {
              name: "ask_claude",
              description: "Call Claude Code CLI with a prompt and return the output.",
              inputSchema: {
                type: "object",
                properties: {
                  prompt: {
                    type: "string",
                    description: "Prompt to send to Claude Code CLI.",
                  },
                  cwd: {
                    type: "string",
                    description: "Optional working directory (must be allowlisted).",
                  },
                  timeoutMs: {
                    type: "number",
                    minimum: 1000,
                    description: "Optional timeout in milliseconds.",
                  },
                  maxOutputChars: {
                    type: "number",
                    minimum: 100,
                    description: "Optional max characters returned.",
                  },
                },
                required: ["prompt"],
                additionalProperties: false,
              },
            },
          ],
        });
        return;
      }
      case "tools/call": {
        const result = await handleToolCall(message.params);
        sendResult(message.id, result);
        return;
      }
      case "ping": {
        sendResult(message.id, {});
        return;
      }
      default:
        sendError(message.id, -32601, `Method not found: ${message.method}`);
    }
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    sendError(message.id, -32603, messageText);
  }
}

async function handleToolCall(params: unknown): Promise<unknown> {
  if (!isRecord(params)) {
    throw new Error("Invalid params for tools/call");
  }

  const name = params.name;
  if (name !== "ask_claude") {
    throw new Error(`Unknown tool: ${String(name)}`);
  }

  const args = (params.arguments || {}) as ToolCallArgs;
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) {
    return {
      content: [{ type: "text", text: "prompt is required" }],
      isError: true,
    };
  }

  try {
    const toolOutput = await runClaude(prompt, args);
    return {
      content: [{ type: "text", text: toolOutput }],
      isError: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }
}

async function runClaude(prompt: string, args: ToolCallArgs): Promise<string> {
  const timeoutMs = normalizeNumber(args.timeoutMs, config.defaultTimeoutMs, 1000);
  const maxOutputChars = normalizeNumber(args.maxOutputChars, config.defaultMaxOutputChars, 100);
  const cwd = resolveCwd(args.cwd);

  const command = config.claudeCommand;
  const cliArgs = [...config.claudeArgsPrefix, prompt];

  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(command, cliArgs, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 3000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      rejectPromise(new Error(`Failed to start Claude command (${command}): ${err.message}`));
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);

      const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n");
      const output = truncate(combined || "(no output)", maxOutputChars);

      if (timedOut) {
        rejectPromise(new Error(`Claude command timed out after ${timeoutMs}ms. Partial output:\n${output}`));
        return;
      }

      if (code !== 0) {
        const suffix = signal != null ? `signal=${signal}` : `exitCode=${String(code)}`;
        rejectPromise(new Error(`Claude command failed (${suffix}). Output:\n${output}`));
        return;
      }

      resolvePromise(output);
    });
  });
}

function resolveCwd(rawCwd: unknown): string {
  const cwd = typeof rawCwd === "string" && rawCwd.trim() ? resolve(rawCwd.trim()) : process.cwd();

  for (const allowed of config.allowedDirs) {
    if (isSubPath(cwd, allowed)) {
      return cwd;
    }
  }

  throw new Error(`cwd is not allowed: ${cwd}`);
}

function isSubPath(target: string, base: string): boolean {
  if (target === base) {
    return true;
  }

  const rel = relative(base, target);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`..${sep}`);
}

function parseAllowedDirs(raw: string | undefined): string[] {
  const values = (raw || process.cwd())
    .split(":")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(value));

  return values.length > 0 ? values : [process.cwd()];
}

function parseArgsPrefix(raw: string | undefined): string[] {
  if (raw == null || raw.trim() === "") {
    return ["-p"];
  }

  return raw
    .split(" ")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return value;
}

function normalizeNumber(value: unknown, fallback: number, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.floor(value));
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }

  return `${text.slice(0, max)}\n\n...[truncated ${text.length - max} chars]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

function sendResult(id: JsonRpcId, result: unknown): void {
  sendMessage({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function sendError(id: JsonRpcId, code: number, message: string): void {
  sendMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  });
}

function sendMessage(message: unknown): void {
  const payload = JSON.stringify(message);
  const contentLength = Buffer.byteLength(payload, "utf8");
  process.stdout.write(`Content-Length: ${contentLength}\r\n\r\n${payload}`);
}

function logToStderr(message: string): void {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}
