# AWS Bedrock AgentCore Memory 完整指南

> 基于 AWS 官方文档整理，涵盖数据模型、API 操作、Strategy 机制和最佳实践。

---

## 1. 架构概览

AgentCore Memory 分为两套 API：

| API                                         | 用途                        | 操作举例                                    |
| ------------------------------------------- | --------------------------- | ------------------------------------------- |
| `bedrock-agentcore-control` (Control Plane) | 管理 Memory 资源和 Strategy | create-memory, update-memory, delete-memory |
| `bedrock-agentcore` (Data Plane)            | 读写 Event 和 Memory Record | create-event, retrieve-memory-records       |

```
Control Plane: 创建 Memory 资源 + 配置 Strategy (一次性)
       │
       │ memory-id
       ▼
Data Plane: 写入 Event → Extraction → Memory Record → Retrieve
       (运行时循环)
```

---

## 2. 核心数据模型

### 2.1 Event (事件 / 短期记忆)

**定义**: 一个 actor 在某个 session 中的一次发言或动作，带时间戳的交互记录。

**不是"一轮对话"，而是一个交互动作。** 一轮对话通常 = 2 个 events (USER + ASSISTANT)。

```
一轮对话 (turn) = 2 个 events:
  Event 1: role=USER,      actor-id="user/customer-123"
  Event 2: role=ASSISTANT,  actor-id="agent/support-bot"
```

**大小限制**:

| 字段                 | 限制             |
| -------------------- | ---------------- |
| payload content text | 1 ~ 100,000 字符 |
| payload items 数量   | 0 ~ 100 条/event |
| metadata 键值对      | 最多 15 对       |
| metadata key         | 1 ~ 128 字符     |
| metadata value       | 0 ~ 256 字符     |
| session-id           | 1 ~ 100 字符     |
| actor-id             | 1 ~ 255 字符     |

**Payload 类型**:

- `conversational`: 带 role (USER / ASSISTANT / TOOL / OTHER) 的对话消息
- `blob`: 二进制数据

**组织维度**:

```
Memory (容器)
 └── Session (一次会话)
      └── Actor (参与者)
           └── Event (按时间排列)
                └── Branch (可选，分支对话)
```

**Branch 机制** (类似 Git):

- `rootEventId`: 分叉点 (相当于 fork point)
- `name`: 分支名称
- `includeParentBranches`: 是否包含父分支历史
- 用途: agent 重试不同回答、用户回退重新开始、A/B 测试

### 2.2 Memory Record (记忆记录 / 长期记忆)

**定义**: 从 events 中提炼出的结构化知识，持久存储。

**大小限制**:

| 字段            | 限制                            |
| --------------- | ------------------------------- |
| content text    | 1 ~ 16,000 字符                 |
| metadata 键值对 | 最多 15 对                      |
| metadata key    | 1 ~ 256 字符                    |
| metadata value  | 0 ~ 256 字符                    |
| batch 操作      | 最多 100 条/次                  |
| namespace       | 1 ~ 1024 字符，最多 1 个/record |

### 2.3 Event vs Memory Record 对比

| 维度     | Event                                                                     | Memory Record                      |
| -------- | ------------------------------------------------------------------------- | ---------------------------------- |
| 本质     | 原始交互日志                                                              | 提炼后的知识                       |
| 粒度     | 一条发言                                                                  | 一条洞察/事实/偏好/摘要            |
| 生命周期 | 短期，TTL 最长 365 天                                                     | 长期，不过期                       |
| 可变性   | 不可修改 (只能删除)                                                       | 支持 batch-update                  |
| 组织方式 | session + actor + timestamp                                               | namespace + strategy               |
| 检索方式 | list-events (时间线)                                                      | retrieve-memory-records (语义搜索) |
| 关系     | 多对多: 多个 events 可产出 1 个 record; 1 个 event 也可能产出多条 records |

---

## 3. Data Plane API 操作

### 3.1 Event 操作

| 操作           | 说明                                 |
| -------------- | ------------------------------------ |
| `create-event` | 创建事件，绑定 actor-id + session-id |
| `get-event`    | 获取单个事件                         |
| `delete-event` | 删除事件                             |
| `list-events`  | 按 session-id + actor-id 列出事件    |

