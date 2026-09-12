<h1 align="center">Biny</h1>

<p align="center">本地优先的开发协作 Agent，面向 macOS 的 Desktop、TUI 与 CLI。</p>

<p align="center">
  <a href="https://github.com/JubinJean/Biny-Agent">GitHub</a> ·
  <a href="#about">About</a> ·
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#development">Development</a>
</p>

> 🚧 This project is under active development. APIs, commands, and behavior may change as the implementation evolves.

## About

Biny 是一个用于本地工作的 AI Agent 底座。它支持在同一套会话中完成对话、任务执行、文件与项目上下文处理，目标是让工作在本地环境内连续、可追踪、可恢复。

项目面向两类用户：

- 用户：直接用桌面端或终端启动助手，处理日常工作。
- 开发者：扩展工具链、接入 MCP/Plugin/Skill，并参与本地运行时能力建设。

## Features

- Desktop、TUI、CLI 多入口统一会话与配置。
- 会话和上下文优先落在本地，默认减少对云端状态的依赖。
- 任务能力支持轻量清单、可恢复流程和长期目标。
- 本地记忆与活动记录用于跨会话延续。
- 可通过 MCP、Plugin、Skill 扩展外部能力。

## Quick Start

```bash
git clone https://github.com/JubinJean/Biny-Agent.git
cd Biny-Agent
corepack enable
corepack prepare pnpm@10.6.5 --activate
pnpm install --frozen-lockfile
pnpm dev -- init
```

初始化可以重复执行，不会覆盖已有配置。完成后配置模型连接：

- Desktop：在设置页配置模型；
- CLI：也可用 `providers.<alias>.apiKeyEnv` 指定密钥来源。

```bash
export DEEPSEEK_API_KEY="YOUR_API_KEY"
pnpm dev -- doctor
```

## Usage

### Desktop

```bash
pnpm desktop:dev
```

### TUI / Chat

```bash
pnpm dev -- tui
pnpm dev -- chat
```

### One-shot Command

```bash
pnpm dev -- run "梳理这个仓库，并说明最优先的风险点"
```

查看完整命令参数：

```bash
pnpm dev -- --help
```

## Development

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

如需在本地验证 TUI 改动，请在目标项目目录中执行 `biny tui` 或 `biny chat`，并先运行 `pnpm build:cli`。
