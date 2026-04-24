import { SecurityGateway } from "@os-agent/agentsec-core";
import { LocalExecutor, SSHExecutor } from "@os-agent/executors";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { LLMClient } from "./llm-client.js";
import { buildHelloWebCleanupCommand, buildHelloWebStartCommand, extractHelloWebContent, getHelloWebStateFile } from "./hello-web.js";
import { buildNginxRollbackCommand, buildNginxStartCommand, buildNginxStatusCommand, buildNginxStopCommand } from "./nginx.js";
import { RollbackService } from "./rollback-service.js";
import type { OrchestratorRequest, OrchestratorResult } from "./types.js";
import type { ApprovalChallenge } from "@os-agent/agentsec-core";

export class Orchestrator {
  private static readonly CHAT_RESPONSE_DELAY_MS = 700;
  private static readonly MAX_TASK_STEPS = 6;
  private static readonly TRASH_DIR = "/tmp/.fusion_os_trash";
  private static readonly BACKUP_DIR = "/tmp/.fusion_os_backup";
  private static readonly HELLO_WEB_STATE_DIR = "/tmp/.fusion_os_hello_web";
  private static readonly SESSION_MEMORY_PATH = resolve(process.cwd(), "logs", "session-memory.json");
  private static readonly PENDING_APPROVAL_PATH = resolve(process.cwd(), "logs", "pending-approvals.json");
  private readonly securityGateway = new SecurityGateway();
  private readonly localExecutor = new LocalExecutor();
  private readonly sshExecutor = new SSHExecutor();
  private readonly rollbackService = new RollbackService();
  private readonly sessionContext = new Map<string, { recentPaths: string[]; updatedAt: number }>();
  private readonly sessionLastMentionedPath = new Map<string, string>();
  private readonly helloWebSessions = new Map<
    string,
    { pid: number; port: number; content: string; mode: "local" | "ssh"; targetHost?: string }
  >();
  private readonly persistedPendingApprovals = new Map<string, ApprovalChallenge>();

  constructor(private readonly llmClient: LLMClient) {
    this.loadSessionContextFromDisk();
    this.loadPendingApprovalsFromDisk();
  }

  async handleRequest(request: OrchestratorRequest): Promise<OrchestratorResult> {
    const sessionId = request.sessionId ?? "default";
    const trace: OrchestratorResult["trace"] = [];
    const mode = request.executorMode ?? "local";
    const approvalInput = `${request.userMessage ?? ""} ${request.approvalText ?? ""}`.trim();

    const intentBlockReason = this.getIntentLevelBlockReason(request.userMessage);
    if (intentBlockReason) {
      this.llmClient.appendAssistantMessage(sessionId, intentBlockReason);
      trace.push({ step: "intent-block", status: "blocked", detail: intentBlockReason });
      return {
        command: "[INTENT_BLOCKED]",
        output: "",
        naturalSummary: intentBlockReason,
        blocked: true,
        reason: intentBlockReason,
        riskLevel: "critical",
        requiresApproval: false,
        trace
      };
    }

    this.rememberPathsFromText(sessionId, request.userMessage ?? "");
    const latestMention = this.extractLatestPath(request.userMessage ?? "");
    if (latestMention && !this.isInternalMemoryPath(latestMention)) {
      this.sessionLastMentionedPath.set(sessionId, latestMention);
    }

    if (this.isRollbackCancelIntent(request.userMessage)) {
      return await this.handleRollbackCancelIntent(sessionId, trace);
    }
    if (this.isRollbackConfirmIntent(request.userMessage)) {
      const confirmedRollback = await this.handleRollbackConfirmIntent({
        sessionId,
        mode,
        request,
        trace,
        confirmIndex: this.extractRollbackIndex(request.userMessage)
      });
      if (confirmedRollback) {
        return confirmedRollback;
      }
    }
    if (this.isRollbackListIntent(request.userMessage)) {
      return this.handleRollbackListIntent(sessionId, trace);
    }
    if (this.isRollbackPreviewIntent(request.userMessage)) {
      return this.handleRollbackPreviewIntent(sessionId, trace);
    }
    if (this.isRollbackIntent(request.userMessage)) {
      const rollbackResult = await this.handleRollbackIntent({
        sessionId,
        mode,
        request,
        trace,
        rollbackIndex: this.extractRollbackIndex(request.userMessage)
      });
      if (rollbackResult) {
        return rollbackResult;
      }
    }
    const clarificationOnly = this.handlePathClarificationIntent(request.userMessage, trace);
    if (clarificationOnly) {
      return clarificationOnly;
    }

    const deterministicServerBootstrap = await this.handleDeterministicServerBootstrapIntent({ sessionId, mode, request, trace });
    if (deterministicServerBootstrap) {
      return deterministicServerBootstrap;
    }

    const deterministicHelloWeb = await this.handleDeterministicHelloWebIntent({ sessionId, mode, request, trace });
    if (deterministicHelloWeb) {
      return deterministicHelloWeb;
    }
    const deterministicNginx = await this.handleDeterministicNginxIntent({ sessionId, mode, request, trace });
    if (deterministicNginx) {
      return deterministicNginx;
    }
    const deterministicCreateOps = await this.handleDeterministicCreateOpsIntent({ sessionId, mode, request, trace });
    if (deterministicCreateOps) {
      return deterministicCreateOps;
    }
    const deterministicCreateWriteView = await this.handleDeterministicCreateWriteViewIntent({ sessionId, mode, request, trace });
    if (deterministicCreateWriteView) {
      return deterministicCreateWriteView;
    }

    const deterministicCheck = await this.handleDeterministicCheckIntent({ sessionId, mode, request, trace });
    if (deterministicCheck) {
      return deterministicCheck;
    }
    const deterministicFileView = await this.handleDeterministicFileViewIntent({ sessionId, mode, request, trace });
    if (deterministicFileView) {
      return deterministicFileView;
    }
    const deterministicRecentFileFollowup = await this.handleDeterministicRecentFileFollowupIntent({ sessionId, mode, request, trace });
    if (deterministicRecentFileFollowup) {
      return deterministicRecentFileFollowup;
    }
    const deterministicLocate = await this.handleDeterministicLocateIntent({ sessionId, mode, request, trace });
    if (deterministicLocate) {
      return deterministicLocate;
    }
    const deterministicDiskUsage = await this.handleDeterministicDiskUsageIntent({ sessionId, mode, request, trace });
    if (deterministicDiskUsage) {
      return deterministicDiskUsage;
    }
    const deterministicSystemInfo = await this.handleDeterministicSystemInfoIntent({ sessionId, mode, request, trace });
    if (deterministicSystemInfo) {
      return deterministicSystemInfo;
    }
    const deterministicFirewall = await this.handleDeterministicFirewallIntent({ sessionId, mode, request, trace });
    if (deterministicFirewall) {
      return deterministicFirewall;
    }
    const deterministicService = await this.handleDeterministicServiceIntent({ sessionId, mode, request, trace });
    if (deterministicService) {
      return deterministicService;
    }
    const deterministicMemory = await this.handleDeterministicMemoryIntent({ sessionId, mode, request, trace });
    if (deterministicMemory) {
      return deterministicMemory;
    }
    const deterministicLogHealth = await this.handleDeterministicLogHealthIntent({ sessionId, mode, request, trace });
    if (deterministicLogHealth) {
      return deterministicLogHealth;
    }
    const deterministicPortProc = await this.handleDeterministicPortProcessIntent({ sessionId, mode, request, trace });
    if (deterministicPortProc) {
      return deterministicPortProc;
    }
    const deterministicLogOps = await this.handleDeterministicLogOpsIntent({ sessionId, mode, request, trace });
    if (deterministicLogOps) {
      return deterministicLogOps;
    }
    const deterministicFileEdit = await this.handleDeterministicFileEditIntent({ sessionId, mode, request, trace });
    if (deterministicFileEdit) {
      return deterministicFileEdit;
    }
    const deterministicTime = await this.handleDeterministicTimeIntent({ sessionId, mode, request, trace });
    if (deterministicTime) {
      return deterministicTime;
    }
    const deterministicNetCfg = await this.handleDeterministicNetworkConfigIntent({ sessionId, mode, request, trace });
    if (deterministicNetCfg) {
      return deterministicNetCfg;
    }
    const deterministicNetwork = await this.handleDeterministicNetworkIntent({ sessionId, mode, request, trace });
    if (deterministicNetwork) {
      return deterministicNetwork;
    }
    const deterministicIp = await this.handleDeterministicIpIntent({ sessionId, mode, request, trace });
    if (deterministicIp) {
      return deterministicIp;
    }
    const deterministicPerf = await this.handleDeterministicPerfIntent({ sessionId, mode, request, trace });
    if (deterministicPerf) {
      return deterministicPerf;
    }

    const hadPendingApprovalBefore =
      Boolean(this.securityGateway.getPendingApproval(sessionId)) || Boolean(this.getPersistedPending(sessionId));
    const approved = this.securityGateway.approveIfPending(sessionId, approvalInput) ?? this.approvePersistedPending(sessionId, approvalInput);
    if (approved) {
      trace.push({
        step: "approval",
        status: "ok",
        detail: "User provided natural-language confirmation."
      });
      const approvalExecution = await this.executeWithAutoRepair({
        sessionId,
        mode,
        request,
        command: approved.command,
        trace
      });
      if (approvalExecution.blockedResult) {
        return approvalExecution.blockedResult;
      }
      const approvalOutput = approvalExecution.output;
      const approvalRollback = this.deriveRollbackFromMarkers(
        sessionId,
        approved.command,
        approved.command,
        approvalOutput
      );
      if (approvalRollback && this.shouldRecordRollback(approvalRollback, approvalOutput)) {
        this.rollbackService.record({
          sessionId,
          originalCommand: approved.command,
          executedCommand: approved.command,
          inverseCommand: approvalRollback.inverseCommand,
          description: approvalRollback.description
        });
      }
      this.clearPersistedPending(sessionId);
      const approvalSummary = await this.llmClient.summarizeOutput(
        approved.command,
        approvalOutput,
        approvalExecution.repairLog
      );
      this.llmClient.setLastRawOutput(sessionId, approvalOutput);
      this.rememberPathsFromText(sessionId, approved.command);
      this.rememberPathsFromText(sessionId, approvalOutput);
      this.llmClient.appendAssistantMessage(sessionId, `高风险操作已按你的确认执行：${approvalSummary}`);
      await this.securityGateway.logExecution(sessionId, approved.command, "Executed approved pending command.");
      return {
        command: approved.command,
        output: approvalOutput,
        naturalSummary: approvalSummary,
        blocked: false,
        riskLevel: "high",
        requiresApproval: false,
        trace
      };
    }
    const pendingApproval = this.securityGateway.getPendingApproval(sessionId) ?? this.getPersistedPending(sessionId);
    if (pendingApproval) {
      const pendingCommand = pendingApproval.command;
      const pendingExpiresAt = pendingApproval.expiresAt;
      const normalized = request.userMessage.trim().toLowerCase();
      if (this.shouldTreatAsGeneralChat(normalized) && !this.looksLikeOpsIntent(request.userMessage ?? "")) {
        const chatReply =
          (await this.buildFallbackChatReply(sessionId, request.userMessage)) ??
          "我在。你可以继续提问，也可以回复“继续”来执行刚才的高风险操作。";
        return {
          command: "[CHAT_ONLY]",
          output: "",
          naturalSummary: `${chatReply}\n\n提示：你还有一个待确认的高风险操作。如需执行，回复“继续”或“我确认执行”；如需放弃，回复“取消”。`,
          chatOnly: true,
          blocked: false,
          trace
        };
      }
      trace.push({
        step: "approval",
        status: "blocked",
        detail: `Pending high-risk command awaits confirmation: ${pendingCommand}`
      });
      const pendingNotice =
        "我已记录上一步高风险操作。若你确认强制执行，请直接回复“继续”或“我确认执行”；若要放弃，请回复“取消”。";
      this.persistPendingApproval(sessionId, pendingCommand, pendingExpiresAt);
      this.llmClient.appendAssistantMessage(sessionId, pendingNotice);
      return {
        command: pendingCommand,
        output: "",
        naturalSummary: pendingNotice,
        blocked: true,
        reason: "Waiting for explicit user confirmation.",
        riskLevel: "high",
        requiresApproval: true,
        challenge: pendingApproval,
        trace
      };
    }

    if (this.isPureCancelPhrase(request.userMessage ?? "")) {
      const summary = hadPendingApprovalBefore
        ? "好的，已取消刚才待确认的高风险操作。"
        : "当前没有待确认的操作可取消。你可以直接告诉我你想做什么。";
      this.llmClient.appendAssistantMessage(sessionId, summary);
      return {
        command: "[CANCEL_PENDING_APPROVAL]",
        output: "",
        naturalSummary: summary,
        blocked: false,
        trace
      };
    }

    if (this.isPureConfirmationPhrase(request.userMessage ?? "")) {
      const summary = "当前没有待确认的操作。你可以直接告诉我你想做什么。";
      this.llmClient.appendAssistantMessage(sessionId, summary);
      return {
        command: "[NO_PENDING_APPROVAL]",
        output: "",
        naturalSummary: summary,
        blocked: false,
        trace
      };
    }

    const fallbackChatReply = await this.buildFallbackChatReply(sessionId, request.userMessage);
    if (fallbackChatReply) {
      await this.delay(Orchestrator.CHAT_RESPONSE_DELAY_MS);
      trace.push({ step: "planner", status: "ok", detail: "Local fallback classified chat-only intent." });
      this.llmClient.appendAssistantMessage(sessionId, fallbackChatReply);
      return {
        command: "[CHAT_ONLY]",
        output: "",
        naturalSummary: fallbackChatReply,
        chatOnly: true,
        blocked: false,
        trace
      };
    }

    const enrichedUserMessage = this.expandImplicitDeleteIntent(sessionId, request.userMessage);
    const command = await this.llmClient.generateLinuxCommand(sessionId, enrichedUserMessage);
    const normalizedSuggestedCommand = this.extractSuggestedReadonlyCommand(command);
    const commandCandidate = normalizedSuggestedCommand ?? command;
    const chatOnlyReply = this.extractChatOnlyReply(commandCandidate);
    if (chatOnlyReply) {
      await this.delay(Orchestrator.CHAT_RESPONSE_DELAY_MS);
      trace.push({ step: "planner", status: "ok", detail: "Planner identified chat-only intent." });
      this.llmClient.appendAssistantMessage(sessionId, chatOnlyReply);
      return {
        command: "[CHAT_ONLY]",
        output: "",
        naturalSummary: chatOnlyReply,
        chatOnly: true,
        blocked: false,
        trace
      };
    }

    const plannedCommands = this.normalizeCommandPlan(commandCandidate);
    if (plannedCommands.length === 0) {
      const fallback = this.buildNoCommandFallback(sessionId, request.userMessage);
      if (fallback) {
        this.llmClient.appendAssistantMessage(sessionId, fallback);
        return {
          command: "[NO_EXECUTABLE_COMMAND]",
          output: "",
          naturalSummary: fallback,
          blocked: false,
          trace
        };
      }
      throw new Error("Planner returned no executable command.");
    }
    if (plannedCommands.length > Orchestrator.MAX_TASK_STEPS) {
      throw new Error(
        `Planned task steps exceed limit (${plannedCommands.length}). Please split into smaller requests (max ${Orchestrator.MAX_TASK_STEPS} steps).`
      );
    }
    trace.push({
      step: "planner",
      status: "ok",
      detail: `Generated ${plannedCommands.length} planned task(s).`
    });

    const allOutputs: string[] = [];
    const repairLogs: string[] = [];
    const stepSummaries: string[] = [];
    let highestRisk: OrchestratorResult["riskLevel"] = "low";
    for (let i = 0; i < plannedCommands.length; i += 1) {
      const plannedCommand = plannedCommands[i];
      const hardBlockReason = this.getHardBlockReason(plannedCommand);
      if (hardBlockReason) {
        trace.push({
          step: "policy",
          status: "blocked",
          detail: `Step ${i + 1} hard-blocked: ${hardBlockReason}`
        });
        const summary = `这个请求包含高危破坏性操作，已被系统直接拒绝。\n\n原因：${hardBlockReason}`;
        this.llmClient.appendAssistantMessage(sessionId, summary);
        return {
          command: plannedCommand,
          output: "",
          naturalSummary: summary,
          blocked: true,
          reason: hardBlockReason,
          riskLevel: "critical",
          requiresApproval: false,
          trace
        };
      }
      const preparedStep = this.prepareRollbackAwareCommand(sessionId, plannedCommand, i);
      let commandToRun = preparedStep.commandToRun;
      let rewrittenForPolicy = false;
      let defensiveValidationError = this.validateDefensivePattern(commandToRun);
      if (defensiveValidationError) {
        const rewritten = await this.tryRewriteForPolicy({
          sessionId,
          command: commandToRun,
          reason: defensiveValidationError
        });
        if (rewritten) {
          const rewrittenValidationError = this.validateDefensivePattern(rewritten);
          if (!rewrittenValidationError) {
            commandToRun = rewritten;
            rewrittenForPolicy = true;
            defensiveValidationError = undefined;
            trace.push({
              step: "policy",
              status: "ok",
              detail: `Step ${i + 1} auto-rewritten into guarded/idempotent command.`
            });
          }
        }
      }
      if (defensiveValidationError) {
        trace.push({
          step: "policy",
          status: "blocked",
          detail: `Step ${i + 1} failed defensive validation: ${defensiveValidationError}`
        });
        const policySummary =
          `我理解你的目标，但这一步缺少必要的安全保护（先检查、后变更），为了避免误操作我先拦下了。\n\n原因：${defensiveValidationError}\n\n你可以继续提同样需求，我会再次尝试自动补全安全检查后再执行。`;
        this.llmClient.appendAssistantMessage(sessionId, policySummary);
        return {
          command: plannedCommand,
          output: "",
          naturalSummary: policySummary,
          blocked: true,
          reason: defensiveValidationError,
          riskLevel: "high",
          requiresApproval: false,
          trace
        };
      }
      trace.push({
        step: "multi-task",
        status: "ok",
        detail: `Step ${i + 1}/${plannedCommands.length}: ${commandToRun}`
      });

      let commandForRiskEvaluation = commandToRun;
      if (preparedStep.riskOnExistingPath) {
        const exists = await this.checkPathExists(mode, request, preparedStep.riskOnExistingPath);
        if (exists) {
          commandForRiskEvaluation = `${commandToRun} # OSA_OVERWRITE_EXISTS:${preparedStep.riskOnExistingPath}`;
        }
      }

      const gate = await this.securityGateway.evaluateCommand({
        sessionId,
        executorMode: mode,
        command: commandForRiskEvaluation,
        targetHost: request.targetHost
      });
      highestRisk = this.maxRiskLevel(highestRisk, gate.riskLevel);
      if (!gate.allow) {
        const blockedReason = gate.blockedReason ?? "Blocked by security policy.";
        if (gate.requiresApproval && gate.challenge) {
          this.persistPendingApproval(sessionId, gate.challenge.command, gate.challenge.expiresAt);
        }
        let blockSummary: string;
        try {
          blockSummary = await this.llmClient.explainSecurityBlock(plannedCommand, blockedReason);
        } catch {
          blockSummary =
            "这个请求涉及高风险或受限操作，已被安全策略拦截。为了保护系统稳定与数据安全，当前不允许直接执行。你可以告诉我你的真实运维目标，我会给出更安全的替代方案。";
        }
        this.llmClient.appendAssistantMessage(sessionId, blockSummary);
        trace.push({
          step: "security-gate",
          status: "blocked",
          detail: `Step ${i + 1} blocked: ${blockedReason}`
        });
        const pendingSummary =
          gate.requiresApproval && gate.challenge
            ? "我已记录这条高风险操作。若你确认执行，请直接回复“继续”“确认”或“确定”；若要放弃，请回复“取消”。"
            : blockSummary;
        this.llmClient.appendAssistantMessage(sessionId, pendingSummary);
        return {
          command: commandToRun,
          output: "",
          naturalSummary: pendingSummary,
          blocked: true,
          reason: blockedReason,
          riskLevel: gate.riskLevel,
          requiresApproval: gate.requiresApproval,
          challenge: gate.challenge,
          trace
        };
      }

      trace.push({ step: "security-gate", status: "ok", detail: `Step ${i + 1} passed security checks.` });
      const execution = await this.executeWithAutoRepair({
        sessionId,
        mode,
        request,
        command: commandToRun,
        trace
      });
      if (execution.blockedResult) {
        return execution.blockedResult;
      }
      // Never include raw commands in user-facing output; they pollute marker parsing and feel too CLI.
      allOutputs.push(`[Step ${i + 1}] 输出：\n${execution.output}`);
      if (execution.repairLog) {
        repairLogs.push(`[Step ${i + 1}] ${execution.repairLog}`);
      }
      this.llmClient.setLastRawOutput(sessionId, execution.output);
      this.rememberPathsFromText(sessionId, plannedCommand);
      this.rememberPathsFromText(sessionId, execution.output);
      await this.securityGateway.logExecution(sessionId, commandToRun, "Task step executed successfully.");
      // Record rollback from explicit mapping or from deterministic markers.
      const derivedRollback = this.deriveRollbackFromMarkers(sessionId, plannedCommand, commandToRun, execution.output);
      const rollbackToRecord = !rewrittenForPolicy && preparedStep.rollbackInverse
        ? {
            inverseCommand: preparedStep.rollbackInverse,
            description: preparedStep.rollbackDescription ?? `撤销步骤 ${i + 1}`,
            recordWhenOutputIncludes: preparedStep.recordWhenOutputIncludes
          }
        : derivedRollback;
      if (rollbackToRecord && this.shouldRecordRollback(rollbackToRecord, execution.output)) {
        this.rollbackService.record({
          sessionId,
          originalCommand: plannedCommand,
          executedCommand: commandToRun,
          inverseCommand: rollbackToRecord.inverseCommand,
          description: rollbackToRecord.description
        });
      }

      // Build user-facing step overview without leaking raw commands.
      const derivedStep = this.deriveUserFacingStepFromOutput(execution.output);
      stepSummaries.push(
        preparedStep.userFacingStep ?? derivedStep ?? this.inferUserFacingStepFromCommand(plannedCommand, i + 1)
      );
    }

    const finalOutput = allOutputs.join("\n\n");
    const repairLogText = repairLogs.length > 0 ? repairLogs.join("\n\n") : undefined;
    const commandForSummary =
      plannedCommands.length === 1 ? plannedCommands[0] : `任务序列：\n${plannedCommands.join("\n")}`;
    const naturalSummary = await this.llmClient.summarizeOutput(commandForSummary, finalOutput, repairLogText);
    const deterministicOutcomeSummary = this.extractDeterministicOutcomeSummary(finalOutput);
    const planOverview = this.buildPlanOverview(stepSummaries);
    const singleStepSummary = stepSummaries[0] ?? "本次操作已完成";
    const finalUserSummary =
      plannedCommands.length === 1
        ? deterministicOutcomeSummary
          ? `${singleStepSummary}。\n${deterministicOutcomeSummary}`
          : `${singleStepSummary}。\n${this.toConciseUserSummary(naturalSummary)}`
        : deterministicOutcomeSummary
          ? `${planOverview}\n\n${deterministicOutcomeSummary}`
          : `${planOverview}\n\n${this.toConciseUserSummary(naturalSummary)}`;
    const assistantSummary =
      plannedCommands.length === 1 ? `任务执行完成：${finalUserSummary}` : `任务执行完成（共 ${plannedCommands.length} 步）：${finalUserSummary}`;
    this.llmClient.appendAssistantMessage(sessionId, assistantSummary);
    trace.push({
      step: "multi-task",
      status: "ok",
      detail: `All ${plannedCommands.length} task(s) completed.`
    });

    return {
      command: plannedCommands.join("\n"),
      output: finalOutput,
      naturalSummary: finalUserSummary,
      blocked: false,
      riskLevel: highestRisk,
      requiresApproval: false,
      trace
    };
  }

  private async executeBySsh(command: string, request: OrchestratorRequest): Promise<string> {
    if (!request.sshConfig) {
      throw new Error("executorMode=ssh requires sshConfig.");
    }
    return this.sshExecutor.executeCommand(request.sshConfig, command);
  }

  private async tryRewriteForPolicy(params: {
    sessionId: string;
    command: string;
    reason: string;
  }): Promise<string | undefined> {
    const { sessionId, command, reason } = params;
    try {
      const rewritten = await this.llmClient.generateRepairCommand(
        command,
        `Policy validation failed: ${reason}. Rewrite to one-line guarded Linux command with pre-check and OSA_RESULT marker.`,
        this.llmClient.getLastRawOutput(sessionId)
      );
      const compact = rewritten.trim();
      if (!compact || !this.isLikelyShellCommand(compact)) {
        return undefined;
      }
      return compact;
    } catch {
      return undefined;
    }
  }

