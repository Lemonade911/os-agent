import { mkdir, appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { RiskLevel } from "./types.js";

export interface AuditEvent {
  ts: string;
  sessionId: string;
  stage: "phases" | "risk" | "approval" | "execution";
  status: "pass" | "fail" | "blocked" | "approved" | "completed";
  riskLevel?: RiskLevel;
  command?: string;
  detail: string;
}

export class AuditLogger {
  constructor(
    private readonly filePath: string = process.env.OS_AGENT_AUDIT_PATH
      ? resolve(process.cwd(), process.env.OS_AGENT_AUDIT_PATH)
      : resolve(process.cwd(), "logs", "audit.jsonl")
  ) {}

  async log(event: AuditEvent): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
  }
}
