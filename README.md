<h1 align="center">Biny</h1>

<p align="center">本地优先的 AI Agent，支持 macOS Desktop、TUI 与 CLI。</p>

<p align="center">
  <a href="https://github.com/JubinJean/Biny-Agent">GitHub</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#可以做什么">功能</a> ·
  <a href="#运行方式">运行方式</a>
</p>

## Biny 是什么

Biny 使用你自己配置的模型，在工作区中协助编码、研究和文件处理。配置、会话与记忆默认保存在本机；模型调用和启用的网络工具会按你的配置发送请求。

## 可以做什么

- 在 Desktop、TUI 或 CLI 中与 Agent 对话、执行任务或先生成计划。
- 在工作区读写文件、搜索代码、使用 Git、运行 Shell 命令和管理进程。
- 使用 Todo 管理任务，并保留会话、工具结果与任务状态，便于继续处理。
- 接入 MCP、Plugin 和 Skill 扩展能力。
- 管理模型、权限、记忆和活动记录等本地设置。
- 进行“情绪/活动/记忆”协同：Agent 会保留会话级情绪上下文，通过 `update_emotion` 在对话中更新情绪状态；并将窗口内活动归档为可检索的活动记录（含报告与摘要）；同时提供本地持久记忆用于跨会话复用背景信息。

## 情绪机制

Biny 按会话和全局保存情绪状态，支持模型在回复前读取并注入情绪上下文（`update_emotion` 工具驱动更新）。  
情绪影响主要是对话风格与主动性（如回复节奏、长度、语气），不改变任务目标、权限边界或执行能力。  
如果你更偏好固定表达风格，可在设置里关闭情绪注入或限制模型更新。

## 活动机制

Biny 会记录会话期间的本地活动摘要（例如主题、时间线、PR/问题/讨论线索等），并支持按需查询。  
可通过活动工具获取日常汇总、近时段摘要、活动检索与会话详情，让“今天做了什么 / 刚才在干嘛 / 找回某项历史记录”更容易被回答。  
活动分析与注入均受隐私策略约束；敏感内容与原始采集数据不会被无差别发送到云侧。

## 记忆机制

记忆是本地优先的持久上下文：  
- 工具化调用 `save_memory` / `recall_memory` 写入与检索记忆。  
- 记忆会通过可控策略参与上下文注入，默认以稳健优先级处理，不会覆盖用户当前指令、会话事实和权限规则。  
- 提供“记忆维护/归档/重建”等后台能力，帮助长期使用时维持检索质量。  
- 你可以在会话中仅开启当前聊天记忆，或按项目/全局范围控制记忆范围。

## 渐进式扩展：Skill / MCP / CLI

建议按三层理解和对外说明：

- Skill（内置能力）：Biny 的能力包，分“先说明、后加载”两步。  
  你通常先在对话里看到某些技能名（例如记忆、反思、任务、计划相关技能），要使用时再显式加载；这样可以减少初始上下文噪音并降低误触发风险。
- MCP（外部能力）：通过 MCP 连接器接入第三方工具和服务（如 GitHub、数据库、搜索网关等），属于“联网执行能力边界”层，默认受权限与策略控制，不等于本地记忆数据。  
- CLI（底座入口）：`biny` 命令是统一入口，既能发起对话、也能执行一次性任务、也能拉起 TUI。`pnpm` 下发的本地命令只用于开发调试与本地运行方式，产品入口与功能调度统一走 `biny`。

## 安全提示

Biny 使用当前操作系统账户的权限运行，不是隔离容器。处理陌生或重要工作区时，请在设置或 `/permissions` 中选用 `ask` 或 `read-only`。不要把 API key、token 或业务密钥提交到仓库。

## 快速开始

需要 Node.js 22 和 `pnpm@10.6.5`。Desktop 目前面向 macOS。

```bash
git clone https://github.com/JubinJean/Biny-Agent.git
cd Biny-Agent
corepack enable
corepack prepare pnpm@10.6.5 --activate
pnpm install --frozen-lockfile
pnpm dev -- init
```

`init` 可以重复运行，不会覆盖已有配置。随后在 Desktop 的 **设置 → 模型** 中添加模型连接并选择默认模型；也可通过 `providers.<alias>.apiKeyEnv` 使用环境变量提供密钥。

```bash
export DEEPSEEK_API_KEY="YOUR_API_KEY"
pnpm dev -- doctor
```

## 运行方式

```bash
# Desktop
pnpm desktop:dev

# TUI / 对话
pnpm dev -- tui
pnpm dev -- chat

# 一次性执行
pnpm dev -- run "梳理这个仓库，并说明最需要先处理的风险"
```

运行 `pnpm dev -- --help` 查看完整命令和参数。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

修改 TUI 后，先运行 `pnpm build:cli`，再到任意目标项目目录使用全局 `biny tui` 或 `biny chat` 验证真实入口。