  private async checkPathExists(
    mode: "local" | "ssh",
    request: OrchestratorRequest,
    targetPath: string
  ): Promise<boolean> {
    const probe = `[ -e "${targetPath}" ] && echo OSA_RESULT:EXISTS:file:${targetPath} || echo OSA_RESULT:DELETED:file:${targetPath}`;
    const output = mode === "ssh" ? await this.executeBySsh(probe, request) : await this.localExecutor.executeCommand(probe);
    return output.includes("OSA_RESULT:EXISTS");
  }

  private async executeWithAutoRepair(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    command: string;
    trace: OrchestratorResult["trace"];
  }): Promise<{ output: string; repairLog?: string; blockedResult?: OrchestratorResult }> {
    const { sessionId, mode, request, command, trace } = params;
    try {
      const output =
        mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
      trace.push({ step: "executor", status: "ok", detail: "Execution completed." });
      return { output };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      trace.push({
        step: "executor",
        status: "error",
        detail: `Command failed (${errorMessage}), triggering auto-repair.`
      });

      let lastRawOutput = this.llmClient.getLastRawOutput(sessionId);
      // If a service management command fails, collect quick diagnostics to help repair and user explanation.
      const svcMatch = command.match(/(?:^|\s)(?:sudo\s+)?systemctl\s+(?:start|restart|stop|enable|disable)\s+([A-Za-z0-9@._-]+)\s*$/);
      if (svcMatch?.[1]) {
        const svc = svcMatch[1];
        const diagCmd = `sh -lc 'systemctl --no-pager -l status ${svc} 2>/dev/null | sed -n \"1,25p\"; echo \"---\"; journalctl -u ${svc} -n 80 --no-pager 2>/dev/null | tail -n 80'`;
        try {
          const diagOut = mode === "ssh" ? await this.executeBySsh(diagCmd, request) : await this.localExecutor.executeCommand(diagCmd);
          lastRawOutput = `${lastRawOutput ?? ""}\n\n[DIAG:${svc}]\n${diagOut}`.trim();
          this.llmClient.setLastRawOutput(sessionId, lastRawOutput);
        } catch {
          // ignore diagnostics collection failure
        }
      }
      const repairCommand = await this.llmClient.generateRepairCommand(command, errorMessage, lastRawOutput);
      trace.push({ step: "repair", status: "ok", detail: `Repair command generated: ${repairCommand}` });

      const repairGate = await this.securityGateway.evaluateCommand({
        sessionId,
        executorMode: mode,
        command: repairCommand,
        targetHost: request.targetHost
      });

      if (!repairGate.allow) {
        const blockedReason = repairGate.blockedReason ?? "Auto-repair command blocked by security policy.";
        let blockSummary: string;
        try {
          blockSummary = await this.llmClient.explainSecurityBlock(repairCommand, blockedReason);
        } catch {
          blockSummary = "自动修复方案触发了安全策略，已被拦截。请调整目标操作，我会给出更安全的修复路径。";
        }
        this.llmClient.appendAssistantMessage(sessionId, blockSummary);
        trace.push({ step: "security-gate", status: "blocked", detail: blockedReason });
        return {
          output: "",
          blockedResult: {
            command: repairCommand,
            output: "",
            naturalSummary: blockSummary,
            blocked: true,
            reason: blockedReason,
            riskLevel: repairGate.riskLevel,
            requiresApproval: repairGate.requiresApproval,
            challenge: repairGate.challenge,
            trace
          }
        };
      }

      try {
        const repairedOutput =
          mode === "ssh"
            ? await this.executeBySsh(repairCommand, request)
            : await this.localExecutor.executeCommand(repairCommand);
        trace.push({ step: "executor", status: "ok", detail: "Auto-repair execution completed." });
        return {
          output: repairedOutput,
          repairLog: `原命令失败：${command}\n错误信息：${errorMessage}\n自动修复命令：${repairCommand}`
        };
      } catch (repairError) {
        const repairErrorMessage = repairError instanceof Error ? repairError.message : String(repairError);
        const maybePathError = /(no such file|not found|cannot access|不存在|没有那个文件|找不到)/i.test(
          repairErrorMessage
        );
        if (!maybePathError) {
          throw repairError;
        }
        trace.push({
          step: "repair",
          status: "error",
          detail: `Repair execution failed (${repairErrorMessage}), reflecting with lastRawOutput.`
        });
        const reflectedCommand = await this.llmClient.generateRepairCommand(
          command,
          `Initial error: ${errorMessage}\nRepair error: ${repairErrorMessage}`,
          this.llmClient.getLastRawOutput(sessionId)
        );
        trace.push({ step: "repair", status: "ok", detail: `Reflected repair command: ${reflectedCommand}` });
        const reflectedOutput =
          mode === "ssh"
            ? await this.executeBySsh(reflectedCommand, request)
            : await this.localExecutor.executeCommand(reflectedCommand);
        trace.push({ step: "executor", status: "ok", detail: "Reflected auto-repair execution completed." });
        return {
          output: reflectedOutput,
          repairLog: `原命令失败：${command}\n错误信息：${errorMessage}\n首次修复失败：${repairErrorMessage}\n反思后修复命令：${reflectedCommand}`
        };
      }
    }
  }

  private extractChatOnlyReply(modelOutput: string): string | undefined {
    const trimmed = modelOutput.trim();
    if (!trimmed.startsWith("[CHAT_ONLY]")) {
      return undefined;
    }
    const reply = trimmed.slice("[CHAT_ONLY]".length).trim();
    return reply || "我在这里，可以继续告诉我你想执行的系统操作。";
  }

  private extractSuggestedReadonlyCommand(modelOutput: string): string | undefined {
    const trimmed = modelOutput.trim();
    const patterns = [
      /^(?:执行|运行|使用|可使用|可以执行)\s+`?([^`。；;]+?)`?(?:\s*(?:查看|检查|获取|显示).*)?$/i,
      /^(?:请)?(?:执行|运行)\s+`?([^`。；;]+?)`?(?:\s*(?:即可|来|以).*)?$/i
    ];
    for (const pattern of patterns) {
      const match = trimmed.match(pattern);
      const candidate = match?.[1]?.trim();
      if (candidate && this.isSafeReadonlyCommand(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  private isSafeReadonlyCommand(command: string): boolean {
    const normalized = command.trim().toLowerCase();
    if (!normalized) return false;
    if (/[><]|\b(rm|mv|cp|tee|sed\s+-i|chmod|chown|useradd|userdel|usermod|groupadd|groupdel|systemctl\s+(start|restart|stop|enable|disable)|apt|apt-get|yum|dnf|firewall-cmd|iptables|nft|mkfs|dd)\b/.test(normalized)) {
      return false;
    }
    return /^(uname|cat|grep|rg|ls|df|free|ps|ss|ip|hostnamectl|sysctl|top|whoami|id|pwd|mount|lsblk|blkid|env)\b/.test(normalized);
  }

  private async buildFallbackChatReply(sessionId: string, userMessage: string): Promise<string | undefined> {
    const normalized = userMessage.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }
    if (this.looksLikeOpsIntent(userMessage)) {
      return undefined;
    }
    if (this.shouldTreatAsGeneralChat(normalized)) {
      try {
        return await this.llmClient.generateChatReply(userMessage, this.shouldUseLastRawOutputForChat(userMessage) ? this.llmClient.getLastRawOutput(sessionId) : undefined);
      } catch {
        return "我在。你可以直接问思路、原理或排查建议，也可以让我直接执行运维操作。";
      }
    }
    return undefined;
  }

  private shouldUseLastRawOutputForChat(userMessage: string): boolean {
    const trimmed = userMessage.trim();
    if (!trimmed) return false;
    if (this.looksLikeOpsIntent(trimmed)) return false;
    return /(上面|刚才|这个输出|这段输出|这个结果|什么意思|帮我解释|怎么看|分析一下|解释一下)/i.test(trimmed);
  }

  private isPureConfirmationPhrase(userMessage: string): boolean {
    const trimmed = userMessage.trim();
    if (!trimmed) return false;
    const confirmWords = ["确认", "继续", "同意", "可以执行", "强制执行", "我确认", "执行吧", "继续执行", "确认执行", "删", "好的", "是的", "对", "行", "没问题", "确定"];
    const normalized = trimmed.replace(/[！!。.，,\s]+/g, " ").trim().toLowerCase();
    const parts = normalized.split(/\s+/);
    return parts.every((part) => confirmWords.some((w) => part === w || part === w + "！" || part === w + "!"));
  }

  private isPureCancelPhrase(userMessage: string): boolean {
    const trimmed = userMessage.trim();
    if (!trimmed) return false;
    const cancelWords = ["取消", "不用了", "算了", "放弃", "不执行", "先别", "不要执行"];
    const normalized = trimmed.replace(/[！!。.，,\s]+/g, " ").trim().toLowerCase();
    const parts = normalized.split(/\s+/);
    return parts.every((part) => cancelWords.some((w) => part === w || part === w + "！" || part === w + "!"));
  }

  private getIntentLevelBlockReason(userMessage: string): string | undefined {
    const msg = (userMessage ?? "").trim();
    if (!msg) return undefined;

    const criticalDirs = ["/etc", "/boot", "/usr", "/lib", "/lib64", "/sbin", "/bin", "/proc", "/sys", "/dev", "/var"];
    const mentionsDelete = /(删除|清空|清除|移除|rm\b|格式化|擦除)/i.test(msg);
    if (mentionsDelete) {
      for (const dir of criticalDirs) {
        if (msg.includes(dir)) {
          return `这个操作涉及系统核心目录 ${dir}，属于极高风险操作，已被直接拒绝。删除该目录下的文件会导致系统无法正常运行，甚至完全崩溃。`;
        }
      }
      if (/删除.*所有|清空.*所有|rm\s+-rf\s+\//.test(msg)) {
        return "这个操作涉及大范围系统文件删除，属于极高风险操作，已被直接拒绝。";
      }
    }

    return undefined;
  }

  private looksLikeOpsIntent(message: string): boolean {
    const normalized = message.trim().toLowerCase();
    if (!normalized) return false;

    if (/\/(home|root|tmp|var|etc|usr|opt|srv|data)\//i.test(message)) {
      return true;
    }

    const opsPatterns = [
      /(创建|新建|添加|删除|移除|修改|重置).*(用户|账号)/i,
      /(普通用户|标准用户|账号)/i,
      /(禁止|关闭|禁用).*(远程|ssh|登录)/i,
      /(useradd|userdel|usermod|passwd|chsh|nologin)/i,
      /(目录|文件|端口|进程|磁盘|内存|cpu|日志|服务|网络|防火墙|系统版本|内核|发行版|主机名|hostname|os-release)/i,
      /(systemctl|journalctl|ss\b|ps\s|top\b|df\b|du\b|ip\b|curl\b|docker\b|nginx\b|uname\b|hostnamectl\b|cat\s+\/etc\/os-release)/i
    ];

    return opsPatterns.some((pattern) => pattern.test(message));
  }

  private shouldTreatAsGeneralChat(normalizedMessage: string): boolean {
    if (normalizedMessage.length <= 3) {
      return true;
    }
    if (/^(hi|hello|hey|你好|您好|嗨|哈喽|在吗|在不在)$/.test(normalizedMessage)) {
      return true;
    }
    if (normalizedMessage.includes("你是谁") || normalizedMessage.includes("你是啥") || normalizedMessage.includes("你叫什么")) {
      return true;
    }
    const opsKeywords = [
      "创建用户",
      "useradd",
      "删除",
      "重启",
      "systemctl",
      "journalctl",
      "磁盘",
      "cpu",
      "内存",
      "进程",
      "端口",
      "日志",
      "服务",
      "ssh",
      "执行",
      "命令",
      "安装",
      "卸载",
      "nginx",
      "mysql",
      "docker",
      "k8s",
      "系统版本",
      "内核",
      "发行版",
      "hostname",
      "主机名"
    ];
    if (opsKeywords.some((keyword) => normalizedMessage.includes(keyword))) {
      return false;
    }

    const chatKeywords = [
      "随便问",
      "聊聊",
      "为什么",
      "怎么",
      "能不能",
      "可以吗",
      "啥意思",
      "什么意思",
      "解释",
      "建议",
      "思路",
      "帮我理解"
    ];
    if (chatKeywords.some((keyword) => normalizedMessage.includes(keyword))) {
      return true;
    }

    return /[?？]$/.test(normalizedMessage);
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private normalizeCommandPlan(modelOutput: string): string[] {
    return modelOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => !this.isNonCommandLine(line))
      .map((line) => line.replace(/^[-*]\s+/, ""))
      .map((line) => line.replace(/^\d+\.\s+/, ""))
      .map((line) => line.replace(/^步骤\s*\d+\s*[:：]\s*/i, ""))
      .map((line) => line.replace(/^\d+\s*[、:：]\s*/, ""))
      .map((line) => line.replace(/^`+|`+$/g, ""))
      .filter((line) => this.isLikelyShellCommand(line))
      .filter(Boolean);
  }

  private isNonCommandLine(line: string): boolean {
    const lower = line.toLowerCase();
    if (!line) {
      return true;
    }
    if (/^(bash|shell|sh)$/i.test(lower)) {
      return true;
    }
    const nonCommandPrefixes = [
      "说明",
      "解释",
      "思路",
      "plan",
      "步骤",
      "note",
      "tips",
      "任务",
      "summary",
      "好的",
      "现在",
      "首先",
      "以下",
      "开始执行",
      "我将"
    ];
    if (nonCommandPrefixes.some((prefix) => lower.startsWith(prefix))) {
      return true;
    }
    // Pure prose line (Chinese punctuation and letters) should not be treated as a shell command.
    if (/^[\u4e00-\u9fa5，。！？：；、“”\s]+$/.test(line)) {
      return true;
    }
    return false;
  }

  private isLikelyShellCommand(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) {
      return false;
    }
    if (/^(if|then|else|fi)\b/.test(trimmed)) {
      return false;
    }
    if (/^(系统|执行|任务|说明|结果|首次尝试|现在开始)/.test(trimmed)) {
      return false;
    }
    // Accept common shell starters or bracket tests.
    return /^(sudo\s+)?([a-zA-Z_][\w.-]*|\[|\(|\{)/.test(trimmed);
  }

  private expandImplicitDeleteIntent(sessionId: string, userMessage: string): string {
    const text = userMessage.trim();
    if (!text) {
      return text;
    }
    const hasDeleteIntent = /(删掉|删除|清理|remove|rm)/i.test(text);
    const hasExplicitPath = /\/[A-Za-z0-9._\-\/]+/.test(text);
    if (!hasDeleteIntent || hasExplicitPath) {
      return text;
    }
    const lastRawOutput = this.llmClient.getLastRawOutput(sessionId) ?? "";
    const lastPath = this.extractLatestPath(lastRawOutput);
    if (!lastPath) {
      return text;
    }
    return `${text} 目标路径是 ${lastPath}`;
  }

  private extractLatestPath(text: string): string | undefined {
    const matches = [...text.matchAll(/\/[A-Za-z0-9._\-\/]+/g)].map((item) => item[0]).filter(Boolean);
    if (matches.length === 0) {
      return undefined;
    }
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const candidate = matches[i];
      if (!this.isInternalMemoryPath(candidate)) {
        return candidate;
      }
    }
    return matches[matches.length - 1];
  }

  private rememberPathsFromText(sessionId: string, text: string): void {
    if (!text) {
      return;
    }
    const matches = [...text.matchAll(/\/[A-Za-z0-9._\-\/]+/g)];
    for (const match of matches) {
      const path = match[0];
      if (path) {
        this.rememberPath(sessionId, path);
      }
    }
  }

  private rememberPath(sessionId: string, path: string): void {
    const normalized = path.trim();
    if (!normalized || normalized.length < 2 || !normalized.startsWith("/")) {
      return;
    }
    if (this.isInternalMemoryPath(normalized)) {
      return;
    }
    const ctx = this.sessionContext.get(sessionId) ?? { recentPaths: [], updatedAt: Date.now() };
    ctx.recentPaths = [normalized, ...ctx.recentPaths.filter((item) => item !== normalized)].slice(0, 30);
    ctx.updatedAt = Date.now();
    this.sessionContext.set(sessionId, ctx);
    this.persistSessionContextToDisk();
  }

  private loadSessionContextFromDisk(): void {
    try {
      if (!existsSync(Orchestrator.SESSION_MEMORY_PATH)) {
        return;
      }
      const raw = readFileSync(Orchestrator.SESSION_MEMORY_PATH, "utf8");
      if (!raw.trim()) {
        return;
      }
      const parsed = JSON.parse(raw) as Record<string, { recentPaths?: string[]; updatedAt?: number }>;
      for (const [sessionId, value] of Object.entries(parsed)) {
        const recentPaths = (value.recentPaths ?? [])
          .filter((item): item is string => typeof item === "string" && item.startsWith("/"))
          .slice(0, 30);
        if (recentPaths.length === 0) {
          continue;
        }
        this.sessionContext.set(sessionId, {
          recentPaths,
          updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now()
        });
      }
    } catch {
      // Ignore broken memory file; runtime should still boot.
    }
  }

  private persistSessionContextToDisk(): void {
    try {
      const parent = dirname(Orchestrator.SESSION_MEMORY_PATH);
      if (!existsSync(parent)) {
        mkdirSync(parent, { recursive: true });
      }
      const now = Date.now();
      const maxAgeMs = 24 * 60 * 60 * 1000;
      const serializable: Record<string, { recentPaths: string[]; updatedAt: number }> = {};
      for (const [sessionId, value] of this.sessionContext.entries()) {
        if (now - value.updatedAt > maxAgeMs) {
          continue;
        }
        if (!value.recentPaths.length) {
          continue;
        }
        serializable[sessionId] = {
          recentPaths: value.recentPaths.slice(0, 30),
          updatedAt: value.updatedAt
        };
      }
      writeFileSync(Orchestrator.SESSION_MEMORY_PATH, JSON.stringify(serializable, null, 2), "utf8");
    } catch {
      // Keep serving requests even if memory persistence fails.
    }
  }

  private buildPlanOverview(commands: string[]): string {
    const compactLines = commands.map((item, idx) => `${idx + 1}. ${item}`).join("\n");
    return `本次任务已完成以下步骤：\n${compactLines}`;
  }

  private inferUserFacingStepFromCommand(command: string, stepNo: number): string {
    const trimmed = command.trim();
    const normalized = trimmed.toLowerCase();
    if (!trimmed) {
      return `步骤 ${stepNo} 已完成`;
    }
    if (/\b(df|lsblk|fdisk)\b/.test(normalized)) {
      return "查看磁盘空间";
    }
    if (/\b(ss|netstat|lsof)\b/.test(normalized)) {
      return "查看端口占用";
    }
    if (/\b(ps|top|htop|pgrep)\b/.test(normalized)) {
      return "查看进程状态";
    }
    if (/\b(find|locate|ls)\b/.test(normalized)) {
      return "检索文件或目录";
    }
    if (/\b(cat|tail|less|grep|rg)\b/.test(normalized)) {
      return "查看日志或文本内容";
    }
    if (/^systemctl\s+status\b/.test(normalized)) {
      return "查看服务状态";
    }
    return `步骤 ${stepNo} 已处理`;
  }

  private deriveUserFacingStepFromOutput(output: string): string | undefined {
    const summary = this.extractDeterministicOutcomeSummary(output);
    if (!summary) {
      return undefined;
    }
    // Prefer the first line as a compact “what happened”.
    const first = summary.split(/\r?\n/).find(Boolean)?.trim();
    return first || undefined;
  }

  private maxRiskLevel(
    current: OrchestratorResult["riskLevel"],
    incoming: OrchestratorResult["riskLevel"]
  ): OrchestratorResult["riskLevel"] {
    const weights = { low: 1, medium: 2, high: 3, critical: 4 };
    return weights[incoming ?? "low"] >= weights[current ?? "low"] ? incoming : current;
  }

  private validateDefensivePattern(command: string): string | undefined {
    const normalized = command.trim().toLowerCase();
    const hasGuardOps = normalized.includes("||") || normalized.includes("&&") || normalized.includes("if ");
    if (this.isStateChangingCommand(normalized) && !/(osa_result:|user_(exists|created):)/.test(normalized) && !hasGuardOps) {
      return "状态变更命令缺少结果标记（建议输出 OSA_RESULT:<STATUS>:<TARGET>）。";
    }
    if (/^useradd\s+/.test(normalized) && !/(^|\s)id\s+/.test(normalized) && !hasGuardOps && !/osa_result:/.test(normalized)) {
      return "创建用户前缺少存在性预检查（例如 id <user> && echo OSA_RESULT:EXISTS:user:<user> || (useradd <user> && echo OSA_RESULT:CREATED:user:<user>)）。";
    }
    if (/^userdel\s+/.test(normalized) && !/(^|\s)id\s+/.test(normalized) && !hasGuardOps) {
      return "删除用户前缺少存在性预检查（例如 id <user> && userdel -r <user> && echo OSA_RESULT:UPDATED:user:<user>:deleted || echo OSA_RESULT:SKIPPED:user:<user>）。";
    }
    if (/^mkdir\s+/.test(normalized) && !hasGuardOps && !/\s-p(\s|$)/.test(normalized)) {
      return "创建目录建议使用幂等保护（例如 mkdir -p 或先检查后创建）。";
    }
    if (/^(dnf|yum)\s+install\s+/.test(normalized) && !hasGuardOps) {
      return "安装软件前建议包含已安装检查或可重复执行保护逻辑。";
    }
    if (/^(apt|apt-get)\s+install\s+/.test(normalized) && !hasGuardOps) {
      return "安装软件前建议包含已安装检查或可重复执行保护逻辑。";
    }
    if (/^firewall-cmd\s+/.test(normalized) && !/(osa_result:)/.test(normalized)) {
      return "防火墙变更建议包含结果标记（例如 echo OSA_RESULT:UPDATED:firewall:...），并在必要时提供可回退操作。";
    }
    return undefined;
  }

  private getHardBlockReason(command: string): string | undefined {
    const normalized = command.trim().toLowerCase();
    if (/\brm\s+-rf\s+\/(?:\s|$)/.test(normalized) || /\brm\s+-rf\s+\/\*/.test(normalized)) {
      return "检测到根目录级删除（rm -rf / 或 rm -rf /*），属于不可接受的高危操作。";
    }
    if (/\brm\s+.*\/(etc|boot|usr|lib|lib64|sbin|bin|proc|sys|dev)\b/.test(normalized)) {
      return "检测到对系统核心目录的删除操作，属于不可接受的高危操作。该目录包含系统运行必需的文件，删除后系统将无法正常工作。";
    }
    if (/\bmkfs\./.test(normalized) || /\bdd\s+if=/.test(normalized)) {
      return "检测到可能破坏磁盘数据的命令（mkfs/dd），属于不可接受的高危操作。";
    }
    return undefined;
  }

  private extractDeterministicOutcomeSummary(rawOutput: string): string | undefined {
    const markerMatches = [...rawOutput.matchAll(/OSA_RESULT:([A-Z_]+):([^\n\r]+)/g)];
    const summaries: string[] = [];
    for (const marker of markerMatches) {
      const status = marker[1] ?? "";
      const target = (marker[2] ?? "").trim();
      // Hide internal backup markers from user-facing summaries.
      if (/^backup:/.test(target)) {
        continue;
      }
      const line = this.formatMarkerSummary(status, target);
      if (line && !summaries.includes(line)) {
        summaries.push(line);
      }
    }

    const existsMatch = rawOutput.match(/USER_EXISTS:([A-Za-z0-9._-]+)/);
    if (existsMatch?.[1]) {
      const line = `检查结果：用户 ${existsMatch[1]} 已存在，未重复创建。`;
      if (!summaries.includes(line)) {
        summaries.push(line);
      }
    }
    const createdMatch = rawOutput.match(/USER_CREATED:([A-Za-z0-9._-]+)/);
    if (createdMatch?.[1]) {
      const line = `执行结果：用户 ${createdMatch[1]} 已成功创建。`;
      if (!summaries.includes(line)) {
        summaries.push(line);
      }
    }
    return summaries.length > 0 ? summaries.join("\n") : undefined;
  }

  private isStateChangingCommand(normalizedCommand: string): boolean {
    return /(^|\s)(useradd|userdel|usermod|groupadd|groupdel|mkdir|rm|mv|cp|chmod|chown|dnf|yum|apt|apt-get|systemctl|sed|tee|echo|firewall-cmd|iptables|nft)\b/.test(
      normalizedCommand
    );
  }

  private formatMarkerSummary(status: string, target: string): string | undefined {
    const normalizedStatus = status.toUpperCase();
    const cleanedTarget = target
      .replace(/\s*\|\|[\s\S]*$/g, "")
      .replace(/\s*&&[\s\S]*$/g, "")
      .trim();
    const displayTarget = this.toDisplayTarget(cleanedTarget);
    if (normalizedStatus === "EXISTS") {
      return `检查结果：${displayTarget} 已存在，本次未重复变更。`;
    }
    if (normalizedStatus === "CREATED") {
      return `执行结果：${displayTarget} 已成功创建。`;
    }
    if (normalizedStatus === "UPDATED") {
      if (cleanedTarget.startsWith("groupmember:")) {
        return `执行结果：${displayTarget} 已完成。`;
      }
      if (cleanedTarget.startsWith("firewall:")) {
        return `执行结果：${displayTarget} 已更新。`;
      }
      return `执行结果：${displayTarget} 已完成更新。`;
    }
    if (normalizedStatus === "INSTALLED") {
      return `执行结果：${displayTarget} 已安装完成。`;
    }
    if (normalizedStatus === "REMOVED") {
      return `执行结果：${displayTarget} 已卸载完成。`;
    }
    if (normalizedStatus === "DELETED") {
      return `执行结果：${displayTarget} 已删除（可回退）。`;
    }
    if (normalizedStatus === "STARTED") {
      return `执行结果：${displayTarget} 已启动。`;
    }
    if (normalizedStatus === "RESTARTED") {
      return `执行结果：${displayTarget} 已重启。`;
    }
    if (normalizedStatus === "SKIPPED") {
      if (cleanedTarget.startsWith("file:")) {
        return `检查结果：文件 ${displayTarget} 本来就不存在，所以没有执行删除。`;
      }
      if (cleanedTarget.startsWith("dir:")) {
        return `检查结果：目录 ${displayTarget} 本来就不存在，所以没有执行删除。`;
      }
      return `检查结果：${displayTarget} 无需变更，已跳过。`;
    }
    if (normalizedStatus === "FAILED") {
      return `执行结果：${displayTarget} 处理失败，请查看详细输出。`;
    }
    return undefined;
  }

  private toDisplayTarget(rawTarget: string): string {
    // Keep only the business target, hide internal rollback storage paths.
    const primary = rawTarget.split(":").slice(0, 2).join(":");
    return primary
      .replace(/^file:/, "")
      .replace(/^dir:/, "")
      .replace(/^user:/, "用户 ")
      .replace(/^groupmember:/, "用户组成员变更 ")
      .replace(/^group:/, "用户组 ")
      .replace(/^pkg:/, "软件包 ")
      .replace(/^svc:/, "服务 ")
      .replace(/^firewall:/, "防火墙项 ")
      .replace(/^move:/, "移动操作 ")
      .replace(/^perm:/, "权限项 ")
      .trim();
  }

  private toConciseUserSummary(summary: string): string {
    const cleaned = summary
      .replace(/这个命令/g, "本次操作")
      .replace(/具体来说[:：]?/g, "")
      .trim();
    const lines = cleaned.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.slice(0, 2).join("\n");
  }

  private isRollbackIntent(userMessage: string): boolean {
    const text = userMessage.trim();
    if (!text) {
      return false;
    }
    return /(撤销|回退|后悔|还原|undo|rollback)/i.test(text);
  }

  private isRollbackConfirmIntent(userMessage: string): boolean {
    const text = userMessage.trim();
    return /(确认撤销|确认回退|确认还原|确认执行撤销|confirm rollback)/i.test(text);
  }

  private isRollbackCancelIntent(userMessage: string): boolean {
    const text = userMessage.trim();
    return /(取消撤销|取消回退|不用撤销|放弃撤销|cancel rollback)/i.test(text);
  }

  private isRollbackListIntent(userMessage: string): boolean {
    const text = userMessage.trim();
    if (!text) {
      return false;
    }
    return /(可回退|回退列表|撤销列表|历史回退|rollback list|undo list)/i.test(text);
  }

  private isRollbackPreviewIntent(userMessage: string): boolean {
    const text = userMessage.trim();
    if (!text) {
      return false;
    }
    return /(最近回退|最近撤销|回退预览|撤销预览|rollback preview|undo preview)/i.test(text);
  }

  private async handleRollbackIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
    rollbackIndex?: number;
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, trace, rollbackIndex } = params;
    const pending = this.rollbackService.requestRollback(sessionId, rollbackIndex);
    if (!pending) {
      return {
        command: "[ROLLBACK]",
        output: "",
        naturalSummary:
          rollbackIndex && rollbackIndex > 1
            ? `未找到可回退的第 ${rollbackIndex} 条操作（可能序号超出范围，或记录已过期）。`
            : "当前会话没有可回退的最近操作（可能没有记录，或已超过回退有效期）。",
        blocked: false,
        trace
      };
    }
    const rollbackAction = this.describeRollbackAction(pending.task);
    const originalOp = this.describeOriginalOperation(pending.task.originalCommand);
    const summary =
      rollbackIndex && rollbackIndex > 1
        ? `已选中第 ${rollbackIndex} 条回退动作：${rollbackAction}（对应原操作：${originalOp}）。`
        : `已选中最近一次回退动作：${rollbackAction}（对应原操作：${originalOp}）。`;
    await this.securityGateway.logExecution(
      sessionId,
      `[ROLLBACK_PENDING] ${pending.task.inverseCommand}`,
      `Rollback pending confirmation for task ${pending.task.id} (index ${pending.requestedIndex}).`
    );
    return {
      command: "[ROLLBACK_PENDING_CONFIRM]",
      output: "",
      naturalSummary: `${summary}\n如确认执行，请回复“确认撤销”；如放弃，请回复“取消撤销”。`,
      blocked: false,
      trace
    };
  }

  private async handleRollbackConfirmIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
    confirmIndex?: number;
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace, confirmIndex } = params;
    const pendingPreview = this.rollbackService.getPendingRollback(sessionId);
    if (pendingPreview && confirmIndex && confirmIndex !== pendingPreview.requestedIndex) {
      return {
        command: "[ROLLBACK_CONFIRM]",
        output: "",
        naturalSummary: `当前待确认的是第 ${pendingPreview.requestedIndex} 条操作。若要继续请回复“确认撤销”，或先“取消撤销”再重新选择。`,
        blocked: false,
        trace
      };
    }
    const pending = this.rollbackService.confirmPendingRollback(sessionId);
    if (!pending) {
      return {
        command: "[ROLLBACK_CONFIRM]",
        output: "",
        naturalSummary: "当前没有待确认的撤销任务。你可以先说“撤销刚才操作”或“撤销第2条”。",
        blocked: false,
        trace
      };
    }
    const task = pending.task;
    trace.push({
      step: "rollback",
      status: "ok",
      detail: `Rollback confirmed for task ${task.id}: ${this.describeRollbackAction(task)}`
    });
    const execution = await this.executeWithAutoRepair({
      sessionId,
      mode,
      request,
      command: task.inverseCommand,
      trace
    });
    if (execution.blockedResult) {
      return execution.blockedResult;
    }
    const output = execution.output;
    const summary = `已为你回退操作：${this.describeRollbackAction(task)}。`;
    this.llmClient.setLastRawOutput(sessionId, output);
    this.llmClient.appendAssistantMessage(sessionId, summary);
    await this.securityGateway.logExecution(
      sessionId,
      task.inverseCommand,
      `Rollback executed for task ${task.id} (requested index ${pending.requestedIndex}).`
    );
    return {
      command: task.inverseCommand,
      output,
      naturalSummary: summary,
      blocked: false,
      riskLevel: "high",
      requiresApproval: false,
      trace
    };
  }

  private async handleRollbackCancelIntent(
    sessionId: string,
    trace: OrchestratorResult["trace"]
  ): Promise<OrchestratorResult> {
    const cancelled = this.rollbackService.cancelPendingRollback(sessionId);
    if (!cancelled) {
      return {
        command: "[ROLLBACK_CANCEL]",
        output: "",
        naturalSummary: "当前没有待取消的撤销任务。",
        blocked: false,
        trace
      };
    }
    await this.securityGateway.logExecution(
      sessionId,
      `[ROLLBACK_CANCEL] ${cancelled.task.inverseCommand}`,
      `Rollback cancelled for task ${cancelled.task.id} (index ${cancelled.requestedIndex}).`
    );
    return {
      command: "[ROLLBACK_CANCEL]",
      output: "",
      naturalSummary: `已取消撤销：${this.describeRollbackAction(cancelled.task)}。`,
      blocked: false,
      trace
    };
  }

  private async handleDeterministicCheckIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    const userExistIntent = /(用户|user).*(是否存在|存不存在|存在吗|在不在|还在吗)/i.test(message);
    if (userExistIntent) {
      const userMatch =
        message.match(/(?:用户|user)\s*[:：]?\s*([a-z_][a-z0-9_-]{0,31})/i) ??
        message.match(/\b([a-z_][a-z0-9_-]{0,31})\b/i);
      const username = userMatch?.[1];
      if (!username) {
        return {
          command: "[DETERMINISTIC_CHECK_NEED_USER]",
          output: "",
          naturalSummary: "我可以帮你检查用户是否存在，但这句话里没有明确用户名。你可以说“查看用户 test42302 是否存在”。",
          blocked: false,
          trace
        };
      }
      const checkUserCmd = `id ${username} >/dev/null 2>&1 && echo OSA_RESULT:EXISTS:user:${username} || echo OSA_RESULT:DELETED:user:${username}`;
      const output = mode === "ssh" ? await this.executeBySsh(checkUserCmd, request) : await this.localExecutor.executeCommand(checkUserCmd);
      const summary = output.includes("OSA_RESULT:EXISTS")
        ? `用户 ${username} 存在。`
        : `用户 ${username} 不存在。`;
      this.llmClient.setLastRawOutput(sessionId, output);
      this.llmClient.appendAssistantMessage(sessionId, summary);
      trace.push({ step: "deterministic-check-user", status: "ok", detail: `Checked user existence for ${username}` });
      return {
        command: checkUserCmd,
        output,
        naturalSummary: summary,
        blocked: false,
        trace
      };
    }
    const pathMatch = message.match(/\/[A-Za-z0-9._\-\/]+/);
    const hasCheckIntent =
      /(是否存在|存不存在|存在吗|检查.*存在|check.*exist)/i.test(message) ||
      /(还在吗|还在不|还在没|是否还在|在不在)/i.test(message);
    if (!hasCheckIntent) {
      return undefined;
    }
    const fileScopedMessage = /(文件|路径|目录|txt|log|\.|\/)/i.test(message);
    const target = pathMatch?.[0] ?? (fileScopedMessage ? this.resolveImplicitPathFromContext(sessionId, message) : undefined);
    if (!target) {
      return {
        command: "[DETERMINISTIC_CHECK_NEED_PATH]",
        output: "",
        naturalSummary: "我可以帮你检查是否还在，但这句话里没有明确路径。你可以说“检查 /tmp/test/hello.txt 是否存在”。",
        blocked: false,
        trace
      };
    }
    const checkCommand = `[ -e "${target}" ] && echo OSA_RESULT:EXISTS:file:${target} || echo OSA_RESULT:DELETED:file:${target}`;
    const output = mode === "ssh" ? await this.executeBySsh(checkCommand, request) : await this.localExecutor.executeCommand(checkCommand);
    const summary = output.includes("OSA_RESULT:EXISTS")
      ? `文件 ${target} 还在。`
      : `文件 ${target} 不在了。`;
    this.llmClient.setLastRawOutput(sessionId, output);
    this.rememberPath(sessionId, target);
    this.llmClient.appendAssistantMessage(sessionId, summary);
    trace.push({ step: "deterministic-check", status: "ok", detail: `Checked existence for ${target}` });
    return {
      command: checkCommand,
      output,
      naturalSummary: summary,
      blocked: false,
      trace
    };
  }

  private resolveImplicitPathFromContext(sessionId: string, userMessage: string): string | undefined {
    const hasReferenceWord = /(刚才|那个|该|上一个|上次|这个|这份|此文件|txt|文件)/i.test(userMessage);
    const hasFileRelatedIntent = /(查看|看下|打开|读取|显示|检查|是否存在|还在|在不在)/i.test(userMessage);
    if (!hasReferenceWord && !hasFileRelatedIntent) {
      return undefined;
    }
    const fromSession = this.pickPathFromSessionContext(sessionId, userMessage);
    if (fromSession) {
      return fromSession;
    }
    const lastRawOutput = this.llmClient.getLastRawOutput(sessionId) ?? "";
    const fromRaw = this.extractLatestPath(lastRawOutput);
    if (fromRaw) {
      return fromRaw;
    }
    return this.extractLatestPath(userMessage);
  }

  private pickPathFromSessionContext(sessionId: string, userMessage: string): string | undefined {
    const ctx = this.sessionContext.get(sessionId);
    if (!ctx?.recentPaths?.length) {
      return undefined;
    }
    const candidates = ctx.recentPaths.filter((item) => !this.isInternalMemoryPath(item));
    if (candidates.length === 0) {
      return undefined;
    }
    const prefersTxt = /(txt|文本|文件内容|看.*文件|查看.*txt)/i.test(userMessage);
    if (prefersTxt) {
      const txtPath = candidates.find((item) => /\.txt$/i.test(item));
      if (txtPath) {
        return txtPath;
      }
    }
    return candidates[0];
  }

  private pickNormalPathFromSessionContext(sessionId: string): string | undefined {
    const ctx = this.sessionContext.get(sessionId);
    if (!ctx?.recentPaths?.length) {
      return undefined;
    }
    return ctx.recentPaths.find((item) => !this.isInternalMemoryPath(item));
  }

  private pickPathByFileNameFromSessionContext(sessionId: string, fileName: string): string | undefined {
    const ctx = this.sessionContext.get(sessionId);
    if (!ctx?.recentPaths?.length || !fileName) {
      return undefined;
    }
    const normalizedName = fileName.toLowerCase();
    return ctx.recentPaths.find((item) => {
      if (this.isInternalMemoryPath(item)) {
        return false;
      }
      return item.toLowerCase().endsWith(`/${normalizedName}`);
    });
  }

  private pickRecentExactFilePathFromSessionContext(sessionId: string, fileName: string): string | undefined {
    const ctx = this.sessionContext.get(sessionId);
    if (!ctx?.recentPaths?.length || !fileName) {
      return undefined;
    }
    const normalizedName = fileName.replace(/^\/+/, "").toLowerCase();
    for (const item of ctx.recentPaths) {
      if (this.isInternalMemoryPath(item)) {
        continue;
      }
      const lower = item.toLowerCase();
      if (!/\/[a-z0-9._-]+\.[a-z0-9._-]+$/i.test(lower)) {
        continue;
      }
      if (lower.endsWith(`/${normalizedName}`)) {
        return item;
      }
    }
    return undefined;
  }

  private inferPathBySiblingFromSessionContext(sessionId: string, fileName: string): string | undefined {
    if (!fileName) {
      return undefined;
    }
    const normalized = fileName.replace(/^\/+/, "");
    if (!normalized) {
      return undefined;
    }
    const ctx = this.sessionContext.get(sessionId);
    const candidates = ctx?.recentPaths?.filter((item) => !this.isInternalMemoryPath(item)) ?? [];
    const fileCandidates = candidates.filter((item) => /\/[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+$/.test(item));
    const preferredFileBase = fileCandidates[0];
    if (preferredFileBase) {
      const lastSlash = preferredFileBase.lastIndexOf("/");
      if (lastSlash > 0) {
        return `${preferredFileBase.slice(0, lastSlash + 1)}${normalized}`;
      }
    }
    const latestMentioned = this.sessionLastMentionedPath.get(sessionId);
    if (latestMentioned && latestMentioned.startsWith("/") && !latestMentioned.toLowerCase().endsWith(`/${normalized.toLowerCase()}`)) {
      const slash = latestMentioned.lastIndexOf("/");
      if (slash > 0) {
        return `${latestMentioned.slice(0, slash + 1)}${normalized}`;
      }
    }
    const base = candidates[0];
    if (!base) {
      return undefined;
    }
    const lastSlash = base.lastIndexOf("/");
    if (lastSlash <= 0) {
      return undefined;
    }
    return `${base.slice(0, lastSlash + 1)}${normalized}`;
  }

  private isInternalMemoryPath(path: string): boolean {
    return path.startsWith(Orchestrator.TRASH_DIR) || path.startsWith(Orchestrator.BACKUP_DIR);
  }

  private handlePathClarificationIntent(
    userMessage: string,
    trace: OrchestratorResult["trace"]
  ): OrchestratorResult | undefined {
    const text = userMessage.trim();
    const clarify = text.match(/^我说的是\s*(\/[A-Za-z0-9._\-\/]+)/);
    if (!clarify?.[1]) {
      return undefined;
    }
    const target = clarify[1];
    const summary = `收到，你指的是 ${target}。你可以直接说“检查 ${target} 是否存在”或“查看 ${target}”。`;
    trace.push({ step: "clarification", status: "ok", detail: `User clarified path: ${target}` });
    return {
      command: "[PATH_CLARIFICATION]",
      output: "",
      naturalSummary: summary,
      blocked: false,
      trace
    };
  }

  private async handleDeterministicLocateIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    if (!message) {
      return undefined;
    }
    const fileNameMatch = message.match(/([A-Za-z0-9._-]+\.[A-Za-z0-9]+)(?=\s|$|，|。|？|！|内容|文件)/i);
    let fileName = fileNameMatch?.[1];
    const asksSpecificPath = /(具体指出|具体路径|正常文件夹是哪里|哪个目录|在哪个目录|在哪儿来着)/.test(message);
    if (asksSpecificPath) {
      const path = fileName
        ? this.pickPathByFileNameFromSessionContext(sessionId, fileName)
        : this.pickNormalPathFromSessionContext(sessionId);
      if (path) {
        return {
          command: "[LOCATE_FROM_CONTEXT]",
          output: "",
          naturalSummary: `正常目录里的文件在：${path}`,
          blocked: false,
          trace
        };
      }
    }

    const hasLocateIntent = /(找出来|在哪里|在哪儿|在哪|检索|查找|定位)/.test(message);
    if (!hasLocateIntent) {
      return undefined;
    }
    if (!fileName && /(刚才|那个|这个)/.test(message)) {
      const path = this.pickNormalPathFromSessionContext(sessionId);
      if (path) {
        fileName = path.split("/").pop();
      }
    }
    if (!fileName) {
      return undefined;
    }
    const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, "");
    if (!safeName) {
      return undefined;
    }
    const locateCommand = `sh -lc 'find /tmp /var/tmp /home -type f -name "${safeName}" 2>/dev/null | head -n 50'`;
    const output =
      mode === "ssh" ? await this.executeBySsh(locateCommand, request) : await this.localExecutor.executeCommand(locateCommand);
    const rows = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("/"));
    const unique = [...new Set(rows)];
    const normal = unique.filter((path) => !this.isInternalMemoryPath(path));
    normal.forEach((path) => this.rememberPath(sessionId, path));

    let summary: string;
    if (unique.length === 0) {
      summary = `没有找到名为 ${safeName} 的文件。`;
    } else if (normal.length > 0) {
      const preview = normal.slice(0, 3).join("、");
      summary = `找到了 ${unique.length} 个同名文件。正常目录里的文件在：${preview}`;
    } else {
      const preview = unique.slice(0, 3).join("、");
      summary = `找到了 ${unique.length} 个同名文件，但都在系统回收或备份目录中：${preview}`;
    }

    this.llmClient.setLastRawOutput(sessionId, output);
    this.llmClient.appendAssistantMessage(sessionId, summary);
    trace.push({ step: "deterministic-locate", status: "ok", detail: `Located file by name: ${safeName}` });
    return {
      command: locateCommand,
      output,
      naturalSummary: summary,
      blocked: false,
      trace
    };
  }

  private buildNoCommandFallback(sessionId: string, userMessage: string): string | undefined {
    const normalized = userMessage.trim();
    if (!normalized) {
      return undefined;
    }
    if (/(刚才|那个|该|上一个|上次)/.test(normalized)) {
      const inferred = this.resolveImplicitPathFromContext(sessionId, normalized);
      if (inferred) {
        return `我理解你在指“${inferred}”，但这次解析不完整。请直接说“检查 ${inferred} 是否存在”，我会马上执行。`;
      }
      return "我知道你在指刚才的对象，但当前上下文里没拿到明确路径。请补一句完整路径，我马上帮你查。";
    }
    return undefined;
  }

  private async handleDeterministicSystemInfoIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    if (!message) {
      return undefined;
    }

    const wantsSystemVersion = /(系统版本|操作系统版本|发行版|系统是啥|os-release|os release|内核版本|uname\b)/i.test(message);
    const wantsSystemEnv = /(系统环境|环境信息|主机环境|系统概况|系统信息|机器信息|当前环境)/i.test(message);
    const wantsDisk = /(磁盘|硬盘|存储|disk|df\b|空间)/i.test(message);
    const wantsPort = /(端口|port|监听)/i.test(message) || (/(占用)/i.test(message) && /(端口|port|监听)/i.test(message));
    const wantsProcLike = /(进程|process|谁在跑)/i.test(message) || /\b(pid|ps|top|cpu)\b/i.test(message);

    if (wantsSystemVersion) {
      const command = `sh -lc 'cat /etc/os-release 2>/dev/null || true; echo "---"; uname -srmo 2>/dev/null || true'`;
      const output =
        mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
      const summary = this.buildSystemVersionSummary(output);
      this.llmClient.setLastRawOutput(sessionId, output);
      this.llmClient.appendAssistantMessage(sessionId, summary);
      trace.push({ step: "deterministic-info", status: "ok", detail: "Collected OS version info." });
      return {
        command,
        output,
        naturalSummary: summary,
        blocked: false,
        trace
      };
    }

    if (wantsSystemEnv) {
      const command =
        `sh -lc 'cat /etc/os-release 2>/dev/null || true; echo "---"; ` +
        `uname -srmo 2>/dev/null || true; echo "---"; hostname 2>/dev/null || true; echo "---"; ` +
        `uptime -p 2>/dev/null || uptime 2>/dev/null || true; echo "---"; free -h 2>/dev/null || true; echo "---"; df -hP 2>/dev/null || true'`;
      const output =
        mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
      const summary = this.buildSystemEnvironmentSummary(output);
      this.llmClient.setLastRawOutput(sessionId, output);
      this.llmClient.appendAssistantMessage(sessionId, summary);
      trace.push({ step: "deterministic-info", status: "ok", detail: "Collected system environment info." });
      return {
        command,
        output,
        naturalSummary: summary,
        blocked: false,
        trace
      };
    }

    if (wantsDisk) {
      const command = "df -hP";
      const output =
        mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
      const requestedThreshold = this.extractDiskUsageThreshold(message);
      const summary = this.buildDiskUsageSummary(output, requestedThreshold);
      this.llmClient.setLastRawOutput(sessionId, output);
      this.llmClient.appendAssistantMessage(sessionId, summary);
      trace.push({ step: "deterministic-info", status: "ok", detail: "Collected disk usage info." });
      return {
        command,
        output,
        naturalSummary: summary,
        blocked: false,
        trace
      };
    }

    // Mixed "port + process/cpu" queries are handled by the dedicated port-process handler.
    if (wantsPort && !wantsProcLike) {
      const command = "ss -ltnp";
      const output =
        mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
      let summary: string;
      try {
        summary = await this.llmClient.summarizeOutput("查看端口占用", output);
      } catch {
        summary = "已完成端口占用检查。";
      }
      this.llmClient.setLastRawOutput(sessionId, output);
      this.llmClient.appendAssistantMessage(sessionId, summary);
      trace.push({ step: "deterministic-info", status: "ok", detail: "Collected listening ports info." });
      return {
        command,
        output,
        naturalSummary: summary,
        blocked: false,
        trace
      };
    }

    return undefined;
  }

  private async handleDeterministicServerBootstrapIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    if (!message) return undefined;

    const looksLikeBootstrap =
      /(服务器初始化|初始化运维|标准.*初始化|一整套.*初始化|基线初始化|系统初始化)/i.test(message) ||
      /创建.*用户[\s\S]{0,80}(sudo|sudo权限)[\s\S]{0,120}(防火墙|端口)[\s\S]{0,120}(补丁|更新)[\s\S]{0,120}(报告|成果)/i.test(message);
    if (!looksLikeBootstrap) return undefined;

    const userMatch = message.match(/(?:用户|user)\s*([a-z_][a-z0-9_-]{0,31})/i);
    const username = (userMatch?.[1] ?? "l123").toLowerCase();

    if (mode !== "ssh") {
      const summary = "这套初始化动作会修改远端 Linux 系统（用户、sudo、防火墙、补丁），需要在 SSH 模式下执行。请先配置 SSH 连接后再执行。";
      this.llmClient.appendAssistantMessage(sessionId, summary);
      trace.push({ step: "deterministic-server-bootstrap", status: "blocked", detail: "Server bootstrap requires ssh mode." });
      return { command: "[SERVER_BOOTSTRAP_REQUIRES_SSH]", output: "", naturalSummary: summary, blocked: true, trace };
    }

    const command =
      `sh -lc 'set -e; ` +
      `USER_NAME="${username}"; ` +
      `echo OSA_RESULT:STEP:1:create-user-and-sudo; ` +
      `id "$USER_NAME" >/dev/null 2>&1 && echo OSA_RESULT:EXISTS:user:$USER_NAME || (useradd -m "$USER_NAME" && echo OSA_RESULT:CREATED:user:$USER_NAME); ` +
      `if getent group sudo >/dev/null 2>&1; then usermod -aG sudo "$USER_NAME" && echo OSA_RESULT:UPDATED:sudo-group:$USER_NAME:sudo; ` +
      `elif getent group wheel >/dev/null 2>&1; then usermod -aG wheel "$USER_NAME" && echo OSA_RESULT:UPDATED:sudo-group:$USER_NAME:wheel; ` +
      `else echo OSA_RESULT:SKIPPED:sudo-group:$USER_NAME:no-sudo-group; fi; ` +
      `echo "$USER_NAME ALL=(ALL) ALL" > /etc/sudoers.d/"$USER_NAME"; chmod 440 /etc/sudoers.d/"$USER_NAME"; ` +
      `visudo -cf /etc/sudoers.d/"$USER_NAME" >/dev/null 2>&1 && echo OSA_RESULT:UPDATED:sudoers:$USER_NAME || echo OSA_RESULT:FAILED:sudoers:$USER_NAME; ` +
      `echo OSA_RESULT:STEP:2:firewall; ` +
      `if command -v firewall-cmd >/dev/null 2>&1; then ` +
      `ZONE=$(firewall-cmd --get-default-zone 2>/dev/null || echo public); ` +
      `systemctl is-active --quiet firewalld || systemctl start firewalld || true; ` +
      `firewall-cmd --permanent --zone="$ZONE" --set-target=DROP >/dev/null 2>&1 || true; ` +
      `firewall-cmd --permanent --zone="$ZONE" --add-port=22/tcp >/dev/null 2>&1; ` +
      `firewall-cmd --permanent --zone="$ZONE" --add-port=80/tcp >/dev/null 2>&1; ` +
      `firewall-cmd --permanent --zone="$ZONE" --add-port=443/tcp >/dev/null 2>&1; ` +
      `firewall-cmd --reload >/dev/null 2>&1; ` +
      `PORTS=$(firewall-cmd --zone="$ZONE" --list-ports 2>/dev/null || true); ` +
      `echo OSA_RESULT:UPDATED:firewall:firewalld:zone=$ZONE:ports=\${PORTS:-none}; ` +
      `elif command -v ufw >/dev/null 2>&1; then ` +
      `ufw --force reset >/dev/null 2>&1 || true; ` +
      `ufw default deny incoming >/dev/null 2>&1 || true; ` +
      `ufw default allow outgoing >/dev/null 2>&1 || true; ` +
      `ufw allow 22/tcp >/dev/null 2>&1 || true; ` +
      `ufw allow 80/tcp >/dev/null 2>&1 || true; ` +
      `ufw allow 443/tcp >/dev/null 2>&1 || true; ` +
      `ufw --force enable >/dev/null 2>&1 || true; ` +
      `echo OSA_RESULT:UPDATED:firewall:ufw:22,80,443; ` +
      `else echo OSA_RESULT:SKIPPED:firewall:no-supported-firewall-tool; fi; ` +
      `echo OSA_RESULT:STEP:3:security-updates; ` +
      `if command -v dnf >/dev/null 2>&1; then dnf -y update --security >/dev/null 2>&1 || dnf -y upgrade --refresh >/dev/null 2>&1; echo OSA_RESULT:UPDATED:patch:dnf; ` +
      `elif command -v yum >/dev/null 2>&1; then yum -y update --security >/dev/null 2>&1 || yum -y update >/dev/null 2>&1; echo OSA_RESULT:UPDATED:patch:yum; ` +
      `elif command -v apt-get >/dev/null 2>&1; then apt-get update >/dev/null 2>&1 && apt-get -y upgrade >/dev/null 2>&1; echo OSA_RESULT:UPDATED:patch:apt; ` +
      `elif command -v zypper >/dev/null 2>&1; then zypper -n refresh >/dev/null 2>&1 && (zypper -n patch >/dev/null 2>&1 || zypper -n update >/dev/null 2>&1); echo OSA_RESULT:UPDATED:patch:zypper; ` +
      `else echo OSA_RESULT:SKIPPED:patch:no-supported-package-manager; fi; ` +
      `echo OSA_RESULT:STEP:4:report; ` +
      `OS_NAME=$(grep "^PRETTY_NAME=" /etc/os-release 2>/dev/null | head -n1 | cut -d= -f2- | tr -d "\\""); ` +
      `KERNEL=$(uname -r 2>/dev/null || true); ` +
      `id "$USER_NAME" >/dev/null 2>&1 && echo OSA_RESULT:REPORT:user:$USER_NAME:exists || echo OSA_RESULT:REPORT:user:$USER_NAME:missing; ` +
      `echo OSA_RESULT:REPORT:os:\${OS_NAME:-unknown}:kernel:\${KERNEL:-unknown}; ` +
      `echo OSA_RESULT:DONE:server-bootstrap'`;

    const gate = await this.securityGateway.evaluateCommand({
      sessionId,
      executorMode: mode,
      command,
      targetHost: request.targetHost
    });
    if (!gate.allow) {
      const reason = gate.blockedReason ?? "Blocked by security policy.";
      const summary = await this.llmClient.explainSecurityBlock(command, reason);
      return {
        command,
        output: "",
        naturalSummary: summary,
        blocked: true,
        reason,
        riskLevel: gate.riskLevel,
        requiresApproval: gate.requiresApproval,
        challenge: gate.challenge,
        trace
      };
    }

    const output = await this.executeBySsh(command, request);
    this.llmClient.setLastRawOutput(sessionId, output);
    const summary = this.buildServerBootstrapSummary(output, username);
    this.llmClient.appendAssistantMessage(sessionId, summary);
    trace.push({ step: "deterministic-server-bootstrap", status: "ok", detail: `Executed server bootstrap for ${username}` });
    return { command, output, naturalSummary: summary, blocked: false, riskLevel: gate.riskLevel, requiresApproval: false, trace };
  }

  private buildServerBootstrapSummary(output: string, username: string): string {
    const created = output.includes(`OSA_RESULT:CREATED:user:${username}`);
    const exists = output.includes(`OSA_RESULT:EXISTS:user:${username}`);
    const sudoersOk = output.includes(`OSA_RESULT:UPDATED:sudoers:${username}`);
    const firewallLine = output
      .split(/\r?\n/)
      .find((line) => line.includes("OSA_RESULT:UPDATED:firewall:"))
      ?.trim();
    const patchLine = output
      .split(/\r?\n/)
      .find((line) => line.includes("OSA_RESULT:UPDATED:patch:") || line.includes("OSA_RESULT:SKIPPED:patch:"))
      ?.trim();
    const osLine = output
      .split(/\r?\n/)
      .find((line) => line.includes("OSA_RESULT:REPORT:os:"))
      ?.replace("OSA_RESULT:REPORT:os:", "")
      .trim();
    const userResult = created ? "已创建" : (exists ? "已存在（跳过创建）" : "状态未知");
    const sudoResult = sudoersOk ? "已配置 sudo（/etc/sudoers.d）" : "sudo 配置未确认成功";
    const firewallResult = firewallLine
      ? firewallLine.replace("OSA_RESULT:UPDATED:firewall:", "已配置防火墙：")
      : "防火墙状态未确认";
    const patchResult = patchLine
      ? patchLine
        .replace("OSA_RESULT:UPDATED:patch:", "已完成补丁更新：")
        .replace("OSA_RESULT:SKIPPED:patch:", "补丁更新跳过：")
      : "补丁更新状态未确认";

    return [
      "服务器初始化已执行完成，成果报告如下：",
      `1) 用户与权限：${username} ${userResult}；${sudoResult}。`,
      `2) 防火墙：${firewallResult}。`,
      `3) 安全补丁：${patchResult}。`,
      `4) 系统信息：${osLine ? osLine : "未获取到系统版本信息"}。`
    ].join("\n");
  }

  private buildDiskUsageSummary(dfOutput: string, threshold?: number): string {
    const lines = (dfOutput || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const rows = lines
      .filter((line) => !/^filesystem\s+/i.test(line))
      .map((line) => line.split(/\s+/))
      .filter((parts) => parts.length >= 6)
      .map((parts) => {
        const usePart = parts[4] ?? "";
        const mount = parts.slice(5).join(" ");
        const usedPct = Number(usePart.replace("%", ""));
        return {
          filesystem: parts[0] ?? "",
          size: parts[1] ?? "",
          used: parts[2] ?? "",
          avail: parts[3] ?? "",
          usedPct: Number.isFinite(usedPct) ? usedPct : 0,
          mount
        };
      });

    if (rows.length === 0) {
      return "已完成磁盘检查，但未能解析分区信息。";
    }

    const thresholdForCheck = typeof threshold === "number" ? threshold : 70;
    const highUsage = rows.filter((r) => r.usedPct > thresholdForCheck);
    const head =
      typeof threshold === "number"
        ? highUsage.length > 0
          ? `已完成磁盘检查。发现 ${highUsage.length} 个分区使用率超过 ${threshold}%：${highUsage.map((r) => `${r.mount}(${r.usedPct}%)`).join("、")}。`
          : `已完成磁盘检查。当前未发现使用率超过 ${threshold}% 的分区。`
        : "已完成磁盘检查。";
    const details = rows
      .map((r) => `${r.mount}: ${r.usedPct}%（总量 ${r.size} / 已用 ${r.used} / 剩余 ${r.avail}）`)
      .join("\n");
    return `${head}\n各分区使用情况：\n${details}`;
  }

  private buildSystemVersionSummary(output: string): string {
    const kv = this.parseOsReleaseKeyValues(output);
    const prettyName = kv.PRETTY_NAME || kv.NAME || "未知发行版";
    const versionId = kv.VERSION_ID ? ` ${kv.VERSION_ID}` : "";
    const kernel = this.extractFirstNonDividerLineAfter(output, "---") || "未知内核";
    return `系统版本信息如下：\n操作系统：${prettyName}${versionId}\n内核：${kernel}`;
  }

  private buildSystemEnvironmentSummary(output: string): string {
    const sections = output.split(/\r?\n---\r?\n/);
    const osBlock = sections[0] ?? "";
    const unameLine = (sections[1] ?? "").split(/\r?\n/).find((line) => line.trim())?.trim() ?? "未知";
    const hostnameLine = (sections[2] ?? "").split(/\r?\n/).find((line) => line.trim())?.trim() ?? "未知";
    const uptimeLine = (sections[3] ?? "").split(/\r?\n/).find((line) => line.trim())?.trim() ?? "未知";
    const memLine = (sections[4] ?? "")
      .split(/\r?\n/)
      .find((line) => /^mem:/i.test(line.trim()))
      ?.trim() ?? "未知";
    const os = this.parseOsReleaseKeyValues(osBlock).PRETTY_NAME || this.parseOsReleaseKeyValues(osBlock).NAME || "未知";
    return `当前系统环境如下：\n操作系统：${os}\n内核与架构：${unameLine}\n主机名：${hostnameLine}\n运行时长：${uptimeLine}\n内存概览：${memLine}\n磁盘明细：\n${this.buildDiskUsageSummary(sections[5] ?? "")}`;
  }

  private parseOsReleaseKeyValues(raw: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of (raw || "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const idx = trimmed.indexOf("=");
      if (idx <= 0) {
        continue;
      }
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
    return result;
  }

  private extractFirstNonDividerLineAfter(raw: string, divider: string): string | undefined {
    const idx = raw.indexOf(divider);
    if (idx < 0) {
      return undefined;
    }
    const tail = raw.slice(idx + divider.length);
    return tail
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
  }

  private extractDiskUsageThreshold(message: string): number | undefined {
    const normalized = (message || "").trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }

    const explicitPatterns = [
      /(超过|高于|大于|阈值|告警线)\s*(\d{1,3})\s*%?/i,
      /(>=|>|at\s*least)\s*(\d{1,3})\s*%?/i,
      /(\d{1,3})\s*%\s*(以上|及以上|告警|报警)/i
    ];
    for (const pattern of explicitPatterns) {
      const matched = normalized.match(pattern);
      if (!matched) {
        continue;
      }
      const value = Number(matched[2] ?? matched[1]);
      if (Number.isFinite(value) && value >= 1 && value <= 100) {
        return value;
      }
    }

    return undefined;
  }

  private async handleDeterministicFirewallIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    if (!message) {
      return undefined;
    }
    const asksFirewall = /(防火墙|firewalld|firewall)/i.test(message);
    const asksStop = /(关掉|关闭|停掉|停止|disable|stop)/i.test(message);
    if (!asksFirewall || !asksStop) {
      return undefined;
    }

    const command =
      `systemctl is-active --quiet firewalld && ` +
      `(systemctl stop firewalld && echo OSA_RESULT:UPDATED:svc:firewalld:stopped) ` +
      `|| echo OSA_RESULT:SKIPPED:svc:firewalld`;
    const riskTaggedCommand = `${command} # OSA_FIREWALL_CHANGE:stop`;

    const gate = await this.securityGateway.evaluateCommand({
      sessionId,
      executorMode: mode,
      command: riskTaggedCommand,
      targetHost: request.targetHost
    });
    if (!gate.allow) {
      const reason = gate.blockedReason ?? "Blocked by security policy.";
      const summary = await this.llmClient.explainSecurityBlock(command, reason);
      return {
        command: riskTaggedCommand,
        output: "",
        naturalSummary: summary,
        blocked: true,
        reason,
        riskLevel: gate.riskLevel,
        requiresApproval: gate.requiresApproval,
        challenge: gate.challenge,
        trace
      };
    }

    const output = mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
    this.llmClient.setLastRawOutput(sessionId, output);
    const summary = output.includes("OSA_RESULT:UPDATED")
      ? "已关闭系统防火墙 firewalld。"
      : "防火墙 firewalld 本来就是关闭状态，本次无需变更。";
    this.llmClient.appendAssistantMessage(sessionId, summary);
    trace.push({ step: "deterministic-firewall", status: "ok", detail: "Handled firewalld stop intent deterministically." });
    await this.securityGateway.logExecution(sessionId, riskTaggedCommand, "Deterministic firewall operation executed.");
    return {
      command: riskTaggedCommand,
      output,
      naturalSummary: summary,
      blocked: false,
      riskLevel: gate.riskLevel,
      requiresApproval: false,
      trace
    };
  }

  private async handleDeterministicServiceIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    if (!message) {
      return undefined;
    }

    const svc = this.extractServiceName(message) ?? "";
    if (!svc) {
      return undefined;
    }

    const wantsLogs = /(日志|log|journalctl|报错|错误)/i.test(message);
    const wantsStatus = /(状态|是否正常|运行吗|有没有启动|status|is-active|active)/i.test(message);
    const wantsRestart = /(重启|restart)/i.test(message);

    // Restart should go through the normal planning path (it is state-changing and already wrapped),
    // so we only handle read-only status/log here.
    if (wantsRestart) {
      return undefined;
    }
    if (!wantsLogs && !wantsStatus) {
      return undefined;
    }

    const command = wantsLogs
      ? `journalctl -u ${svc} -n 80 --no-pager`
      : `sh -lc 'systemctl is-active ${svc} 2>/dev/null || true; systemctl is-enabled ${svc} 2>/dev/null || true; systemctl --no-pager -l status ${svc} 2>/dev/null | sed -n \"1,25p\"'`;

    const output =
      mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
    this.llmClient.setLastRawOutput(sessionId, output);
    this.rememberPathsFromText(sessionId, output);

    let summary: string;
    try {
      summary = await this.llmClient.summarizeOutput(
        wantsLogs ? `查看服务 ${svc} 的最近日志` : `查看服务 ${svc} 的状态`,
        output
      );
    } catch {
      summary = wantsLogs ? `已获取服务 ${svc} 的最近日志。` : `已获取服务 ${svc} 的状态信息。`;
    }

    this.llmClient.appendAssistantMessage(sessionId, summary);
    trace.push({
      step: wantsLogs ? "deterministic-service-log" : "deterministic-service-status",
      status: "ok",
      detail: wantsLogs ? `Fetched journal for ${svc}` : `Fetched status for ${svc}`
    });
    return {
      command,
      output,
      naturalSummary: summary,
      blocked: false,
      trace
    };
  }

  private async handleDeterministicMemoryIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    if (!message) return undefined;
    const wantsMemoryDiagnosis =
      /(内存|mem\b|memory)/i.test(message) &&
      /(异常|过高|排查|检查|看看|进程|占用|top)/i.test(message);
    if (!wantsMemoryDiagnosis) return undefined;

    const command =
      `sh -lc '` +
      `free -m 2>/dev/null || true; ` +
      `echo "---TOP_MEM---"; ` +
      `ps -eo pid=,comm=,%mem=,rss=,etime=,args= --sort=-%mem | head -n 12 2>/dev/null || true` +
      `'`;
    const output = mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
    this.llmClient.setLastRawOutput(sessionId, output);

    const summary = this.buildMemoryHealthSummary(output);
    this.llmClient.appendAssistantMessage(sessionId, summary);
    trace.push({ step: "deterministic-memory", status: "ok", detail: "Checked memory usage and high-memory processes." });
    return { command, output, naturalSummary: summary, blocked: false, trace };
  }

  private extractServiceName(message: string): string | undefined {
    // Common patterns:
    // - "firewalld" in parentheses: (firewalld)
    // - "nginx 服务" / "服务 nginx"
    const paren = message.match(/\(([A-Za-z0-9@._-]{2,50})\)/);
    const fromParen = paren?.[1]?.trim();
    const svcWord1 = message.match(/服务\s*([A-Za-z0-9@._-]{2,50})/);
    const svcWord2 = message.match(/([A-Za-z0-9@._-]{2,50})\s*服务/);
    const candidate = fromParen ?? svcWord1?.[1] ?? svcWord2?.[1];
    if (!candidate) {
      return undefined;
    }
    const cleaned = candidate.replace(/[^A-Za-z0-9@._-]/g, "");
    if (!cleaned || cleaned.length < 2) {
      return undefined;
    }
    return cleaned;
  }

  private async handleDeterministicPortProcessIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    if (!message) return undefined;

    const wantsPort = /(端口|port|监听|占用)/i.test(message);
    const wantsProc = /(进程|process|谁在跑)/i.test(message) || /\b(pid|ps|top)\b/i.test(message);
    if (!wantsPort && !wantsProc) return undefined;

    const portMatch = message.match(/\b([0-9]{2,5})\b/);
    const port = portMatch?.[1] ? Number(portMatch[1]) : undefined;
    const looksLikePortQuery = wantsPort && port && port > 0 && port <= 65535;
    const wantsBothPortAndProc = wantsPort && wantsProc;

    const command = wantsBothPortAndProc
      ? `sh -lc 'ps aux --sort=-%cpu | head -n 4; echo \"--- LISTENING PORTS ---\"; ss -ltnp 2>/dev/null || true'`
      : looksLikePortQuery
        ? `sh -lc 'ss -ltnp 2>/dev/null | grep -E \"[:.]${port}\\b\" || true; lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null || true'`
        : wantsPort
          ? "ss -ltnp"
          : `sh -lc 'ps aux --sort=-%cpu | head -n 12; echo \"---\"; ps aux --sort=-%mem | head -n 12'`;

    const output = mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
    this.llmClient.setLastRawOutput(sessionId, output);

    let summary: string;
    if (wantsBothPortAndProc) {
      summary = this.buildCpuPortFactSummary(output);
    } else {
      try {
        summary = await this.llmClient.summarizeOutput(
          looksLikePortQuery
            ? `查看端口 ${port} 的占用情况`
            : wantsPort
              ? "查看当前正在监听的端口"
              : "查看当前进程占用情况",
          output
        );
      } catch {
        summary = looksLikePortQuery
          ? `已检查端口 ${port} 的占用情况。`
          : wantsPort
            ? "已获取当前监听端口信息。"
            : "已获取当前进程信息。";
      }
    }

    this.llmClient.appendAssistantMessage(sessionId, summary);
    trace.push({
      step: "deterministic-port-process",
      status: "ok",
      detail: wantsBothPortAndProc
        ? "Listed top CPU processes and listening ports"
        : looksLikePortQuery
          ? `Checked port ${port}`
          : wantsPort
            ? "Listed listening ports"
            : "Listed top processes"
    });
    return { command, output, naturalSummary: summary, blocked: false, trace };
  }

  private async handleDeterministicLogOpsIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    if (!message) return undefined;

    const wantsTail = /(最后|末尾|tail|最近)\s*(\d{1,4})?\s*(行)?/i.test(message) && /(日志|log|文件)/i.test(message);
    const wantsGrep = /(搜|搜索|查找|grep|包含|关键字)/i.test(message);
    const hasRecent24hHint = /(最近\s*24\s*小时|24h|24小时|一天内|近一天)/i.test(message);
    const wantsRecentLogFind =
      /(查找|搜索|检索|列出|find)/i.test(message) &&
      /(\.log|后缀|日志|log)/i.test(message) &&
      hasRecent24hHint;
    if (!wantsTail && !wantsGrep && !wantsRecentLogFind) return undefined;

    const path = message.match(/\/[A-Za-z0-9._\-\/]+/)?.[0] ?? this.resolveImplicitPathFromContext(sessionId, message);
    if (!path) return undefined;

    if (wantsRecentLogFind) {
      const command = `sh -lc '[ -d "${path}" ] && find "${path}" -type f -name "*.log" -mmin -1440 2>/dev/null | sort || echo OSA_RESULT:DELETED:dir:${path}'`;
      const output = mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
      this.llmClient.setLastRawOutput(sessionId, output);
      this.rememberPath(sessionId, path);
      const files = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("/"));
      const summary = output.includes("OSA_RESULT:DELETED")
        ? `目录 ${path} 不存在。`
        : files.length > 0
          ? `已在 ${path} 找到最近24小时内修改的 .log 文件（共 ${files.length} 个）：\n${files.join("\n")}`
          : `已检查 ${path}，最近24小时内没有修改过的 .log 文件。`;
      this.llmClient.appendAssistantMessage(sessionId, summary);
      trace.push({
        step: "deterministic-log-ops",
        status: "ok",
        detail: `Listed .log files changed in last 24h under ${path}`
      });
      return { command, output, naturalSummary: summary, blocked: false, trace };
    }

    const linesMatch = message.match(/\b(\d{1,4})\b/);
    const lines = Math.min(300, Math.max(20, linesMatch?.[1] ? Number(linesMatch[1]) : 80));

    const keywordMatch = message.match(/(?:关键字|包含|搜|搜索|查找)\s*[:：]?\s*([A-Za-z0-9._-]{2,40})/);
    const keyword = keywordMatch?.[1];

    const command = keyword
      ? `sh -lc '[ -f "${path}" ] && (tail -n ${lines} "${path}" | rg -n "${keyword}" || true) || echo OSA_RESULT:DELETED:file:${path}'`
      : `sh -lc '[ -f "${path}" ] && tail -n ${lines} "${path}" || echo OSA_RESULT:DELETED:file:${path}'`;

    const output = mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
    this.llmClient.setLastRawOutput(sessionId, output);
    this.rememberPath(sessionId, path);

    const summary = output.includes("OSA_RESULT:DELETED")
      ? `文件 ${path} 不存在。`
      : await this.llmClient.summarizeOutput(
          keyword
            ? `在 ${path} 的最近 ${lines} 行里搜索 ${keyword}`
            : hasRecent24hHint
              ? `按最近24小时筛选 ${path} 下的日志相关信息`
              : `查看 ${path} 的最近 ${lines} 行`,
          output
        );

    this.llmClient.appendAssistantMessage(sessionId, summary);
    trace.push({
      step: "deterministic-log-ops",
      status: "ok",
      detail: keyword ? `Tailed+searched ${path}` : `Tailed ${path}`
    });
    return { command, output, naturalSummary: summary, blocked: false, trace };
  }

  private async handleDeterministicTimeIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    if (!message) return undefined;
    const wantsTime = /(时间|时钟|当前时间|time|date)/i.test(message);
    const wantsTz = /(时区|timezone|tz)/i.test(message);
    const wantsNtp = /(ntp|时间同步|同步时间|校时)/i.test(message);
    if (!wantsTime && !wantsTz && !wantsNtp) return undefined;

    const command = `sh -lc 'date; echo \"---\"; timedatectl status 2>/dev/null || true'`;
    const output = mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
    this.llmClient.setLastRawOutput(sessionId, output);
    let summary: string;
    try {
      summary = await this.llmClient.summarizeOutput("查看系统时间/时区/同步状态", output);
    } catch {
      summary = "已获取系统时间与时区信息。";
    }
    this.llmClient.appendAssistantMessage(sessionId, summary);
    trace.push({ step: "deterministic-time", status: "ok", detail: "Collected time/timezone status." });
    return { command, output, naturalSummary: summary, blocked: false, trace };
  }

  private async handleDeterministicNetworkIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    if (!message) return undefined;
    const wantsNet = /(网络|连通|ping|curl|访问|dns|解析|能不能连|通不通)/i.test(message);
    if (!wantsNet) return undefined;

    const hostMatch = message.match(/\b([A-Za-z0-9.-]+\.[A-Za-z]{2,}|[0-9]{1,3}(?:\.[0-9]{1,3}){3})\b/);
    const target = hostMatch?.[1] ?? "8.8.8.8";
    const urlMatch = message.match(/https?:\/\/[^\s]+/i)?.[0];
    const curlTarget = urlMatch ?? (target.includes("/") ? target : `http://${target}`);

    const command =
      `sh -lc '` +
      `echo "TARGET=${target}"; ` +
      `getent hosts ${target} 2>/dev/null || true; ` +
      `ping -c 2 -W 2 ${target} 2>/dev/null || true; ` +
      `echo "---"; ` +
      `curl -I -m 5 -sS ${curlTarget} | head -n 8 || true` +
      `'`;
    const output = mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
    this.llmClient.setLastRawOutput(sessionId, output);
    let summary: string;
    try {
      summary = await this.llmClient.summarizeOutput(`检查网络连通性（目标 ${target}）`, output);
    } catch {
      summary = `已检查网络连通性（目标 ${target}）。`;
    }
    this.llmClient.appendAssistantMessage(sessionId, summary);
    trace.push({ step: "deterministic-network", status: "ok", detail: `Checked connectivity for ${target}` });
    return { command, output, naturalSummary: summary, blocked: false, trace };
  }

  private async handleDeterministicNetworkConfigIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    if (!message) return undefined;
    const wantsCfg = /(网关|gateway|路由|route|dns|解析配置|resolv|网卡配置|interface|ifconfig|ip\s+route)/i.test(message);
    if (!wantsCfg) return undefined;

    const command =
      `sh -lc '` +
      `echo "ip_addr:"; ip -br addr 2>/dev/null || ip addr 2>/dev/null || true; ` +
      `echo "---"; echo "routes:"; ip route 2>/dev/null || true; ` +
      `echo "---"; echo "dns:"; (resolvectl status 2>/dev/null || true); (cat /etc/resolv.conf 2>/dev/null || true)` +
      `'`;
    const output = mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
    this.llmClient.setLastRawOutput(sessionId, output);
    let summary: string;
    try {
      summary = await this.llmClient.summarizeOutput("查看网络配置（IP/路由/DNS）", output);
    } catch {
      summary = "已获取网络配置（IP/路由/DNS）。";
    }
    this.llmClient.appendAssistantMessage(sessionId, summary);
    trace.push({ step: "deterministic-netcfg", status: "ok", detail: "Collected ip/route/dns config." });
    return { command, output, naturalSummary: summary, blocked: false, trace };
  }

  private async handleDeterministicDiskUsageIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    if (!message) return undefined;
    const wantsDu =
      /(du\b|目录大小|空间都去哪了|哪个目录大|目录占用|文件夹占用|目录多大|磁盘目录分析)/i.test(message) ||
      (/(占用|多大|多占)/i.test(message) && /(目录|文件夹|\/)/i.test(message));
    if (!wantsDu) return undefined;
    const path = message.match(/\/[A-Za-z0-9._\-\/]+/)?.[0] ?? "/var";
    const command = `sh -lc 'test -d "${path}" || test -f "${path}"; du -xh --max-depth=1 "${path}" 2>/dev/null | sort -h | tail -n 12 || true'`;
    const output = mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
    this.llmClient.setLastRawOutput(sessionId, output);
    this.rememberPath(sessionId, path);
    let summary: string;
    try {
      summary = await this.llmClient.summarizeOutput(`分析目录占用（${path}）`, output);
    } catch {
      summary = `已分析 ${path} 的目录占用情况。`;
    }
    this.llmClient.appendAssistantMessage(sessionId, summary);
    trace.push({ step: "deterministic-disk-usage", status: "ok", detail: `Analyzed du for ${path}` });
    return { command, output, naturalSummary: summary, blocked: false, trace };
  }

  private async handleDeterministicLogHealthIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    if (!message) return undefined;
    const wantsLogs = /(日志|log|journal|journald|var\/log|磁盘爆了|空间不够)/i.test(message);
    const hasExplicitPath = /\/[A-Za-z0-9._\-\/]+/.test(message);
    const hasSearchIntent = /(搜|搜索|查找|grep|关键字|包含)/i.test(message);
    if (hasExplicitPath || hasSearchIntent) return undefined;
    if (!wantsLogs) return undefined;
    const command =
      `sh -lc '` +
      `echo "var_log_top:"; ` +
      `du -sh /var/log/* 2>/dev/null | sort -h | tail -n 12 || true; ` +
      `echo "---"; ` +
      `echo "journald_usage:"; ` +
      `journalctl --disk-usage 2>/dev/null || true` +
      `'`;
    const output = mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
    this.llmClient.setLastRawOutput(sessionId, output);
    let summary: string;
    try {
      summary = await this.llmClient.summarizeOutput("检查日志占用情况（/var/log 与 journald）", output);
    } catch {
      summary = "已检查日志占用情况。";
    }
    this.llmClient.appendAssistantMessage(sessionId, summary);
    trace.push({ step: "deterministic-log-health", status: "ok", detail: "Checked /var/log and journald usage." });
    return { command, output, naturalSummary: summary, blocked: false, trace };
  }

  private async handleDeterministicIpIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    if (!message) return undefined;
    const wantsIp = /(ip地址|ip\b|本机ip|主机ip|网卡|地址是什么)/i.test(message);
    if (!wantsIp) return undefined;

    const command = `sh -lc 'ip -4 -o addr show scope global 2>/dev/null || true; echo \"---\"; hostname -I 2>/dev/null || true'`;
    const output = mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
    this.llmClient.setLastRawOutput(sessionId, output);

    let summary: string;
    try {
      summary = await this.llmClient.summarizeOutput("查看本机 IPv4 地址", output);
    } catch {
      summary = "已获取本机 IP 地址信息。";
    }
    this.llmClient.appendAssistantMessage(sessionId, summary);
    trace.push({ step: "deterministic-ip", status: "ok", detail: "Collected IPv4 addresses." });
    return { command, output, naturalSummary: summary, blocked: false, trace };
  }

  private async handleDeterministicPerfIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    if (!message) return undefined;
    const wantsPerf = /(性能|卡|慢|负载|load|cpu|i\/o|磁盘io|inode)/i.test(message);
    const wantsMemOnly = /(内存|mem\b|memory)/i.test(message) && !wantsPerf;
    if (!wantsPerf && !wantsMemOnly) return undefined;

    const command = wantsMemOnly
      ? `sh -lc 'free -h 2>/dev/null || true; echo "---"; cat /proc/meminfo 2>/dev/null | head -n 5 || true'`
      :
      `sh -lc '` +
      `echo "load:"; uptime 2>/dev/null || true; ` +
      `echo "---"; echo "cpu_mem:"; (command -v top >/dev/null 2>&1 && top -b -n 1 | head -n 15) || true; ` +
      `echo "---"; echo "mem:"; free -h 2>/dev/null || true; ` +
      `echo "---"; echo "disk:"; df -hP 2>/dev/null || true; ` +
      `echo "---"; echo "inode:"; df -iP 2>/dev/null || true; ` +
      `echo "---"; echo "io:"; (command -v iostat >/dev/null 2>&1 && iostat -xz 1 1) || (cat /proc/diskstats 2>/dev/null | head -n 20) || true` +
      `'`;
    const output = mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
    this.llmClient.setLastRawOutput(sessionId, output);
    let summary: string;
    try {
      summary = await this.llmClient.summarizeOutput("查看主机性能概况（负载/CPU/内存/磁盘/IO/inode）", output);
    } catch {
      summary = "已获取主机性能概况。";
    }
    this.llmClient.appendAssistantMessage(sessionId, summary);
    trace.push({ step: "deterministic-perf", status: "ok", detail: "Collected perf snapshot." });
    return { command, output, naturalSummary: summary, blocked: false, trace };
  }

  private async handleDeterministicHelloWebIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    if (!message) return undefined;

    // Avoid swallowing broader ops-init tasks that mention "服务/关闭" etc.
    if (/(初始化|运维|sudo|防火墙|补丁|端口22|端口80|端口443)/i.test(message)) {
      return undefined;
    }

    const wantsWeb = /(web|网页|http|服务|server|起一个服务|启动服务)/i.test(message);
    const wantsHello = /(hello|hello world|helloworld|你好世界|hello-world)/i.test(message);
    const wantsStart = /(起|启动|开启|start|run)/i.test(message);
    const wantsStop = /(停|停止|关闭|stop|kill|关掉)/i.test(message);
    const wantsCleanup = /(不要了|不想要|不需要|取消|清理|清除|撤掉|关了吧)/i.test(message);
    const hasDisplayIntent = /(显示|展示|内容|返回)/i.test(message);
    // Accept explicit hello keyword, plain start-web requests, or "start a web service and display X".
    if (!wantsWeb || !(wantsHello || wantsStart || (wantsStart && hasDisplayIntent) || wantsStop || wantsCleanup)) return undefined;

    const desiredContent = extractHelloWebContent(message) ?? "hello world";

    if (wantsStop || wantsCleanup) {
      if (mode !== "ssh") {
        const summary = "这个能力会在目标 Linux 主机上启动/停止服务，需要先切到 SSH 执行模式（OS_AGENT_EXECUTOR_MODE=ssh 并配置 SSH_* 环境变量）。";
        this.llmClient.appendAssistantMessage(sessionId, summary);
        trace.push({ step: "deterministic-hello-web-stop", status: "blocked", detail: "Hello-web stop requires ssh mode." });
        return { command: "[HELLO_WEB_REQUIRES_SSH]", output: "", naturalSummary: summary, blocked: true, trace };
      }
      const running = this.helloWebSessions.get(sessionId);
      const stateFile = getHelloWebStateFile(Orchestrator.HELLO_WEB_STATE_DIR, sessionId);
      const pidToKill = running?.pid;

      // "Clean" means: stop the process, ensure port is not listening (if known), and remove state file.
      // If we don't have in-memory pid/port, fall back to reading state file on Linux.
      const command =
        `sh -lc '` +
        `set -e; ` +
        `STATE_FILE="${stateFile}"; ` +
        `PID="${pidToKill ?? ""}"; ` +
        `PORT=""; ` +
        `if [ -z "$PID" ] && command -v python3 >/dev/null 2>&1 && [ -f "$STATE_FILE" ]; then ` +
        `  PID=$(python3 -c "import json; d=json.load(open(\\"${stateFile}\\",\\"r\\")); print(int(d.get(\\"pid\\",0)))" 2>/dev/null || echo 0); ` +
        `  PORT=$(python3 -c "import json; d=json.load(open(\\"${stateFile}\\",\\"r\\")); print(int(d.get(\\"port\\",0)))" 2>/dev/null || echo 0); ` +
        `fi; ` +
        `if [ -n "$PID" ] && [ "$PID" != "0" ]; then ` +
        `  kill "$PID" 2>/dev/null || true; ` +
        `  sleep 0.2; ` +
        `  kill -0 "$PID" 2>/dev/null && { kill -9 "$PID" 2>/dev/null || true; sleep 0.2; } || true; ` +
        `fi; ` +
        `# Verify port not listening when we know it (best-effort). ` +
        `if [ -z "$PORT" ] && [ -f "$STATE_FILE" ] && command -v python3 >/dev/null 2>&1; then ` +
        `  PORT=$(python3 -c "import json; d=json.load(open(\\"${stateFile}\\",\\"r\\")); print(int(d.get(\\"port\\",0)))" 2>/dev/null || echo 0); ` +
        `fi; ` +
        `if [ -n "$PORT" ] && [ "$PORT" != "0" ]; then ` +
        `  ss -lnt sport = :$PORT 2>/dev/null | grep -q LISTEN && { echo OSA_RESULT:FAILED:service:hello-web:port-still-listening:$PORT; exit 1; } || true; ` +
        `fi; ` +
        `# Remove state file and verify removal. ` +
        `if command -v python3 >/dev/null 2>&1; then ` +
        `  python3 -c "import os; p=\\"${stateFile}\\"; os.path.exists(p) and os.remove(p)" 2>/dev/null || true; ` +
        `fi; ` +
        `[ -f "$STATE_FILE" ] && { echo OSA_RESULT:FAILED:service:hello-web:state-file-not-removed; exit 1; } || true; ` +
        `echo OSA_RESULT:UPDATED:service:hello-web:cleaned'`;

      const output = await this.executeBySsh(command, request);
      this.llmClient.setLastRawOutput(sessionId, output);
      this.helloWebSessions.delete(sessionId);
      const summary = output.includes("OSA_RESULT:UPDATED:service:hello-web:cleaned")
        ? "好的，已帮你把刚才启动的 Web 服务停止并清理干净了。"
        : "好的，这个 Web 服务目前看起来已经不在运行了（无需再清理）。";
      this.llmClient.appendAssistantMessage(sessionId, summary);
      trace.push({
        step: "deterministic-hello-web-stop",
        status: "ok",
        detail: pidToKill ? `Stopped hello-web pid=${pidToKill}` : "Stopped hello-web via state file."
      });
      return { command, output, naturalSummary: summary, blocked: false, trace };
    }

    if (!wantsStart) return undefined;

    if (mode !== "ssh") {
      const summary = "这个能力会在目标 Linux 主机上启动一个临时 Web 服务，需要先切到 SSH 执行模式（OS_AGENT_EXECUTOR_MODE=ssh 并配置 SSH_* 环境变量）。";
      this.llmClient.appendAssistantMessage(sessionId, summary);
      trace.push({ step: "deterministic-hello-web-start", status: "blocked", detail: "Hello-web start requires ssh mode." });
      return { command: "[HELLO_WEB_REQUIRES_SSH]", output: "", naturalSummary: summary, blocked: true, trace };
    }

    const existing = this.helloWebSessions.get(sessionId);
    if (existing) {
      if (existing.content === desiredContent) {
        const probeCmd =
          `sh -lc 'python3 -c "import urllib.request,sys; ` +
          `urllib.request.urlopen(\\"http://127.0.0.1:${existing.port}/raw\\", timeout=1.5).read(); sys.exit(0)" ` +
          `>/dev/null 2>&1 && echo OSA_RESULT:OK || echo OSA_RESULT:FAILED'`;
        try {
          const probeOut = await this.executeBySsh(probeCmd, request);
          if (probeOut.includes("OSA_RESULT:OK")) {
            const summary = `Web服务已启动，内容显示为 ${existing.content}，curl 命令：curl -sS http://127.0.0.1:${existing.port}/raw ; echo（浏览器访问：http://127.0.0.1:${existing.port}/）`;
            this.llmClient.appendAssistantMessage(sessionId, summary);
            trace.push({ step: "deterministic-hello-web-start", status: "ok", detail: "Hello-web already running and passed probe." });
            return { command: "[HELLO_WEB_ALREADY_RUNNING]", output: probeOut, naturalSummary: summary, blocked: false, trace };
          }
        } catch {
          // probe failed: continue with restart flow below
        }
        this.helloWebSessions.delete(sessionId);
      }
      // Content changed: restart service with new response.
      const stopCmd = `sh -lc 'kill ${existing.pid} 2>/dev/null || true'`;
      try {
        await this.executeBySsh(stopCmd, request);
      } catch {
        // ignore
      }
      this.helloWebSessions.delete(sessionId);
    }

    // Start a tiny HTTP server on Linux (python3). Use an ephemeral free port chosen by the OS.
    // IMPORTANT: this string is embedded in a single-quoted sh -lc script, so it must NOT contain single quotes.
    // Keep it strictly one-line Python (no indentation pitfalls).
    const pythonSnippet =
      "import http.server,socketserver,os,base64,html,json;" +
      'msg=base64.b64decode(os.environ.get("MSG_B64","YUdWc2JHOGdkMjl5YkdRPQ==")).decode("utf-8","ignore");' +
      "safe=html.escape(msg);" +
      'raw=(msg+"\\n").encode("utf-8");' +
      'state_file=os.environ.get("STATE_FILE","");' +
      'port=os.environ.get("PORT","0");' +
      'page=("<!doctype html><html><head><meta charset=\\"utf-8\\"><meta name=\\"viewport\\" content=\\"width=device-width, initial-scale=1\\">"' +
      '"+\"<title>FusionOS Hello</title>\"' +
      '"+\"<style>body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;min-height:100vh;display:grid;place-items:center;\"' +
      '"+\"background:radial-gradient(circle at 20% 20%, rgba(0,240,255,.18), transparent 35%),radial-gradient(circle at 80% 30%, rgba(176,38,255,.18), transparent 40%),#0b0f19;color:#e2e8f0;}\"' +
      '"+\".card{width:min(900px,92vw);border:1px solid rgba(255,255,255,.10);border-radius:16px;background:rgba(18,25,43,.65);backdrop-filter:blur(14px);\"' +
      '"+\"box-shadow:0 0 40px rgba(0,0,0,.55), inset 0 0 20px rgba(0,240,255,.16);padding:28px;}\"' +
      '"+\".badge{display:inline-block;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#00f0ff;opacity:.9;margin-bottom:10px;}\"' +
      '"+\"h1{margin:0 0 10px;font-size:28px;}\"' +
      '"+\"pre{margin:14px 0 0;padding:14px;border-radius:12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);overflow:auto;}\"' +
      '"+\".hint{margin-top:14px;color:#94a3b8;font-size:13px;}\"' +
      '"+\"</style></head><body><div class=\\\\\\\"card\\\\\\\">\"' +
      '"+\"<div class=\\\\\\\"badge\\\\\\\">FusionOS Agent Demo</div>\"' +
      '"+\"<h1>\"+safe+\"</h1>\"' +
      '"+\"<div class=\\\\\\\"hint\\\\\\\">Tip: curl <code>/raw</code> for plain text.</div>\"' +
      '"+\"<pre>curl -s http://127.0.0.1:\"+real_port+\"/raw</pre>\"' +
      "+\"</div></body></html>\").encode(\"utf-8\");" +
      'def do_GET(self): p=self.path.split("?",1)[0]; ' +
      'self.send_response(200); ' +
      'self.send_header("Content-Type","text/plain; charset=utf-8") if p=="/raw" else self.send_header("Content-Type","text/html; charset=utf-8"); ' +
      "self.end_headers(); " +
      "self.wfile.write(raw if p==\"/raw\" else page);" +
      'H=type("H",(http.server.BaseHTTPRequestHandler,),{"do_GET":do_GET,"log_message":lambda *a,**k:None});' +
      'httpd=socketserver.TCPServer(("0.0.0.0",int(port)),H);' +
      'real_port=httpd.server_address[1];' +
      'state_file and json.dump({"pid":os.getpid(),"port":int(real_port)}, open(state_file,"w"));' +
      'httpd.serve_forever()';

    const desiredB64 = Buffer.from(desiredContent, "utf8").toString("base64");
    const stateFile = getHelloWebStateFile(Orchestrator.HELLO_WEB_STATE_DIR, sessionId);

    const command = buildHelloWebStartCommand({
      stateDir: Orchestrator.HELLO_WEB_STATE_DIR,
      stateFile,
      desiredB64
    });
    const output = await this.executeBySsh(command, request);
    this.llmClient.setLastRawOutput(sessionId, output);
    const parsedPort =
      output.match(/OSA_RESULT:CREATED:service:hello-web:port=([0-9]{2,5})/)?.[1] ??
      output.match(/http:\/\/127\.0\.0\.1:([0-9]{2,5})\/raw/)?.[1];
    const port = Number(parsedPort);
    const pid = Number(output.match(/OSA_RESULT:CREATED:process:pid=([0-9]{1,10})/)?.[1]);
    const failedCode = output.match(/OSA_RESULT:FAILED:service:hello-web:([A-Za-z0-9._-]+)/)?.[1];
    if (port > 0 && pid > 0) {
      this.helloWebSessions.set(sessionId, { pid, port, content: desiredContent, mode, targetHost: request.targetHost });
      // Integrate with rollback: allow user to "回退/撤销" to stop the temporary service.
      this.rollbackService.record({
        sessionId,
        originalCommand: "[HELLO_WEB_START]",
        executedCommand: command,
        inverseCommand: buildHelloWebCleanupCommand(stateFile, pid),
        description: `停止临时 Web 服务（端口 ${port}）`
      });
    }

    const summary =
      port > 0
        ? `Web服务已启动，内容显示为 ${desiredContent}，curl 命令：curl -sS http://127.0.0.1:${port}/raw ; echo（浏览器访问：http://127.0.0.1:${port}/）`
        : failedCode === "python3-missing"
          ? "启动失败：目标 Linux 缺少 python3。先安装 python3 后再试。"
          : failedCode === "not-listening"
            ? "启动失败：服务进程未进入监听状态（可能端口/网络栈异常或启动即退出）。可重试一次，若仍失败请检查系统日志。"
            : failedCode === "self-test"
              ? "启动失败：服务启动后自检未通过（/raw 返回内容不符合预期），建议重试或简化返回内容后再试。"
              : "我尝试启动 Web 服务，但未拿到可用端口（未检测到成功标记）。请重试一次；若仍失败我会按失败码继续诊断。";
    this.llmClient.appendAssistantMessage(sessionId, summary);
    trace.push({ step: "deterministic-hello-web-start", status: "ok", detail: `Started hello-web port=${port} pid=${pid}` });
    return { command, output, naturalSummary: summary, blocked: false, trace };
  }

  private async handleDeterministicNginxIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    if (!message) return undefined;

    const mentionsNginx = /(nginx)/i.test(message);
    if (!mentionsNginx) return undefined;

    const wantsInstall = /(安装|install|部署)/i.test(message);
    const wantsStart = /(启动|start|运行起来|起服务)/i.test(message);
    const wantsStop = /(停止|stop|关掉|关闭)/i.test(message);
    const wantsStatus = /(状态|是否正常|运行吗|有没有启动|status|is-active|active)/i.test(message);
    const wantsCurl = /(curl|访问|打开网页|http)/i.test(message);

    if (mode !== "ssh") {
      const summary = "nginx 这类服务运维会在目标 Linux 主机上执行，请先切到 SSH 模式（OS_AGENT_EXECUTOR_MODE=ssh 并配置 SSH_*）。";
      this.llmClient.appendAssistantMessage(sessionId, summary);
      trace.push({ step: "deterministic-nginx", status: "blocked", detail: "nginx intent requires ssh mode." });
      return { command: "[NGINX_REQUIRES_SSH]", output: "", naturalSummary: summary, blocked: true, trace };
    }

    // Read-only: status
    if (wantsStatus && !wantsInstall && !wantsStart && !wantsStop) {
      const command = buildNginxStatusCommand();
      const output = await this.executeBySsh(command, request);
      this.llmClient.setLastRawOutput(sessionId, output);
      const summary = await this.llmClient.summarizeOutput("查看 nginx 服务状态", output);
      this.llmClient.appendAssistantMessage(sessionId, summary);
      trace.push({ step: "deterministic-nginx-status", status: "ok", detail: "Fetched nginx status." });
      return { command, output, naturalSummary: summary, blocked: false, trace };
    }

    // Stop nginx (state-changing; policy will decide if approval needed)
    if (wantsStop) {
      const command = buildNginxStopCommand();
      const gate = await this.securityGateway.evaluateCommand({ sessionId, executorMode: mode, command, targetHost: request.targetHost });
      if (!gate.allow) {
        const reason = gate.blockedReason ?? "Blocked by security policy.";
        const summary = await this.llmClient.explainSecurityBlock(command, reason);
        this.llmClient.appendAssistantMessage(sessionId, summary);
        trace.push({ step: "deterministic-nginx-stop", status: "blocked", detail: reason });
        return { command, output: "", naturalSummary: summary, blocked: true, reason, riskLevel: gate.riskLevel, requiresApproval: gate.requiresApproval, challenge: gate.challenge, trace };
      }
      const output = await this.executeBySsh(command, request);
      this.llmClient.setLastRawOutput(sessionId, output);
      const summary = output.includes("OSA_RESULT:UPDATED") ? "已停止 nginx 服务。" : "nginx 当前未运行，本次无需停止。";
      this.llmClient.appendAssistantMessage(sessionId, summary);
      trace.push({ step: "deterministic-nginx-stop", status: "ok", detail: "Stopped nginx (or skipped)." });
      await this.securityGateway.logExecution(sessionId, command, "Deterministic nginx stop executed.");
      return { command, output, naturalSummary: summary, blocked: false, trace };
    }

    // Install+start nginx (state-changing; policy may require approval for pkg operations)
    if (wantsInstall || wantsStart) {
      const command = buildNginxStartCommand();

      const gate = await this.securityGateway.evaluateCommand({ sessionId, executorMode: mode, command, targetHost: request.targetHost });
      if (!gate.allow) {
        const reason = gate.blockedReason ?? "Blocked by security policy.";
        const summary = await this.llmClient.explainSecurityBlock(command, reason);
        this.llmClient.appendAssistantMessage(sessionId, summary);
        trace.push({ step: "deterministic-nginx-start", status: "blocked", detail: reason });
        return { command, output: "", naturalSummary: summary, blocked: true, reason, riskLevel: gate.riskLevel, requiresApproval: gate.requiresApproval, challenge: gate.challenge, trace };
      }

      const output = await this.executeBySsh(command, request);
      this.llmClient.setLastRawOutput(sessionId, output);

      // Rollback integration: stop nginx (safe-ish). Package uninstall rollback is distro-specific and riskier, so we don't auto-record it.
      this.rollbackService.record({
        sessionId,
        originalCommand: "[NGINX_START]",
        executedCommand: command,
        inverseCommand: buildNginxRollbackCommand(),
        description: "停止 nginx 服务"
      });

      const summaryBase =
        output.includes("OSA_RESULT:FAILED:svc:nginx:start")
          ? "我尝试启动 nginx，但启动失败了。我已经把状态信息取回来了，你把输出发我我可以继续自动修复。"
          : "已安装并启动 nginx（如果未安装会自动安装）。";
      const summary = wantsCurl
        ? `${summaryBase}\n\n你可以在 Linux 上执行：curl -I http://127.0.0.1/`
        : summaryBase;
      this.llmClient.appendAssistantMessage(sessionId, summary);
      trace.push({ step: "deterministic-nginx-start", status: "ok", detail: "Installed/started nginx." });
      await this.securityGateway.logExecution(sessionId, command, "Deterministic nginx install/start executed.");
      return { command, output, naturalSummary: summary, blocked: false, trace };
    }

    // Default: if user only mentions nginx without a verb, give status.
    const fallback = await this.handleDeterministicNginxIntent({
      sessionId,
      mode,
      request: { ...request, userMessage: `${message} 状态` },
      trace
    });
    return fallback;
  }

  private async handleDeterministicCreateWriteViewIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    if (!message) return undefined;

    const hasCreate = /(创建|新建|mkdir|建一个|建个)/i.test(message);
    const hasWrite = /(写入|写成|内容为|内容是|写上)/i.test(message);
    const hasView = /(查看|读取|看下|显示)/i.test(message);
    const hasTxt = /([A-Za-z0-9._-]+\.txt)\b/i.test(message);
    if (!(hasCreate && hasWrite && hasView && hasTxt)) return undefined;

    const basePath = message.match(/\/[A-Za-z0-9._\-\/]+/)?.[0];
    const dirName = message.match(/(?:创建|新建)(?:一个|个)?\s*([A-Za-z0-9._-]+)\s*目录/i)?.[1];
    const fileName = message.match(/([A-Za-z0-9._-]+\.txt)\b/i)?.[1];
    const content = message.match(/写入\s*[“"']?([^，。！？\n]+)[”"']?/i)?.[1]?.trim();
    if (!basePath || !dirName || !fileName || !content) return undefined;

    const rootDir = basePath.replace(/\/+$/, "");
    const targetDir = `${rootDir}/${dirName}`;
    const targetFile = `${targetDir}/${fileName}`;
    const shellContent = content.replace(/'/g, `'\"'\"'`);
    const precheckCommand =
      `sh -lc '[ -d "${targetDir}" ] && echo OSA_RESULT:EXISTS:dir:${targetDir} || echo OSA_RESULT:DELETED:dir:${targetDir}; ` +
      `[ -f "${targetFile}" ] && echo OSA_RESULT:EXISTS:file:${targetFile} || echo OSA_RESULT:DELETED:file:${targetFile}'`;
    const command =
      `sh -lc '[ -d "${targetDir}" ] && echo OSA_RESULT:EXISTS:dir:${targetDir} ` +
      `|| (mkdir -p "${targetDir}" && echo OSA_RESULT:CREATED:dir:${targetDir}); ` +
      `[ -f "${targetFile}" ] && echo OSA_RESULT:EXISTS:file:${targetFile} || true; ` +
      `printf %s '${shellContent}' > "${targetFile}" ` +
      `&& echo OSA_RESULT:UPDATED:file:${targetFile} ` +
      `&& sed -n "1,40p" "${targetFile}"'`;

    const precheckOutput = mode === "ssh" ? await this.executeBySsh(precheckCommand, request) : await this.localExecutor.executeCommand(precheckCommand);
    const dirExistsBefore = precheckOutput.includes(`OSA_RESULT:EXISTS:dir:${targetDir}`);
    const fileExistsBefore = precheckOutput.includes(`OSA_RESULT:EXISTS:file:${targetFile}`);

    const gate = await this.securityGateway.evaluateCommand({
      sessionId,
      executorMode: mode,
      command,
      targetHost: request.targetHost
    });
    if (!gate.allow) {
      const reason = gate.blockedReason ?? "Blocked by security policy.";
      const precheckSummary = `预检查结果：目录 ${targetDir}${dirExistsBefore ? "已存在" : "不存在"}；文件 ${targetFile}${fileExistsBefore ? "已存在" : "不存在"}。`;
      const summary = `${precheckSummary}\n${await this.llmClient.explainSecurityBlock(command, reason)}`;
      return {
        command,
        output: "",
        naturalSummary: summary,
        blocked: true,
        reason,
        riskLevel: gate.riskLevel,
        requiresApproval: gate.requiresApproval,
        challenge: gate.challenge,
        trace
      };
    }

    const output = mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
    this.llmClient.setLastRawOutput(sessionId, output);
    this.rememberPath(sessionId, targetFile);
    const dirAction = output.includes(`OSA_RESULT:CREATED:dir:${targetDir}`) ? "已创建" : "已存在";
    const fileAction = output.includes(`OSA_RESULT:EXISTS:file:${targetFile}`) ? "已存在并更新" : "已创建并写入";
    const display = output
      .replace(/OSA_RESULT:[^\n\r]*/g, "")
      .trim();
    const summary = `已完成：目录 ${targetDir}${dirAction}，文件 ${targetFile}${fileAction}，并已查看内容。\n${targetFile} 内容：${display || content}`;
    this.llmClient.appendAssistantMessage(sessionId, summary);
    trace.push({ step: "deterministic-create-write-view", status: "ok", detail: `Created and viewed ${targetFile}` });
    return {
      command,
      output,
      naturalSummary: summary,
      blocked: false,
      riskLevel: gate.riskLevel,
      requiresApproval: false,
      trace
    };
  }

  private async handleDeterministicCreateOpsIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    if (!message) return undefined;

    const hasCreateIntent = /(创建|新建|新增|create|mkdir|touch|useradd)/i.test(message);
    if (!hasCreateIntent) return undefined;

    const hasDeleteOrRollbackIntent = /(删除|移除|回退|撤销|rollback|undo|remove|delete)/i.test(message);
    if (hasDeleteOrRollbackIntent) return undefined;

    const userMatch = message.match(/(?:创建|新建|新增)\s*(?:用户|user)\s*([a-z_][a-z0-9_-]{0,31})/i);
    if (userMatch?.[1]) {
      const username = userMatch[1];
      const command =
        `id ${username} >/dev/null 2>&1 && echo OSA_RESULT:EXISTS:user:${username} ` +
        `|| (useradd -m ${username} && echo OSA_RESULT:CREATED:user:${username})`;
      const gate = await this.securityGateway.evaluateCommand({
        sessionId,
        executorMode: mode,
        command,
        targetHost: request.targetHost
      });
      if (!gate.allow) {
        const reason = gate.blockedReason ?? "Blocked by security policy.";
        const summary = await this.llmClient.explainSecurityBlock(command, reason);
        return {
          command,
          output: "",
          naturalSummary: summary,
          blocked: true,
          reason,
          riskLevel: gate.riskLevel,
          requiresApproval: gate.requiresApproval,
          challenge: gate.challenge,
          trace
        };
      }
      const output = mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
      this.llmClient.setLastRawOutput(sessionId, output);
      const created = output.includes(`OSA_RESULT:CREATED:user:${username}`);
      if (created) {
        this.rollbackService.record({
          sessionId,
          originalCommand: command,
          executedCommand: command,
          inverseCommand: `id ${username} >/dev/null 2>&1 && userdel -r ${username} || true`,
          description: `删除用户 ${username}`
        });
      }
      const summary = created ? `用户 ${username} 已创建。` : `用户 ${username} 已存在，无需重复创建。`;
      this.llmClient.appendAssistantMessage(sessionId, summary);
      trace.push({ step: "deterministic-create-user", status: "ok", detail: `Create user ${username} (${created ? "created" : "exists"})` });
      return { command, output, naturalSummary: summary, blocked: false, riskLevel: gate.riskLevel, requiresApproval: false, trace };
    }

    const basePath = message.match(/\/[A-Za-z0-9._\-\/]+/)?.[0];
    const dirName = message.match(/(?:创建|新建)(?:一个|个)?\s*([A-Za-z0-9._-]+)\s*目录/i)?.[1];
    if (basePath && dirName && !/\.txt\b|\.log\b|文件/.test(message)) {
      const rootDir = basePath.replace(/\/+$/, "");
      const targetDir = `${rootDir}/${dirName}`;
      const command =
        `[ -d "${targetDir}" ] && echo OSA_RESULT:EXISTS:dir:${targetDir} ` +
        `|| (mkdir -p "${targetDir}" && echo OSA_RESULT:CREATED:dir:${targetDir})`;
      const gate = await this.securityGateway.evaluateCommand({
        sessionId,
        executorMode: mode,
        command,
        targetHost: request.targetHost
      });
      if (!gate.allow) {
        const reason = gate.blockedReason ?? "Blocked by security policy.";
        const summary = await this.llmClient.explainSecurityBlock(command, reason);
        return {
          command,
          output: "",
          naturalSummary: summary,
          blocked: true,
          reason,
          riskLevel: gate.riskLevel,
          requiresApproval: gate.requiresApproval,
          challenge: gate.challenge,
          trace
        };
      }
      const output = mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
      this.llmClient.setLastRawOutput(sessionId, output);
      this.rememberPath(sessionId, targetDir);
      const created = output.includes(`OSA_RESULT:CREATED:dir:${targetDir}`);
      const summary = created ? `目录 ${targetDir} 已创建。` : `目录 ${targetDir} 已存在，无需重复创建。`;
      this.llmClient.appendAssistantMessage(sessionId, summary);
      trace.push({ step: "deterministic-create-dir", status: "ok", detail: `Create dir ${targetDir} (${created ? "created" : "exists"})` });
      return { command, output, naturalSummary: summary, blocked: false, riskLevel: gate.riskLevel, requiresApproval: false, trace };
    }

    const explicitFile = message.match(/\/[A-Za-z0-9._\-\/]+\.(?:txt|log|conf|json|yaml|yml|ini|sh)\b/i)?.[0];
    if (explicitFile && /(创建|新建|文件|touch)/i.test(message)) {
      const content = message.match(/(?:写入|内容(?:为|是)?)\s*[“"']?([^，。！？\n]+)[”"']?/i)?.[1]?.trim();
      const safeContent = (content ?? "").replace(/'/g, `'\"'\"'`);
      const command = content
        ? `sh -lc '[ -f "${explicitFile}" ] && echo OSA_RESULT:EXISTS:file:${explicitFile} || true; printf %s '${safeContent}' > "${explicitFile}" && echo OSA_RESULT:UPDATED:file:${explicitFile}'`
        : `sh -lc '[ -f "${explicitFile}" ] && echo OSA_RESULT:EXISTS:file:${explicitFile} || (touch "${explicitFile}" && echo OSA_RESULT:CREATED:file:${explicitFile})'`;
      const gate = await this.securityGateway.evaluateCommand({
        sessionId,
        executorMode: mode,
        command,
        targetHost: request.targetHost
      });
      if (!gate.allow) {
        const reason = gate.blockedReason ?? "Blocked by security policy.";
        const summary = await this.llmClient.explainSecurityBlock(command, reason);
        return {
          command,
          output: "",
          naturalSummary: summary,
          blocked: true,
          reason,
          riskLevel: gate.riskLevel,
          requiresApproval: gate.requiresApproval,
          challenge: gate.challenge,
          trace
        };
      }
      const output = mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
      this.llmClient.setLastRawOutput(sessionId, output);
      this.rememberPath(sessionId, explicitFile);
      const existed = output.includes(`OSA_RESULT:EXISTS:file:${explicitFile}`);
      const summary = content
        ? `文件 ${explicitFile}${existed ? " 已存在并更新内容。" : " 已创建并写入内容。"}`
        : existed
          ? `文件 ${explicitFile} 已存在，无需重复创建。`
          : `文件 ${explicitFile} 已创建。`;
      this.llmClient.appendAssistantMessage(sessionId, summary);
      trace.push({ step: "deterministic-create-file", status: "ok", detail: `Create file ${explicitFile} (${existed ? "exists" : "created"})` });
      return { command, output, naturalSummary: summary, blocked: false, riskLevel: gate.riskLevel, requiresApproval: false, trace };
    }

    return undefined;
  }

  private async handleDeterministicFileViewIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    if (!message) {
      return undefined;
    }
    const hasMutatingIntent = /(创建|新建|写入|改为|改成|修改|删除|移动|重命名|mkdir|touch|echo\s+|写到)/i.test(message);
    if (hasMutatingIntent) {
      // Let multi-step/state-changing flows handle mixed requests like "create + write + then view".
      return undefined;
    }
    const hasViewIntent = /(查看|看下|看一眼|打开|读取|显示)/i.test(message);
    const hasFileHint = /(txt|文件|文档|内容)/i.test(message);
    if (!hasViewIntent || !hasFileHint) {
      return undefined;
    }

    const explicitPath = message.match(/\/[A-Za-z0-9._\-\/]+/)?.[0];
    const target = explicitPath ?? this.resolveImplicitPathFromContext(sessionId, message);
    if (!target) {
      return {
        command: "[FILE_VIEW_NEED_PATH]",
        output: "",
        naturalSummary: "我可以帮你查看文件内容，但这句话里没有明确路径。你可以说“查看 /tmp/test/hello.txt”。",
        blocked: false,
        trace
      };
    }

    const viewCommand = `[ -f "${target}" ] && sed -n '1,40p' "${target}" || echo OSA_RESULT:DELETED:file:${target}`;
    const output =
      mode === "ssh" ? await this.executeBySsh(viewCommand, request) : await this.localExecutor.executeCommand(viewCommand);
    const summary = output.includes("OSA_RESULT:DELETED")
      ? `文件 ${target} 不存在。`
      : `文件 ${target} 的内容是：\n${output.trim()}`;
    this.llmClient.setLastRawOutput(sessionId, output);
    this.rememberPath(sessionId, target);
    this.llmClient.appendAssistantMessage(sessionId, summary);
    trace.push({ step: "deterministic-file-view", status: "ok", detail: `Viewed file content for ${target}` });
    return {
      command: viewCommand,
      output,
      naturalSummary: summary,
      blocked: false,
      trace
    };
  }

  private async handleDeterministicFileEditIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    if (!message) {
      return undefined;
    }
    const looksLikeLogSearch =
      /(查找|搜索|检索|列出|find)/i.test(message) &&
      /(\.log|后缀|日志|log)/i.test(message) &&
      /(最近\s*24\s*小时|24h|24小时|一天内|近一天)/i.test(message);
    if (looksLikeLogSearch) {
      return undefined;
    }
    const looksLikeCreateThenViewFlow =
      /(创建|新建|mkdir|建一个|建个)/i.test(message) &&
      /(目录|文件|txt|\.txt)/i.test(message) &&
      /(写入|写成|内容为|内容是|并查看|再查看|然后查看|查看这个)/i.test(message);
    if (looksLikeCreateThenViewFlow) {
      // Let the planner/multi-step executor handle "create dir/file + write + view" in one request.
      return undefined;
    }
    const hasEditIntent = /(改为|改成|写成|改一下|修改|内容变为|内容改为|写入|覆盖)/i.test(message) && /(内容|txt|文件)/i.test(message);
    if (!hasEditIntent) {
      return undefined;
    }

    const explicitPath = message.match(/\/[A-Za-z0-9._\-\/]+/)?.[0];
    const namedFile = message.match(/([A-Za-z0-9._-]+\.txt)\b/i)?.[1] ?? message.match(/([A-Za-z0-9._-]*txt)(?=\s|$|内容|文件|文本|改为|改成|写成|写入|为)/i)?.[1];
    const mentionsFileTarget = /(\.txt\b|文件|文档|路径|\/[A-Za-z0-9._\-\/]+)/i.test(message);
    if (!mentionsFileTarget && !explicitPath && !namedFile) {
      return undefined;
    }
    const target =
      explicitPath ??
      (namedFile ? this.pickRecentExactFilePathFromSessionContext(sessionId, namedFile) : undefined) ??
      (namedFile ? this.pickPathByFileNameFromSessionContext(sessionId, namedFile) : undefined) ??
      (namedFile ? this.inferPathBySiblingFromSessionContext(sessionId, namedFile) : undefined);

    if (!target) {
      return {
        command: "[FILE_EDIT_NEED_PATH]",
        output: "",
        naturalSummary: "我可以帮你改文件内容，但这句话里没有明确目标文件。你可以说“把 /root/666/999txt 内容改为 okk”。",
        blocked: false,
        trace
      };
    }

    const contentMatch =
      message.match(/内容(?:改为|改成|写成|写为|写上|为|变为)\s*[“"']?(.+?)[”"']?\s*$/i) ??
      message.match(/改为\s*[“"']?(.+?)[”"']?\s*$/i) ??
      message.match(/写成\s*[“"']?(.+?)[”"']?\s*$/i);
    const newContent = contentMatch?.[1]?.trim().replace(/[。！!；;]$/, "");
    if (!newContent) {
      return {
        command: "[FILE_EDIT_NEED_CONTENT]",
        output: "",
        naturalSummary: `我找到了目标文件 ${target}，但没有识别到要写入的新内容。你可以说“把 ${target} 内容改为 okk”。`,
        blocked: false,
        trace
      };
    }

    const safeName = target.replace(/[\/\\:]/g, "_");
    const backupName = `${sessionId}_${Date.now()}_det_${safeName}`;
    const backupPath = `${Orchestrator.BACKUP_DIR}/${backupName}`;
    const shellContent = newContent.replace(/'/g, `'\"'\"'`);
    const command =
      `sh -lc '[ -e "${target}" ] ` +
      `&& (mkdir -p "${Orchestrator.BACKUP_DIR}" && cp -p "${target}" "${backupPath}" ` +
      `&& printf %s '${shellContent}' > "${target}" ` +
      `&& echo OSA_RESULT:UPDATED:backup:${target}:${backupPath} ` +
      `&& echo OSA_RESULT:UPDATED:file:${target}) ` +
      `|| (printf %s '${shellContent}' > "${target}" && echo OSA_RESULT:CREATED:file:${target})'`;

    let commandForRiskEvaluation = command;
    const exists = await this.checkPathExists(mode, request, target);
    if (exists) {
      commandForRiskEvaluation = `${command} # OSA_OVERWRITE_EXISTS:${target}`;
    }
    const gate = await this.securityGateway.evaluateCommand({
      sessionId,
      executorMode: mode,
      command: commandForRiskEvaluation,
      targetHost: request.targetHost
    });
    if (!gate.allow) {
      const reason = gate.blockedReason ?? "Blocked by security policy.";
      const summary = await this.llmClient.explainSecurityBlock(command, reason);
      return {
        command: commandForRiskEvaluation,
        output: "",
        naturalSummary: summary,
        blocked: true,
        reason,
        riskLevel: gate.riskLevel,
        requiresApproval: gate.requiresApproval,
        challenge: gate.challenge,
        trace
      };
    }

    const output = mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
    this.llmClient.setLastRawOutput(sessionId, output);
    this.rememberPath(sessionId, target);

    const derivedRollback = this.deriveRollbackFromMarkers(sessionId, command, command, output);
    if (derivedRollback && this.shouldRecordRollback(derivedRollback, output)) {
      this.rollbackService.record({
        sessionId,
        originalCommand: command,
        executedCommand: command,
        inverseCommand: derivedRollback.inverseCommand,
        description: derivedRollback.description
      });
    }

    const summary = output.includes("OSA_RESULT:UPDATED:file:")
      ? `文件 ${target} 已更新为“${newContent}”。修改前已自动备份，可回退。`
      : `已创建并写入文件 ${target}，内容为“${newContent}”。`;
    this.llmClient.appendAssistantMessage(sessionId, summary);
    trace.push({ step: "deterministic-file-edit", status: "ok", detail: `Updated content for ${target}` });
    await this.securityGateway.logExecution(sessionId, commandForRiskEvaluation, "Deterministic file content edit executed.");
    return {
      command: commandForRiskEvaluation,
      output,
      naturalSummary: summary,
      blocked: false,
      riskLevel: gate.riskLevel,
      requiresApproval: false,
      trace
    };
  }

  private async handleDeterministicRecentFileFollowupIntent(params: {
    sessionId: string;
    mode: "local" | "ssh";
    request: OrchestratorRequest;
    trace: OrchestratorResult["trace"];
  }): Promise<OrchestratorResult | undefined> {
    const { sessionId, mode, request, trace } = params;
    const message = request.userMessage.trim();
    if (!message) return undefined;
    const looksLikeContentFollowup = /(不是.+吗|不应该是|怎么还是|内容不是|不是okk吗|不是ok吗)/i.test(message);
    if (!looksLikeContentFollowup) return undefined;

    const target = this.pickPathFromSessionContext(sessionId, "查看这个txt");
    if (!target || !/\.[A-Za-z0-9._-]+$/i.test(target)) {
      return undefined;
    }

    const command = `[ -f "${target}" ] && sed -n '1,40p' "${target}" || echo OSA_RESULT:DELETED:file:${target}`;
    const output = mode === "ssh" ? await this.executeBySsh(command, request) : await this.localExecutor.executeCommand(command);
    this.llmClient.setLastRawOutput(sessionId, output);
    this.rememberPath(sessionId, target);

    const summary = output.includes("OSA_RESULT:DELETED")
      ? `文件 ${target} 不存在，所以当前看不到你刚才说的内容。`
      : `我重新看了一下，文件 ${target} 当前内容是：\n${output.trim()}`;
    this.llmClient.appendAssistantMessage(sessionId, summary);
    trace.push({ step: "deterministic-file-followup", status: "ok", detail: `Re-checked file content for ${target}` });
    return { command, output, naturalSummary: summary, blocked: false, trace };
  }

  private handleRollbackListIntent(sessionId: string, trace: OrchestratorResult["trace"]): OrchestratorResult {
    const tasks = this.rollbackService.list(sessionId);
    if (tasks.length === 0) {
      return {
        command: "[ROLLBACK_LIST]",
        output: "",
        naturalSummary: "当前会话没有可回退操作（可能记录已过期）。",
        blocked: false,
        trace
      };
    }
    const lines = tasks.slice(0, 10).map((task, idx) => {
      const originalOp = this.describeOriginalOperation(task.originalCommand);
      return `${idx + 1}. 回退动作：${this.describeRollbackAction(task)}（对应原操作：${originalOp}）`;
    });
    return {
      command: "[ROLLBACK_LIST]",
      output: "",
      naturalSummary: `当前可回退操作如下（这里展示的是“撤销动作”，不是原动作）：\n${lines.join("\n")}\n\n如需撤销最近一步，直接说“撤销刚才操作”。也可以说“撤销第2条”。`,
      blocked: false,
      trace
    };
  }

  private buildMemoryHealthSummary(output: string): string {
    const lines = (output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const memLine = lines.find((line) => /^mem:\s+/i.test(line));
    const topMarkerIndex = lines.findIndex((line) => line === "---TOP_MEM---");
    const procLines = topMarkerIndex >= 0 ? lines.slice(topMarkerIndex + 1) : [];

    let memOverview = "已获取内存信息。";
    if (memLine) {
      const parts = memLine.split(/\s+/);
      const totalMb = Number(parts[1] ?? "0");
      const usedMb = Number(parts[2] ?? "0");
      const freeMb = Number(parts[3] ?? "0");
      const usedPct = totalMb > 0 ? ((usedMb / totalMb) * 100).toFixed(1) : "0.0";
      memOverview = `当前内存：总计 ${totalMb}MB，已用 ${usedMb}MB（${usedPct}%），可用约 ${freeMb}MB。`;
    }

    const procRows = procLines
      .map((line) => {
        const match = line.match(/^(\d+)\s+(\S+)\s+([0-9.]+)\s+(\d+)\s+(\S+)\s+(.+)$/);
        if (!match) return undefined;
        return {
          pid: match[1],
          comm: match[2],
          memPct: Number(match[3]),
          rssKb: Number(match[4]),
          etime: match[5],
          args: match[6]
        };
      })
      .filter((item): item is { pid: string; comm: string; memPct: number; rssKb: number; etime: string; args: string } => Boolean(item));

    const abnormal = procRows.filter((row) => row.memPct >= 20);
    if (abnormal.length === 0) {
      const top = procRows.slice(0, 3).map((row) => `${row.comm}(PID ${row.pid}, ${row.memPct}%)`).join("、");
      return `${memOverview}\n未发现内存占用过高的异常进程（阈值：单进程 >=20%）。${top ? `当前占用较高进程：${top}。` : ""}`;
    }

    const details = abnormal
      .map((row) => `- PID ${row.pid} | 进程 ${row.comm} | 内存 ${row.memPct}% | RSS ${row.rssKb}KB | 运行时长 ${row.etime} | 命令 ${row.args}`)
      .join("\n");
    return `${memOverview}\n发现 ${abnormal.length} 个内存占用过高的异常进程（阈值：单进程 >=20%）：\n${details}`;
  }

  private buildCpuPortFactSummary(output: string): string {
    const lines = (output || "").split(/\r?\n/);
    const markerIndex = lines.findIndex((line) => line.trim() === "--- LISTENING PORTS ---");
    const cpuLines = (markerIndex >= 0 ? lines.slice(0, markerIndex) : lines)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(1, 4);
    const portLinesRaw = (markerIndex >= 0 ? lines.slice(markerIndex + 1) : [])
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const listening = portLinesRaw.filter((line) => /\bLISTEN\b/i.test(line));

    const cpuItems = cpuLines.map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length < 11) return undefined;
      const pid = parts[1];
      const cpu = parts[2];
      const cmd = parts[10];
      return `${cmd}(PID ${pid}, CPU ${cpu}%)`;
    }).filter((x): x is string => Boolean(x));

    const ports = listening
      .map((line) => {
        const m = line.match(/[:.]([0-9]{2,5})\s+/);
        return m?.[1];
      })
      .filter((p): p is string => Boolean(p));
    const uniquePorts = [...new Set(ports)];

    const topSimple = cpuItems
      .map((item) => item.split("(PID")[0]?.trim())
      .filter(Boolean)
      .slice(0, 3);
    const cpuPartSimple =
      topSimple.length > 0
        ? `当前最占 CPU 的 3 个程序是：${topSimple.join("、")}。`
        : "已检查 CPU，但这次没有成功识别到前 3 个进程名称。";
    const portPartSimple =
      uniquePorts.length > 0
        ? `当前有 ${uniquePorts.length} 个端口正在监听（例如：${uniquePorts.slice(0, 8).join("、")}）。`
        : "已检查端口，但这次没有解析到监听端口信息。";

    const detailCpu = cpuItems.length > 0 ? `CPU 详细：${cpuItems.join("、")}。` : "";
    const detailPorts = uniquePorts.length > 0 ? `端口明细（节选）：${uniquePorts.slice(0, 20).join("、")}。` : "";
    return `${cpuPartSimple}\n${portPartSimple}\n${[detailCpu, detailPorts].filter(Boolean).join("\n")}\n注：以上是客观检查结果，没有对端口用途做主观判断。`;
  }

  private handleRollbackPreviewIntent(sessionId: string, trace: OrchestratorResult["trace"]): OrchestratorResult {
    const task = this.rollbackService.peekLast(sessionId);
    if (!task) {
      return {
        command: "[ROLLBACK_PREVIEW]",
        output: "",
        naturalSummary: "当前没有可预览的最近回退项。",
        blocked: false,
        trace
      };
    }
    const originalOp = this.describeOriginalOperation(task.originalCommand);
    return {
      command: "[ROLLBACK_PREVIEW]",
      output: "",
      naturalSummary: `最近可回退动作：${this.describeRollbackAction(task)}（对应原操作：${originalOp}）。\n如果确认撤销，请回复“撤销刚才操作”。`,
      blocked: false,
      trace
    };
  }

  private describeOriginalOperation(originalCommand: string): string {
    const cmd = (originalCommand || "").trim();
    if (!cmd) return "未知操作";
    if (/HELLO_WEB_START|http\.server|\/raw/.test(cmd)) return "启动临时 Web 服务";
    const createUser = cmd.match(/useradd(?:\s+-m)?\s+([A-Za-z0-9._-]+)/);
    if (createUser?.[1]) return `创建用户 ${createUser[1]}`;
    const deleteUser = cmd.match(/userdel(?:\s+-r)?\s+([A-Za-z0-9._-]+)/);
    if (deleteUser?.[1]) return `删除用户 ${deleteUser[1]}`;
    const mkdir = cmd.match(/mkdir(?:\s+-p)?\s+"?([^"\s]+)"?/);
    if (mkdir?.[1]) return `创建目录 ${mkdir[1]}`;
    const fileWrite = cmd.match(/printf\s+%s.*>\s+"?([^"\s]+)"?/);
    if (fileWrite?.[1]) return `写入文件 ${fileWrite[1]}`;
    return cmd.length > 60 ? `${cmd.slice(0, 57)}...` : cmd;
  }

  private describeRollbackAction(task: { description: string; inverseCommand: string }): string {
    const inverse = (task.inverseCommand || "").trim();
    if (!inverse) return task.description;
    const userAdd = inverse.match(/useradd(?:\s+-m)?\s+([A-Za-z0-9._-]+)/);
    if (userAdd?.[1]) return `创建用户 ${userAdd[1]}（可恢复账号主体）`;
    const userDel = inverse.match(/userdel(?:\s+-r)?\s+([A-Za-z0-9._-]+)/);
    if (userDel?.[1]) return `删除用户 ${userDel[1]}`;
    const mkdir = inverse.match(/mkdir(?:\s+-p)?\s+"?([^"\s]+)"?/);
    if (mkdir?.[1]) return `创建目录 ${mkdir[1]}`;
    const rmdir = inverse.match(/rmdir\s+"?([^"\s]+)"?/);
    if (rmdir?.[1]) return `删除目录 ${rmdir[1]}`;
    const rmFile = inverse.match(/rm\s+-f\s+"?([^"\s]+)"?/);
    if (rmFile?.[1]) return `删除文件 ${rmFile[1]}`;
    return task.description;
  }

  private prepareRollbackAwareCommand(
    sessionId: string,
    command: string,
    stepIndex: number
  ): {
    commandToRun: string;
    rollbackInverse?: string;
    rollbackDescription?: string;
    recordWhenOutputIncludes?: string;
    userFacingStep?: string;
    riskOnExistingPath?: string;
  } {
    const trimmed = command.trim();

    // File overwrite/copy into destination: snapshot destination first if exists.
    const cpMatch = trimmed.match(/^cp(?:\s+-[^\s]+)*\s+([^\s]+)\s+([^\s]+)$/);
    if (cpMatch?.[1] && cpMatch?.[2]) {
      const src = cpMatch[1];
      const dst = cpMatch[2];
      const safeName = dst.replace(/[\/\\:]/g, "_");
      const backupName = `${sessionId}_${Date.now()}_${stepIndex}_${safeName}`;
      const backupPath = `${Orchestrator.BACKUP_DIR}/${backupName}`;
      return {
        commandToRun: `[ -e "${dst}" ] && (mkdir -p "${Orchestrator.BACKUP_DIR}" && cp -p "${dst}" "${backupPath}" && echo OSA_RESULT:UPDATED:backup:${dst}:${backupPath}; ${trimmed} && echo OSA_RESULT:UPDATED:file:${dst}) || (${trimmed} && echo OSA_RESULT:CREATED:file:${dst})`,
        rollbackInverse: `[ -e "${backupPath}" ] && cp -p "${backupPath}" "${dst}" || true`,
        rollbackDescription: `覆盖文件 ${dst}（已做备份，可回退）`,
        userFacingStep: `更新文件 ${dst}`,
        riskOnExistingPath: dst
      };
    }

    // tee writes: snapshot destination first (only simple `tee file` pattern).
    const teeMatch = trimmed.match(/^tee\s+([^\s]+)$/);
    if (teeMatch?.[1]) {
      const dst = teeMatch[1];
      const safeName = dst.replace(/[\/\\:]/g, "_");
      const backupName = `${sessionId}_${Date.now()}_${stepIndex}_${safeName}`;
      const backupPath = `${Orchestrator.BACKUP_DIR}/${backupName}`;
      return {
        commandToRun: `[ -e "${dst}" ] && (mkdir -p "${Orchestrator.BACKUP_DIR}" && cp -p "${dst}" "${backupPath}" && echo OSA_RESULT:UPDATED:backup:${dst}:${backupPath}; ${trimmed} && echo OSA_RESULT:UPDATED:file:${dst}) || (${trimmed} && echo OSA_RESULT:CREATED:file:${dst})`,
        rollbackInverse: `[ -e "${backupPath}" ] && cp -p "${backupPath}" "${dst}" || true`,
        rollbackDescription: `写入文件 ${dst}（已做备份，可回退）`,
        userFacingStep: `写入文件 ${dst}`,
        riskOnExistingPath: dst
      };
    }

    // shell redirection `> file`: wrap into `sh -lc` so we can snapshot then write.
    const redirectMatch = trimmed.match(/^(.*)\s+>\s*([^\s]+)\s*$/);
    if (redirectMatch?.[1] && redirectMatch?.[2] && !trimmed.startsWith("sh ")) {
      const left = redirectMatch[1];
      const dst = redirectMatch[2];
      const safeName = dst.replace(/[\/\\:]/g, "_");
      const backupName = `${sessionId}_${Date.now()}_${stepIndex}_${safeName}`;
      const backupPath = `${Orchestrator.BACKUP_DIR}/${backupName}`;
      const escaped = trimmed.replace(/"/g, '\\"');
      return {
        commandToRun: `sh -lc '[ -e "${dst}" ] && (mkdir -p "${Orchestrator.BACKUP_DIR}" && cp -p "${dst}" "${backupPath}" && echo OSA_RESULT:UPDATED:backup:${dst}:${backupPath}; ${escaped} && echo OSA_RESULT:UPDATED:file:${dst}) || (${escaped} && echo OSA_RESULT:CREATED:file:${dst})'`,
        rollbackInverse: `[ -e "${backupPath}" ] && cp -p "${backupPath}" "${dst}" || true`,
        rollbackDescription: `写入文件 ${dst}（已做备份，可回退）`,
        userFacingStep: `写入文件 ${dst}`,
        riskOnExistingPath: dst
      };
    }

    // File in-place edits: snapshot backup then apply change.
    const sedInPlaceMatch = trimmed.match(/^sed\s+-i\b[\s\S]*\s+([^\s]+)$/);
    if (sedInPlaceMatch?.[1] && !sedInPlaceMatch[1].startsWith("-")) {
      const target = sedInPlaceMatch[1];
      const safeName = target.replace(/[\/\\:]/g, "_");
      const backupName = `${sessionId}_${Date.now()}_${stepIndex}_${safeName}`;
      const backupPath = `${Orchestrator.BACKUP_DIR}/${backupName}`;
      return {
        commandToRun: `[ -f "${target}" ] && mkdir -p "${Orchestrator.BACKUP_DIR}" && cp -p "${target}" "${backupPath}" && ${trimmed} && echo OSA_RESULT:UPDATED:file:${target} || echo OSA_RESULT:SKIPPED:file:${target}`,
        rollbackInverse: `[ -f "${backupPath}" ] && cp -p "${backupPath}" "${target}" && echo OSA_RESULT:UPDATED:file:${target} || true`,
        rollbackDescription: `修改文件 ${target}（已做备份，可回退）`,
        recordWhenOutputIncludes: `OSA_RESULT:UPDATED:file:${target}`,
        userFacingStep: `修改文件 ${target}`
      };
    }

    const chmodMatch = trimmed.match(/^chmod\s+([0-7]{3,4})\s+([^\s]+)$/);
    if (chmodMatch?.[1] && chmodMatch?.[2]) {
      const mode = chmodMatch[1];
      const target = chmodMatch[2];
      return {
        commandToRun: `[ -e "${target}" ] && old=$(stat -c %a "${target}" 2>/dev/null) && chmod ${mode} "${target}" && echo OSA_RESULT:UPDATED:perm:${target}:$old || echo OSA_RESULT:SKIPPED:perm:${target}`,
        rollbackDescription: `调整权限 ${target}（可回退）`,
        recordWhenOutputIncludes: `OSA_RESULT:UPDATED:perm:${target}`,
        userFacingStep: `调整权限 ${target}`
      };
    }

    const userAddMatch = trimmed.match(/^useradd\s+(.*\s+)?([A-Za-z0-9._-]+)$/);
    if (userAddMatch?.[2] && !trimmed.includes("|") && !trimmed.includes(">")) {
      const user = userAddMatch[2];
      const fullCmd = trimmed;
      return {
        commandToRun: `id ${user} >/dev/null 2>&1 && echo OSA_RESULT:EXISTS:user:${user} || (${fullCmd} && echo OSA_RESULT:CREATED:user:${user})`,
        rollbackInverse: `id ${user} >/dev/null 2>&1 && userdel -r ${user} || true`,
        rollbackDescription: `删除用户 ${user}`,
        recordWhenOutputIncludes: `OSA_RESULT:CREATED:user:${user}`,
        userFacingStep: `创建用户 ${user}`
      };
    }

    const userDelMatch = trimmed.match(/^userdel(?:\s+-r)?\s+([A-Za-z0-9._-]+)$/);
    if (userDelMatch?.[1]) {
      const user = userDelMatch[1];
      const withHome = /\s-r\s+/.test(` ${trimmed} `) || trimmed.includes("userdel -r");
      return {
        commandToRun: `id ${user} >/dev/null 2>&1 && (userdel ${withHome ? "-r " : ""}${user} && echo OSA_RESULT:UPDATED:user:${user}:deleted) || echo OSA_RESULT:SKIPPED:user:${user}`,
        rollbackInverse: `id ${user} >/dev/null 2>&1 || (useradd -m ${user} && echo OSA_RESULT:CREATED:user:${user}:restored) || true`,
        rollbackDescription: `创建用户 ${user}（可恢复账号主体）`,
        recordWhenOutputIncludes: `OSA_RESULT:UPDATED:user:${user}:deleted`,
        userFacingStep: `删除用户 ${user}`
      };
    }

    const mkdirMatch = trimmed.match(/^mkdir(?:\s+-p)?\s+([^\s]+)$/);
    if (mkdirMatch?.[1]) {
      const dir = mkdirMatch[1];
      return {
        commandToRun: `[ -d "${dir}" ] && echo OSA_RESULT:EXISTS:dir:${dir} || (mkdir -p "${dir}" && echo OSA_RESULT:CREATED:dir:${dir})`,
        rollbackInverse: `[ -d "${dir}" ] && rmdir "${dir}" || true`,
        rollbackDescription: `创建目录 ${dir}`,
        recordWhenOutputIncludes: `OSA_RESULT:CREATED:dir:${dir}`,
        userFacingStep: `创建目录 ${dir}`
      };
    }

    const touchMatch = trimmed.match(/^touch\s+([^\s]+)$/);
    if (touchMatch?.[1]) {
      const file = touchMatch[1];
      return {
        commandToRun: `[ -f "${file}" ] && echo OSA_RESULT:EXISTS:file:${file} || (touch "${file}" && echo OSA_RESULT:CREATED:file:${file})`,
        rollbackInverse: `[ -f "${file}" ] && rm -f "${file}" || true`,
        rollbackDescription: `创建文件 ${file}`,
        recordWhenOutputIncludes: `OSA_RESULT:CREATED:file:${file}`,
        userFacingStep: `创建文件 ${file}`
      };
    }

    const mvMatch = trimmed.match(/^mv\s+([^\s]+)\s+([^\s]+)$/);
    if (mvMatch?.[1] && mvMatch?.[2]) {
      const src = mvMatch[1];
      const dst = mvMatch[2];
      const safeDst = dst.replace(/[\/\\:]/g, "_");
      const trashName = `${sessionId}_${Date.now()}_${stepIndex}_${safeDst}`;
      const trashPath = `${Orchestrator.TRASH_DIR}/${trashName}`;
      return {
        commandToRun: `[ -e "${src}" ] && ( [ -e "${dst}" ] && mkdir -p "${Orchestrator.TRASH_DIR}" && mv "${dst}" "${trashPath}" && echo OSA_RESULT:UPDATED:trash:${dst}:${trashPath} ; true ) && mv "${src}" "${dst}" && echo OSA_RESULT:UPDATED:move:${src}=>${dst} || echo OSA_RESULT:SKIPPED:move:${src}`,
        rollbackInverse: `[ -e "${dst}" ] && mv "${dst}" "${src}" && ( [ -e "${trashPath}" ] && mv "${trashPath}" "${dst}" ; true ) || true`,
        rollbackDescription: `移动/改名 ${src} -> ${dst}（目标冲突已备份）`,
        recordWhenOutputIncludes: `OSA_RESULT:UPDATED:move:${src}=>${dst}`,
        userFacingStep: `移动/改名 ${src} -> ${dst}`
      };
    }

    const systemctlStartMatch = trimmed.match(/^(?:sudo\s+)?systemctl\s+start\s+([A-Za-z0-9@._-]+)\s*$/);
    if (systemctlStartMatch?.[1]) {
      const svc = systemctlStartMatch[1];
      return {
        commandToRun: `systemctl is-active --quiet ${svc} && echo OSA_RESULT:EXISTS:svc:${svc} || (systemctl start ${svc} && echo OSA_RESULT:STARTED:svc:${svc})`,
        rollbackInverse: `systemctl stop ${svc} || true`,
        rollbackDescription: `启动服务 ${svc}`,
        recordWhenOutputIncludes: `OSA_RESULT:STARTED:svc:${svc}`,
        userFacingStep: `启动服务 ${svc}`
      };
    }

    const systemctlRestartMatch = trimmed.match(/^(?:sudo\s+)?systemctl\s+restart\s+([A-Za-z0-9@._-]+)\s*$/);
    if (systemctlRestartMatch?.[1]) {
      const svc = systemctlRestartMatch[1];
      // Restart is not strictly reversible. We still record a best-effort "restart again" action for quick recovery.
      return {
        commandToRun: `systemctl restart ${svc} && echo OSA_RESULT:RESTARTED:svc:${svc}`,
        rollbackInverse: `systemctl restart ${svc} || true`,
        rollbackDescription: `重启服务 ${svc}（不可严格回退）`,
        recordWhenOutputIncludes: `OSA_RESULT:RESTARTED:svc:${svc}`,
        userFacingStep: `重启服务 ${svc}`
      };
    }

    const systemctlStopMatch = trimmed.match(/^(?:sudo\s+)?systemctl\s+stop\s+([A-Za-z0-9@._-]+)\s*$/);
    if (systemctlStopMatch?.[1]) {
      const svc = systemctlStopMatch[1];
      return {
        commandToRun: `systemctl is-active --quiet ${svc} && (systemctl stop ${svc} && echo OSA_RESULT:UPDATED:svc:${svc}:stopped) || echo OSA_RESULT:SKIPPED:svc:${svc}`,
        rollbackInverse: `systemctl start ${svc} || true`,
        rollbackDescription: `停止服务 ${svc}`,
        recordWhenOutputIncludes: `OSA_RESULT:UPDATED:svc:${svc}:stopped`,
        userFacingStep: `停止服务 ${svc}`
      };
    }

    const systemctlEnableMatch = trimmed.match(/^(?:sudo\s+)?systemctl\s+enable\s+([A-Za-z0-9@._-]+)\s*$/);
    if (systemctlEnableMatch?.[1]) {
      const svc = systemctlEnableMatch[1];
      return {
        commandToRun: `systemctl is-enabled --quiet ${svc} && echo OSA_RESULT:EXISTS:svc:${svc}:enabled || (systemctl enable ${svc} && echo OSA_RESULT:UPDATED:svc:${svc}:enabled)`,
        rollbackInverse: `systemctl disable ${svc} || true`,
        rollbackDescription: `设置服务 ${svc} 开机自启`,
        recordWhenOutputIncludes: `OSA_RESULT:UPDATED:svc:${svc}:enabled`,
        userFacingStep: `设置服务 ${svc} 开机自启`
      };
    }

    const systemctlDisableMatch = trimmed.match(/^(?:sudo\s+)?systemctl\s+disable\s+([A-Za-z0-9@._-]+)\s*$/);
    if (systemctlDisableMatch?.[1]) {
      const svc = systemctlDisableMatch[1];
      return {
        commandToRun: `systemctl is-enabled --quiet ${svc} && (systemctl disable ${svc} && echo OSA_RESULT:UPDATED:svc:${svc}:disabled) || echo OSA_RESULT:SKIPPED:svc:${svc}:disabled`,
        rollbackInverse: `systemctl enable ${svc} || true`,
        rollbackDescription: `取消服务 ${svc} 开机自启`,
        recordWhenOutputIncludes: `OSA_RESULT:UPDATED:svc:${svc}:disabled`,
        userFacingStep: `取消服务 ${svc} 开机自启`
      };
    }

    const dnfInstallMatch = trimmed.match(/^(dnf|yum)\s+install\s+(?:-y\s+)?([A-Za-z0-9._+-]+)$/);
    if (dnfInstallMatch?.[1] && dnfInstallMatch?.[2]) {
      const pkgMgr = dnfInstallMatch[1];
      const pkg = dnfInstallMatch[2];
      return {
        commandToRun: `rpm -q ${pkg} >/dev/null 2>&1 && echo OSA_RESULT:EXISTS:pkg:${pkg} || (${pkgMgr} install -y ${pkg} && echo OSA_RESULT:INSTALLED:pkg:${pkg})`,
        rollbackInverse: `${pkgMgr} remove -y ${pkg} || true`,
        rollbackDescription: `安装软件包 ${pkg}`,
        recordWhenOutputIncludes: `OSA_RESULT:INSTALLED:pkg:${pkg}`,
        userFacingStep: `安装软件包 ${pkg}`
      };
    }

    const dnfRemoveMatch = trimmed.match(/^(dnf|yum)\s+remove\s+(?:-y\s+)?([A-Za-z0-9._+-]+)$/);
    if (dnfRemoveMatch?.[1] && dnfRemoveMatch?.[2]) {
      const pkgMgr = dnfRemoveMatch[1];
      const pkg = dnfRemoveMatch[2];
      return {
        commandToRun: `rpm -q ${pkg} >/dev/null 2>&1 && (${pkgMgr} remove -y ${pkg} && echo OSA_RESULT:UPDATED:pkg:${pkg}:removed) || echo OSA_RESULT:SKIPPED:pkg:${pkg}`,
        rollbackInverse: `${pkgMgr} install -y ${pkg} || true`,
        rollbackDescription: `卸载软件包 ${pkg}`,
        recordWhenOutputIncludes: `OSA_RESULT:UPDATED:pkg:${pkg}:removed`,
        userFacingStep: `卸载软件包 ${pkg}`
      };
    }

    const aptInstallMatch = trimmed.match(/^(apt|apt-get)\s+install\s+(?:-y\s+)?([A-Za-z0-9._+-]+)$/);
    if (aptInstallMatch?.[1] && aptInstallMatch?.[2]) {
      const pkgMgr = aptInstallMatch[1];
      const pkg = aptInstallMatch[2];
      return {
        commandToRun: `dpkg -s ${pkg} >/dev/null 2>&1 && echo OSA_RESULT:EXISTS:pkg:${pkg} || (${pkgMgr} install -y ${pkg} && echo OSA_RESULT:INSTALLED:pkg:${pkg})`,
        rollbackInverse: `${pkgMgr} remove -y ${pkg} || true`,
        rollbackDescription: `安装软件包 ${pkg}`,
        recordWhenOutputIncludes: `OSA_RESULT:INSTALLED:pkg:${pkg}`,
        userFacingStep: `安装软件包 ${pkg}`
      };
    }

    const aptRemoveMatch = trimmed.match(/^(apt|apt-get)\s+remove\s+(?:-y\s+)?([A-Za-z0-9._+-]+)$/);
    if (aptRemoveMatch?.[1] && aptRemoveMatch?.[2]) {
      const pkgMgr = aptRemoveMatch[1];
      const pkg = aptRemoveMatch[2];
      return {
        commandToRun: `dpkg -s ${pkg} >/dev/null 2>&1 && (${pkgMgr} remove -y ${pkg} && echo OSA_RESULT:UPDATED:pkg:${pkg}:removed) || echo OSA_RESULT:SKIPPED:pkg:${pkg}`,
        rollbackInverse: `${pkgMgr} install -y ${pkg} || true`,
        rollbackDescription: `卸载软件包 ${pkg}`,
        recordWhenOutputIncludes: `OSA_RESULT:UPDATED:pkg:${pkg}:removed`,
        userFacingStep: `卸载软件包 ${pkg}`
      };
    }

    const groupAddMatch = trimmed.match(/^groupadd\s+([A-Za-z0-9._-]+)$/);
    if (groupAddMatch?.[1]) {
      const group = groupAddMatch[1];
      return {
        commandToRun: `getent group ${group} >/dev/null 2>&1 && echo OSA_RESULT:EXISTS:group:${group} || (groupadd ${group} && echo OSA_RESULT:CREATED:group:${group})`,
        rollbackInverse: `getent group ${group} >/dev/null 2>&1 && groupdel ${group} || true`,
        rollbackDescription: `创建用户组 ${group}`,
        recordWhenOutputIncludes: `OSA_RESULT:CREATED:group:${group}`,
        userFacingStep: `创建用户组 ${group}`
      };
    }

    const groupDelMatch = trimmed.match(/^groupdel\s+([A-Za-z0-9._-]+)$/);
    if (groupDelMatch?.[1]) {
      const group = groupDelMatch[1];
      return {
        commandToRun: `getent group ${group} >/dev/null 2>&1 && (groupdel ${group} && echo OSA_RESULT:UPDATED:group:${group}:deleted) || echo OSA_RESULT:SKIPPED:group:${group}`,
        rollbackDescription: `删除用户组 ${group}`,
        recordWhenOutputIncludes: `OSA_RESULT:UPDATED:group:${group}:deleted`,
        userFacingStep: `删除用户组 ${group}`
      };
    }

    // Add user to supplemental group (reversible).
    const usermodAddGroupMatch = trimmed.match(/^usermod\s+-aG\s+([A-Za-z0-9._-]+)\s+([A-Za-z0-9._-]+)$/);
    if (usermodAddGroupMatch?.[1] && usermodAddGroupMatch?.[2]) {
      const group = usermodAddGroupMatch[1];
      const user = usermodAddGroupMatch[2];
      return {
        commandToRun: `id ${user} >/dev/null 2>&1 && (id -nG ${user} | tr " " "\\n" | grep -qx ${group} && echo OSA_RESULT:EXISTS:groupmember:${user}:${group} || (usermod -aG ${group} ${user} && echo OSA_RESULT:UPDATED:groupmember:${user}:${group})) || echo OSA_RESULT:SKIPPED:user:${user}`,
        rollbackInverse: `id ${user} >/dev/null 2>&1 && gpasswd -d ${user} ${group} >/dev/null 2>&1 || true`,
        rollbackDescription: `将用户 ${user} 加入用户组 ${group}`,
        recordWhenOutputIncludes: `OSA_RESULT:UPDATED:groupmember:${user}:${group}`,
        userFacingStep: `把用户 ${user} 加入用户组 ${group}`
      };
    }

    // Change password (not strictly reversible): keep idempotent guard + marker for audit.
    const passwdMatch = trimmed.match(/^passwd\s+([A-Za-z0-9._-]+)$/);
    if (passwdMatch?.[1]) {
      const user = passwdMatch[1];
      return {
        commandToRun: `id ${user} >/dev/null 2>&1 && (passwd ${user} && echo OSA_RESULT:UPDATED:passwd:${user}) || echo OSA_RESULT:SKIPPED:user:${user}`,
        rollbackDescription: `修改用户 ${user} 密码（不可严格回退）`,
        recordWhenOutputIncludes: `OSA_RESULT:UPDATED:passwd:${user}`,
        userFacingStep: `修改用户 ${user} 密码`
      };
    }

    // Account aging policy (not strictly reversible): record marker for audit.
    const chageMatch = trimmed.match(/^chage\s+(.+)\s+([A-Za-z0-9._-]+)$/);
    if (chageMatch?.[1] && chageMatch?.[2]) {
      const args = chageMatch[1].trim();
      const user = chageMatch[2];
      return {
        commandToRun: `id ${user} >/dev/null 2>&1 && (chage ${args} ${user} && echo OSA_RESULT:UPDATED:chage:${user}) || echo OSA_RESULT:SKIPPED:user:${user}`,
        rollbackDescription: `修改用户 ${user} 密码策略（不可严格回退）`,
        recordWhenOutputIncludes: `OSA_RESULT:UPDATED:chage:${user}`,
        userFacingStep: `修改用户 ${user} 密码策略`
      };
    }

    const usermodLockMatch = trimmed.match(/^usermod\s+-L\s+([A-Za-z0-9._-]+)$/);
    if (usermodLockMatch?.[1]) {
      const user = usermodLockMatch[1];
      return {
        commandToRun: `id ${user} >/dev/null 2>&1 && (passwd -S ${user} 2>/dev/null | awk '{print $2}' | grep -qx L && echo OSA_RESULT:EXISTS:user:${user}:locked || (usermod -L ${user} && echo OSA_RESULT:UPDATED:user:${user}:locked)) || echo OSA_RESULT:SKIPPED:user:${user}`,
        rollbackInverse: `id ${user} >/dev/null 2>&1 && usermod -U ${user} >/dev/null 2>&1 || true`,
        rollbackDescription: `锁定用户 ${user} 登录`,
        recordWhenOutputIncludes: `OSA_RESULT:UPDATED:user:${user}:locked`,
        userFacingStep: `锁定用户 ${user}`
      };
    }

    const usermodUnlockMatch = trimmed.match(/^usermod\s+-U\s+([A-Za-z0-9._-]+)$/);
    if (usermodUnlockMatch?.[1]) {
      const user = usermodUnlockMatch[1];
      return {
        commandToRun: `id ${user} >/dev/null 2>&1 && (passwd -S ${user} 2>/dev/null | awk '{print $2}' | grep -qx L && (usermod -U ${user} && echo OSA_RESULT:UPDATED:user:${user}:unlocked) || echo OSA_RESULT:SKIPPED:user:${user}:unlocked) || echo OSA_RESULT:SKIPPED:user:${user}`,
        rollbackInverse: `id ${user} >/dev/null 2>&1 && usermod -L ${user} >/dev/null 2>&1 || true`,
        rollbackDescription: `解锁用户 ${user} 登录`,
        recordWhenOutputIncludes: `OSA_RESULT:UPDATED:user:${user}:unlocked`,
        userFacingStep: `解锁用户 ${user}`
      };
    }

    // firewall-cmd add/remove port (reversible).
    const fwAddPort = trimmed.match(/^firewall-cmd\s+--permanent\s+--add-port=([0-9]{1,5})\/(tcp|udp)\s*$/);
    if (fwAddPort?.[1] && fwAddPort?.[2]) {
      const port = fwAddPort[1];
      const proto = fwAddPort[2];
      const spec = `${port}/${proto}`;
      return {
        commandToRun: `firewall-cmd --permanent --query-port=${spec} >/dev/null 2>&1 && echo OSA_RESULT:EXISTS:firewall:port:${spec} || (firewall-cmd --permanent --add-port=${spec} && echo OSA_RESULT:UPDATED:firewall:port:${spec}:added)`,
        rollbackInverse: `firewall-cmd --permanent --remove-port=${spec} >/dev/null 2>&1 || true`,
        rollbackDescription: `放通防火墙端口 ${spec}`,
        recordWhenOutputIncludes: `OSA_RESULT:UPDATED:firewall:port:${spec}:added`,
        userFacingStep: `放通防火墙端口 ${spec}`
      };
    }

    const fwRemovePort = trimmed.match(/^firewall-cmd\s+--permanent\s+--remove-port=([0-9]{1,5})\/(tcp|udp)\s*$/);
    if (fwRemovePort?.[1] && fwRemovePort?.[2]) {
      const port = fwRemovePort[1];
      const proto = fwRemovePort[2];
      const spec = `${port}/${proto}`;
      return {
        commandToRun: `firewall-cmd --permanent --query-port=${spec} >/dev/null 2>&1 && (firewall-cmd --permanent --remove-port=${spec} && echo OSA_RESULT:UPDATED:firewall:port:${spec}:removed) || echo OSA_RESULT:SKIPPED:firewall:port:${spec}`,
        rollbackInverse: `firewall-cmd --permanent --add-port=${spec} >/dev/null 2>&1 || true`,
        rollbackDescription: `关闭防火墙端口 ${spec}`,
        recordWhenOutputIncludes: `OSA_RESULT:UPDATED:firewall:port:${spec}:removed`,
        userFacingStep: `关闭防火墙端口 ${spec}`
      };
    }

    // firewall-cmd add/remove service (reversible).
    const fwAddSvc = trimmed.match(/^firewall-cmd\s+--permanent\s+--add-service=([A-Za-z0-9._-]+)\s*$/);
    if (fwAddSvc?.[1]) {
      const svc = fwAddSvc[1];
      return {
        commandToRun: `firewall-cmd --permanent --query-service=${svc} >/dev/null 2>&1 && echo OSA_RESULT:EXISTS:firewall:service:${svc} || (firewall-cmd --permanent --add-service=${svc} && echo OSA_RESULT:UPDATED:firewall:service:${svc}:added)`,
        rollbackInverse: `firewall-cmd --permanent --remove-service=${svc} >/dev/null 2>&1 || true`,
        rollbackDescription: `放通防火墙服务 ${svc}`,
        recordWhenOutputIncludes: `OSA_RESULT:UPDATED:firewall:service:${svc}:added`,
        userFacingStep: `放通防火墙服务 ${svc}`
      };
    }

    const fwRemoveSvc = trimmed.match(/^firewall-cmd\s+--permanent\s+--remove-service=([A-Za-z0-9._-]+)\s*$/);
    if (fwRemoveSvc?.[1]) {
      const svc = fwRemoveSvc[1];
      return {
        commandToRun: `firewall-cmd --permanent --query-service=${svc} >/dev/null 2>&1 && (firewall-cmd --permanent --remove-service=${svc} && echo OSA_RESULT:UPDATED:firewall:service:${svc}:removed) || echo OSA_RESULT:SKIPPED:firewall:service:${svc}`,
        rollbackInverse: `firewall-cmd --permanent --add-service=${svc} >/dev/null 2>&1 || true`,
        rollbackDescription: `关闭防火墙服务 ${svc}`,
        recordWhenOutputIncludes: `OSA_RESULT:UPDATED:firewall:service:${svc}:removed`,
        userFacingStep: `关闭防火墙服务 ${svc}`
      };
    }

    // firewall reload (best-effort rollback not possible, but keep marker).
    if (/^firewall-cmd\s+--reload\s*$/.test(trimmed)) {
      return {
        commandToRun: `firewall-cmd --reload && echo OSA_RESULT:UPDATED:firewall:reload`,
        rollbackInverse: `firewall-cmd --reload || true`,
        rollbackDescription: "重新加载防火墙规则（不可严格回退）",
        recordWhenOutputIncludes: "OSA_RESULT:UPDATED:firewall:reload",
        userFacingStep: "重新加载防火墙规则"
      };
    }

    // firewall rich-rule add/remove (reversible by symmetric operation) - single-quoted rule.
    const fwAddRichSingle = trimmed.match(/^firewall-cmd\s+--permanent\s+--add-rich-rule='([\s\S]+)'\s*$/);
    if (fwAddRichSingle?.[1]) {
      const rule = fwAddRichSingle[1].replace(/'/g, "'\\''");
      return {
        commandToRun: `sh -lc 'firewall-cmd --permanent --query-rich-rule='\\''${rule}'\\'' >/dev/null 2>&1 && echo OSA_RESULT:EXISTS:firewall:richrule || (firewall-cmd --permanent --add-rich-rule='\\''${rule}'\\'' && echo OSA_RESULT:UPDATED:firewall:richrule:added)'`,
        rollbackInverse: `sh -lc 'firewall-cmd --permanent --remove-rich-rule='\\''${rule}'\\'' >/dev/null 2>&1 || true'`,
        rollbackDescription: "新增防火墙高级规则",
        recordWhenOutputIncludes: "OSA_RESULT:UPDATED:firewall:richrule:added",
        userFacingStep: "新增防火墙高级规则"
      };
    }

    const fwRemoveRichSingle = trimmed.match(/^firewall-cmd\s+--permanent\s+--remove-rich-rule='([\s\S]+)'\s*$/);
    if (fwRemoveRichSingle?.[1]) {
      const rule = fwRemoveRichSingle[1].replace(/'/g, "'\\''");
      return {
        commandToRun: `sh -lc 'firewall-cmd --permanent --query-rich-rule='\\''${rule}'\\'' >/dev/null 2>&1 && (firewall-cmd --permanent --remove-rich-rule='\\''${rule}'\\'' && echo OSA_RESULT:UPDATED:firewall:richrule:removed) || echo OSA_RESULT:SKIPPED:firewall:richrule'`,
        rollbackInverse: `sh -lc 'firewall-cmd --permanent --add-rich-rule='\\''${rule}'\\'' >/dev/null 2>&1 || true'`,
        rollbackDescription: "删除防火墙高级规则",
        recordWhenOutputIncludes: "OSA_RESULT:UPDATED:firewall:richrule:removed",
        userFacingStep: "删除防火墙高级规则"
      };
    }

    const rmMatch = trimmed.match(/^rm(?:\s+-[^\s]+)*\s+([^\s]+)$/);
    if (rmMatch?.[1]) {
      const target = rmMatch[1];
      const safeName = target.replace(/[\/\\:]/g, "_");
      const trashName = `${sessionId}_${Date.now()}_${stepIndex}_${safeName}`;
      const trashPath = `${Orchestrator.TRASH_DIR}/${trashName}`;
      return {
        commandToRun: `[ -e "${target}" ] && mkdir -p "${Orchestrator.TRASH_DIR}" && mv "${target}" "${trashPath}" && echo OSA_RESULT:DELETED:file:${target}:${trashPath} || echo OSA_RESULT:SKIPPED:file:${target}`,
        rollbackInverse: `[ -e "${trashPath}" ] && mv "${trashPath}" "${target}" && echo OSA_RESULT:UPDATED:file:${target} || true`,
        rollbackDescription: `删除 ${target}（已移动到隔离区，可回退）`,
        recordWhenOutputIncludes: `OSA_RESULT:DELETED:file:${target}:`,
        userFacingStep: `删除 ${target}`
      };
    }

    return { commandToRun: trimmed };
  }

  private shouldRecordRollback(
    preparedStep: { recordWhenOutputIncludes?: string },
    output: string
  ): boolean {
    if (!preparedStep.recordWhenOutputIncludes) {
      return true;
    }
    return output.includes(preparedStep.recordWhenOutputIncludes);
  }

  private deriveRollbackFromMarkers(
    sessionId: string,
    originalCommand: string,
    executedCommand: string,
    output: string
  ): { inverseCommand: string; description: string; recordWhenOutputIncludes?: string } | undefined {
    // Only derive rollback when the output explicitly says something was CREATED.
    const createdUser = output.match(/OSA_RESULT:CREATED:user:([A-Za-z0-9._-]+)/)?.[1];
    if (createdUser) {
      return {
        inverseCommand: `id ${createdUser} >/dev/null 2>&1 && userdel -r ${createdUser} || true`,
        description: `删除用户 ${createdUser}`,
        recordWhenOutputIncludes: `OSA_RESULT:CREATED:user:${createdUser}`
      };
    }
    const deletedUser = output.match(/OSA_RESULT:UPDATED:user:([A-Za-z0-9._-]+):deleted/)?.[1];
    if (deletedUser) {
      return {
        inverseCommand: `id ${deletedUser} >/dev/null 2>&1 || (useradd -m ${deletedUser} && echo OSA_RESULT:CREATED:user:${deletedUser}:restored) || true`,
        description: `创建用户 ${deletedUser}（可恢复账号主体）`,
        recordWhenOutputIncludes: `OSA_RESULT:UPDATED:user:${deletedUser}:deleted`
      };
    }
    const createdDir = output.match(/OSA_RESULT:CREATED:dir:([^\s\r\n]+)/)?.[1];
    if (createdDir) {
      return {
        inverseCommand: `[ -d "${createdDir}" ] && rmdir "${createdDir}" || true`,
        description: `删除目录 ${createdDir}`,
        recordWhenOutputIncludes: `OSA_RESULT:CREATED:dir:${createdDir}`
      };
    }
    const createdFile = output.match(/OSA_RESULT:CREATED:file:([^\s\r\n]+)/)?.[1];
    if (createdFile) {
      return {
        inverseCommand: `[ -f "${createdFile}" ] && rm -f "${createdFile}" || true`,
        description: `删除文件 ${createdFile}`,
        recordWhenOutputIncludes: `OSA_RESULT:CREATED:file:${createdFile}`
      };
    }
    const installedPkg = output.match(/OSA_RESULT:INSTALLED:pkg:([A-Za-z0-9._+-]+)/)?.[1];
    if (installedPkg) {
      // Prefer dnf; yum is usually a symlink but keep it simple.
      return {
        inverseCommand: `dnf remove -y ${installedPkg} || yum remove -y ${installedPkg} || true`,
        description: `卸载软件包 ${installedPkg}`,
        recordWhenOutputIncludes: `OSA_RESULT:INSTALLED:pkg:${installedPkg}`
      };
    }
    const startedSvc = output.match(/OSA_RESULT:STARTED:svc:([A-Za-z0-9@._-]+)/)?.[1];
    if (startedSvc) {
      return {
        inverseCommand: `systemctl stop ${startedSvc} || true`,
        description: `停止服务 ${startedSvc}`,
        recordWhenOutputIncludes: `OSA_RESULT:STARTED:svc:${startedSvc}`
      };
    }
    const deletedFile = output.match(/OSA_RESULT:DELETED:file:([^:\r\n]+):([^:\r\n]+)/);
    if (deletedFile?.[1] && deletedFile?.[2]) {
      const target = deletedFile[1];
      const trashPath = deletedFile[2];
      return {
        inverseCommand: `[ -e "${trashPath}" ] && mv "${trashPath}" "${target}" && echo OSA_RESULT:UPDATED:file:${target} || true`,
        description: `删除 ${target}（已移动到隔离区，可回退）`,
        recordWhenOutputIncludes: `OSA_RESULT:DELETED:file:${target}:`
      };
    }
    const backupUpdatedFile = output.match(/OSA_RESULT:UPDATED:backup:([^:\r\n]+):([^:\r\n]+)/);
    if (backupUpdatedFile?.[1] && backupUpdatedFile?.[2]) {
      const target = backupUpdatedFile[1];
      const backupPath = backupUpdatedFile[2];
      return {
        inverseCommand: `[ -e "${backupPath}" ] && cp -p "${backupPath}" "${target}" && echo OSA_RESULT:UPDATED:file:${target} || true`,
        description: `恢复文件 ${target} 到修改前版本`,
        recordWhenOutputIncludes: `OSA_RESULT:UPDATED:backup:${target}:${backupPath}`
      };
    }
    const permMatch = output.match(/OSA_RESULT:UPDATED:perm:([^:\r\n]+):([0-7]{3,4})/);
    if (permMatch?.[1] && permMatch?.[2]) {
      const target = permMatch[1];
      const oldMode = permMatch[2];
      return {
        inverseCommand: `[ -e "${target}" ] && chmod ${oldMode} "${target}" || true`,
        description: `调整权限 ${target}`,
        recordWhenOutputIncludes: `OSA_RESULT:UPDATED:perm:${target}:${oldMode}`
      };
    }
    return undefined;
  }

  private extractRollbackIndex(userMessage: string): number | undefined {
    const text = userMessage.trim();
    if (!text) {
      return undefined;
    }
    const toValidIndex = (raw?: string): number | undefined => {
      if (!raw) return undefined;
      const index = Number(raw);
      return Number.isInteger(index) && index > 0 ? index : undefined;
    };

    // Supported forms:
    // - 撤销第2条 / 回退第2条
    // - 回退2 / 回退操作2 / 撤销 2 / undo 2
    const patterns = [
      /第\s*(\d+)\s*条/,
      /(撤销|回退|还原|rollback|undo)\s*(?:操作)?\s*(\d+)\b/i
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      const value = match?.[1] && /^\d+$/.test(match[1]) ? match[1] : match?.[2];
      const idx = toValidIndex(value);
      if (idx) return idx;
    }

    const zhMap: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const zhPatterns = [
      /第\s*(一|二|三|四|五|六|七|八|九|十)\s*条/,
      /(撤销|回退|还原)\s*(?:操作)?\s*(一|二|三|四|五|六|七|八|九|十)\b/
    ];
    for (const pattern of zhPatterns) {
      const match = text.match(pattern);
      const key = match?.[1] && zhMap[match[1]] ? match[1] : match?.[2];
      if (key && zhMap[key]) return zhMap[key];
    }
    return undefined;
  }

  private persistPendingApproval(sessionId: string, command: string, expiresAt: number): void {
    this.persistedPendingApprovals.set(sessionId, {
      id: `persisted-${sessionId}`,
      sessionId,
      command,
      requiredPhrase: "自然语言确认",
      summary: `High-risk command requires approval: ${command}`,
      expiresAt
    });
    this.persistPendingApprovalsToDisk();
  }

  private getPersistedPending(sessionId: string): ApprovalChallenge | undefined {
    const item = this.persistedPendingApprovals.get(sessionId);
    if (!item) return undefined;
    if (Date.now() > item.expiresAt) {
      this.persistedPendingApprovals.delete(sessionId);
      this.persistPendingApprovalsToDisk();
      return undefined;
    }
    return item;
  }

  private approvePersistedPending(sessionId: string, approvalText: string): ApprovalChallenge | undefined {
    const pending = this.getPersistedPending(sessionId);
    if (!pending) return undefined;
    const normalized = approvalText.trim().toLowerCase();
    if (!normalized) return undefined;
    if (/(取消|不用了|算了|放弃|不执行|先别)/i.test(normalized)) {
      this.clearPersistedPending(sessionId);
      return undefined;
    }
    if (!/(确认|继续|同意|可以执行|强制执行|我确认|执行吧|继续执行|确定|是的|好的|行|没问题)/i.test(normalized)) {
      return undefined;
    }
    this.clearPersistedPending(sessionId);
    return pending;
  }

  private clearPersistedPending(sessionId: string): void {
    if (this.persistedPendingApprovals.delete(sessionId)) {
      this.persistPendingApprovalsToDisk();
    }
  }

  private loadPendingApprovalsFromDisk(): void {
    try {
      if (!existsSync(Orchestrator.PENDING_APPROVAL_PATH)) return;
      const raw = readFileSync(Orchestrator.PENDING_APPROVAL_PATH, "utf8");
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw) as Record<
        string,
        { id?: string; sessionId?: string; command?: string; requiredPhrase?: string; summary?: string; expiresAt?: number }
      >;
      const now = Date.now();
      for (const [sid, item] of Object.entries(parsed)) {
        if (item?.command && typeof item.expiresAt === "number" && item.expiresAt > now) {
          this.persistedPendingApprovals.set(sid, {
            id: item.id ?? `persisted-${sid}`,
            sessionId: item.sessionId ?? sid,
            command: item.command,
            requiredPhrase: item.requiredPhrase ?? "自然语言确认",
            summary: item.summary ?? `High-risk command requires approval: ${item.command}`,
            expiresAt: item.expiresAt
          });
        }
      }
    } catch {
      // ignore
    }
  }

  private persistPendingApprovalsToDisk(): void {
    try {
      const parent = dirname(Orchestrator.PENDING_APPROVAL_PATH);
      if (!existsSync(parent)) {
        mkdirSync(parent, { recursive: true });
      }
      const serializable: Record<
        string,
        { id: string; sessionId: string; command: string; requiredPhrase: string; summary: string; expiresAt: number }
      > = {};
      const now = Date.now();
      for (const [sid, item] of this.persistedPendingApprovals.entries()) {
        if (item.expiresAt > now) {
          serializable[sid] = item;
        }
      }
      writeFileSync(Orchestrator.PENDING_APPROVAL_PATH, JSON.stringify(serializable, null, 2), "utf8");
    } catch {
      // ignore
    }
  }
}
