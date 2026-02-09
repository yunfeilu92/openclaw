# AgentCore Memory/History Fix Plan

## Target Architecture

**Gateway = thin routing layer** (no memory/history/transcript logic)
**Runtime = owns ALL intelligence and state** (history, memory recall, transcript writing)

This matches the native OpenClaw model where the agent owns conversation state.

## Problem Summary

AgentCore interaction chain had 5 issues vs native OpenClaw model:

1. **Enriched prompt pollution**: `[Recalled Memory]` blocks saved to session history, cumulative bloat
2. **Double-write**: Same conversation written by both Gateway and Python session_manager
3. **Session reset broken**: `/new` doesn't reset Python history (sessionKey stable vs sessionId changes)
4. **Memory logic misplaced**: Gateway was doing memory pre-fetch instead of Runtime
5. **Transcript writing misplaced**: Gateway was writing transcripts instead of Runtime

## Fixes Applied (Round 2 — Clean Architecture)

### ✅ Fix 1: Slim Gateway to pure routing layer

- `agentcore-provider.ts`: Removed memory pre-fetch, history loading, transcript writing
- Gateway only: builds workspace context + system prompt, forwards raw prompt, emits events
- Removed `loadRecentTranscriptHistory()`, `writeTranscriptToStorage()`, memory recall import
- Added `resolveStorageConfigForRuntime()` to pass storage info to Python
- Added `updateSessionEntryWithTranscriptUri()` to set `entry.sessionFile` for chat.history

### ✅ Fix 2: Runtime owns history + transcript

- `agent.py`: Loads FULL session history (no artificial limit, like native)
- `agent.py`: Saves transcript with conversational payload (triggers LTM extraction)
- `session.py`: Uses same actor/session scheme as Gateway backend for chat.history compatibility
  - `actorId = "openclaw-storage/{prefix}/transcripts"`
  - `sessionId = "tr-{sanitized(key)}"`
- `session.py`: Dual payloads per event: `conversational` (LTM) + `blob` (transcript recovery)

### ✅ Fix 3: Unify session_id to transcriptSessionId

- Gateway sends `transcriptSessionId` (changes on `/new`) in `storage.transcript_session_id`
- `app.py`: Uses `transcript_session_id` for history/transcript operations
- `agentCoreSessionId = ensureSessionKeyLength(transcriptSessionId)` for AgentCore API

### ✅ Fix 4: Per-request session manager from Gateway storage config

- `app.py`: Creates `AgentCoreSessionManager` per-request from payload's `storage` config
- Receives `memory_arn`, `namespace_prefix`, `transcript_session_id` from Gateway
- No more global session_manager from env vars (was coupled to wrong session key)

### ✅ Fix 5: Raw prompt (no enrichment)

- Gateway sends `params.prompt` directly (no `[Recalled Memory]` enrichment)
- Memory recall is a tool the agent calls on-demand (like native OpenClaw)

## Files Changed

### Gateway (openclaw repo)

- `src/agents/agentcore-provider.ts` — Slimmed to pure routing, storage config for Runtime

### Python Runtime (openclaw-agentcore-demo repo)

- `src/runtime/agent.py` — Owns history loading + transcript writing
- `src/runtime/app.py` — Per-request session manager, simplified invoke
- `src/memory/session.py` — Rewritten with correct actor/session scheme + dual payloads

## Verification

- [x] `pnpm build` passes
- [x] `pnpm tsgo` — no new type errors (pre-existing errors in agentcore-memory-backend.ts unchanged)
- [ ] Manual test: send message, check Runtime logs for history loading + transcript writing
- [ ] Manual test: `/new` resets conversation (transcript_session_id changes)
- [ ] Manual test: memory recall still works cross-session (LTM via conversational payload)
- [ ] Manual test: chat.history reads from Runtime-written transcript correctly