### 3.2 Memory Record 操作

| 操作                          | 说明                                                |
| ----------------------------- | --------------------------------------------------- |
| `batch-create-memory-records` | 批量创建 (最多 100 条/次)                           |
| `batch-update-memory-records` | 批量更新                                            |
| `batch-delete-memory-records` | 批量删除                                            |
| `delete-memory-record`        | 删除单条                                            |
| `get-memory-record`           | 获取单条                                            |
| `list-memory-records`         | 按 namespace 前缀 + strategy-id 列出 (枚举式)       |
| `retrieve-memory-records`     | 语义搜索，支持 searchQuery + topK + metadataFilters |

### 3.3 Extraction Job 操作

| 操作                          | 说明                                 |
| ----------------------------- | ------------------------------------ |
| `start-memory-extraction-job` | 手动触发提取 (处理之前失败的 events) |
| `list-memory-extraction-jobs` | 列出提取任务                         |

---

## 4. Memory Strategy 机制

### 4.1 三种 Strategy 类型

| 类型                  | 特点                               | 触发条件             |
| --------------------- | ---------------------------------- | -------------------- |
| **Built-in**          | 全托管，零配置                     | AWS 预设，用户不可配 |
| **Built-in Override** | 可自定义 prompt，仍用托管 pipeline | AWS 预设，用户不可配 |
| **Self-managed**      | 完全自控提取逻辑，SNS+S3 推送      | 用户自己配置         |

### 4.2 Extraction 触发条件

三种触发器，满足任一即触发：

```json
"triggerConditions": [
  { "messageBasedTrigger": { "messageCount": 6 } },
  { "tokenBasedTrigger":   { "tokenCount": 1000 } },
  { "timeBasedTrigger":    { "idleSessionTimeout": 30 } }
]
```

| 触发器              | 条件                    | 含义                     |
| ------------------- | ----------------------- | ------------------------ |
| messageBasedTrigger | `messageCount: N`       | 每累积 N 条新 event 触发 |
| tokenBasedTrigger   | `tokenCount: N`         | 每累积 N 个 token 触发   |
| timeBasedTrigger    | `idleSessionTimeout: N` | session 空闲 N 秒后触发  |

> Built-in strategy 使用 AWS 预设的触发条件，不可配置。
> Self-managed strategy 的触发条件完全由用户定义。

### 4.3 四种 Built-in Strategy 详解

#### Semantic (语义记忆)

- **提取什么**: 事实性知识 ("用户住北京"、"订单号 #35476")
- **提取输入**: 单 session 的 USER + ASSISTANT events
- **Consolidation 范围**: 跨 session，per actor (合并/去重已有 records)
- **Namespace**: `/strategy/{sid}/actors/{actorId}/`
- **输出格式**: JSON 对象，每条是独立事实

#### UserPreference (用户偏好)

- **提取什么**: 用户偏好 ("喜欢蓝色"、"预算3000")
- **提取输入**: 单 session 的 USER + ASSISTANT events
- **Consolidation 范围**: 跨 session，per actor (更新/覆盖偏好)
- **Namespace**: `/strategy/{sid}/actors/{actorId}/`
- **特点**: 构建持久动态的用户画像

#### Summary (会话摘要)

- **提取什么**: 会话摘要
- **提取输入**: 单 session 的 events
- **Consolidation 范围**: 仅当前 session，不跨 session
- **Namespace**: `/strategy/{sid}/actor/{actorId}/session/{sessionId}/`
- **特点**: 一个长 session 可能产出多个 summary chunks

#### Episodic (情景记忆)

- **提取什么**: 跨 session 的行为模式和 episode 记录
- **提取输入**: 单 session 的 events
- **触发方式**: 不走消息数/token 触发器，靠语义判断 episode 是否结束
- **步骤**: Extraction → Consolidation → Reflection (跨 episode 生成洞察)
- **Namespace**: 三种粒度可选

| Namespace                                              | 粒度       |
| ------------------------------------------------------ | ---------- |
| `/strategy/{sid}/`                                     | 全局级     |
| `/strategy/{sid}/actor/{actorId}/`                     | actor 级   |
| `/strategy/{sid}/actor/{actorId}/session/{sessionId}/` | session 级 |

