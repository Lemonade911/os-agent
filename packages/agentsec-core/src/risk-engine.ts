import type { RiskDecision } from "./types.js";

const BLACKLIST_PATTERNS = [
  "rm -rf",
  "chmod 777",
  "mkfs",
  "> /dev/sda",
  "dd if=",
  "shutdown",
  "reboot"
];

export class RiskEngine {
  evaluate(command: string): RiskDecision {
    const normalized = command.toLowerCase();
    if (normalized.includes("osa_firewall_change:")) {
      return {
        allow: true,
        riskLevel: "high",
        requiresApproval: true,
        reason: "检测到防火墙策略变更操作，需要你确认后执行。"
      };
    }
    if (normalized.includes("osa_overwrite_exists:")) {
      return {
        allow: true,
        riskLevel: "high",
        requiresApproval: true,
        reason: "检测到目标已存在，本次写入可能覆盖原内容，需要你确认后执行。"
      };
    }
    const hit = BLACKLIST_PATTERNS.find((pattern) => normalized.includes(pattern));

    if (hit) {
      return {
        allow: false,
        reason: `Blocked by security policy: detected dangerous pattern "${hit}".`,
        riskLevel: "critical",
        requiresApproval: false
      };
    }

    if (
      normalized.includes("useradd") ||
      normalized.includes("userdel") ||
      normalized.includes("groupadd") ||
      normalized.includes("groupdel") ||
      normalized.includes("usermod") ||
      normalized.includes("passwd ") ||
      normalized.includes("chage ") ||
      normalized.includes("sudo") ||
      /\brm\b/.test(normalized) ||
      normalized.includes("chmod ") ||
      normalized.includes("chown ")
    ) {
      return {
        allow: true,
        riskLevel: "high",
        requiresApproval: true,
        reason: "High-risk command requires explicit approval."
      };
    }

    // File content overwrite/update operations should require confirmation.
    // We intentionally classify by "potentially destructive" behavior, even if runtime may create a new file.
    if (
      /(^|\s)sed\s+-i\b/.test(normalized) ||
      /(^|\s)tee\s+/.test(normalized) ||
      /\s>\s*[^\s]+/.test(normalized) ||
      /(^|\s)cp(\s|$)/.test(normalized)
    ) {
      const isGuardedCreateOrUpdateFlow =
        normalized.includes("osa_result:created:file:") &&
        normalized.includes("osa_result:updated:file:") &&
        normalized.includes("[ -e ");
      if (isGuardedCreateOrUpdateFlow) {
        return {
          allow: true,
          riskLevel: "medium",
          requiresApproval: false,
          reason: "检测到受保护的创建/更新流程（含存在性检查与标记）。"
        };
      }
      return {
        allow: true,
        riskLevel: "high",
        requiresApproval: true,
        reason: "检测到可能覆盖文件内容的操作，需要你确认后再执行。"
      };
    }

    const isSystemctlStartOrRestart = /(^|\s)systemctl\s+(start|restart)\b/.test(normalized);
    const isSystemctlStopOrDisable = /(^|\s)systemctl\s+(stop|disable)\b/.test(normalized);
    const isSystemctlOtherChange = /(^|\s)systemctl\s+(enable|reload|daemon-reload)\b/.test(normalized);
    const isPkgChange =
      /(^|\s)(apt|apt-get)\s+(install|remove|purge)\b/.test(normalized) ||
      /(^|\s)(yum|dnf)\s+(install|remove)\b/.test(normalized);
    const isFirewallChange =
      /(^|\s)firewall-cmd\b/.test(normalized) || /(^|\s)iptables\b/.test(normalized) || /(^|\s)nft\b/.test(normalized);
    if (isFirewallChange || isPkgChange || isSystemctlStopOrDisable || isSystemctlOtherChange) {
      return {
        allow: true,
        riskLevel: "high",
        requiresApproval: true,
        reason: "检测到系统/网络策略变更操作，需要你确认后执行。"
      };
    }

    if (isSystemctlStartOrRestart) {
      return {
        allow: true,
        riskLevel: "medium",
        requiresApproval: false,
        reason: "检测到服务启动/重启操作。"
      };
    }

    return {
      allow: true,
      riskLevel: "low",
      requiresApproval: false
    };
  }
}
