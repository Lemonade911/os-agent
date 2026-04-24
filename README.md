# FusionOS Agent

## 项目简介

FusionOS Agent 是一个面向远程执行场景的 Agent 服务：通过 HTTP 接口接收请求，经过运行时编排与安全策略校验后，调用执行器（如 SSH）在目标机器执行任务，并返回统一结果。

- 架构图：`ARCHITECTURE.md`
- 设计文档：`DESIGN.md`

---

## 新版启动方式（推荐）

本项目已切换到**启动器**，入口为根目录的：

- `项目启动器.exe`

双击后会打开中文 GUI，按页面提示填写配置即可。

### 按钮说明（新版）

- `保存配置`：只写入配置，不启动服务
- `保存并启动`：写入配置后，自动执行依赖安装并启动开发服务

### 配置项说明

- **LLM 配置**
  - `LLM_API_KEY`：模型 API Key
  - `LLM_BASE_URL`：模型服务地址
  - `LLM_MODEL`：模型名称

- **SSH 配置（远程执行）**
  - `SSH_HOST` / `SSH_PORT` / `SSH_USERNAME`
  - `SSH_PASSWORD`：登录密码（留空表示不改原值）

- **前端联动配置**
  - `API_HOST`：前端访问后端地址（本机常用 `127.0.0.1`）
  - `AGENT_PORT`：服务端口（会同步到 `.env` 和 HTML `API_URL`）
  - `HTML_FILE`：下拉选择要同步 `API_URL` 的 html 文件

### 写入位置

点击保存后会同步写入：

- `.env`（如 `OS_AGENT_PORT`、LLM/SSH 相关配置）
- 选中的 `HTML_FILE`（默认 `fusion-agent.html`）里的 `API_URL`

---

## 命令行启动（备用）

在项目根目录执行：

```bash
corepack pnpm install --config.confirmModulesPurge=false
corepack pnpm run dev
```

---

## 常见问题

- **改完配置后，编辑器里没马上刷新**
  - 文件通常已写入磁盘，重新打开该文件即可看到最新内容。

- **端口改成 3003 可以吗**
  - 可以，只要端口未被占用；新版启动器会自动同步端口到 `.env` 和 HTML。

- **一键启动时会安装依赖吗**
  - 会。`保存并启动` 会自动执行安装依赖并启动服务。

