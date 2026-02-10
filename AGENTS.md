# Repository Guidelines

- Repo: https://github.com/openclaw/openclaw
- GitHub issues/comments/PR comments: use literal multiline strings or `-F - <<'EOF'` (or $'...') for real newlines; never embed "\\n".

## Project Structure & Module Organization

- Source code: `src/` (CLI wiring in `src/cli`, commands in `src/commands`, web provider in `src/provider-web.ts`, infra in `src/infra`, media pipeline in `src/media`).
- Tests: colocated `*.test.ts`.
- Docs: `docs/` (images, queue, Pi config). Built output lives in `dist/`.
- Plugins/extensions: live under `extensions/*` (workspace packages). Keep plugin-only deps in the extension `package.json`; do not add them to the root `package.json` unless core uses them.
- Plugins: install runs `npm install --omit=dev` in plugin dir; runtime deps must live in `dependencies`. Avoid `workspace:*` in `dependencies` (npm install breaks); put `openclaw` in `devDependencies` or `peerDependencies` instead (runtime resolves `openclaw/plugin-sdk` via jiti alias).
- Installers served from `https://openclaw.ai/*`: live in the sibling repo `../openclaw.ai` (`public/install.sh`, `public/install-cli.sh`, `public/install.ps1`).
- Messaging channels: always consider **all** built-in + extension channels when refactoring shared logic (routing, allowlists, pairing, command gating, onboarding, docs).
  - Core channel docs: `docs/channels/`
  - Core channel code: `src/telegram`, `src/discord`, `src/slack`, `src/signal`, `src/imessage`, `src/web` (WhatsApp web), `src/channels`, `src/routing`
  - Extensions (channel plugins): `extensions/*` (e.g. `extensions/msteams`, `extensions/matrix`, `extensions/zalo`, `extensions/zalouser`, `extensions/voice-call`)
- When adding channels/extensions/apps/docs, review `.github/labeler.yml` for label coverage.

## Docs Linking (Mintlify)

- Docs are hosted on Mintlify (docs.openclaw.ai).
- Internal doc links in `docs/**/*.md`: root-relative, no `.md`/`.mdx` (example: `[Config](/configuration)`).
- Section cross-references: use anchors on root-relative paths (example: `[Hooks](/configuration#hooks)`).
- Doc headings and anchors: avoid em dashes and apostrophes in headings because they break Mintlify anchor links.
- When Peter asks for links, reply with full `https://docs.openclaw.ai/...` URLs (not root-relative).
- When you touch docs, end the reply with the `https://docs.openclaw.ai/...` URLs you referenced.
- README (GitHub): keep absolute docs URLs (`https://docs.openclaw.ai/...`) so links work on GitHub.
- Docs content must be generic: no personal device names/hostnames/paths; use placeholders like `user@gateway-host` and “gateway host”.

## Docs i18n (zh-CN)

- `docs/zh-CN/**` is generated; do not edit unless the user explicitly asks.
- Pipeline: update English docs → adjust glossary (`docs/.i18n/glossary.zh-CN.json`) → run `scripts/docs-i18n` → apply targeted fixes only if instructed.
- Translation memory: `docs/.i18n/zh-CN.tm.jsonl` (generated).
- See `docs/.i18n/README.md`.
- The pipeline can be slow/inefficient; if it’s dragging, ping @jospalmbier on Discord instead of hacking around it.

## exe.dev VM ops (general)

- Access: stable path is `ssh exe.dev` then `ssh vm-name` (assume SSH key already set).
- SSH flaky: use exe.dev web terminal or Shelley (web agent); keep a tmux session for long ops.
- Update: `sudo npm i -g openclaw@latest` (global install needs root on `/usr/lib/node_modules`).
- Config: use `openclaw config set ...`; ensure `gateway.mode=local` is set.
- Discord: store raw token only (no `DISCORD_BOT_TOKEN=` prefix).
- Restart: stop old gateway and run:
  `pkill -9 -f openclaw-gateway || true; nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &`
- Verify: `openclaw channels status --probe`, `ss -ltnp | rg 18789`, `tail -n 120 /tmp/openclaw-gateway.log`.

## Build, Test, and Development Commands

