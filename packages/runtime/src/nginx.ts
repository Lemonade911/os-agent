export function buildNginxStatusCommand(): string {
  return `sh -lc 'systemctl is-active nginx 2>/dev/null || true; systemctl is-enabled nginx 2>/dev/null || true; systemctl --no-pager -l status nginx 2>/dev/null | sed -n "1,25p" || true'`;
}

export function buildNginxStopCommand(): string {
  return `sh -lc 'systemctl is-active --quiet nginx && (systemctl stop nginx && echo OSA_RESULT:UPDATED:svc:nginx:stopped) || echo OSA_RESULT:SKIPPED:svc:nginx'`;
}

export function buildNginxStartCommand(): string {
  return (
    `sh -lc '` +
    `command -v nginx >/dev/null 2>&1 || (` +
    `(command -v dnf >/dev/null 2>&1 && dnf -y install nginx) || ` +
    `(command -v yum >/dev/null 2>&1 && yum -y install nginx) || ` +
    `(command -v apt-get >/dev/null 2>&1 && (apt-get update -y || true) && DEBIAN_FRONTEND=noninteractive apt-get install -y nginx) || ` +
    `echo OSA_RESULT:FAILED:pkg:nginx:install` +
    `); ` +
    `systemctl enable nginx >/dev/null 2>&1 || true; ` +
    `systemctl start nginx >/dev/null 2>&1 && echo OSA_RESULT:UPDATED:svc:nginx:started || echo OSA_RESULT:FAILED:svc:nginx:start; ` +
    `systemctl is-active nginx 2>/dev/null || true; ` +
    `ss -ltnp 2>/dev/null | grep -E ":(80|443)\\b" || true; ` +
    `echo OSA_RESULT:UPDATED:hint:curl=curl\\ -I\\ http://127.0.0.1/` +
    `'`
  );
}

export function buildNginxRollbackCommand(): string {
  return `sh -lc 'systemctl stop nginx 2>/dev/null && echo OSA_RESULT:UPDATED:svc:nginx:stopped || echo OSA_RESULT:SKIPPED:svc:nginx:not_running'`;
}
