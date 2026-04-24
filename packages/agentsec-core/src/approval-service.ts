import type { ApprovalChallenge } from "./types.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const CONFIRM_KEYWORDS = [
  "确认",
  "继续",
  "同意",
  "可以执行",
  "强制执行",
  "我确认",
  "执行吧",
  "继续执行",
  "确定",
  "是的",
  "好的",
  "行",
  "没问题"
];
const CANCEL_KEYWORDS = ["取消", "不用了", "算了", "放弃", "不执行", "先别"];

function getPendingFilePath(): string {
  return resolve(process.cwd(), "logs", "pending-approvals.json");
}

export class ApprovalService {
  private readonly pendingBySession = new Map<string, ApprovalChallenge>();

  constructor() {
    this.loadFromDisk();
  }

  createChallenge(sessionId: string, command: string): ApprovalChallenge {
    const id = `confirm-${Date.now()}`;
    const requiredPhrase = "自然语言确认";
    const challenge: ApprovalChallenge = {
      id,
      sessionId,
      command,
      requiredPhrase,
      summary: `High-risk command requires approval: ${command}`,
      expiresAt: Date.now() + DEFAULT_TTL_MS
    };
    this.pendingBySession.set(sessionId, challenge);
    this.persistToDisk();
    return challenge;
  }

  getPending(sessionId: string): ApprovalChallenge | undefined {
    const challenge = this.pendingBySession.get(sessionId);
    if (!challenge) {
      return undefined;
    }
    if (Date.now() > challenge.expiresAt) {
      this.pendingBySession.delete(sessionId);
      this.persistToDisk();
      return undefined;
    }
    return challenge;
  }

  approve(sessionId: string, approvalText: string): ApprovalChallenge | undefined {
    const challenge = this.getPending(sessionId);
    if (!challenge) {
      return undefined;
    }
    const normalized = approvalText.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }
    if (CANCEL_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
      this.pendingBySession.delete(sessionId);
      this.persistToDisk();
      return undefined;
    }
    const isConfirmIntent = CONFIRM_KEYWORDS.some((keyword) => normalized.includes(keyword));
    if (!isConfirmIntent) {
      return undefined;
    }
    const messageTargets = this.extractTargets(normalized);
    if (messageTargets.length > 0) {
      const commandTargets = this.extractTargets(challenge.command.toLowerCase());
      const hasOverlap = messageTargets.some((target) => commandTargets.includes(target));
      if (!hasOverlap) {
        return undefined;
      }
    }
    this.pendingBySession.delete(sessionId);
    this.persistToDisk();
    return challenge;
  }

  private extractTargets(text: string): string[] {
    const pathTargets = [...text.matchAll(/\/[a-z0-9._\-\/]+/gi)].map((match) => match[0].toLowerCase());
    const userTargets = [...text.matchAll(/\buser(?:add|del)?\s+([a-z0-9._-]+)/gi)].map((match) => match[1].toLowerCase());
    const explicitChineseUser = [...text.matchAll(/(?:用户|账号)\s*([a-z0-9._-]+)/gi)].map((match) => match[1].toLowerCase());
    return [...new Set([...pathTargets, ...userTargets, ...explicitChineseUser])];
  }

  private persistToDisk(): void {
    const filePath = getPendingFilePath();
    try {
      const parent = dirname(filePath);
      if (!existsSync(parent)) {
        mkdirSync(parent, { recursive: true });
      }
      const data: Record<string, ApprovalChallenge> = {};
      for (const [sid, challenge] of this.pendingBySession.entries()) {
        if (Date.now() <= challenge.expiresAt) {
          data[sid] = challenge;
        }
      }
      writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
      console.error("[ApprovalService] persistToDisk failed:", e);
    }
  }

  private loadFromDisk(): void {
    const filePath = getPendingFilePath();
    try {
      if (!existsSync(filePath)) return;
      const raw = readFileSync(filePath, "utf8");
      const sanitized = raw.replace(/^\uFEFF/, "").replace(/^[^\[{]+/, "").trim();
      if (!sanitized) return;
      const parsed = JSON.parse(sanitized) as Record<string, ApprovalChallenge>;
      const now = Date.now();
      for (const [sid, challenge] of Object.entries(parsed)) {
        if (challenge && typeof challenge.expiresAt === "number" && now <= challenge.expiresAt) {
          this.pendingBySession.set(sid, challenge);
        }
      }
    } catch {
      // ignore invalid persisted state
    }
  }
}
