export function extractHelloWebContent(message: string): string | undefined {
  const m = message.trim();
  if (!m) return undefined;

  const quotedMatch = m.match(/["'“”‘’]([^"'“”‘’\n]{1,120})["'“”‘’]/);
  const displayMatch = m.match(/(?:显示|展示|返回)\s*(?:内容)?(?:是|为)?\s*[:：]?\s*([^\n]{1,120})$/i);
  const helloCn = m.match(/\bhello(?:\s+world)?\s+([^，。！？\n]+)/i);
  const raw = (quotedMatch?.[1] ?? displayMatch?.[1] ?? (helloCn?.[1] ? `hello ${helloCn[1]}` : undefined))?.trim();
  if (!raw) return undefined;

  const cleaned = raw.replace(/^(?:内容)?(?:是|为)\s*/i, "").replace(/["'`<>\\]/g, "").trim();
  if (!cleaned) return undefined;
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
}

export function getHelloWebStateFile(stateDir: string, sessionId: string): string {
  const raw = (sessionId || "default").trim() || "default";
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "default";
  return `${stateDir}/${cleaned}.json`;
}

export function buildHelloWebCleanupCommand(stateFile: string, pid?: number): string {
  return (
    `sh -lc 'STATE_FILE="${stateFile}"; ` +
    `kill ${pid ?? '$(command -v python3 >/dev/null 2>&1 && [ -f "' + stateFile + '" ] && python3 -c "import json; d=json.load(open(\\"' + stateFile + '\\",\\"r\\")); print(int(d.get(\\"pid\\",0)))" 2>/dev/null || echo 0)'} 2>/dev/null || true; ` +
    `sleep 0.2; ` +
    `command -v python3 >/dev/null 2>&1 && python3 -c "import os; p=\\"${stateFile}\\"; os.path.exists(p) and os.remove(p)" 2>/dev/null || true; ` +
    `echo OSA_RESULT:UPDATED:service:hello-web:cleaned'`
  );
}

export function buildHelloWebStartCommand(params: {
  stateDir: string;
  stateFile: string;
  desiredB64: string;
}): string {
  const { stateDir, stateFile, desiredB64 } = params;
  return (
    `sh -lc '` +
    `command -v python3 >/dev/null 2>&1 || { echo OSA_RESULT:FAILED:service:hello-web:python3-missing; exit 1; }; ` +
    `STATE_FILE="${stateFile}"; ` +
    `WEB_DIR="${stateFile.replace(/\.json$/, ".site")}"; ` +
    `LOG_FILE="${stateFile.replace(/\.json$/, ".log")}"; ` +
    `mkdir -p "${stateDir}"; ` +
    `mkdir -p "$WEB_DIR"; ` +
    `rm -f "$STATE_FILE"; ` +
    `rm -f "$LOG_FILE"; ` +
    `MSG_B64="${desiredB64}" WEB_DIR="$WEB_DIR" python3 -c "import os,base64,html; d=os.environ.get(\\"WEB_DIR\\",\\"/tmp\\"); msg=base64.b64decode(os.environ.get(\\"MSG_B64\\",\\"\\" )).decode(\\"utf-8\\",\\"ignore\\").strip() or \\"hello world\\"; open(os.path.join(d,\\"raw\\"),\\"w\\",encoding=\\"utf-8\\").write(msg+\\"\\\\n\\"); open(os.path.join(d,\\"index.html\\"),\\"w\\",encoding=\\"utf-8\\").write(\\"<!doctype html><html><head><meta charset=\\\\\\"utf-8\\\\\\"><title>Hello</title></head><body><h1>\\"+html.escape(msg)+\\"</h1><p>curl -sS http://127.0.0.1:{port}/raw ; echo</p></body></html>\\")" >/dev/null 2>&1 || { echo OSA_RESULT:FAILED:service:hello-web:prepare-files; exit 1; }; ` +
    `PORT=$(python3 -c "import socket; s=socket.socket(); s.bind((\\"127.0.0.1\\",0)); print(s.getsockname()[1]); s.close()" 2>/dev/null || echo 0); ` +
    `[ -n "$PORT" ] && [ "$PORT" != "0" ] || { echo OSA_RESULT:FAILED:service:hello-web:port-alloc; exit 1; }; ` +
    `nohup python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$WEB_DIR" >"$LOG_FILE" 2>&1 </dev/null & ` +
    `PID=$!; READY=0; ` +
    `for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do ` +
    `python3 -c "import urllib.request,sys; p=\\"$PORT\\"; urllib.request.urlopen(\\"http://127.0.0.1:%s/raw\\"%p, timeout=1).read(); sys.exit(0)" >/dev/null 2>&1 && { READY=1; break; }; ` +
    `kill -0 "$PID" 2>/dev/null || break; ` +
    `sleep 0.25; ` +
    `done; ` +
    `[ "$READY" = "1" ] || (kill $PID 2>/dev/null || true; rm -f "$STATE_FILE"; echo OSA_RESULT:FAILED:service:hello-web:not-listening; [ -f "$LOG_FILE" ] && tail -n 20 "$LOG_FILE"; exit 1); ` +
    `python3 -c "import json; json.dump({\\"pid\\": int(\\"$PID\\"), \\"port\\": int(\\"$PORT\\"), \\"web_dir\\": \\"$WEB_DIR\\", \\"log_file\\": \\"$LOG_FILE\\"}, open(\\"$STATE_FILE\\",\\"w\\"))" 2>/dev/null || true; ` +
    `PORT="$PORT" EXPECT_B64="${desiredB64}" python3 -c "import os,base64,urllib.request,sys; port=os.environ.get(\\"PORT\\",\\"\\"); exp=base64.b64decode(os.environ.get(\\"EXPECT_B64\\",\\"\\")).decode(\\"utf-8\\",\\"ignore\\").strip(); body=urllib.request.urlopen(\\"http://127.0.0.1:%s/raw\\"%port, timeout=2).read().decode(\\"utf-8\\",\\"ignore\\").strip(); sys.exit(0 if body==exp else 2)" >/dev/null 2>&1 || (kill $PID 2>/dev/null || true; rm -f "$STATE_FILE"; echo OSA_RESULT:FAILED:service:hello-web:self-test; exit 1); ` +
    `echo OSA_RESULT:UPDATED:service:hello-web:ready; ` +
    `echo OSA_RESULT:CREATED:service:hello-web:port=$PORT; ` +
    `echo OSA_RESULT:CREATED:process:pid=$PID; ` +
    `echo OSA_RESULT:UPDATED:hint:curl=curl\\ -sS\\ http://127.0.0.1:$PORT/raw\\ \\;\\ echo;` +
    `'`
  );
}