### 4.4 Extraction 作用域总结

```
                    提取输入        Consolidation 范围      Namespace
                    (看什么)        (跟什么合并)           (存到哪)
─────────────────────────────────────────────────────────────────────
Semantic            单 session      跨 session (per actor)  .../actors/{actorId}/
UserPreference      单 session      跨 session (per actor)  .../actors/{actorId}/
Summary             单 session      仅当前 session          .../session/{sessionId}/
Episodic            单 session      跨 episode (reflection) 可选 3 种粒度
```

**核心规律**: 提取 (extraction) 永远是 per session，但 consolidation 的范围由 namespace 设计决定。Namespace 不带 sessionId → 跨 session 合并; 带 sessionId → session 内隔离。

---

## 5. 两条数据通路

### 通路 A: Event → 自动 Extraction → Memory Record

适用: 有原始对话流，让系统自动提炼。

```bash
# 写入对话 events
aws bedrock-agentcore create-event \
  --memory-id "myMemory-1234567890" \
  --actor-id "user/customer-123" \
  --session-id "session-abc" \
  --event-timestamp "2026-02-09T10:00:00Z" \
  --payload '[{"conversational":{"content":{"text":"我的订单还没到"},"role":"USER"}}]'

# 触发条件满足后，Strategy 自动提取出 Memory Record
# 之后可以语义检索
aws bedrock-agentcore retrieve-memory-records \
  --memory-id "myMemory-1234567890" \
  --namespace "/" \
  --search-criteria '{"searchQuery": "客户订单问题", "topK": 5}'
```

### 通路 B: 直接写入 Memory Record

适用: 已有结构化知识，不需要系统提炼。

```bash
# 从 CRM 导入、人工标注等
aws bedrock-agentcore batch-create-memory-records \
  --memory-id "myMemory-1234567890" \
  --records '[{
    "requestIdentifier": "crm-sync-001",
    "namespaces": ["/profiles/user-123"],
    "content": {"text": "用户是 VIP 客户，需要优先处理"},
    "timestamp": "2026-02-09T00:00:00Z"
  }]'
```

### 决策参考

| 场景                    | 选择              | 原因                         |
| ----------------------- | ----------------- | ---------------------------- |
| Agent 与用户实时聊天    | Event (通路 A)    | 原始对话让 strategy 自动提炼 |
| 从外部系统导入知识      | Record (通路 B)   | 已是结构化数据               |
| 自己做了总结            | Record (通路 B)   | 自定义逻辑更精确             |
| 需要最近 k 轮上下文     | Event list-events | 天然按时间排列               |
| 需要跨 session 知识检索 | Record retrieve   | 语义搜索                     |

---

## 6. 典型 Agent 运行时数据流

```
用户开始对话
    │
    ├─→ 每条消息 → create-event (短期记忆)
    │
    │   同时:
    │   ├─ list-events 拿最近 k 轮 → 塞进 Agent prompt (上下文)
    │   └─ retrieve-memory-records → 拿相关长期记忆 → 也塞进 prompt
    │
    │   对话结束 / 触发条件满足:
    │   └─ Strategy 自动 extraction → 新 Memory Records 产生
    │
    ├─→ 业务系统有新信息 → batch-create-memory-records (直接写入长期记忆)
    │
    └─→ 旧记忆不准了 → batch-update / batch-delete (维护长期记忆)
```

---

## 7. 参考链接

- [Get started with AgentCore Memory](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-get-started.html)
- [Memory strategies overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-strategies.html)
- [Built-in strategies](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/built-in-strategies.html)
- [Self-managed strategy](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-self-managed-strategies.html)
- [Semantic memory strategy](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/semantic-memory-strategy.html)
- [Summary strategy](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/summary-strategy.html)
- [Episodic memory strategy](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/episodic-memory-strategy.html)
- [User preference memory strategy](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/user-preference-memory-strategy.html)
- [bedrock-agentcore CLI (Data Plane)](https://docs.aws.amazon.com/cli/latest/reference/bedrock-agentcore/)
- [bedrock-agentcore-control CLI (Control Plane)](https://docs.aws.amazon.com/cli/latest/reference/bedrock-agentcore-control/)
