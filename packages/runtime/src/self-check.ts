import { Orchestrator } from "./orchestrator.js";
import { LLMClient } from "./llm-client.js";

type GateResult = {
  allow: boolean;
  blockedReason?: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  requiresApproval: boolean;
  challenge?: { id: string; sessionId: string; command: string; requiredPhrase: string; summary: string; expiresAt: number };
};

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`Self-check failed: ${message}`);
  }
}

function assertUserFacing(text: string | undefined, context: string): void {
  const value = (text ?? "").trim();
  assert(value.length > 0, `${context}: summary should not be empty`);
  assert(!/OSA_RESULT:|APPROVE\s+/i.test(value), `${context}: summary should not leak internal markers`);
  assert(!/^\s*执行操作[:：]/m.test(value), `${context}: summary should not use CLI-like header`);
  assert(!/backup:|\/tmp\/\.fusion_os_(trash|backup)/i.test(value), `${context}: summary should not expose internal paths`);
}

async function run(): Promise<void> {
  const llm = new LLMClient({
    baseUrl: "https://example.invalid/v1",
    apiKey: "dummy",
    model: "dummy",
    fallbackModels: []
  });
  const orch = new Orchestrator(llm);

  const pending = new Map<string, string>();
  const executedCommands: string[] = [];
  let mockHomeTxtContent = "lkqok";

  (llm as any).generateLinuxCommand = async (_sessionId: string, userMessage: string): Promise<string> => {
    if (userMessage.includes("重启 sshd 服务")) return "systemctl restart sshd";
    if (userMessage.includes("建一个l000")) return "useradd l000";
    if (userMessage.includes("删除这个用户")) return "userdel l000";
    if (userMessage.includes("删掉 /tmp/abc.txt")) return "rm /tmp/abc.txt";
    if (userMessage.includes("建个文件夹") && userMessage.includes("hello.txt")) return `echo "OK" > /tmp/test/hello.txt`;
    if (userMessage.includes("多步任务演示")) return "mkdir /tmp/multi_demo\nsystemctl start sshd\nss -ltnp";
    return "echo OSA_RESULT:SKIPPED:file:/tmp/noop";
  };
  (llm as any).summarizeOutput = async (_command: string, rawOutput: string): Promise<string> => {
    if (rawOutput.includes("OSA_RESULT:CREATED:user:l000")) return "已成功创建用户 l000。";
    if (rawOutput.includes("OSA_RESULT:UPDATED:user:l000:deleted")) return "已成功删除用户 l000。";
    if (rawOutput.includes("OSA_RESULT:SKIPPED:file:/tmp/abc.txt")) return "文件 /tmp/abc.txt 本来就不存在，所以没有执行删除。";
    if (rawOutput.includes("OSA_RESULT:UPDATED:svc:firewalld:stopped")) return "已关闭系统防火墙 firewalld。";
    if (rawOutput.includes("OSA_RESULT:CREATED:file:/tmp/test/hello.txt")) return "已创建文件 /tmp/test/hello.txt。";
    if (rawOutput.includes("OSA_RESULT:CREATED:file:/root/666/999txt")) return "已创建文件 /root/666/999txt。";
    if (rawOutput.includes("OSA_RESULT:UPDATED:file:/root/666/999txt")) return "已更新文件 /root/666/999txt。";
    if (rawOutput.includes("127.0.0.1")) return "服务状态正常。";
    if (rawOutput.includes("Started Session")) return "已获取服务最近日志。";
    if (rawOutput.includes("192.168.230.128/24")) return "已获取本机 IPv4 地址。";
    if (rawOutput.includes("default via 192.168.230.2")) return "已获取网络配置（IP/路由/DNS）。";
    if (rawOutput.includes("TARGET=8.8.8.8")) return "已检查网络连通性。";
    if (rawOutput.includes("load average")) return "已获取主机性能概况。";
    if (rawOutput.includes("/var/log/messages")) return "已分析目录占用情况。";
    if (rawOutput.includes("journald_usage")) return "已检查日志占用情况。";
    if (rawOutput.includes("error line")) return "已在日志中完成关键词搜索。";
    if (rawOutput.includes("OSA_RESULT:CREATED:dir:/tmp/multi_demo")) return "多步任务已完成。";
    return "已完成处理。";
  };
  (llm as any).explainSecurityBlock = async (): Promise<string> => "该操作有风险，请确认是否继续执行。";
  (llm as any).generateRepairCommand = async (failed: string): Promise<string> => failed;
  (llm as any).generateChatReply = async (): Promise<string> => "收到。";

  (orch as any).localExecutor.executeCommand = async (command: string): Promise<string> => {
    executedCommands.push(command);
    if (command.includes("useradd l000")) return "OSA_RESULT:CREATED:user:l000";
    if (command.includes("userdel") && command.includes("l000")) return "OSA_RESULT:UPDATED:user:l000:deleted";
    if (command.includes('"/tmp/abc.txt"') && command.includes("OSA_RESULT:SKIPPED:file:/tmp/abc.txt"))
      return "OSA_RESULT:SKIPPED:file:/tmp/abc.txt";
    if (command.includes("firewalld")) return "OSA_RESULT:UPDATED:svc:firewalld:stopped";
    if (command.includes("ROLLBACK") || command.includes("useradd -m l000")) return "OSA_RESULT:CREATED:user:l000:restored";
    if (command.includes("/tmp/test/hello.txt") && command.includes("OSA_RESULT:CREATED:file:/tmp/test/hello.txt")) {
      return "OSA_RESULT:CREATED:file:/tmp/test/hello.txt";
    }
    if (command.includes("sed -n '1,40p'") && command.includes("/home/liukunqiang/666/666.txt")) {
      return mockHomeTxtContent;
    }
    if (command.includes("/home/liukunqiang/666/666.txt") && command.includes("OSA_RESULT:UPDATED:file:/home/liukunqiang/666/666.txt")) {
      mockHomeTxtContent = command.includes("lkqokk") ? "lkqokk" : mockHomeTxtContent;
      return "OSA_RESULT:UPDATED:backup:/home/liukunqiang/666/666.txt:/tmp/.fusion_os_backup/mock_backup\nOSA_RESULT:UPDATED:file:/home/liukunqiang/666/666.txt";
    }
    if (command.includes('OSA_RESULT:EXISTS:file:/home/liukunqiang/666/666.txt')) {
      return "OSA_RESULT:EXISTS:file:/home/liukunqiang/666/666.txt";
    }
    if (command.includes("/home/liukunqiang/666/666.txt") && command.includes("OSA_RESULT:CREATED:file:/home/liukunqiang/666/666.txt")) {
      return "OSA_RESULT:CREATED:file:/home/liukunqiang/666/666.txt";
    }
    if (command.includes("sed -n '1,40p'") && command.includes("/tmp/test/hello.txt")) {
      return "OK";
    }
    if (command.includes('OSA_RESULT:EXISTS:file:/tmp/test/hello.txt')) {
      return "OSA_RESULT:EXISTS:file:/tmp/test/hello.txt";
    }
    if (command.includes('OSA_RESULT:DELETED:file:/root/666/888txt')) {
      return "OSA_RESULT:SKIPPED:file:/root/666/888txt";
    }
    if (command.includes('OSA_RESULT:EXISTS:file:/root/666/999txt')) {
      return "OSA_RESULT:DELETED:file:/root/666/999txt";
    }
    if (command.includes("/root/666/999txt") && command.includes("OSA_RESULT:CREATED:file:/root/666/999txt")) {
      return "OSA_RESULT:CREATED:file:/root/666/999txt";
    }
    if (command.includes("sed -n '1,40p'") && command.includes("/root/666/999txt")) {
      return "okk";
    }
    if (command.includes("systemctl is-active firewalld")) {
      return "active\nenabled\n● firewalld.service - firewalld";
    }
    if (command.includes("journalctl -u firewalld")) {
      return "Started Session c1 of user root.";
    }
    if (command.includes("ip -4 -o addr show scope global")) {
      return "2: ens33    inet 192.168.230.128/24 brd 192.168.230.255 scope global dynamic noprefixroute ens33\n---\n192.168.230.128";
    }
    if (command.includes('echo "ip_addr:"; ip -br addr')) {
      return "ip_addr:\nens33 UP 192.168.230.128/24\n---\nroutes:\ndefault via 192.168.230.2 dev ens33\n---\ndns:\nnameserver 8.8.8.8";
    }
    if (command.includes('echo "TARGET=8.8.8.8"')) {
      return "TARGET=8.8.8.8\n8.8.8.8 dns.google\n2 packets transmitted, 2 received\n---\nHTTP/1.1 200 OK";
    }
    if (command.includes('echo "load:"; uptime')) {
      return "load:\n 12:00:00 up 1 day,  1 user,  load average: 0.10, 0.08, 0.05\n---\ncpu_mem:\n...\n---\nmem:\n...\n---\ndisk:\n...\n---\ninode:\n...\n---\nio:\n...";
    }
    if (command.includes('du -xh --max-depth=1 "/var"')) {
      return "4.0K\t/var/tmp\n120M\t/var/log/messages\n300M\t/var/log\n450M\t/var";
    }
    if (command.includes('echo "var_log_top:";')) {
      return "var_log_top:\n80M /var/log/messages\n120M /var/log/secure\n---\njournald_usage:\nArchived and active journals take up 200.0M in the file system.";
    }
    if (command.includes('tail -n 80 "/var/log/messages"') && command.includes('rg -n "error"')) {
      return "12:error line one\n29:error line two";
    }
    if (command.includes('"/tmp/multi_demo"') && command.includes("OSA_RESULT:CREATED:dir:/tmp/multi_demo")) {
      return "OSA_RESULT:CREATED:dir:/tmp/multi_demo";
    }
    if (command.includes("systemctl is-active --quiet sshd")) {
      return "OSA_RESULT:EXISTS:svc:sshd";
    }
    if (command.includes("ss -ltnp")) {
      return "LISTEN 0 128 0.0.0.0:22 users:((\"sshd\",pid=1205,fd=3))";
    }
    return "OSA_RESULT:SKIPPED:file:/tmp/noop";
  };

  (orch as any).securityGateway.evaluateCommand = async (ctx: { sessionId: string; command: string }): Promise<GateResult> => {
    const cmd = ctx.command;
    if (cmd.includes("rm -rf /")) {
      return {
        allow: false,
        blockedReason: "critical dangerous command",
        riskLevel: "critical",
        requiresApproval: false
      };
    }
    if (cmd.includes("OSA_FIREWALL_CHANGE") || cmd.includes("useradd") || cmd.includes("userdel") || cmd.includes("OSA_OVERWRITE_EXISTS:")) {
      pending.set(ctx.sessionId, cmd);
      return {
        allow: false,
        blockedReason: "approval required",
        riskLevel: "high",
        requiresApproval: true,
        challenge: {
          id: "c1",
          sessionId: ctx.sessionId,
          command: cmd,
          requiredPhrase: "自然语言确认",
          summary: "need approval",
          expiresAt: Date.now() + 60_000
        }
      };
    }
    return { allow: true, riskLevel: "low", requiresApproval: false };
  };
  (orch as any).securityGateway.approveIfPending = (sessionId: string, text: string) => {
    if (/(取消|放弃|不用了|算了)/.test(text)) {
      pending.delete(sessionId);
      return undefined;
    }
    if (!/(继续|确认|同意)/.test(text)) return undefined;
    const cmd = pending.get(sessionId);
    if (!cmd) return undefined;
    pending.delete(sessionId);
    return { command: cmd };
  };
  (orch as any).securityGateway.getPendingApproval = (sessionId: string) => {
    const cmd = pending.get(sessionId);
    if (!cmd) return undefined;
    return { command: cmd };
  };
  (orch as any).securityGateway.logExecution = async () => {};

  const sessionId = "self-check";

  const createBlocked = await orch.handleRequest({ sessionId, userMessage: "帮我建一个l000的用户", executorMode: "local" });
  assert(createBlocked.blocked && createBlocked.requiresApproval, "useradd should require approval");

  const createDone = await orch.handleRequest({ sessionId, userMessage: "继续", executorMode: "local" });
  assert(!createDone.blocked, "approved useradd should execute");
  assertUserFacing(createDone.naturalSummary, "create user");

  const delBlocked = await orch.handleRequest({ sessionId, userMessage: "删除这个用户", executorMode: "local" });
  assert(delBlocked.blocked && delBlocked.requiresApproval, "userdel should require approval");

  const delDone = await orch.handleRequest({ sessionId, userMessage: "确认执行", executorMode: "local" });
  assert(!delDone.blocked, "approved userdel should execute");
  assertUserFacing(delDone.naturalSummary, "delete user");

  const rollbackList = await orch.handleRequest({ sessionId, userMessage: "可回退操作", executorMode: "local" });
  assert(
    rollbackList.naturalSummary?.includes("删除用户 l000") || rollbackList.naturalSummary?.includes("可恢复账号主体"),
    "rollback list should include user deletion rollback item"
  );

  const skipDelete = await orch.handleRequest({ sessionId, userMessage: "删掉 /tmp/abc.txt", executorMode: "local" });
  assert(skipDelete.naturalSummary?.includes("本来就不存在"), "delete missing file should be explained in plain language");
  assertUserFacing(skipDelete.naturalSummary, "delete missing file");

  const deleteOtherTxt = await orch.handleRequest({
    sessionId: "self-check-edit",
    userMessage: "删除 /root/666/888txt",
    executorMode: "local"
  });
  assert(
    deleteOtherTxt.naturalSummary?.includes("不存在") || deleteOtherTxt.naturalSummary?.includes("没有执行删除"),
    "delete missing sibling txt should be explained"
  );
  const editBySiblingContext = await orch.handleRequest({
    sessionId: "self-check-edit",
    userMessage: "把999txt内容改为okk",
    executorMode: "local"
  });
  assert(!editBySiblingContext.blocked, "edit txt by sibling context should execute");
  assert(
    editBySiblingContext.command.includes("/root/666/999txt"),
    `edit should infer sibling path from previous context, got: ${editBySiblingContext.command}`
  );
  assertUserFacing(editBySiblingContext.naturalSummary, "edit txt by sibling context");
  const viewEdited = await orch.handleRequest({
    sessionId: "self-check-edit",
    userMessage: "查看999txt",
    executorMode: "local"
  });
  assert(viewEdited.naturalSummary?.includes("okk"), "view edited txt should show updated content");

  (orch as any).sessionContext.set("self-check-filectx", {
    recentPaths: ["/home/liukunqiang/666/666.txt", "/home/liukunqiang/666", "/home/liukunqiang"],
    updatedAt: Date.now()
  });
  const fileViewCtx = await orch.handleRequest({
    sessionId: "self-check-filectx",
    userMessage: "查看这个txt",
    executorMode: "local"
  });
  assert(
    fileViewCtx.naturalSummary?.includes("/home/liukunqiang/666/666.txt") || fileViewCtx.naturalSummary?.includes("lkqok"),
    "viewing implicit txt should resolve to the recent concrete file path"
  );

  const fileEditPreviewCtx = await orch.handleRequest({
    sessionId: "self-check-filectx",
    userMessage: "修改666.txt内容为lkqokk",
    executorMode: "local"
  });
  assert(
    (fileEditPreviewCtx.command.includes("/home/liukunqiang/666/666.txt") && fileEditPreviewCtx.command.includes("lkqokk")) &&
      (fileEditPreviewCtx.blocked || fileEditPreviewCtx.requiresApproval || (fileEditPreviewCtx.naturalSummary ?? "").includes("确认")),
    "editing named txt preview should target the recent concrete file path and enter approval flow"
  );

  const fileEditCtx = await orch.handleRequest({
    sessionId: "self-check-filectx",
    userMessage: "修改666.txt内容为lkqokk",
    executorMode: "local"
  });
  assert(fileEditCtx.blocked && fileEditCtx.requiresApproval, "editing existing txt should require approval");
  assert(
    fileEditCtx.command.includes("/home/liukunqiang/666/666.txt") && fileEditCtx.command.includes("lkqokk"),
    "editing named txt should target the recent concrete file path and parse content"
  );

  const fileEditConfirmed = await orch.handleRequest({
    sessionId: "self-check-filectx",
    userMessage: "继续",
    executorMode: "local"
  });
  assert(!fileEditConfirmed.blocked, "approved txt edit should execute");
  assert(
    fileEditConfirmed.naturalSummary?.includes("/home/liukunqiang/666/666.txt"),
    "approved txt edit should report updated target"
  );

  const followupCtx = await orch.handleRequest({
    sessionId: "self-check-filectx",
    userMessage: "不是okk吗",
    executorMode: "local"
  });
  assert(
    !followupCtx.blocked && !followupCtx.requiresApproval,
    "content follow-up should not enter approval flow"
  );
  assert(
    followupCtx.naturalSummary?.includes("/home/liukunqiang/666/666.txt") && followupCtx.naturalSummary?.includes("lkqokk"),
    "content follow-up should report current file content"
  );

  const fwBlocked = await orch.handleRequest({
    sessionId: "self-check-fw",
    userMessage: "帮我关掉系统的防火墙 (firewalld)",
    executorMode: "local"
  });
  assert(fwBlocked.blocked && fwBlocked.requiresApproval, "firewall stop should require approval");

  const fwCancel = await orch.handleRequest({
    sessionId: "self-check-fw",
    userMessage: "取消",
    executorMode: "local"
  });
  assert(fwCancel.chatOnly || fwCancel.blocked, "cancel branch should not directly execute high-risk command");
  const firewalldExecutedAfterCancel = executedCommands.some((cmd) => cmd.includes("systemctl stop firewalld"));
  assert(!firewalldExecutedAfterCancel, "firewall stop should not execute after cancel");
  const fwFollowup = await orch.handleRequest({
    sessionId: "self-check-fw",
    userMessage: "你好",
    executorMode: "local"
  });
  assert(
    !(fwFollowup.naturalSummary ?? "").includes("待确认的高风险操作"),
    "cancelled approval should not keep stale pending reminder"
  );
  assertUserFacing(fwFollowup.naturalSummary, "chat after cancel approval");

  // Force planner result for this session by direct method monkey patch behavior:
  (llm as any).generateLinuxCommand = async (_sessionId: string, userMessage: string): Promise<string> => {
    if (userMessage.includes("重启 sshd 服务")) return "systemctl restart sshd";
    if (userMessage.includes("危险命令")) return "rm -rf /";
    if (userMessage.includes("建一个l000")) return "useradd l000";
    if (userMessage.includes("删除这个用户")) return "userdel l000";
    if (userMessage.includes("删掉 /tmp/abc.txt")) return "rm /tmp/abc.txt";
    if (userMessage.includes("建个文件夹") && userMessage.includes("hello.txt")) return `echo "OK" > /tmp/test/hello.txt`;
    if (userMessage.includes("多步任务演示")) return "mkdir /tmp/multi_demo\nsystemctl start sshd\nss -ltnp";
    return "echo OSA_RESULT:SKIPPED:file:/tmp/noop";
  };
  const dangerousBlocked2 = await orch.handleRequest({
    sessionId: "self-check-danger-2",
    userMessage: "执行危险命令",
    executorMode: "local"
  });
  assert(dangerousBlocked2.blocked, "dangerous command should be blocked");

  const fileCreate = await orch.handleRequest({
    sessionId: "self-check-file",
    userMessage: "帮我在 /tmp 建个文件夹叫 test，里面存个 hello.txt，内容写 OK",
    executorMode: "local"
  });
  assert(!fileCreate.blocked, "file create flow should execute");

  const fileView = await orch.handleRequest({
    sessionId: "self-check-file",
    userMessage: "查看这个txt",
    executorMode: "local"
  });
  assert(fileView.naturalSummary?.includes("/tmp/test/hello.txt"), "implicit txt view should resolve remembered path");
  assertUserFacing(fileView.naturalSummary, "file view");

  const fileExists = await orch.handleRequest({
    sessionId: "self-check-file",
    userMessage: "查看这个txt还在不",
    executorMode: "local"
  });
  assert(fileExists.naturalSummary?.includes("还在"), "implicit existence check should work with remembered path");

  const clarify = await orch.handleRequest({
    sessionId: "self-check-file",
    userMessage: "我说的是 /tmp/test/hello.txt",
    executorMode: "local"
  });
  assert(clarify.command === "[PATH_CLARIFICATION]", "clarification should not execute operation");

  const locate = await orch.handleRequest({
    sessionId: "self-check-file",
    userMessage: "刚才那个 hello.txt 在哪儿来着？帮我找出来。",
    executorMode: "local"
  });
  assert(locate.naturalSummary?.includes("/tmp/test/hello.txt"), "locate should point to the correct normal path");
  assertUserFacing(locate.naturalSummary, "locate file");

  const svcStatus = await orch.handleRequest({
    sessionId: "self-check-svc",
    userMessage: "查看 firewalld 服务状态",
    executorMode: "local"
  });
  assert(svcStatus.command.includes("systemctl"), "service status deterministic path should be used");
  assertUserFacing(svcStatus.naturalSummary, "service status");

  const svcLog = await orch.handleRequest({
    sessionId: "self-check-svc",
    userMessage: "看看 firewalld 日志",
    executorMode: "local"
  });
  assert(svcLog.command.includes("journalctl"), "service log deterministic path should be used");
  assertUserFacing(svcLog.naturalSummary, "service log");

  const restartFlow = await orch.handleRequest({
    sessionId: "self-check-svc2",
    userMessage: "重启 sshd 服务",
    executorMode: "local"
  });
  assert(
    restartFlow.command.includes("systemctl restart") || restartFlow.command.includes("sshd"),
    "service restart should go through executable path"
  );
  assertUserFacing(restartFlow.naturalSummary, "service restart");

  const ipQuery = await orch.handleRequest({
    sessionId: "self-check-net",
    userMessage: "查看这台主机的ip",
    executorMode: "local"
  });
  assert(ipQuery.command.includes("ip -4 -o addr"), "ip deterministic path should be used");
  assert(ipQuery.naturalSummary?.includes("IPv4") || ipQuery.naturalSummary?.includes("IP"), "ip summary should exist");
  assertUserFacing(ipQuery.naturalSummary, "ip query");

  const netCfg = await orch.handleRequest({
    sessionId: "self-check-net",
    userMessage: "看下网关和dns配置",
    executorMode: "local"
  });
  assert(netCfg.command.includes("ip route"), "network config deterministic path should be used");
  assertUserFacing(netCfg.naturalSummary, "network config");

  const netReach = await orch.handleRequest({
    sessionId: "self-check-net",
    userMessage: "网络通不通",
    executorMode: "local"
  });
  assert(netReach.command.includes("TARGET=8.8.8.8"), "network reachability deterministic path should be used");
  assertUserFacing(netReach.naturalSummary, "network reachability");

  const perf = await orch.handleRequest({
    sessionId: "self-check-perf",
    userMessage: "这台机器是不是有点卡",
    executorMode: "local"
  });
  assert(perf.command.includes('echo "load:"; uptime'), "perf deterministic path should be used");
  assertUserFacing(perf.naturalSummary, "perf snapshot");

  const du = await orch.handleRequest({
    sessionId: "self-check-perf",
    userMessage: "看看 /var 空间都去哪了",
    executorMode: "local"
  });
  assert(du.command.includes("du -xh --max-depth=1"), "du deterministic path should be used");
  assertUserFacing(du.naturalSummary, "du usage");

  const logHealth = await orch.handleRequest({
    sessionId: "self-check-perf",
    userMessage: "检查一下日志占用",
    executorMode: "local"
  });
  assert(
    logHealth.command.includes('echo "var_log_top:";'),
    `log health deterministic path should be used, got: ${logHealth.command}`
  );
  assertUserFacing(logHealth.naturalSummary, "log health");

  const logSearch = await orch.handleRequest({
    sessionId: "self-check-perf",
    userMessage: "在 /var/log/messages 最近80行里搜 error",
    executorMode: "local"
  });
  assert(logSearch.command.includes('rg -n "error"'), "log keyword search deterministic path should be used");
  assertUserFacing(logSearch.naturalSummary, "log search");

  const multiTask = await orch.handleRequest({
    sessionId: "self-check-multi",
    userMessage: "多步任务演示",
    executorMode: "local"
  });
  assert(!multiTask.blocked, "multi-step task should execute");
  assert((multiTask.command.match(/\n/g)?.length ?? 0) >= 1, "multi-step plan should contain multiple commands");
  assert(multiTask.naturalSummary?.includes("多步") || multiTask.naturalSummary?.includes("步骤"), "multi-step summary should exist");
  assertUserFacing(multiTask.naturalSummary, "multi-step");

  const rollbackPrepare = await orch.handleRequest({
    sessionId: "self-check-rb2",
    userMessage: "帮我建一个l000的用户",
    executorMode: "local"
  });
  assert(rollbackPrepare.blocked && rollbackPrepare.requiresApproval, "user create in rollback test should require approval");
  await orch.handleRequest({ sessionId: "self-check-rb2", userMessage: "继续", executorMode: "local" });
  const rollbackPick = await orch.handleRequest({
    sessionId: "self-check-rb2",
    userMessage: "撤销刚才操作",
    executorMode: "local"
  });
  assert(rollbackPick.naturalSummary?.includes("待确认") || rollbackPick.naturalSummary?.includes("确认撤销"), "rollback should be two-phase");
  const rollbackConfirm = await orch.handleRequest({
    sessionId: "self-check-rb2",
    userMessage: "确认撤销",
    executorMode: "local"
  });
  assert(!rollbackConfirm.blocked, "rollback confirm should execute");
  assertUserFacing(rollbackConfirm.naturalSummary, "rollback confirm");

  const indexCreateBlocked = await orch.handleRequest({
    sessionId: "self-check-rb-index",
    userMessage: "帮我建一个l000的用户",
    executorMode: "local"
  });
  assert(indexCreateBlocked.blocked && indexCreateBlocked.requiresApproval, "index rollback create should require approval");
  await orch.handleRequest({ sessionId: "self-check-rb-index", userMessage: "继续", executorMode: "local" });
  const indexDeleteBlocked = await orch.handleRequest({
    sessionId: "self-check-rb-index",
    userMessage: "删除这个用户",
    executorMode: "local"
  });
  assert(indexDeleteBlocked.blocked && indexDeleteBlocked.requiresApproval, "index rollback delete should require approval");
  await orch.handleRequest({ sessionId: "self-check-rb-index", userMessage: "确认执行", executorMode: "local" });
  const rollbackIndexPick = await orch.handleRequest({
    sessionId: "self-check-rb-index",
    userMessage: "撤销第1条",
    executorMode: "local"
  });
  assert(
    rollbackIndexPick.naturalSummary?.includes("删除用户 l000") ||
      rollbackIndexPick.naturalSummary?.includes("最近一次可回退操作"),
    "rollback index #1 should target latest rollback item"
  );
  const rollbackIndexConfirm = await orch.handleRequest({
    sessionId: "self-check-rb-index",
    userMessage: "确认撤销第1条",
    executorMode: "local"
  });
  assert(!rollbackIndexConfirm.blocked, "rollback index confirm should execute");
  assertUserFacing(rollbackIndexConfirm.naturalSummary, "rollback index confirm");

  console.log(
    "Self-check passed: logic and language quality checks (approval, rollback, safety gating, context memory, deterministic handlers, multi-step, two-phase rollback)."
  );
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
