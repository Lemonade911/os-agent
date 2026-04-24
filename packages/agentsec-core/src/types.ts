export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface SecurityContext {
  sessionId: string;
  executorMode: "local" | "ssh";
  command?: string;
  targetHost?: string;
}

export interface RiskDecision {
  allow: boolean;
  reason?: string;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
}

export interface ApprovalChallenge {
  id: string;
  sessionId: string;
  command: string;
  requiredPhrase: string;
  summary: string;
  expiresAt: number;
}

export interface SecurityGateResult {
  allow: boolean;
  blockedReason?: string;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  challenge?: ApprovalChallenge;
}