- Runtime baseline: Node **22+** (keep Node + Bun paths working).
- Install deps: `pnpm install`
- Pre-commit hooks: `prek install` (runs same checks as CI)
- Also supported: `bun install` (keep `pnpm-lock.yaml` + Bun patching in sync when touching deps/patches).
- Prefer Bun for TypeScript execution (scripts, dev, tests): `bun <file.ts>` / `bunx <tool>`.
- Run CLI in dev: `pnpm openclaw ...` (bun) or `pnpm dev`.
- Node remains supported for running built output (`dist/*`) and production installs.
- Type-check/build: `pnpm build`
- TypeScript checks: `pnpm tsgo`
- Lint/format: `pnpm check`
- Tests: `pnpm test` (vitest); coverage: `pnpm test:coverage`

## Coding Style & Naming Conventions

- Language: TypeScript (ESM). Prefer strict typing; avoid `any`.
- Formatting/linting via Oxlint and Oxfmt; run `pnpm check` before commits.
- Add brief code comments for tricky or non-obvious logic.
- Keep files concise; extract helpers instead of “V2” copies. Use existing patterns for CLI options and dependency injection via `createDefaultDeps`.
- Aim to keep files under ~700 LOC; guideline only (not a hard guardrail). Split/refactor when it improves clarity or testability.
- Naming: use **OpenClaw** for product/app/docs headings; use `openclaw` for CLI command, package/binary, paths, and config keys.

## Release Channels (Naming)

- stable: tagged releases only (e.g. `vYYYY.M.D`), npm dist-tag `latest`.
- beta: prerelease tags `vYYYY.M.D-beta.N`, npm dist-tag `beta` (may ship without macOS app).
- dev: moving head on `main` (no tag; git checkout main).

## Testing Guidelines

- Framework: Vitest with V8 coverage thresholds (70% lines/branches/functions/statements).
- Naming: match source names with `*.test.ts`; e2e in `*.e2e.test.ts`.
- Run `pnpm test` (or `pnpm test:coverage`) before pushing when you touch logic.
- Do not set test workers above 16; tried already.
- Live tests (real keys): `CLAWDBOT_LIVE_TEST=1 pnpm test:live` (OpenClaw-only) or `LIVE=1 pnpm test:live` (includes provider live tests). Docker: `pnpm test:docker:live-models`, `pnpm test:docker:live-gateway`. Onboarding Docker E2E: `pnpm test:docker:onboard`.
- Full kit + what’s covered: `docs/testing.md`.
- Pure test additions/fixes generally do **not** need a changelog entry unless they alter user-facing behavior or the user asks for one.
- Mobile: before using a simulator, check for connected real devices (iOS + Android) and prefer them when available.

## Commit & Pull Request Guidelines

