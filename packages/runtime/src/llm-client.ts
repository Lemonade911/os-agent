import type { LLMConfig } from "./types.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LLMResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

interface SessionState {
  history: LLMMessage[];
  lastRawOutput?: string;
}

export class LLMClient {
  private static readonly SYSTEM_PROMPT = [
    "You are FusionOS Linux operation planner.",
    "Identity rule: you are FusionOS assistant only; never claim to be Kiro, AWS, Claude, or any third-party brand.",
    "Use user-facing, concise Chinese for chat.",
    "When user asks chat-only question, return: [CHAT_ONLY] <reply>.",
    "For ops tasks and system information queries, return executable Linux command(s) only.",
    "For read-only inspection requests, do not explain which command to run; output the command itself.",
    "Never include explanations, markdown fences, headings, bullets, or words like 'bash'.",
    "Do not output multi-line shell blocks. Use one-line commands only.",
    "Use deterministic markers for state changes: OSA_RESULT:<STATUS>:<TARGET>."
  ].join(" ");
  private static readonly CHAT_SYSTEM_PROMPT =
    [
      "你是 FusionOS 智能运维助手。",
      "对话要求：像真实运维同事一样说话，简洁、自然、面向小白。",
      "不要反复问用户问题；能直接给结论/建议就直接给。",
      "只有在缺少关键参数且无法安全推断时，才允许问一个澄清问题。",
      "不要复读同一种句式（避免每次都用同样的模板开头/结尾）。",
      "禁止 markdown。禁止提及 Kiro、AWS、Claude、/model 或任何第三方产品命令。"
    ].join(" ");
  private static readonly SUMMARY_SYSTEM_PROMPT =
    [
      "你是 FusionOS 智能运维助手。",
      "请把执行结果翻译成面向小白用户的中文说明：先说结论，再补充1-2个关键细节。",
      "不要用客服式反问；不要让用户再选来选去。",
      "禁止输出命令、路径拼接细节、代码块、Markdown符号、内部标记（如 OSA_RESULT）。",
      "避免术语堆砌；必须像客服解释给普通用户听得懂。"
    ].join(" ");
  private static readonly REPAIR_SYSTEM_PROMPT =
    "你是 Linux 运维专家。上一条命令失败，请只返回一条修复命令，不要解释。";
  private static readonly MAX_HISTORY_MESSAGES = 10;
  private static readonly SESSION_HISTORY_PATH = resolve(process.cwd(), "logs", "llm-session-history.json");

  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly config: LLMConfig) {
    this.loadSessionsFromDisk();
  }

  async generateLinuxCommand(sessionId: string, userMessage: string): Promise<string> {
    const state = this.getSessionState(sessionId);
    const messages: LLMMessage[] = [{ role: "system", content: LLMClient.SYSTEM_PROMPT }];
    if (this.shouldAttachLastRawOutputToPlanner(userMessage)) {
      messages.push({ role: "system", content: `Hidden context:\n${state.lastRawOutput ?? "(none)"}` });
    }
    messages.push({ role: "user", content: userMessage });
    const payload = await this.requestChatCompletions(messages);
    const command = payload.choices?.[0]?.message?.content?.trim();
    if (!command) {
      throw new Error("LLM returned an empty command.");
    }
    return this.normalizePlannerOutput(command);
  }

  async generateChatReply(userMessage: string, lastRawOutput?: string): Promise<string> {
    const payload = await this.requestChatCompletions([
      { role: "system", content: LLMClient.CHAT_SYSTEM_PROMPT },
      { role: "user", content: `用户输入：${userMessage}\n最近输出：${lastRawOutput ?? "(none)"}` }
    ]);
    const reply = payload.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      throw new Error("LLM returned an empty chat reply.");
    }
    return reply;
  }

  async summarizeOutput(command: string, rawOutput: string, repairLog?: string): Promise<string> {
    const payload = await this.requestChatCompletions([
      { role: "system", content: LLMClient.SUMMARY_SYSTEM_PROMPT },
      {
        role: "user",
        content: repairLog
          ? `命令：${command}\n修复：${repairLog}\n输出：\n${rawOutput}`
          : `命令：${command}\n输出：\n${rawOutput}`
      }
    ]);
    const rawSummary = payload.choices?.[0]?.message?.content?.trim() || "已完成处理。";
    return this.normalizeUserFacingSummary(rawSummary);
  }

  async explainSecurityBlock(command: string, reason: string): Promise<string> {
    const payload = await this.requestChatCompletions([
      {
        role: "system",
        content:
          "请用面向小白用户的中文解释风险。风格要求：先一句结论，再一句原因，最后一句确认提示。总长度控制在3句以内，不要模板化长段落。"
      },
      { role: "user", content: `command=${command}\nreason=${reason}` }
    ]);
    return payload.choices?.[0]?.message?.content?.trim() || "该操作存在风险，是否继续？";
  }

  async generateRepairCommand(failedCommand: string, errorMessage: string, lastRawOutput?: string): Promise<string> {
    const payload = await this.requestChatCompletions([
      { role: "system", content: LLMClient.REPAIR_SYSTEM_PROMPT },
      {
        role: "user",
        content: `failedCommand=${failedCommand}\nerrorMessage=${errorMessage}\nlastRawOutput=${lastRawOutput ?? "(none)"}`
      }
    ]);
    const cmd = payload.choices?.[0]?.message?.content?.trim();
    if (!cmd) {
      throw new Error("LLM returned an empty repair command.");
    }
    return cmd.replace(/^`+|`+$/g, "").trim();
  }

  appendAssistantMessage(sessionId: string, content: string): void {
    if (!content.trim()) {
      return;
    }
    const state = this.getSessionState(sessionId);
    state.history.push({ role: "assistant", content });
    this.trimHistory(state.history);
    this.persistSessionsToDisk();
  }

  setLastRawOutput(sessionId: string, rawOutput: string): void {
    this.getSessionState(sessionId).lastRawOutput = rawOutput;
    this.persistSessionsToDisk();
  }

  getLastRawOutput(sessionId: string): string | undefined {
    return this.getSessionState(sessionId).lastRawOutput;
  }

  private async requestChatCompletions(messages: LLMMessage[]): Promise<LLMResponse> {
    const baseUrlLower = this.config.baseUrl.toLowerCase();
    const isAnthropicLike = baseUrlLower.includes("anthropic");
    const isOpenAiCompatibleRelay = baseUrlLower.includes("squarefaceicon");
    const modelCandidates = [this.config.model, ...this.config.fallbackModels].filter(
      (v, i, arr) => arr.indexOf(v) === i
    );
    let lastErr = "";
    for (const model of modelCandidates) {
      const endpoint = this.buildEndpoint(isAnthropicLike && !isOpenAiCompatibleRelay);
      const body = isAnthropicLike && !isOpenAiCompatibleRelay
        ? {
            model,
            max_tokens: 4096,
            system: messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n"),
            messages: messages.filter((m) => m.role !== "system"),
            temperature: 0
          }
        : { model, temperature: 0, messages };
      const headers: Record<string, string> = isAnthropicLike && !isOpenAiCompatibleRelay
        ? {
            "Content-Type": "application/json",
            "x-api-key": this.config.apiKey,
            "anthropic-version": "2023-06-01"
          }
        : {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`
          };
      const resp = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
      if (!resp.ok) {
        const txt = await resp.text();
        lastErr = `LLM request failed: ${resp.status} ${txt}`;
        if (!/model_not_found|no available channel|model does not exist/i.test(txt)) {
          throw new Error(lastErr);
        }
        continue;
      }
      const bodyText = await resp.text();
      let data: any;
      try {
        data = JSON.parse(bodyText);
      } catch {
        throw new Error(`LLM response parse failed: ${bodyText}`);
      }
      if (isAnthropicLike && !isOpenAiCompatibleRelay) {
        const text = data?.content?.find((x: any) => x?.type === "text")?.text ?? data?.content?.[0]?.text;
        return { choices: [{ message: { content: text ?? "" } }] };
      }
      return data as LLMResponse;
    }
    throw new Error(lastErr || "LLM request failed.");
  }

  private buildEndpoint(isAnthropicLike: boolean): string {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    if (isAnthropicLike) {
      if (base.endsWith("/messages")) return base;
      return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
    }
    if (base.endsWith("/chat/completions")) return base;
    return base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  }

  private normalizePlannerOutput(raw: string): string {
    let text = raw.trim();
    const fenced = text.match(/```(?:bash|sh|shell)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      text = fenced[1].trim();
    }
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !this.isNarrativeLine(line))
      .filter((line) => !/^(bash|shell|sh)$/i.test(line));

    if (lines.length === 0) {
      throw new Error("Planner output does not contain executable command lines.");
    }

    if (lines[0].startsWith("if ") && lines.some((line) => line === "fi" || line.endsWith(" fi"))) {
      return lines.join(" ").replace(/\s+/g, " ").trim();
    }

    return lines.join("\n").replace(/^`+|`+$/g, "").trim();
  }

  private isNarrativeLine(line: string): boolean {
    if (/^(好的|现在|首先|以下|步骤|说明|我将|开始执行|请|然后)/.test(line)) {
      return true;
    }
    if (/^[\u4e00-\u9fa5，。！？：；、“”\s]+$/.test(line)) {
      return true;
    }
    return false;
  }

  private normalizeUserFacingSummary(summary: string): string {
    const cleaned = summary
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`+/g, "")
      .replace(/\bOSA_RESULT:[^\n\r]*/g, "")
      .replace(/\b(?:bash|shell|cmd)\b/gi, "")
      .replace(/^\s*[-*]\s+/gm, "")
      .replace(/^执行操作[:：].*$/gm, "")
      .replace(/^关键细节[:：]\s*$/gm, "")
      .replace(/^结论[:：]\s*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return cleaned || "已完成处理。";
  }

  private shouldAttachLastRawOutputToPlanner(userMessage: string): boolean {
    const trimmed = userMessage.trim();
    if (!trimmed) {
      return false;
    }
    return /(上面|刚才|上一条|这个输出|这段输出|这个结果|基于上次|继续刚才|继续上次|根据上面的结果)/i.test(trimmed);
  }

  private getSessionState(sessionId: string): SessionState {
    const key = sessionId.trim() || "default";
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const created: SessionState = { history: [] };
    this.sessions.set(key, created);
    return created;
  }

  private loadSessionsFromDisk(): void {
    try {
      if (!existsSync(LLMClient.SESSION_HISTORY_PATH)) {
        return;
      }
      const raw = readFileSync(LLMClient.SESSION_HISTORY_PATH, "utf8");
      if (!raw.trim()) {
        return;
      }
      const parsed = JSON.parse(raw) as Record<string, { history?: LLMMessage[]; lastRawOutput?: string }>;
      for (const [sessionId, value] of Object.entries(parsed)) {
        const history = Array.isArray(value.history) ? value.history.slice(-LLMClient.MAX_HISTORY_MESSAGES) : [];
        const cleanedHistory = history
          .filter((m) => m && (m.role === "user" || m.role === "assistant" || m.role === "system") && typeof m.content === "string")
          .map((m) => ({ role: m.role, content: m.content })) as LLMMessage[];
        const state: SessionState = { history: cleanedHistory };
        if (typeof value.lastRawOutput === "string") {
          state.lastRawOutput = value.lastRawOutput;
        }
        this.sessions.set(sessionId, state);
      }
    } catch {
      // ignore
    }
  }

  private persistSessionsToDisk(): void {
    try {
      const parent = dirname(LLMClient.SESSION_HISTORY_PATH);
      if (!existsSync(parent)) {
        mkdirSync(parent, { recursive: true });
      }
      const serializable: Record<string, { history: LLMMessage[]; lastRawOutput?: string }> = {};
      for (const [sessionId, state] of this.sessions.entries()) {
        if (!state.history.length && !state.lastRawOutput) {
          continue;
        }
        serializable[sessionId] = {
          history: state.history.slice(-LLMClient.MAX_HISTORY_MESSAGES),
          ...(state.lastRawOutput ? { lastRawOutput: state.lastRawOutput } : {})
        };
      }
      writeFileSync(LLMClient.SESSION_HISTORY_PATH, JSON.stringify(serializable, null, 2), "utf8");
    } catch {
      // ignore
    }
  }

  private trimHistory(history: LLMMessage[]): void {
    if (history.length > LLMClient.MAX_HISTORY_MESSAGES) {
      history.splice(0, history.length - LLMClient.MAX_HISTORY_MESSAGES);
    }
  }
}
