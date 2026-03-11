# OpenClaw 架构文档

> **"Gateway is just the control plane — the product is the assistant."**

OpenClaw 是一个**本地优先（local-first）**的单用户 AI 助手网关平台。它通过一个 Gateway 控制面将多个消息渠道（WhatsApp、Telegram、Slack、Discord 等 15+ 平台）连接到 AI Agent 运行时，同时提供 macOS/iOS/Android 伴侣应用作为原生交互界面。

---

## 目录

1. [项目概述](#1-项目概述)
2. [高层架构](#2-高层架构)
3. [核心组件详解](#3-核心组件详解)
4. [数据流分析](#4-数据流分析)
5. [架构 Tradeoff 分析](#5-架构-tradeoff-分析)
6. [技术栈速查表](#6-技术栈速查表)
7. [目录结构速查](#7-目录结构速查)

---

## 1. 项目概述

### 定位

- **本地优先**：所有数据（对话历史、配置、向量索引）存储在用户本机 SQLite 数据库中
- **单用户网关**：一个 Gateway 实例服务一个用户，跨多个消息渠道统一管理
- **核心理念**：Gateway 只是控制面，真正的产品是 AI 助手本身

### 技术栈一览

| 类别            | 技术                                                |
| --------------- | --------------------------------------------------- |
| Runtime         | Node.js ≥22.12, TypeScript 5.9                      |
| Build           | tsdown, esbuild, rolldown                           |
| Test            | Vitest (unit/e2e/live/gateway)                      |
| Agent Core      | pi-agent-core, pi-ai, pi-coding-agent               |
| HTTP/WS         | Hono, Express, ws                                   |
| Data            | SQLite + sqlite-vec + FTS5                          |
| Schema          | Zod 4, TypeBox, AJV                                 |
| CLI             | Commander.js, @clack/prompts                        |
| Native Apps     | Swift/SwiftUI (macOS/iOS), Kotlin/Compose (Android) |
| Package Manager | pnpm 10 (monorepo workspaces)                       |

---

## 2. 高层架构

### 图 1：全局系统拓扑

```
                          ┌──────────────────────────────────────────────────┐
                          │              Native Apps (Nodes)                 │
                          │  ┌─────────┐  ┌─────────┐  ┌──────────────┐    │
                          │  │  macOS   │  │   iOS   │  │   Android    │    │
                          │  │ Menu Bar │  │  Swift  │  │   Kotlin     │    │
                          │  └────┬────┘  └────┬────┘  └──────┬───────┘    │
                          └───────┼────────────┼──────────────┼────────────┘
                                  │   WebSocket / mDNS        │
    ┌─────────────────────────────┼────────────┼──────────────┼───────────┐
    │                             ▼            ▼              ▼           │
    │   Messaging Channels    ┌──────────────────────────────────┐        │
    │  ┌──────────┐           │         GATEWAY (控制面)          │        │
    │  │ WhatsApp  │◄────────►│                                  │        │
    │  │ Telegram  │◄────────►│  HTTP/WS Server ◄─► RPC Router  │        │
    │  │ Slack     │◄────────►│       │              │           │        │
    │  │ Discord   │◄────────►│       ▼              ▼           │        │
    │  │ Signal    │◄────────►│  Session Mgr    Config Mgr      │        │
    │  │ iMessage  │◄────────►│       │              │           │        │
    │  │ GChat     │◄────────►│       ▼              ▼           │        │
    │  │ Matrix    │◄────────►│  Channel Mgr    Plugin Registry  │        │
    │  │ ...15+    │◄────────►│       │              │           │        │
    │  └──────────┘           └───────┼──────────────┼───────────┘        │
    │                                 │              │                    │
    │                                 ▼              ▼                    │
    │                          ┌─────────────────────────┐                │
    │                          │    Agent Runtime (Pi)    │                │
    │                          │  ┌─────────┐ ┌────────┐ │                │
    │                          │  │ Tools   │ │ Skills │ │                │
    │                          │  └────┬────┘ └────┬───┘ │                │
    │                          └───────┼───────────┼─────┘                │
    │                                  │           │                      │
    │                    ┌─────────────┼───────────┼───────────┐          │
    │                    │             ▼           ▼           │          │
    │                    │  ┌──────────────┐ ┌───────────┐    │          │
    │                    │  │  Memory/Vec  │ │  Browser  │    │          │
    │                    │  │  SQLite+FTS  │ │ Playwright│    │          │
    │                    │  └──────────────┘ └───────────┘    │          │
    │                    │         Subsystems                  │          │
    │                    └────────────────────────────────────┘          │
    │                              OpenClaw (本机)                       │
    └───────────────────────────────────────────────────────────────────┘
```

### 图 2：Gateway 内部组件

```
    ┌────────────────────────────── Gateway ──────────────────────────────┐
    │                                                                     │
    │  ┌──────────────────┐    ┌──────────────────────────────────────┐  │
    │  │  HTTP/WS Server   │    │          RPC Handler Router          │  │
    │  │  (Hono + ws)      │───►│                                      │  │
    │  │  port: 18789      │    │  agent.*     sessions.*   config.*   │  │
    │  │  TLS optional     │    │  chat.*      channels.*   wizard.*   │  │
    │  └──────────────────┘    │  nodes.*     skills.*     cron.*     │  │
    │          │                │  send        health       models.*   │  │
    │          │                │  devices.*   logs.*       tts.*      │  │
    │          ▼                │  exec.*      browser.*    system.*   │  │
    │  ┌──────────────────┐    └──────────────────────────────────────┘  │
    │  │  Auth & Scopes    │                     │                       │
    │  │  ┌─────────────┐  │                     ▼                       │
    │  │  │ admin       │  │    ┌──────────────────────────────────────┐ │
    │  │  │ read        │  │    │          Core Subsystems              │ │
    │  │  │ write       │  │    │                                      │ │
    │  │  │ approvals   │  │    │  ┌────────────┐  ┌───────────────┐  │ │
    │  │  │ pairing     │  │    │  │ Channel Mgr│  │ Session Mgr   │  │ │
    │  │  └─────────────┘  │    │  └─────┬──────┘  └───────┬───────┘  │ │
    │  └──────────────────┘    │        │                  │          │ │
    │                          │  ┌─────▼──────┐  ┌───────▼───────┐  │ │
    │  ┌──────────────────┐    │  │ Plugin Reg │  │ Node Registry │  │ │
    │  │  Event Bus        │    │  └────────────┘  └───────────────┘  │ │
    │  │  broadcast()      │    │                                      │ │
    │  │  broadcastToConn  │    │  ┌────────────┐  ┌───────────────┐  │ │
    │  │  NodeSubscription │    │  │ Cron Svc   │  │ Config Reload │  │ │
    │  └──────────────────┘    │  └────────────┘  └───────────────┘  │ │
    │                          └──────────────────────────────────────┘ │
    └─────────────────────────────────────────────────────────────────────┘
```

### 图 3：消息生命周期

```
    Inbound                                                    Outbound
    ═══════                                                    ════════

    ┌──────────┐   ┌───────────┐   ┌─────────────┐   ┌──────────────┐
    │ Channel   │   │ Normalize │   │ Session     │   │ Auto-Reply   │
    │ Webhook/  │──►│ & Route   │──►│ Resolution  │──►│ Pipeline     │
    │ Polling   │   │           │   │ (scope/dm)  │   │              │
    └──────────┘   └───────────┘   └──────┬──────┘   └──────┬───────┘
                                          │                   │
                   ┌──────────────────────┘                   │
                   ▼                                          ▼
           ┌──────────────┐                          ┌──────────────┐
           │ Hook:        │                          │ Pi Agent     │
           │ message_     │                          │ Execution    │
           │ received     │                          │ (LLM call)   │
           └──────────────┘                          └──────┬───────┘
                                                            │
                                                            ▼
                                                   ┌──────────────┐
                                                   │ Block        │
                                                   │ Streaming    │
                                                   │ Coalescer    │
                                                   └──────┬───────┘
                                                          │
                                          ┌───────────────┼───────────┐
                                          ▼               ▼           ▼
                                   ┌───────────┐   ┌──────────┐ ┌─────────┐
                                   │ Channel   │   │ Native   │ │ WebChat │
                                   │ Outbound  │   │ App Node │ │         │
                                   │ Delivery  │   │ (WS)     │ │         │
                                   └───────────┘   └──────────┘ └─────────┘
```

---

## 3. 核心组件详解

### 3.1 Gateway (`src/gateway/`, ~131 files)

Gateway 是 OpenClaw 的**控制面**，负责编排所有子系统的启动、消息路由和客户端通信。

```
    Gateway Server
    ├── HTTP Server (Hono)          ─── REST API + Control UI
    ├── WebSocket Server (ws)       ─── Node/App 实时通信
    ├── RPC Router                  ─── 24+ handler 域 (AJV 校验)
    ├── Channel Manager             ─── 多平台连接生命周期
    ├── Node Registry               ─── Native app 注册与发现
    ├── Event Broadcasting          ─── 事件广播 (全局/定向)
    ├── Cron Service                ─── 定时任务调度
    ├── Config Reloader             ─── 热重载配置
    └── Discovery (mDNS/Bonjour)    ─── 局域网网关发现
```

**关键文件**：

| 文件                  | 职责                                                     |
| --------------------- | -------------------------------------------------------- |
| `server.impl.ts`      | 启动编排（70+ import），初始化所有子系统                 |
| `server-methods.ts`   | RPC 路由分发，合并 24+ handler 文件                      |
| `server-methods/*.ts` | 各域 handler（agent, chat, sessions, config...）         |
| `protocol/schema.ts`  | AJV JSON Schema 验证器（ConnectParams, RequestFrame...） |

**Bind 模式**：`loopback`（127.0.0.1）| `lan`（0.0.0.0）| `tailnet`（Tailscale）| `auto`

**授权 Scope**：`operator.admin` | `operator.read` | `operator.write` | `operator.approvals` | `operator.pairing`

---

### 3.2 Agent System (`src/agents/`, ~312 files)

Agent 是 OpenClaw 的"大脑"——基于 Pi Agent Core 的嵌入式 AI 运行时。

```
    Agent Runtime
    ├── Pi Embedded Runner          ─── 核心执行引擎
    │   ├── run.ts                  ─── 执行入口 (workspace/sandbox/tools/skills)
    │   └── run/attempt.ts          ─── 单轮 LLM 调用 + streaming 订阅
    ├── Embedded Subscribe          ─── 流式事件订阅
    │   ├── Block Chunker           ─── 段落级分块输出
    │   ├── Reasoning Filter        ─── <think> 标签过滤
    │   └── Dedup & Merge           ─── 文本去重合并
    ├── Tools Registry              ─── Agent 可用工具集
    │   ├── Messaging Tools         ─── 发消息 / 回复
    │   ├── Browser Tools           ─── 网页浏览 / 截图
    │   ├── File Tools              ─── 文件读写 / 代码执行
    │   └── Channel-Specific        ─── Discord/Slack actions
    ├── Sandbox                     ─── 代码执行沙箱
    └── Skills System               ─── 可安装 skill 扩展
```

**关键文件**：

| 文件                        | 职责                                               |
| --------------------------- | -------------------------------------------------- |
| `pi-embedded-runner/run.ts` | Agent 执行入口，解析 config/tools/skills/workspace |
| `pi-embedded-subscribe.ts`  | 流式输出订阅，Block Chunker 控制输出粒度           |
| `tools/*.ts`                | Agent 工具定义（messaging, browser, file, etc.）   |
| `agent-scope.ts`            | Agent workspace 路径解析                           |

**执行流程**：Config → Workspace 解析 → Tools 注册 → Skills 加载 → LLM 调用 → Stream 订阅 → Block Reply

---

### 3.3 Channel System (`src/channels/` + 各平台目录)

Channel System 提供统一的 `ChannelPlugin` 抽象，将 15+ 消息平台接入 Gateway。

```
    Channel Layer
    ├── Registry                    ─── 渠道注册与发现
    ├── ChannelPlugin Interface     ─── 统一插件接口
    │   ├── Config Adapter          ─── 账号配置管理
    │   ├── Gateway Adapter         ─── 连接生命周期 (start/stop/QR login)
    │   ├── Outbound Adapter        ─── 消息投递 (text/media/poll)
    │   ├── Security Adapter        ─── DM Policy / Allowlist
    │   ├── Threading Adapter       ─── 消息回复模式 (off/first/all)
    │   ├── Directory Adapter       ─── 联系人/群组查询
    │   └── Status Adapter          ─── 健康检查 / 审计
    └── Platform Implementations
        ├── telegram/               ─── grammY Bot API
        ├── whatsapp/               ─── Baileys (QR login)
        ├── slack/                  ─── Bolt Socket Mode
        ├── discord/                ─── discord.js
        ├── signal/                 ─── signal-cli linked device
        ├── googlechat/             ─── Chat API webhook
        └── ...15+ platforms
```

**关键文件**：

| 文件                                 | 职责                         |
| ------------------------------------ | ---------------------------- |
| `channels/plugins/types.plugin.ts`   | ChannelPlugin 完整接口定义   |
| `channels/plugins/types.adapters.ts` | 各 Adapter 类型定义          |
| `channels/registry.ts`               | 渠道注册表，静态 + 动态插件  |
| `channels/dock.ts`                   | ChannelDock（UI 展示元数据） |

**支持的渠道**：Telegram, WhatsApp, Slack, Discord, Signal, iMessage, Google Chat, Matrix, MS Teams, LINE, Feishu, Mattermost, Nextcloud Talk, Nostr, Twitch, Zalo, BlueBubbles

---

### 3.4 Plugin System (`src/plugins/`, ~37 files)

Plugin System 提供 7 种插件类型，支持从 bundled / global / workspace / config 四个来源加载。

```
    Plugin Registry
    ├── Tool Plugins          ─── 为 Agent 添加自定义工具
    ├── Hook Plugins          ─── 14 个生命周期事件钩子
    ├── Channel Plugins       ─── 新消息渠道接入
    ├── Provider Plugins      ─── LLM / Embedding 供应商
    ├── HTTP Plugins          ─── 自定义 HTTP 路由
    ├── CLI Plugins           ─── Commander.js 子命令扩展
    ├── Service Plugins       ─── 后台服务 (start/stop 生命周期)
    └── Command Plugins       ─── 简单命令 handler
```

**关键文件**：

| 文件          | 职责                                                     |
| ------------- | -------------------------------------------------------- |
| `registry.ts` | `createPluginRegistry()` — 统一注册表创建                |
| `types.ts`    | `OpenClawPluginDefinition`, `OpenClawPluginApi` 完整接口 |

**Plugin 生命周期**：Discovery → Load → Register → Enable → Activate → Runtime → Close

**Plugin API** 提供 `registerTool()`, `registerHook()`, `registerChannel()`, `registerProvider()`, `registerHttpHandler()`, `registerCli()`, `registerService()` 等注册方法。

---

### 3.5 Memory System (`src/memory/`, ~45 files)

Memory System 基于 SQLite 实现本地持久化记忆，结合 FTS5 全文检索和 sqlite-vec 向量搜索提供混合搜索能力。

```
    Memory Index Manager
    ├── SQLite Database
    │   ├── files table          ─── 文件元数据 (path, hash, mtime)
    │   ├── chunks table         ─── 文本分块 + embedding 向量
    │   ├── chunks_fts (FTS5)    ─── BM25 全文检索虚拟表
    │   └── chunks_vec (vec0)    ─── sqlite-vec 向量搜索虚拟表
    │
    ├── Embedding Pipeline
    │   ├── OpenAI               ─── text-embedding-3-large/small
    │   ├── Gemini               ─── text-embedding-004
    │   ├── Voyage               ─── voyage-3 / voyage-3-lite
    │   └── Local LLaMA          ─── node-llama-cpp
    │
    ├── Hybrid Search
    │   ├── Vector Search        ─── cosine similarity via sqlite-vec
    │   ├── Keyword Search       ─── BM25 via FTS5
    │   └── Score Fusion         ─── weighted combination
    │
    └── Sync Engine
        ├── File Watcher         ─── debounced fs.watch
        ├── Session Delta Sync   ─── 增量 JSONL 解析
        └── Full Reindex         ─── 模型/配置变更时触发
```

**关键文件**：

| 文件                | 职责                                   |
| ------------------- | -------------------------------------- |
| `manager.ts`        | `MemoryIndexManager` — 索引管理核心类  |
| `hybrid.ts`         | 混合搜索（BM25 + Vector score fusion） |
| `sqlite-vec.ts`     | sqlite-vec 扩展加载，动态维度向量表    |
| `manager-search.ts` | 搜索接口实现                           |
| `embeddings.ts`     | Embedding pipeline 路由                |

**搜索公式**：`score = vectorWeight × vectorScore + textWeight × textScore`

**Memory 来源**：`MEMORY.md` / `memory/` 目录（workspace 记忆）+ Session 转录文件（对话历史）

---

### 3.6 Auto-Reply Pipeline (`src/auto-reply/`, ~73 files)

Auto-Reply Pipeline 是消息从 inbound 到 outbound 的核心处理链路。

```
    Auto-Reply Pipeline
    ├── Inbound Processing
    │   ├── Message Normalization    ─── 标准化消息格式
    │   ├── Session Resolution       ─── scope/dmScope 路由
    │   └── Queue & Debounce         ─── 消息队列合并
    │
    ├── Reply Generation
    │   ├── get-reply.ts             ─── 回复逻辑入口
    │   ├── Agent Invocation         ─── Pi Agent LLM 调用
    │   └── Reply Directives         ─── 解析回复指令
    │
    └── Outbound Processing
        ├── Block Streaming          ─── 段落级流式输出
        │   ├── Coalescer            ─── min/max chars 合并
        │   └── Paragraph Break      ─── 段落边界检测
        ├── Text Chunking            ─── 平台长度限制分块
        └── Channel Delivery         ─── 多渠道投递
```

**关键文件**：

| 文件                            | 职责                                       |
| ------------------------------- | ------------------------------------------ |
| `reply/get-reply.ts`            | 核心回复逻辑入口                           |
| `reply/block-streaming.ts`      | Block Streaming 配置与 coalescing          |
| `chunk.ts`                      | 文本分块策略（paragraph/newline/sentence） |
| `reply/reply-directives.ts`     | 回复指令解析                               |
| `reply/streaming-directives.ts` | 流式指令累加器                             |

**Block Streaming 默认参数**：`minChars=800`, `maxChars=1200`, `coalesceIdleMs=1000`

---

### 3.7 Config System (`src/config/`, ~127 files)

Config System 提供类型安全的 YAML/JSON5 配置管理，支持热重载、遗留迁移和 Zod 验证。

```
    Config System
    ├── IO Layer
    │   ├── loadConfig()          ─── 配置加载入口
    │   ├── JSON5 Parse           ─── 支持注释和尾逗号
    │   ├── $include Resolution   ─── 文件包含指令
    │   └── Env Substitution      ─── ${VAR} 环境变量替换
    │
    ├── Validation
    │   ├── Zod Schema            ─── 类型安全验证
    │   ├── Plugin Schema Merge   ─── 插件配置 schema 合并
    │   └── Legacy Detection      ─── 旧格式自动识别
    │
    ├── Migration
    │   ├── legacy-migrate.ts     ─── 迁移入口
    │   ├── Part 1 Migrations     ─── 基础字段迁移
    │   └── Part 2 Migrations     ─── 高级结构迁移
    │
    └── Hot Reload
        ├── Config Reloader       ─── 文件变更监听
        └── Reload Handlers       ─── 变更应用逻辑
```

**关键类型**：

| 类型           | 定义位置        | 说明                                                     |
| -------------- | --------------- | -------------------------------------------------------- |
| `SessionScope` | `types.base.ts` | `"per-sender"` \| `"global"`                             |
| `DmScope`      | `types.base.ts` | `"main"` \| `"per-peer"` \| `"per-channel-peer"`         |
| `DmPolicy`     | `types.base.ts` | `"pairing"` \| `"allowlist"` \| `"open"` \| `"disabled"` |
| `ReplyMode`    | `types.base.ts` | `"text"` \| `"command"`                                  |
| `ReplyToMode`  | `types.base.ts` | `"off"` \| `"first"` \| `"all"`                          |
| `GroupPolicy`  | `types.base.ts` | `"open"` \| `"disabled"` \| `"allowlist"`                |
| `TypingMode`   | `types.base.ts` | `"never"` \| `"instant"` \| `"thinking"` \| `"message"`  |

**配置路径**：`~/.state/openclaw/config.json5`（可通过 `OPENCLAW_CONFIG_PATH` 覆盖）

---

### 3.8 Hook System (`src/hooks/`, ~30 files)

Hook System 提供事件驱动的扩展机制，支持 bundled、workspace 和 plugin 三种来源。

```
    Hook System
    ├── Internal Hooks             ─── 事件驱动核心
    │   ├── command events         ─── command:new, command:invoke
    │   ├── session events         ─── session:start, session:end
    │   ├── agent events           ─── agent:bootstrap, before_agent_start
    │   └── gateway events         ─── gateway:start, gateway:stop
    │
    ├── Hook Discovery
    │   ├── Bundled                ─── src/hooks/bundled/*/HOOK.md
    │   ├── Workspace              ─── {workspace}/hooks/*/HOOK.md
    │   └── Plugin                 ─── 插件注册的 hooks
    │
    ├── Eligibility Check
    │   ├── OS Filter              ─── darwin/linux/win32
    │   ├── Binary Deps            ─── requires.bins / requires.anyBins
    │   ├── Config Deps            ─── requires.config
    │   └── Enable/Disable         ─── hooks.internal.entries.{name}.enabled
    │
    └── Bundled Hooks
        ├── command-logger         ─── 命令审计日志
        ├── session-memory         ─── /new 时保存会话记忆
        └── boot-md                ─── Agent bootstrap 上下文
```

**关键文件**：

| 文件                | 职责                                             |
| ------------------- | ------------------------------------------------ |
| `types.ts`          | `Hook`, `HookEntry`, `OpenClawHookMetadata` 定义 |
| `internal-hooks.ts` | 事件注册 / 触发核心                              |
| `loader.ts`         | Hook 加载与初始化                                |
| `config.ts`         | `shouldIncludeHook()` 资格检查                   |

**HOOK.md 格式**：Frontmatter（name, events, requires, os）+ Markdown 描述

---

### 3.9 CLI (`src/cli/`, ~107 files)

基于 Commander.js 的命令行界面，采用**懒加载**架构确保启动速度。

**核心命令**：

| 命令       | 说明                              |
| ---------- | --------------------------------- |
| `onboard`  | 引导式初始化（推荐入口）          |
| `gateway`  | Gateway 服务管理 (start/stop/dev) |
| `agent`    | AI Agent 直接调用                 |
| `config`   | 配置文件管理                      |
| `channels` | 渠道认证与管理                    |
| `sessions` | 会话管理                          |
| `memory`   | 记忆系统管理                      |
| `skills`   | Skill 安装与管理                  |
| `cron`     | 定时任务                          |
| `nodes`    | 已连接 Node 管理                  |
| `health`   | 系统健康检查                      |

---

### 3.10 Native Apps (`apps/`)

| 平台    | 技术栈                            | 最低版本 | 状态   |
| ------- | --------------------------------- | -------- | ------ |
| macOS   | Swift + SwiftUI + SPM             | macOS 15 | Stable |
| iOS     | Swift + SwiftUI + XcodeGen        | iOS 18   | Alpha  |
| Android | Kotlin + Jetpack Compose + Gradle | SDK 31   | Active |

**共享代码**：`apps/shared/OpenClawKit/` — 协议定义、Chat UI 组件、WebSocket 传输层

**连接方式**：Native App 作为 Node 通过 WebSocket 连接 Gateway，支持 mDNS 自动发现 (`_openclaw-gw._tcp`)

---

### 3.11 Workspace 与 Agent 状态管理

Agent 的运行时状态分为两个物理目录：**Workspace**（用户空间）和 **agentDir**（系统空间），遵循"用户可编辑 vs 系统敏感"的隔离原则。

#### Workspace — Agent 的身份定义域

Workspace 是 Agent 所有用户可编辑文件的根目录，是 Bootstrap/Memory/Hook/Skills 的统一数据源。

```
    {workspace}/                          # 默认 ~/.openclaw/workspace
    ├── SOUL.md                           # Agent 人格与行为指南
    ├── AGENTS.md                         # 多 Agent 配置
    ├── TOOLS.md                          # 工具使用指南
    ├── IDENTITY.md                       # 身份信息
    ├── USER.md                           # 用户偏好
    ├── HEARTBEAT.md                      # 心跳/定时提示
    ├── BOOTSTRAP.md                      # 启动上下文
    ├── MEMORY.md                         # 持久记忆
    ├── memory/                           # 扩展记忆目录
    ├── hooks/                            # 用户自定义 Hook
    │   └── {hook-name}/HOOK.md
    └── skills/                           # 已安装 Skill
```

**Bootstrap 加载顺序**（`workspace.ts`）：

```
AGENTS.md → SOUL.md → TOOLS.md → IDENTITY.md → USER.md
→ HEARTBEAT.md → BOOTSTRAP.md → MEMORY.md
```

> Subagent Session 仅加载 `AGENTS.md` + `TOOLS.md`（通过 `SUBAGENT_BOOTSTRAP_ALLOWLIST` 过滤）

#### Workspace 路径解析优先级

`resolveAgentWorkspaceDir()` 按以下优先级解析 Workspace 路径（`agent-scope.ts`）：

```
    ┌──────────────────────────────────────────────────────┐
    │            Workspace 路径解析优先级                    │
    │                                                      │
    │  1. agent config 显式配置                             │
    │     → agents.{id}.workspace (resolveUserPath)        │
    │                                                      │
    │  2. default agent 全局默认                            │
    │     → agents.defaults.workspace                      │
    │     → 或 resolveDefaultAgentWorkspaceDir(env)        │
    │       ├── OPENCLAW_PROFILE 已设:                     │
    │       │   ~/.openclaw/workspace-{profile}            │
    │       └── OPENCLAW_PROFILE 未设:                     │
    │           ~/.openclaw/workspace                      │
    │                                                      │
    │  3. 非 default agent                                 │
    │     → {stateDir}/workspace-{agentId}                 │
    └──────────────────────────────────────────────────────┘
```

#### Workspace vs agentDir 对比

| 维度         | Workspace                                   | agentDir                        |
| ------------ | ------------------------------------------- | ------------------------------- |
| **定位**     | 用户可编辑空间                              | 系统敏感状态                    |
| **默认路径** | `~/.openclaw/workspace`                     | `{stateDir}/agents/{id}/agent`  |
| **内容**     | SOUL.md, TOOLS.md, hooks/, skills/, memory/ | auth-profiles.json, models.json |
| **安全级别** | 用户自由修改                                | 仅系统写入（file locking）      |
| **生命周期** | 跨 session 持久                             | 跨 session 持久                 |
| **用途**     | Bootstrap/Memory/Hook/Skills 数据源         | 认证凭据 + 模型配置             |

**agentDir 内容**：

| 文件                 | 职责                             | 写入方式                                    |
| -------------------- | -------------------------------- | ------------------------------------------- |
| `auth-profiles.json` | API Key / OAuth Token / 凭据存储 | proper-lockfile 原子写入，30s stale timeout |
| `models.json`        | Provider + Model 配置            | 内容变更时原子写入，权限 0o600              |

#### Sandbox 隔离模式

Sandbox 通过 `workspaceAccess` 控制 Agent 对 Workspace 的访问级别（`sandbox/context.ts`）：

| 模式   | 行为                                          | 适用场景     |
| ------ | --------------------------------------------- | ------------ |
| `rw`   | 直接访问 Agent Workspace（无隔离）            | 受信 Agent   |
| `ro`   | 从 Agent Workspace 复制到 Sandbox（只读隔离） | 半受信 Agent |
| `none` | 仅使用 Sandbox Workspace（完全隔离）          | 不受信 Agent |

Sandbox 作用域（`scope`）：`"shared"`（所有 session 共用）或 per-session（每个 session 独立 workspace）

#### 各子系统如何消费 Workspace

```
    ┌─────────────────────────────────────────────────┐
    │                  Workspace                       │
    │  SOUL.md  TOOLS.md  MEMORY.md  hooks/  skills/  │
    └──────┬──────┬──────────┬─────────┬────────┬─────┘
           │      │          │         │        │
           ▼      ▼          ▼         ▼        ▼
    ┌──────────┐ ┌──────┐ ┌────────┐ ┌─────┐ ┌──────┐
    │Bootstrap │ │Tools │ │Memory  │ │Hook │ │Skills│
    │ System   │ │ Reg  │ │ Index  │ │ Sys │ │ Sys  │
    │          │ │      │ │Manager │ │     │ │      │
    │ 加载     │ │ 解析 │ │ 索引   │ │ 发现│ │ 加载 │
    │ .md 文件 │ │ 指南 │ │ & 搜索 │ │ 执行│ │ 注册 │
    └────┬─────┘ └──┬───┘ └───┬────┘ └──┬──┘ └──┬───┘
         │          │         │         │       │
         └──────────┴────┬────┴─────────┴───────┘
                         ▼
                  ┌──────────────┐
                  │  Pi Embedded │
                  │  Runner      │
                  │  (run.ts)    │
                  └──────────────┘
```

**关键文件**：

| 文件                            | 职责                                       |
| ------------------------------- | ------------------------------------------ |
| `agents/agent-scope.ts`         | Workspace/agentDir 路径解析                |
| `agents/workspace.ts`           | Bootstrap 文件加载与模板初始化             |
| `agents/auth-profiles/store.ts` | auth-profiles.json 管理（proper-lockfile） |
| `agents/models-config.ts`       | models.json 生成与更新                     |
| `agents/sandbox/context.ts`     | Sandbox workspace 隔离上下文               |

---

## 4. 数据流分析

### 4.1 Inbound 消息处理流

```
    Platform Webhook/Poll
           │
           ▼
    ┌─────────────────┐
    │ Channel Plugin   │  ← 平台 SDK 接收原始消息
    │ (e.g. grammY)    │
    └────────┬────────┘
             │ normalize()
             ▼
    ┌─────────────────┐
    │ Message Router   │  ← 标准化 InboundMessage
    │                  │
    │ 1. 识别 sender   │
    │ 2. 解析 chatType │  (dm / group / thread)
    │ 3. 提取 media    │
    └────────┬────────┘
             │
             ▼
    ┌─────────────────┐
    │ Session Resolver │  ← 根据 SessionScope + DmScope 路由
    │                  │
    │ per-sender:      │  每个发送者独立 session
    │ global:          │  所有消息共享 session
    │ per-peer:        │  每个 DM 对话独立
    └────────┬────────┘
             │
             ▼
    ┌─────────────────┐
    │ Hook: message_   │  ← 触发 message_received hook
    │ received         │
    └────────┬────────┘
             │
             ▼
    ┌─────────────────┐
    │ Queue & Debounce │  ← 消息合并，避免频繁触发 Agent
    └────────┬────────┘
             │
             ▼
       Auto-Reply Pipeline
```

### 4.2 Agent 执行流

```
    Auto-Reply Pipeline
           │
           ▼
    ┌─────────────────┐
    │ get-reply()      │  ← 回复逻辑入口
    │                  │
    │ 1. 加载 session  │
    │    历史消息       │
    │ 2. 注入 memory   │
    │    搜索结果       │
    │ 3. 解析 skills   │
    └────────┬────────┘
             │
             ▼
    ┌─────────────────┐
    │ Pi Embedded      │  ← Agent 执行引擎
    │ Runner           │
    │                  │
    │ 1. 解析 workspace│
    │ 2. 创建 tools    │  (messaging, browser, file, ...)
    │ 3. 加载 skills   │
    │ 4. 构建 system   │
    │    prompt         │
    │ 5. 调用 LLM      │  (streaming)
    └────────┬────────┘
             │ streamSimple()
             ▼
    ┌─────────────────┐
    │ Subscribe        │  ← 流式事件处理
    │ Session          │
    │                  │
    │ • delta 累积     │
    │ • <think> 过滤   │
    │ • tool_call 处理 │
    │ • 文本去重       │
    └────────┬────────┘
             │
             ▼
       Block Streaming
```

### 4.3 Outbound 投递流

```
    Block Streaming Coalescer
           │
           │ 段落级分块 (min=800, max=1200 chars)
           ▼
    ┌─────────────────┐
    │ Text Chunker     │  ← 适配平台字符限制
    │                  │
    │ paragraph break  │
    │ newline break    │
    │ sentence break   │
    └────────┬────────┘
             │
             ▼
    ┌─────────────────┐
    │ Hook: message_   │  ← message_sending hook
    │ sending          │
    └────────┬────────┘
             │
        ┌────┴─────┬──────────┐
        ▼          ▼          ▼
    ┌────────┐ ┌────────┐ ┌────────┐
    │Channel │ │ Native │ │  Web   │
    │Outbound│ │ App WS │ │  Chat  │
    │        │ │ Node   │ │        │
    │sendText│ │broadcast│ │        │
    └────────┘ └────────┘ └────────┘
        │
        ▼
    ┌─────────────────┐
    │ Hook: message_   │  ← message_sent hook
    │ sent             │
    └─────────────────┘
```

### 4.4 Session 生命周期

```
    ┌──────────────────────────────────────────────────────────┐
    │                   Session Lifecycle                       │
    │                                                          │
    │  Created ──► Active ──► Idle ──► Reset/Compact           │
    │     │           │         │          │                    │
    │     │           │         │          ▼                    │
    │     │           │         │     ┌─────────┐              │
    │     │           │         └────►│ Daily   │ (daily mode) │
    │     │           │               │ Reset   │              │
    │     │           │               └─────────┘              │
    │     │           │                                        │
    │     │           └──────────────────────┐                 │
    │     │                                  ▼                 │
    │     │                          ┌───────────────┐         │
    │     │                          │ Compaction    │         │
    │     │                          │ (LLM 摘要)    │         │
    │     │                          │ 保留 inject   │         │
    │     │                          └───────────────┘         │
    │     │                                                    │
    │     └──► Scope Rules                                     │
    │          per-sender: senderId → sessionKey                │
    │          global: 固定 "main" sessionKey                   │
    │          per-peer: channelId+peerId → sessionKey          │
    └──────────────────────────────────────────────────────────┘
```

#### Session Transcript 存储

Session 对话记录以 `.jsonl`（JSON Lines）格式存储，每条消息独立成行，支持即时追加写入。

**物理存储路径**（`sessions/paths.ts`）：

```
~/.openclaw/state/agents/{agentId}/sessions/
├── sessions.json                          # Session 元数据索引
├── {sessionId}.jsonl                      # 对话转录文件
└── {sessionId}-topic-{topicId}.jsonl      # 带主题的转录文件
```

**三个 ID 层级**：

```
    Session Key (用户/路由层)          Session ID (文件层)           物理路径
    ────────────────────           ──────────────────           ────────────
    per-sender: senderId     ┐
    global: "main"           ├──► sessions.json ──► sessionId ──► {sessionId}.jsonl
    per-peer: chan+peerId    ┘     (key→id 映射)
```

**`.jsonl` 文件格式**（`sessions/transcript.ts`）：

```jsonl
{"type":"session","version":1,"id":"abc-123","timestamp":"2026-02-09T...","cwd":"/..."}
{"role":"user","content":[{"type":"text","text":"Hello"}],"timestamp":1739...}
{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"model":"...","usage":{...},"timestamp":1739...}
```

| 行      | 类型           | 说明                                               |
| ------- | -------------- | -------------------------------------------------- |
| 第 1 行 | Session Header | `type: "session"`, version, id, timestamp, cwd     |
| 后续行  | Message Entry  | role, content, model, usage, stopReason, timestamp |

**写入方**：`SessionManager`（pi-coding-agent SDK），每条消息**立即追加**到 `.jsonl` 文件——崩溃时最多丢失最后一条消息，不会损坏已写入的记录。

#### sessions.json 元数据管理

`sessions.json` 存储所有 session 的路由元数据，采用文件锁 + TTL 缓存保证并发安全（`sessions/store.ts`）：

```json
{
  "senderId-abc": {
    "sessionId": "uuid-1234",
    "channel": "telegram",
    "lastThreadId": "5678",
    "deliveryContext": { "channel": "telegram", "to": "chat-id", ... }
  }
}
```

**并发控制**：

| 机制         | 参数               | 说明                                                    |
| ------------ | ------------------ | ------------------------------------------------------- |
| 文件锁       | `{storePath}.lock` | proper-lockfile，防止多进程竞争                         |
| Lock Timeout | 10s                | 等待获取锁的超时时间                                    |
| Lock Poll    | 25ms               | 轮询间隔                                                |
| Stale Lock   | 30s                | 超时后视为死锁并夺取                                    |
| TTL 缓存     | 45s（默认）        | 缓存有效期，可通过 `OPENCLAW_SESSION_CACHE_TTL_MS` 覆盖 |
| 原子写入     | temp + rename      | 非 Windows 平台使用 rename 确保原子性                   |

#### Compaction 机制

当对话历史增长到影响 context window 时，Compaction 通过 LLM 摘要压缩旧消息（`pi-embedded-runner/compact.ts`）：

```
    Compaction 流程
    ═══════════════

    ┌─────────────────────────────────────────────────────┐
    │ Session Transcript (.jsonl)                          │
    │                                                     │
    │  [msg1] [msg2] [msg3] ... [msg-N-2] [msg-N-1] [msgN]│
    │  ├──── 旧消息（被摘要替换）────┤├── 近期消息（保留）─┤│
    └────────────────┬────────────────────────────────────┘
                     │
                     ▼  LLM 摘要
              ┌──────────────┐
              │  Summary:    │
              │  "用户讨论了.."│
              └──────┬───────┘
                     │
                     ▼
    ┌─────────────────────────────────────────────────────┐
    │ Compacted Transcript                                 │
    │                                                     │
    │  [summary] [msg-N-2] [msg-N-1] [msgN]               │
    └─────────────────────────────────────────────────────┘
```

**Compaction 保留内容**：

- System Prompt（从 Workspace 重新构建）
- Tools Schema（按 provider 清洗）
- Bootstrap 文件（Skills, SOUL.md 等）
- 近期消息（由 history limit 或 DM limit 决定）

**Compaction 结果**：

- `tokensBefore` / `tokensAfter` — token 使用量对比
- `summary` — LLM 生成的旧消息摘要
- `compactionCount` — 累计 compaction 次数

**并发安全**：Compaction 通过双层 Lane Queue 保证串行执行——Session Lane（per-session 互斥）+ Global Lane（全局互斥），防止同一 session 并发 compact。

#### Reset vs Delete 行为对比

| 操作       | 行为                            | 保留内容                                       |
| ---------- | ------------------------------- | ---------------------------------------------- |
| **Reset**  | 清空对话历史，保留 session 路由 | sessions.json 条目保留，.jsonl 重置为空 header |
| **Delete** | 完全移除 session                | sessions.json 条目删除，.jsonl 文件删除        |

### 4.5 Memory 索引与搜索流

```
    Memory Sources                    Search Query
    ─────────────                     ────────────
    ┌──────────────┐                        │
    │ MEMORY.md    │                        ▼
    │ memory/*.md  │──┐            ┌──────────────┐
    └──────────────┘  │            │ Embedding    │
    ┌──────────────┐  │            │ (query vec)  │
    │ Session      │──┤            └──────┬───────┘
    │ Transcripts  │  │                   │
    │ (.jsonl)     │  │        ┌──────────┼──────────┐
    └──────────────┘  │        ▼                     ▼
                      │  ┌───────────┐        ┌───────────┐
    Sync Engine ──────┤  │ Vector    │        │ Keyword   │
    (watch/interval)  │  │ Search    │        │ Search    │
                      │  │ sqlite-vec│        │ FTS5/BM25 │
                      ▼  └─────┬─────┘        └─────┬─────┘
    ┌──────────────┐       │                     │
    │ Chunk &      │       └────────┬────────────┘
    │ Embed        │                ▼
    │              │       ┌──────────────┐
    │ markdown →   │       │ Score Fusion │
    │ chunks →     │       │ v×vec + t×kw │
    │ embeddings   │       └──────┬───────┘
    └──────┬───────┘              │
           │                      ▼
           ▼              ┌──────────────┐
    ┌──────────────┐      │ Top-K Results│
    │  SQLite DB   │      │ (snippet +   │
    │  chunks      │      │  score +     │
    │  chunks_fts  │      │  source)     │
    │  chunks_vec  │      └──────────────┘
    └──────────────┘
```

### 4.6 Agent 上下文组装

Pi Agent 每次调用 LLM 前，需要从多个数据源读取信息并组装成一个完整的上下文结构。整个流程在 `pi-embedded-runner/run.ts` → `run/attempt.ts` 中完成。

#### 最终发给 LLM 的结构

```
streamSimple(model, { system, messages, tools }, options)
```

| 字段       | 说明                 | 组装来源                                         |
| ---------- | -------------------- | ------------------------------------------------ |
| `system`   | System Prompt 文本   | 硬编码模板 + Workspace 文件 + 运行时信息         |
| `messages` | 对话历史 + 新 prompt | Session .jsonl 提取 + Hook 注入                  |
| `tools`    | 可用工具列表         | `createOpenClawCodingTools()` + 插件工具         |
| `options`  | 调用参数             | Config 中的 temperature/maxTokens/cacheRetention |

#### Phase 1：System Prompt 组装

`buildEmbeddedSystemPrompt()` 按以下顺序拼接 System Prompt（`system-prompt.ts`）：

```
    System Prompt 组成（按注入顺序）
    ══════════════════════════════

    ┌─────────────────────────────────────────────────────────────┐
    │  硬编码区域                                                  │
    │  ├── Identity        "You are a personal assistant..."      │
    │  ├── Tooling 指南     可用工具名称 + 使用风格                  │
    │  ├── Safety 规则      合规约束                                │
    │  ├── CLI 速查         OpenClaw 命令参考                       │
    │  ├── Reply Tags       [[reply_to:id]] 用法                  │
    │  ├── Silent Reply     SILENT_REPLY_TOKEN                    │
    │  └── Messaging 指南   message tool + inline buttons          │
    ├─────────────────────────────────────────────────────────────┤
    │  运行时探测                                                  │
    │  ├── Runtime Info     OS, arch, Node, shell, channel        │
    │  ├── 时间信息          用户时区 + 当前时间                     │
    │  ├── Workspace 路径    当前工作目录                            │
    │  └── Sandbox 信息      模式 + workspace access + browser      │
    ├─────────────────────────────────────────────────────────────┤
    │  Config 驱动                                                 │
    │  ├── Model Aliases    provider/model 别名映射                 │
    │  ├── User Identity    ownerNumbers                          │
    │  ├── TTS 提示          语音合成格式                            │
    │  ├── Docs 路径         OpenClaw 文档位置                      │
    │  └── Reasoning 格式    <think> 标签提示（特定 provider）       │
    ├─────────────────────────────────────────────────────────────┤
    │  Workspace 文件（用户可编辑，关键区域）                         │
    │  ├── SOUL.md          Agent 人格与行为指南                    │
    │  ├── AGENTS.md        多 Agent 配置                          │
    │  ├── TOOLS.md         工具使用指南                            │
    │  ├── IDENTITY.md      身份信息                               │
    │  ├── USER.md          用户偏好                               │
    │  ├── BOOTSTRAP.md     启动上下文                              │
    │  ├── MEMORY.md        持久记忆（始终注入）                     │
    │  └── HEARTBEAT.md     心跳/定时提示                           │
    ├─────────────────────────────────────────────────────────────┤
    │  动态注入                                                    │
    │  ├── Skills 提示       已安装 Skill 的使用说明                 │
    │  ├── Memory 指南       memory_search/memory_get 用法          │
    │  └── extraSystemPrompt subagent/群聊附加上下文                │
    └─────────────────────────────────────────────────────────────┘
```

> Subagent 使用 `promptMode: "minimal"`，仅注入核心区域，跳过 Docs/Heartbeat/Silent Reply 等。

#### Phase 2：Message History 加载与过滤

从当前 Session 的 `.jsonl` 文件提取消息，经过 4 层过滤后作为 `messages` 数组：

```
    SessionManager.open(sessionFile)
            │
            ▼ 读取 .jsonl
       全部消息（含 CompactionEntry）
            │
            ▼ SDK 处理 CompactionEntry
       [summary] + [firstKeptEntryId 之后的消息]
            │
            ▼ ① sanitizeSessionHistory()
       ┌────────────────────────────────────┐
       │ 清洗图片引用 / 修复 tool_use 配对    │
       │ 降级 reasoning blocks / Gemini 修复 │
       └────────────────────────────────────┘
            │
            ▼ ② validateGeminiTurns / validateAnthropicTurns
       确保消息角色交替合法
            │
            ▼ ③ limitHistoryTurns(dmHistoryLimit)
       按 config 截取最近 N 轮 user turns
            │
            ▼ ④ injectHistoryImagesIntoMessages()
       将图片数据注入到历史消息的原始位置
            │
            ▼
       最终 messages 数组
```

#### Phase 3：New Prompt 处理

```
    用户消息 (params.prompt)
            │
            ▼  Hook: before_agent_start
    hookResult.prependContext + "\n\n" + prompt
            │
            ▼  detectAndLoadPromptImages()
    检测并加载 prompt 中引用的图片
            │
            ▼
    session.prompt(effectivePrompt, { images })
```

#### Phase 4：Tools 注册

```
    createOpenClawCodingTools()
    ├── Messaging Tools     ─── send / reply / react
    ├── File Tools          ─── read / write / edit / grep / find / ls
    ├── Exec Tool           ─── shell 执行
    ├── Browser Tools       ─── 网页浏览 / 截图
    ├── Memory Tools        ─── memory_search / memory_get
    └── Channel-Specific    ─── Discord/Slack actions
            │
            ▼ splitSdkTools()
    builtInTools + customTools + clientToolDefs
            │
            ▼ sanitizeToolsForGoogle()（Gemini 专用）
    最终 tools 列表 (name + description + input_schema)
```

#### Agent 的三层记忆模型

Agent 上下文中有三种不同来源的"记忆"，对应不同的范围和机制：

```
    ┌────────────────────────────────────────────────────────────┐
    │                  Agent 看到的上下文                          │
    │                                                            │
    │  System Prompt:                                            │
    │  ┌──────────────────────────────────────────────────────┐  │
    │  │ ① MEMORY.md（始终存在）                                │  │
    │  │   用户手写的持久记忆，每次请求都注入                      │  │
    │  └──────────────────────────────────────────────────────┘  │
    │                                                            │
    │  Messages:                                                 │
    │  ┌──────────────────────────────────────────────────────┐  │
    │  │ ② Message History（当前 session）                      │  │
    │  │   compaction 后的近期消息，容量受 context window 限制    │  │
    │  └──────────────────────────────────────────────────────┘  │
    │                                                            │
    │  Tool Result（按需触发）:                                    │
    │  ┌──────────────────────────────────────────────────────┐  │
    │  │ ③ Memory Search（跨所有 session）                      │  │
    │  │   Agent 调用 memory_search 工具 → 查 SQLite 索引       │  │
    │  │   覆盖所有 session 的全部历史 + MEMORY.md + memory/     │  │
    │  └──────────────────────────────────────────────────────┘  │
    └────────────────────────────────────────────────────────────┘
```

| 层                | 来源                | 注入时机                     | 数据范围                       | 类比         |
| ----------------- | ------------------- | ---------------------------- | ------------------------------ | ------------ |
| ① MEMORY.md       | Workspace 文件      | 每次请求，System Prompt 内联 | 仅此文件                       | 自我认知     |
| ② Message History | 当前 Session .jsonl | 每次请求，messages 数组      | 当前 session（compact 后子集） | 短期工作记忆 |
| ③ Memory Search   | SQLite 索引         | 按需，Agent 调用工具时       | 所有 session + memory 目录     | 长期记忆检索 |

- ① 和 ② **始终存在**于上下文中，不需要 Agent 主动操作
- ③ 是 **按需检索**，Agent 自己决定是否调用 `memory_search`
- Compaction 只影响 ②（压缩当前 session 的旧消息），不影响 ① 和 ③

**关键文件**：

| 文件                                             | 职责                                   |
| ------------------------------------------------ | -------------------------------------- |
| `agents/pi-embedded-runner/run.ts`               | Agent 执行入口，参数解析与流程编排     |
| `agents/pi-embedded-runner/run/attempt.ts`       | 单轮 LLM 调用，上下文组装核心          |
| `agents/pi-embedded-runner/system-prompt.ts`     | System Prompt 模板拼接                 |
| `agents/pi-embedded-runner/bootstrap-context.ts` | Bootstrap 文件加载与过滤               |
| `agents/compaction.ts`                           | Compaction 摘要逻辑（分块 + LLM 总结） |

---

## 5. 架构 Tradeoff 分析

### Tradeoff 1：本地优先 vs 云托管

| 维度         | 分析                                                                    |
| ------------ | ----------------------------------------------------------------------- |
| **选择**     | 所有数据存储在用户本机，Gateway 运行在本地                              |
| **替代方案** | 云端 SaaS 部署（如 Vercel/AWS Lambda）                                  |
| **优势**     | 数据完全私有，无需账号/订阅，离线可用，低延迟                           |
| **代价**     | 用户需自行维护运行环境（Node.js），跨设备同步复杂，无法利用云端弹性扩缩 |
| **适用场景** | 注重隐私的个人用户，对话数据敏感，需要在本地 LLM 和云端 LLM 间灵活切换  |

**相关代码**：整体架构 — SQLite 本地数据库、`~/.state/openclaw/` 状态目录

---

### Tradeoff 2：SQLite + sqlite-vec vs 专用向量数据库

| 维度         | 分析                                                                     |
| ------------ | ------------------------------------------------------------------------ |
| **选择**     | SQLite 单文件数据库 + sqlite-vec 扩展 + FTS5 全文检索                    |
| **替代方案** | Pinecone, Weaviate, Milvus, Qdrant 等专用向量数据库                      |
| **优势**     | 零部署依赖（单文件），与关系数据共存，事务一致性，备份即复制文件         |
| **代价**     | 向量搜索性能受限（无 HNSW/IVF 索引），不支持分布式，大规模数据时性能下降 |
| **适用场景** | 单用户场景（文档量 <100K chunks），本地优先架构的自然选择                |

**相关代码**：`src/memory/sqlite-vec.ts`（扩展加载）, `src/memory/hybrid.ts`（混合搜索）

---

### Tradeoff 3：嵌入式 Agent vs 微服务

| 维度         | 分析                                                     |
| ------------ | -------------------------------------------------------- |
| **选择**     | Pi Agent Core 作为 in-process 嵌入式运行时               |
| **替代方案** | Agent 作为独立微服务（如 gRPC/HTTP API），通过 API 调用  |
| **优势**     | 启动快，无网络开销，共享内存状态，工具调用零延迟         |
| **代价**     | Agent crash 影响整个 Gateway，水平扩展困难，内存占用集中 |
| **适用场景** | 单用户桌面/服务器部署，Agent 与 Gateway 生命周期一致     |

**相关代码**：`src/agents/pi-embedded-runner/run.ts`（直接 import 调用，非 RPC）

---

### Tradeoff 4：插件系统 vs 单体

| 维度         | 分析                                                                       |
| ------------ | -------------------------------------------------------------------------- |
| **选择**     | 7 种插件类型（Tool/Hook/Channel/Provider/HTTP/CLI/Service），支持 4 种来源 |
| **替代方案** | 单体架构，所有功能内建                                                     |
| **优势**     | 社区可贡献渠道/工具，核心轻量，功能按需加载                                |
| **代价**     | 插件 API 维护成本高，版本兼容性管理复杂，调试跨插件问题困难                |
| **适用场景** | 消息渠道和 AI 工具快速迭代的场景，第三方集成需求强的用户群                 |

**相关代码**：`src/plugins/registry.ts`（统一注册表）, `src/plugins/types.ts`（Plugin API）

---

### Tradeoff 5：统一 ChannelPlugin 抽象 vs 原生 SDK

| 维度         | 分析                                                                                    |
| ------------ | --------------------------------------------------------------------------------------- |
| **选择**     | 定义统一的 `ChannelPlugin` 接口（20+ adapter），所有渠道实现相同抽象                    |
| **替代方案** | 每个渠道使用原生 SDK 直接集成，无中间抽象层                                             |
| **优势**     | 新渠道接入有清晰规范，Gateway 逻辑对渠道无感知，统一的安全/路由/监控                    |
| **代价**     | 部分平台特性无法通过统一接口暴露（如 Telegram inline buttons 需额外适配），抽象泄漏风险 |
| **适用场景** | 需要同时支持 15+ 渠道且希望统一管理的场景                                               |

**相关代码**：`src/channels/plugins/types.plugin.ts`（接口定义，20+ adapter）

---

### Tradeoff 6：Block Streaming vs 批量回复

| 维度         | 分析                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------- |
| **选择**     | 段落级 Block Streaming — LLM 输出按段落分块，达到 min/max chars 阈值时投递                |
| **替代方案** | 等待完整回复后一次性发送                                                                  |
| **优势**     | 用户感知延迟低，长回复不会超时，符合即时通讯的交互预期                                    |
| **代价**     | coalescing 逻辑复杂（需处理 code block、thinking tag、dedup），消息分段可能影响阅读连贯性 |
| **适用场景** | 即时通讯渠道（WhatsApp/Telegram），用户期望快速响应                                       |

**相关代码**：`src/auto-reply/reply/block-streaming.ts`（min=800, max=1200, idleMs=1000）

---

### Tradeoff 7：Session Scope 策略 (per-sender / global / per-peer)

| 维度         | 分析                                                                          |
| ------------ | ----------------------------------------------------------------------------- |
| **选择**     | 提供 `per-sender`、`global`、`per-peer` 等多种 session 作用域，按 config 选择 |
| **替代方案** | 固定使用单一 session 策略                                                     |
| **优势**     | 灵活适配不同场景：个人助手(global)、客服(per-sender)、多渠道(per-peer)        |
| **代价**     | 路由逻辑复杂度增加，跨渠道 session 合并（identityLinks）引入额外状态管理      |
| **适用场景** | 同一用户在多个渠道使用时，可通过 `identityLinks` 关联身份实现会话连续性       |

**相关代码**：`src/config/types.base.ts`（`SessionScope`, `DmScope` 类型定义）

---

### Tradeoff 8：混合搜索 BM25 + Vector vs 纯向量

<!-- TODO(human): 请从架构师视角补充对这个 tradeoff 的评价和建议 -->

| 维度         | 分析                                                                         |
| ------------ | ---------------------------------------------------------------------------- |
| **选择**     | BM25 全文检索 + Vector 向量搜索加权融合                                      |
| **替代方案** | 仅使用向量搜索（如 RAG 系统常见做法）                                        |
| **优势**     | BM25 精确匹配关键词（术语、代码标识符），Vector 捕捉语义相似性，互补性强     |
| **代价**     | 需维护两套索引（FTS5 + vec0），score fusion 权重需调参，查询延迟略增         |
| **适用场景** | 技术文档 + 对话记忆混合检索，既需要精确匹配代码/命令，也需要语义理解自然语言 |

**相关代码**：`src/memory/hybrid.ts`（`score = vectorWeight × vectorScore + textWeight × textScore`）

---

## 6. 技术栈速查表

### Runtime & Core

| 组件            | 技术          | 版本     |
| --------------- | ------------- | -------- |
| Runtime         | Node.js       | ≥22.12.0 |
| Language        | TypeScript    | 5.9      |
| Package Manager | pnpm          | 10.23.0  |
| Agent Core      | pi-agent-core | 0.52.9   |
| HTTP            | Hono          | 4.11.9   |
| WebSocket       | ws            | 8.x      |
| CLI             | Commander.js  | 14.x     |

### Build & Quality

| 组件        | 技术                         |
| ----------- | ---------------------------- |
| Bundler     | tsdown (based on rolldown)   |
| Type Check  | tsc (TypeScript)             |
| Linter      | oxlint (with type awareness) |
| Formatter   | oxfmt                        |
| Test Runner | Vitest 4.x                   |
| Coverage    | V8 provider (70% threshold)  |

### Data & Search

| 组件              | 技术                   |
| ----------------- | ---------------------- |
| Database          | SQLite (node:sqlite)   |
| Vector Search     | sqlite-vec 0.1.7-alpha |
| Full-Text Search  | SQLite FTS5 (BM25)     |
| Schema Validation | Zod 4 + TypeBox + AJV  |
| Config Format     | JSON5 / YAML           |

### Channel SDKs

| 渠道     | SDK                           |
| -------- | ----------------------------- |
| Telegram | grammY 1.39+                  |
| WhatsApp | Baileys 7.0                   |
| Slack    | @slack/bolt 4.6+              |
| Discord  | discord.js                    |
| Signal   | signal-utils 0.21+            |
| LINE     | @line/bot-sdk 10.x            |
| Feishu   | @larksuiteoapi/node-sdk 1.58+ |

### Native Apps

| 平台    | 语言           | 构建     |
| ------- | -------------- | -------- |
| macOS   | Swift/SwiftUI  | SPM      |
| iOS     | Swift/SwiftUI  | XcodeGen |
| Android | Kotlin/Compose | Gradle   |

---

## 7. 目录结构速查

```
openclaw/
├── src/                           # TypeScript 源码
│   ├── gateway/                   # Gateway 控制面 (131 files)
│   ├── agents/                    # Agent 运行时 (312 files)
│   ├── channels/                  # 渠道抽象层 (33 subdirs)
│   ├── config/                    # 配置系统 (127 files)
│   ├── auto-reply/                # 自动回复流水线 (73 files)
│   ├── memory/                    # 记忆与向量搜索 (45 files)
│   ├── plugins/                   # 插件系统 (37 files)
│   ├── hooks/                     # Hook 系统 (30 files)
│   ├── cli/                       # CLI 命令 (107 files)
│   ├── commands/                  # 命令实现 (183 files)
│   ├── browser/                   # 浏览器自动化 (70 files)
│   ├── infra/                     # 基础设施工具 (157 files)
│   ├── providers/                 # LLM Provider 集成
│   ├── media-understanding/       # 媒体理解 (23 files)
│   ├── security/                  # 安全工具
│   ├── logging/                   # 结构化日志 (17 files)
│   ├── tui/                       # Terminal UI (32 files)
│   ├── web/                       # Web 界面
│   ├── cron/                      # 定时任务
│   └── plugin-sdk/                # 插件 SDK 导出
│
├── extensions/                    # 插件扩展 (36 subdirs)
│   ├── telegram/                  # Telegram 渠道插件
│   ├── whatsapp/                  # WhatsApp 渠道插件
│   ├── slack/                     # Slack 渠道插件
│   ├── discord/                   # Discord 渠道插件
│   ├── signal/                    # Signal 渠道插件
│   ├── memory-core/               # 核心记忆插件
│   └── ...                        # 30+ 其他扩展
│
├── apps/                          # 原生应用
│   ├── macos/                     # macOS Menu Bar App (Swift)
│   ├── ios/                       # iOS App (Swift)
│   ├── android/                   # Android App (Kotlin)
│   └── shared/OpenClawKit/        # 跨平台共享代码
│
├── ui/                            # Web UI (Vite + Lit)
├── packages/                      # NPM 包变体
├── scripts/                       # 构建/工具脚本
├── docs/                          # 文档 (Mint)
├── package.json                   # 主包配置
├── pnpm-workspace.yaml            # Monorepo 配置
├── tsconfig.json                  # TypeScript 配置
└── vitest.config.ts               # 测试配置
```

---

_文档生成时间：2026-02-09_
