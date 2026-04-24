import type { SSHConfig } from "@os-agent/executors";
import type { ApprovalChallenge, RiskLevel } from "@os-agent/agentsec-core";

export interface OrchestratorRequest {
  sessionId?: string;
  userMessage: string;
  approvalText?: string;
  executorMode?: "local" | "ssh";
  sshConfig?: SSHConfig;
  targetHost?: string;
}

export interface OrchestratorResult {
  command: string;
  output: string;
  naturalSummary?: string;
  chatOnly?: boolean;
  blocked: boolean;
  reason?: string;
  riskLevel?: RiskLevel;
  requiresApproval?: boolean;
  challenge?: ApprovalChallenge;
  trace: Array<{ step: string; status: "ok" | "blocked" | "error"; detail: string }>;
}

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  fallbackModels: string[];
}
