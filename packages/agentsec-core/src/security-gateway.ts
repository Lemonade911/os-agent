import { ApprovalService } from "./approval-service.js";
import { AuditLogger } from "./audit-logger.js";
import { runSecurityPhases } from "./phase-runner.js";
import { RiskEngine } from "./risk-engine.js";
import type { SecurityContext, SecurityGateResult } from "./types.js";

export class SecurityGateway {
  private readonly riskEngine = new RiskEngine();
  private readonly approvalService = new ApprovalService();
  private readonly auditLogger = new AuditLogger();

  async evaluateCommand(ctx: SecurityContext & { command: string }): Promise<SecurityGateResult> {
    const phaseResult = runSecurityPhases(ctx);
    if (!phaseResult.ok) {
      await this.auditLogger.log({
        ts: new Date().toISOString(),
        sessionId: ctx.sessionId,
        stage: "phases",
        status: "fail",
        command: ctx.command,
        detail: phaseResult.reason ?? "Security phase failed."
      });
      return {
        allow: false,
        blockedReason: phaseResult.reason,
        riskLevel: "critical",
        requiresApproval: false
      };
    }

    await this.auditLogger.log({
      ts: new Date().toISOString(),
      sessionId: ctx.sessionId,
      stage: "phases",
      status: "pass",
      command: ctx.command,
      detail: "All security phases passed."
    });

    const risk = this.riskEngine.evaluate(ctx.command);
    if (!risk.allow) {
      await this.auditLogger.log({
        ts: new Date().toISOString(),
        sessionId: ctx.sessionId,
        stage: "risk",
        status: "blocked",
        riskLevel: risk.riskLevel,
        command: ctx.command,
        detail: risk.reason ?? "Blocked by risk engine."
      });
      return {
        allow: false,
        blockedReason: risk.reason,
        riskLevel: risk.riskLevel,
        requiresApproval: false
      };
    }

    if (risk.requiresApproval) {
      const challenge = this.approvalService.createChallenge(ctx.sessionId, ctx.command);
      await this.auditLogger.log({
        ts: new Date().toISOString(),
        sessionId: ctx.sessionId,
        stage: "approval",
        status: "blocked",
        riskLevel: risk.riskLevel,
        command: ctx.command,
        detail: "Approval required: waiting for natural-language confirmation from user."
      });
      return {
        allow: false,
        blockedReason: risk.reason,
        riskLevel: risk.riskLevel,
        requiresApproval: true,
        challenge
      };
    }

    return {
      allow: true,
      riskLevel: risk.riskLevel,
      requiresApproval: false
    };
  }

  approveIfPending(sessionId: string, approvalText: string) {
    return this.approvalService.approve(sessionId, approvalText);
  }

  getPendingApproval(sessionId: string) {
    return this.approvalService.getPending(sessionId);
  }

  async logExecution(sessionId: string, command: string, detail: string): Promise<void> {
    await this.auditLogger.log({
      ts: new Date().toISOString(),
      sessionId,
      stage: "execution",
      status: "completed",
      command,
      detail
    });
  }
}
