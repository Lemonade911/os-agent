import dotenv from "dotenv";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LLMClient, loadLLMConfig, Orchestrator } from "@os-agent/runtime";
import type { SSHConfig } from "@os-agent/executors";

interface ChatRequestBody {
  session_id?: string;
  approval_text?: string;
  messages?: Array<{ role?: string; content?: string }>;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

loadEnvFiles();

const llmConfig = loadLLMConfig();
const llmClient = new LLMClient(llmConfig);
const orchestrator = new Orchestrator(llmClient);
const BUILD_STAMP = new Date().toISOString();
const RUNTIME_MARKER = "fusion-core-live-marker-2025-02-path-fix";

app.use((_req, res, next) => {
  res.setHeader("x-fusion-build-stamp", BUILD_STAMP);
  res.setHeader("x-fusion-runtime-marker", RUNTIME_MARKER);
  next();
});

app.get("/", (_req: Request, res: Response) => {
  res.type("application/json").json({ ok: true, runtimeMarker: RUNTIME_MARKER, buildStamp: BUILD_STAMP });
});

app.post("/v1/chat/completions", async (req: Request, res: Response) => {
  try {
    const body = req.body as ChatRequestBody;
    const userMessage = extractUserMessage(body);
    if (!userMessage) {
      res.status(400).json({ error: "No user message found in OpenAI messages array." });
      return;
    }

    const executorMode = (process.env.OS_AGENT_EXECUTOR_MODE ?? "local") as "local" | "ssh";
    const sshConfig = executorMode === "ssh" ? buildSshConfigFromEnv() : undefined;

    const result = await orchestrator.handleRequest({
      sessionId: body.session_id,
      userMessage,
      approvalText: body.approval_text,
      executorMode,
      sshConfig,
      targetHost: sshConfig?.host
    });

    const content = renderResponseContent(result);
    res.json(toOpenAIResponse(content));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

const basePort = Number(process.env.OS_AGENT_PORT ?? 3000);
void startServerWithFallback(basePort);

function extractUserMessage(body: ChatRequestBody): string {
  const messages = body.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (item.role === "user" && typeof item.content === "string" && item.content.trim()) {
      return item.content.trim();
    }
  }
  return "";
}

function buildSshConfigFromEnv(): SSHConfig {
  const host = process.env.SSH_HOST;
  const username = process.env.SSH_USERNAME;
  const password = process.env.SSH_PASSWORD;
  const privateKey = process.env.SSH_PRIVATE_KEY;
  const port = Number(process.env.SSH_PORT ?? 22);

  if (!host || !username) {
    throw new Error("SSH mode requires SSH_HOST and SSH_USERNAME.");
  }
  if (!password && !privateKey) {
    throw new Error("SSH mode requires either SSH_PASSWORD or SSH_PRIVATE_KEY.");
  }
  return { host, port, username, ...(password ? { password } : {}), ...(privateKey ? { privateKey } : {}) };
}

function toOpenAIResponse(content: string) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "os-agent-proxy",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }]
  };
}

async function startServerWithFallback(basePort: number): Promise<void> {
  const maxAttempts = 10;
  let currentPort = basePort;
  for (let i = 0; i < maxAttempts; i += 1) {
    const started = await tryListen(currentPort);
    if (started) {
      process.env.OS_AGENT_PORT = String(currentPort);
      console.log(`Server is running on port ${currentPort}`);
      return;
    }
    currentPort += 1;
  }
  throw new Error(`Failed to start server. Ports ${basePort}-${currentPort - 1} are unavailable.`);
}

async function tryListen(port: number): Promise<boolean> {
  const server = createServer(app);
  return new Promise<boolean>((resolvePromise, rejectPromise) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      server.close(() => {
        if (error.code === "EADDRINUSE") {
          resolvePromise(false);
          return;
        }
        rejectPromise(error);
      });
    });
    server.listen(port, () => resolvePromise(true));
  });
}

function loadEnvFiles() {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, ".env"),
    resolve(currentDir, "..", ".env"),
    resolve(currentDir, "..", "..", ".env"),
    resolve(currentDir, "..", "..", "..", ".env"),
    resolve(currentDir, "..", "..", "..", "..", ".env")
  ];
  for (const envPath of candidates) {
    if (existsSync(envPath)) {
      dotenv.config({ path: envPath, override: false });
      return;
    }
  }
  dotenv.config();
}

function renderResponseContent(result: {
  blocked: boolean;
  naturalSummary?: string;
}) {
  return normalizeForDisplay(result.naturalSummary) || (result.blocked ? "该请求已被安全策略拦截。" : "已完成处理。");
}

function normalizeForDisplay(content?: string): string {
  if (!content) return "";
  return content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[`*#]/g, "")
    .replace(/\bOSA_RESULT:[^\n\r]*/g, "")
    .replace(/\[Step\s+\d+\][^\n\r]*/g, "")
    .replace(/Pending high-risk command[^\n\r]*/gi, "")
    .replace(/APPROVE\s+[A-Za-z0-9-]+/g, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