- Create commits with `scripts/committer "<msg>" <file...>`; avoid manual `git add`/`git commit` so staging stays scoped.
- Follow concise, action-oriented commit messages (e.g., `CLI: add verbose flag to send`).
- Group related changes; avoid bundling unrelated refactors.
- Changelog workflow: keep latest released version at top (no `Unreleased`); after publishing, bump version and start a new top section.
- PRs should summarize scope, note testing performed, and mention any user-facing changes or new flags.
- PR review flow: when given a PR link, review via `gh pr view`/`gh pr diff` and do **not** change branches.
- PR review calls: prefer a single `gh pr view --json ...` to batch metadata/comments; run `gh pr diff` only when needed.
- Before starting a review when a GH Issue/PR is pasted: run `git pull`; if there are local changes or unpushed commits, stop and alert the user before reviewing.
- Goal: merge PRs. Prefer **rebase** when commits are clean; **squash** when history is messy.
- PR merge flow: create a temp branch from `main`, merge the PR branch into it (prefer squash unless commit history is important; use rebase/merge when it is). Always try to merge the PR unless it’s truly difficult, then use another approach. If we squash, add the PR author as a co-contributor. Apply fixes, add changelog entry (include PR # + thanks), run full gate before the final commit, commit, merge back to `main`, delete the temp branch, and end on `main`.
- If you review a PR and later do work on it, land via merge/squash (no direct-main commits) and always add the PR author as a co-contributor.
- When working on a PR: add a changelog entry with the PR number and thank the contributor.
- When working on an issue: reference the issue in the changelog entry.
- When merging a PR: leave a PR comment that explains exactly what we did and include the SHA hashes.
- When merging a PR from a new contributor: add their avatar to the README “Thanks to all clawtributors” thumbnail list.
- After merging a PR: run `bun scripts/update-clawtributors.ts` if the contributor is missing, then commit the regenerated README.

## Shorthand Commands

- `sync`: if working tree is dirty, commit all changes (pick a sensible Conventional Commit message), then `git pull --rebase`; if rebase conflicts and cannot resolve, stop; otherwise `git push`.

### PR Workflow (Review vs Land)

- **Review mode (PR link only):** read `gh pr view/diff`; **do not** switch branches; **do not** change code.
- **Landing mode:** create an integration branch from `main`, bring in PR commits (**prefer rebase** for linear history; **merge allowed** when complexity/conflicts make it safer), apply fixes, add changelog (+ thanks + PR #), run full gate **locally before committing** (`pnpm build && pnpm check && pnpm test`), commit, merge back to `main`, then `git switch main` (never stay on a topic branch after landing). Important: contributor needs to be in git graph after this!

## Security & Configuration Tips

- Web provider stores creds at `~/.openclaw/credentials/`; rerun `openclaw login` if logged out.
- Pi sessions live under `~/.openclaw/sessions/` by default; the base directory is not configurable.
- Environment variables: see `~/.profile`.
- Never commit or publish real phone numbers, videos, or live configuration values. Use obviously fake placeholders in docs, tests, and examples.
- Release flow: always read `docs/reference/RELEASING.md` and `docs/platforms/mac/release.md` before any release work; do not ask routine questions once those docs answer them.

## Troubleshooting

- Rebrand/migration issues or legacy config/service warnings: run `openclaw doctor` (see `docs/gateway/doctor.md`).

## Agent-Specific Notes

- Never edit `node_modules` (global/Homebrew/npm/git installs too). Updates overwrite. Skill notes go in `tools.md` or `AGENTS.md`.
- Signal: "update fly" => `fly ssh console -a flawd-bot -C "bash -lc 'cd /data/clawd/openclaw && git pull --rebase origin main'"` then `fly machines restart e825232f34d058 -a flawd-bot`.
- When working on a GitHub Issue or PR, print the full URL at the end of the task.
- When answering questions, respond with high-confidence answers only: verify in code; do not guess.
- Never update the Carbon dependency.
- Any dependency with `pnpm.patchedDependencies` must use an exact version (no `^`/`~`).
- Patching dependencies (pnpm patches, overrides, or vendored changes) requires explicit approval; do not do this by default.
- CLI progress: use `src/cli/progress.ts` (`osc-progress` + `@clack/prompts` spinner); don’t hand-roll spinners/bars.
- Status output: keep tables + ANSI-safe wrapping (`src/terminal/table.ts`); `status --all` = read-only/pasteable, `status --deep` = probes.
- **Gateway restart:** `pkill -f openclaw-gateway; pnpm openclaw gateway run --port 18789 --force &`
- If shared guardrails are available locally, review them; otherwise follow this repo's guidance.
- Connection providers: when adding a new connection, update every UI surface and docs (web UI, onboarding/overview docs) and add matching status + configuration forms so provider lists and settings stay in sync.
- Version locations: `package.json` (CLI), `docs/install/updating.md` (pinned npm version).
- **Multi-agent safety:** do **not** create/apply/drop `git stash` entries unless explicitly requested (this includes `git pull --rebase --autostash`). Assume other agents may be working; keep unrelated WIP untouched and avoid cross-cutting state changes.
- **Multi-agent safety:** when the user says "push", you may `git pull --rebase` to integrate latest changes (never discard other agents' work). When the user says "commit", scope to your changes only. When the user says "commit all", commit everything in grouped chunks.
- **Multi-agent safety:** do **not** create/remove/modify `git worktree` checkouts (or edit `.worktrees/*`) unless explicitly requested.
- **Multi-agent safety:** do **not** switch branches / check out a different branch unless explicitly requested.
- **Multi-agent safety:** running multiple agents is OK as long as each agent has its own session.
- **Multi-agent safety:** when you see unrecognized files, keep going; focus on your changes and commit only those.
- Lint/format churn:
  - If staged+unstaged diffs are formatting-only, auto-resolve without asking.
  - If commit/push already requested, auto-stage and include formatting-only follow-ups in the same commit (or a tiny follow-up commit if needed), no extra confirmation.
  - Only ask when changes are semantic (logic/data/behavior).
- Lobster seam: use the shared CLI palette in `src/terminal/palette.ts` (no hardcoded colors); apply palette to onboarding/config prompts and other TTY UI output as needed.
- **Multi-agent safety:** focus reports on your edits; avoid guard-rail disclaimers unless truly blocked; when multiple agents touch the same file, continue if safe; end with a brief “other files present” note only if relevant.
- Bug investigations: read source code of relevant npm dependencies and all related local code before concluding; aim for high-confidence root cause.
- Code style: add brief comments for tricky logic; keep files under ~500 LOC when feasible (split/refactor as needed).
- Tool schema guardrails (google-antigravity): avoid `Type.Union` in tool input schemas; no `anyOf`/`oneOf`/`allOf`. Use `stringEnum`/`optionalStringEnum` (Type.Unsafe enum) for string lists, and `Type.Optional(...)` instead of `... | null`. Keep top-level tool schema as `type: "object"` with `properties`.
- Tool schema guardrails: avoid raw `format` property names in tool schemas; some validators treat `format` as a reserved keyword and reject the schema.
- When asked to open a "session" file, open the Pi session logs under `~/.openclaw/agents/<agentId>/sessions/*.jsonl` (use the `agent=<id>` value in the Runtime line of the system prompt; newest unless a specific ID is given), not the default `sessions.json`. If logs are needed from another machine, SSH via Tailscale and read the same path there.
- Never send streaming/partial replies to external messaging surfaces (WhatsApp, Telegram); only final replies should be delivered there. Streaming/tool events may still go to internal UIs/control channel.
- For manual `openclaw message send` messages that include `!`, use the heredoc pattern noted below to avoid the Bash tool's escaping.
- Release guardrails: do not change version numbers without operator’s explicit consent; always ask permission before running any npm publish/release step.

## NPM + 1Password (publish/verify)

- Use the 1password skill; all `op` commands must run inside a fresh tmux session.
- Sign in: `eval "$(op signin --account my.1password.com)"` (app unlocked + integration on).
- OTP: `op read 'op://Private/Npmjs/one-time password?attribute=otp'`.
- Publish: `npm publish --access public --otp="<otp>"` (run from the package dir).
- Verify without local npmrc side effects: `npm view <pkg> version --userconfig "$(mktemp)"`.
- Kill the tmux session after publish.

---

## AgentCore Integration Context (memory-fix branch)

This branch (`fix/memory-not-include`) implements AgentCore Memory integration for OpenClaw. The core work is fixing how Gateway and Python Runtime collaborate on conversation history, memory recall, and transcript storage.

### AWS 环境

- Account: `497892281794`, User: `yunfeilu`, Region: `us-east-1`
- IAM Role (my_agent): `AmazonBedrockAgentCoreSDKRuntime-us-east-1-e72c1a7c7a`
- Runtime: `my_agent-kIxtLF89ok` (v10, S3 代码 Python 3.13, READY)
- Runtime S3: `bedrock-agentcore-codebuild-sources-497892281794-us-east-1/my_agent/deployment.zip`
- Memory: `openclaw_agentcore_demo_mem-K4TRmS44p9` (ACTIVE)

### 架构: Gateway vs Runtime 职责

**Gateway = 策略执行 + 传输抽象 (NOT intelligence)**

- 路由: session key → 哪个 agent (`resolveSessionAgentId`)
- 安全: 授权检查、send policy、default-deny
- 抽象: 多渠道 (Telegram/Discord/Slack/WS) → 统一 MsgContext
- 配置: model/timeout/thinking level 预解析
- 传递 `storage` config (memory_arn, namespace_prefix, transcript_session_id) 给 Runtime

**Runtime = 全部智能 (owns ALL intelligence and state)**

- 从 AgentCore Memory 读 full session history (no limit)
- Memory recall 作为 tool (agent 按需调用，非 pre-fetch)
- 写 transcript (conversational payload → 触发 LTM extraction)
- 自主拼 system prompt

### 已修复的问题 (本分支)

1. **Enriched prompt pollution** — `[Recalled Memory]` 不再保存到 session history
2. **Double-write** — 去掉 Gateway 的 transcript 写入，仅 Runtime 写
3. **Session reset broken** — `/new` 正确使用 `transcriptSessionId` 而非 stable `sessionKey`
4. **Memory logic misplaced** — 从 Gateway pre-fetch 改为 Runtime tool call
5. **Transcript writing misplaced** — 从 Gateway 改为 Runtime 负责
6. **Workspace files** — 迁移到 S3，Runtime 直接加载
7. **Event metadata** — 使用 `stringValue` 而非 `value`

### 关键文件

| 文件                                               | 职责                                                           |
| -------------------------------------------------- | -------------------------------------------------------------- |
| `src/agents/agentcore-provider.ts`                 | Gateway thin routing, 传递 storage config                      |
| `src/agents/tools/agentcore-memory-tool.ts`        | `agentcore_memory_recall` tool 定义                            |
| `src/storage/backends/agentcore-memory-backend.ts` | AgentCore Memory 读写 (`ListEventsCommand`)                    |
| `src/storage/transcript-uri.ts`                    | `readTranscriptMessagesFromUri()`, newest-first (must reverse) |
| `src/storage/storage-service.ts`                   | 统一存储服务                                                   |
| `src/storage/types.ts`                             | 存储类型定义                                                   |
| `src/config/types.storage.ts`                      | Storage config 类型                                            |
| `src/config/zod-schema.storage.ts`                 | Storage config Zod schema                                      |
| `src/gateway/session-utils.fs.ts`                  | `readSessionMessagesAsync()` for chat.history                  |
| `src/memory/manager.ts`                            | Memory manager (skip local memory in agentcore mode)           |

Python Runtime (部署到 AgentCore, 对应 `agentcore-runtime-quickstart/`):

- `src/runtime/agent.py` — 拥有 history + transcript + memory decisions
- `src/runtime/app.py` — Per-request session manager from storage config
- `src/memory/session.py` — AgentCore Memory client, dual payloads

### Session ID 语义

- `sessionKey`: stable per user/channel (不随 /new 改变)
- `sessionId`: per conversation session (随 /new 改变)
- `transcriptSessionId`: `params.sessionId || rawSessionKey` — 用于 transcript 存储
- AgentCore session must be >=33 chars → `ensureSessionKeyLength()` pads short keys
- Gateway 通过 `storage.transcript_session_id` 传给 Runtime

### Actor/Session Scheme (Gateway backend 和 Runtime 必须一致)

- `actorId = "openclaw-storage/{namespace_prefix}/transcripts"`
- `sessionId = "tr-{sanitized(key)}"` (sanitize: 非字母数字替换为 `_`)
- `memoryId` 从 ARN 提取: `arn:aws:bedrock-agentcore:REGION:ACCOUNT:memory/MEMORY_ID`

### 关键调试命令

```bash
# Control Plane
aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "my_agent-kIxtLF89ok" --region us-east-1
aws bedrock-agentcore-control list-memories --region us-east-1

# Data Plane invoke
PAYLOAD=$(echo -n '{"prompt": "Hello"}' | base64)
aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn "arn:aws:bedrock-agentcore:us-east-1:497892281794:runtime/my_agent-kIxtLF89ok" \
  --payload "$PAYLOAD" --region us-east-1 /dev/stdout

# Memory 查询
aws bedrock-agentcore list-events --memory-id "openclaw_agentcore_demo_mem-K4TRmS44p9" --session-id "<sid>" --region us-east-1

# 运行 Gateway
pkill -f openclaw-gateway || true; nohup pnpm openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
```

### Gateway → Runtime 调用协议

Gateway 通过 AWS SDK `InvokeAgentRuntimeCommand` 调用 Runtime，payload 经 `Buffer.from(JSON.stringify(payload))` 编码。

#### Request (Gateway → Runtime)

```json
{
  "prompt": "用户的原始消息 (无 enrichment)",
  "session_id": "tr-{sanitized_key}，>=33 chars",
  "system_prompt": "Gateway 构建的 system prompt (不含 workspace files，Runtime 从 S3 追加)",
  "context": {
    "channel": "api | telegram | discord | slack | web",
    "agent_id": "main 或 params.agentAccountId",
    "sender_id": "平台用户 ID (optional)",
    "is_group": false,
    "group_id": "群组 ID (optional, is_group=true 时)"
  },
  "storage": {
    "memory_arn": "arn:aws:bedrock-agentcore:us-east-1:ACCOUNT:memory/MEMORY_ID",
    "namespace_prefix": "default",
    "transcript_session_id": "tr-{sanitized_key}"
  },
  "workspace_storage": {
    "s3_bucket": "bucket name",
    "s3_prefix": "openclaw/workspace",
    "s3_region": "us-east-1",
    "namespace_prefix": "default"
  }
}
```

- `storage` 和 `workspace_storage` 仅在配置了 AgentCore Memory / S3 时存在
- `prompt` 是 raw 用户输入，不做 memory enrichment（memory recall 由 Runtime tool call 负责）

#### Response (Runtime → Gateway)

```json
{
  "response": "assistant 的文本回复",
  "session_id": "echo back request 的 session_id",
  "metadata": {
    "model_id": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "tools_used": []
  },
  "workspace_updates": [{ "filename": "SOUL.md", "content": "文件内容 (null = 删除)" }]
}
```

- `workspace_updates` 仅在 agent 使用 `<workspace_update>` tags 时存在
- Gateway 从 response 中 strip `<workspace_update>` tags 后再返回给用户

#### Response 解析优先级 (Gateway 侧)

Gateway 按以下顺序尝试提取 response text:

1. `result.content[].text` — Claude native format
2. `result.response` — 直接字符串
3. 如果 `response` 是 Python dict string (`{'role': 'assistant', 'content': [...]}`) → regex 提取 `'text'` value（`extractTextFromPythonDict()` fallback）
4. `result.text` — 最终 fallback

#### Transcript 存储格式 (Runtime 写入 AgentCore Memory)

每条消息写入双 payload:

```json
{
  "payload": [
    {
      "conversational": {
        "role": "USER | ASSISTANT",
        "content": { "text": "消息内容" }
      }
    },
    {
      "blob": {
        "_type": "line",
        "text": "{\"type\":\"message\",\"id\":\"...\",\"message\":{\"role\":\"...\",\"content\":\"...\"}}"
      }
    }
  ],
  "metadata": {
    "timestamp": { "stringValue": "2026-02-10T..." }
  }
}
```

- `conversational` payload 触发 AgentCore LTM extraction
- `blob` payload 用于 transcript 恢复 (Gateway `readLines()` 读取)

### Gotchas

- AgentCore `readLines` 返回 events newest-first → 必须 reverse
- Pre-existing type errors in `agentcore-memory-backend.ts` (SDK type mismatch) — 不影响运行
- `str(result.message)` in Python 输出 dict format → Gateway 有 `extractTextFromPythonDict()` fallback
- `scripts/committer` handles staged file scoping for commits
- Dual-payload memory: 每个 event 有 `conversational` (触发 LTM 提取) + `blob` (transcript 恢复)

### 已知问题 (待解决)

1. **Response format 未对齐** — runtime 返回 `{response: str(dict)}`, openclaw 期望 `{payloads, meta}`
2. **无 streaming 支持** — runtime 用 `asyncio.run()` 阻塞
3. **ToolRegistry.get_tool()** — 用 `getattr(tool, "name")` 但 Strands `@tool` 设的是 `tool_name`
4. **Code Interpreter / Browser 未创建** — 需通过 control plane 创建后才能在 tool delegation 中使用

### 性能基准 (my_agent v10, Claude Sonnet 4.5)

| 场景                 | 延迟   |
| -------------------- | ------ |
| 冷启动               | ~6.5s  |
| 热启动 - 短回复      | ~6.4s  |
| 热启动 - 长回复      | ~10.4s |
| tool_invoke (无 LLM) | ~4.3s  |

AgentCore Runtime 调度开销约 4s（本地直连 Bedrock 只需 ~1.8s）。
