# Grok Bot host tool runner

## Shipping decision (2026-10-31)

George approved [the host-tool runner design](../specs/2026-10-31-openbot-host-tool-runner-design.md).

- Phase 1 is on `main` (pull request #37). Do not implement it again.
- Implement phases 2, 3, and 4 together in one later effort. Do not open one pull request per phase.
- This file stays the 2026-10-30 analysis. Follow the design spec when the two files disagree.
- Do not turn this file into the implementation checklist. That checklist comes later.

> **For agentic workers:** Read the design spec first. Phases 2–4 ship together. This plan does not change production behavior.

**Goal:** Make OpenBot a host tool runner for a Grok Bot sand agent, in the same role as the BotAI Mac host, while the sand box keeps inference and sand tools.

**Architecture:** Keep the default turn on `POST /api/sendPrompt`. Show tool activity from the transcript first. Then attach OpenBot to the gateway local-exec channel so host tool results return into that same sand turn. Leave `directInference` off.

**Tech stack:** Existing `grok-bot` provider, sand gateway HTTP, OpenBot `item/tool/call` router, agent JSON settings, `@openbot/i18n`.

**Evidence date:** 2026-10-30. Fork tip `6b1bad703` (`origin/main`). BotAI tip read from `jorge123255/botai` at `63cc1e03586b07f5216b900f9e9f296ba0fddea7`. No Electron app, no sand login, and no BotAI build were run.

## Global constraints

- Fork only. Do not open or push a pull request to `nightly-labs/openbot`.
- Draft #30 lands first. This plan does not reimplement its Connect end frame or restart recovery.
- Migrations are irreversible. These phases add no SQLite migration.
- Released Team API adapters stay unchanged. New behavior is local desktop only.
- User-visible text uses `@openbot/i18n` keys. Backend errors use `sourceText(key)`.
- Redact tokens on every log, export, and diagnostic path.
- Keep the renderer-to-main trust boundary. The renderer does not call the gateway.
- Do not change Cursor CLI auth, the `cursor` provider, or the `grok` CLI provider.
- Tests are E2E scripts that write a report under `.openbot-build/`. One worker. No broad `bun run typecheck`.

---

## 1. Gap analysis

### What BotAI does

BotAI (`jorge123255/botai`, private) is the Mac host. The sand box runs the model.

| Step | BotAI location | Behavior |
| --- | --- | --- |
| Send the turn | `source/host/extensions/transcript/send-pipeline.ts` | `sendPrompt` goes to the in-box gateway. |
| Run inference | `source/host/sand-host.ts` and `docs/local-backend.md` | The box calls `InferenceService/Stream` with the box credential from `/sand-box/inference-credential`. The Mac app does not call Stream. |
| Run sand tools | Box, then transcript projection | Shell, edit, read, MCP, web, and computer calls are projected in `source/host/extensions/transcript/client-side-tool-v2-projection.ts`. |
| Run host tools | `source/host/local-exec/local-exec-provider.ts` | The host opens `GET /local-exec/requests` (SSE) and posts results to `POST /local-exec/responses`. Paths are in `source/shared/local-exec-gateway.ts`. |
| Ask permission | `source/shared/local-tool-permission.ts` | Actions are `run-command`, `send-input`, `read-file`, `list-directory`, and `write-file`. Modes are `always`, `ask`, and `never`. Default is `ask`. |
| Show the ask | `source/shared/send-message-preview.ts` | A transcript card uses `message.type` `local-tool-permission`. The UI calls `resolveLocalToolPermission`. |
| MCP in the box | `source/host/extensions/mcp/box-mcp-exec.ts` | `loadServers` pushes MCP config into the box. The box executes `McpArgs`. That puts server config on the box. |
| Computer | `handBackForeverBox`, `getForeverBoxStatus`, `ensureForeverBox` | The host shows the forever-box screen and sends hand-back with `trigger: "button"`. |

Frame kinds the host must understand, from `SandLocalExecProvider`: `welcome`, `retire-approval`, `exec`, `upload`, `download`, `device`, `cancel`. Response kinds: `hello`, `ping`, `client`, `control`, `file`, `file-error`, `device-result`.

### What OpenBot does on `origin/main`

The provider id is `grok-bot`. `provider-drivers.ts` builds `GrokBotAgentClient` and does not set `directInference`.

| Path | Code | What the user sees |
| --- | --- | --- |
| Default `#viaGateway` | `grok-bot-agent-client.ts` `#startTurn` | `POST /api/sendPrompt` with the gateway bearer. Poll `POST /api/getAgentTranscriptTail` every 1500 ms. Emit assistant text only. Stop after the text is unchanged for two polls, or after 10 minutes. |
| Transcript parse | `grok-bot-transcript.ts` `transcriptToMessages` | Keep user and assistant text. Drop every other entry, including tool cards and permission cards. |
| Optional `#stream` | Same client, `directInference === true` | `POST /aiserver.v1.InferenceService/Stream` with the user sand access token. Advertise `dynamicTools`. On a complete `toolCallPart`, call `item/tool/call` and send the result on the next Stream round. Production leaves this flag off. The E2E `scripts/grok-bot-agent-turn-e2e.ts` exercises this path. |
| Account | `grok-bot-account.ts` | User sand access token and refresh token. Separate from the Cursor CLI token. Refresh before Stream (#18) and on gateway 401. |
| Gateway session | `grok-bot-gateway.ts` | `EnsureSandBox` stores `gatewayUrl`, gateway bearer, and `x-anyrun-network-token`. |
| Computer | #20, `grok-bot-computer.ts` | Status, noVNC window, hand-back. Not tied to a tool card in the chat. |
| Side panel | #21 | For a local `grok-bot` chat: Browser tab is the computer pane, Files is a placeholder, Settings is the normal agent settings. |
| MCP picker | #22, `mcp-gateway.ts` `forAgent` | Filters external MCP servers for Codex, Claude, ACP, Pi, and Muse. `src/backend/grok-bot/` does not call it. |
| Chat tool rows | `turn-lifecycle.ts` and `AgentSteps` | Render `dynamicToolCall` items. The gateway path never emits those items. The stream path does. |

### Contradictions to correct in phase 1 docs

These comments describe the old stream path. The code default is the gateway.

- `grok-bot-agent-client.ts` class comment (about lines 72–76) says a turn is `InferenceService.Stream` and that tool parts are not executed.
- `packages/contracts/src/agent-providers.ts` comment on `grok-bot` says turns use InferenceService with that token.
- `docs/architecture/providers.md` section "Grok Bot" says the same and describes host `#runTool` as the turn. That text matches only `directInference`.

`grok-bot-gateway.ts` (about lines 115–118) matches BotAI: the Mac app does not call Stream. The box uses `/sand-box/inference-credential`.

### Gap table

| Capability | BotAI host | OpenBot gateway (default) | OpenBot `directInference` (off) |
| --- | --- | --- | --- |
| Who runs the model | Sand box, box credential | Sand box, box credential | OpenBot, user sand token |
| Sand tools (shell, web, computer, box MCP) | Box | Box, invisible in chat | Not run, unless the model also calls them and OpenBot refuses |
| Host tool execution | `/local-exec/requests` | Absent | `item/tool/call` for advertised names only |
| Tool list sent on the turn | Box tool list | None (`sendPrompt` has prompt text and empty attachments) | `advertisedTools()` from `dynamicTools` |
| MCP from the OpenBot picker | Not applicable | Ignored | Not in the grok-bot client |
| Tool rows in chat | Transcript cards | Assistant text only | `dynamicToolCall` progress when the flag is on |
| Permission ask | `local-tool-permission` card | Not shown | OpenBot approval rules for dynamic tools only |
| Computer hand-back | In the turn UI | Side pane and account panel only | Same |

Draft #30 (`cursor/grok-bot-turn-completion-3feb`) ends a turn when the Connect stream ends, fails with HTTP 415 or `unauthenticated`, or the process restarts. It does not parse gateway tool cards. Assume it has landed before phase 1 edits `grok-bot-agent-client.ts`.

## 2. Target architecture

OpenBot stays a client of the sand gateway. It does not become the inference client.

```text
User message
    -> GrokBotAgentClient #viaGateway
    -> POST /api/sendPrompt          (gateway bearer)
    -> sand box runs the model and sand tools
    -> POST /api/getAgentTranscriptTail
    -> OpenBot emits text and tool-step items

Host tools, only when the agent flag is on:
    sand box -> GET /local-exec/requests  (SSE)
    -> OpenBot allowlist + approval
    -> OpenBot tool router for allowed calls
    -> POST /local-exec/responses
    -> box continues the same turn
```

Rules:

1. One tool owner per call. The box runs sand tools. OpenBot runs a host call only after a local-exec frame arrives. OpenBot does not also call Stream for that turn.
2. `directInference` stays off in `provider-drivers.ts`. Keep the flag for the existing stream E2E. Do not advertise OpenBot tools on Stream in production.
3. Host tools are off when the agent field is absent. Absence means off.
4. Default permission is ask. There is no default of always.
5. MCP secrets and server launch config stay on this computer. Do not call BotAI `loadServers` to copy that config into the box.
6. Cursor, Codex, Claude, ACP, Pi, and Muse keep `mcp.forAgent` as it is today. Grok Bot reads the same filter. It does not change the filter.

### Approaches considered

**A. Gateway plus local-exec. Chosen.** This matches BotAI. Sand tools stay in the box. Host results rejoin the sand turn. The user sand token is not used as the inference credential.

**B. Turn `directInference` on.** Rejected as the product path. The stream client uses the user sand token. BotAI documents that token as the wrong credential for Stream. Sand tools would not run inside the box. If both paths run, the same tool can run twice. The code path can stay for tests.

**C. Push OpenBot MCP config into the box.** Rejected for connectors. `box-mcp-exec.ts` `loadServers` gives the box the server config. OpenBot connector secrets must stay on the computer. Phase 3 runs an MCP call on the host only when the box sends that call on local-exec. It does not upload the connector config.

The 2026-10-31 design uses “full phases 2–4” for one implementation of local-exec, host MCP, and ask / always / never. That name is not approach C in this section. Approach C here stays rejected.

## 3. Phased pull requests

The original split was one pull request per phase. The design spec replaces that split: phases 2, 3, and 4 are one implementation. The sections below keep the original file lists as analysis. They are not the shipping sequence.

### Phase 1 — Show sand tool activity in chat

The turn stays on the gateway. OpenBot does not execute tools.

**Files:**

- Modify: `src/backend/grok-bot/grok-bot-transcript.ts`
- Modify: `src/backend/grok-bot/grok-bot-agent-client.ts` (`#viaGateway` only, after #30)
- Modify: `docs/architecture/providers.md` Grok Bot section
- Modify: the `grok-bot` comment in `packages/contracts/src/agent-providers.ts`
- Create: `scripts/grok-bot-transcript-tools-e2e.ts`
- Modify: `scripts/grok-bot-gateway-e2e.ts` only if the existing fake gateway must serve the fixture
- Changelog: the phase 1 branch adds `changelog.d/<branch>.md` with one user-visible item for tool rows in a Grok Bot chat. This plan pull request has no user-visible change.

**Interface produced:**

```ts
export interface GrokBotTranscriptToolStep {
  readonly id: string;
  readonly name: string;
  readonly status: "inProgress" | "completed" | "failed";
  readonly detail: string;
}

export function transcriptToolSteps(body: unknown): readonly GrokBotTranscriptToolStep[];
```

`transcriptToMessages` stays the text parser. `transcriptToolSteps` is separate.

**Mapping rules:**

- Read a redacted `getAgentTranscriptTail` fixture checked into the E2E. Record the fixture from the fake gateway first. Do not invent field names that the fixture does not contain.
- Emit a step only when `id` and `name` are non-empty strings.
- Status `failed` only when the fixture marks an error. Otherwise `completed` when the entry is finished, and `inProgress` when it is not.
- `detail` is display text already present on the entry. Do not add tool arguments that are absent.
- Ignore `send-message` cards, as `transcriptToMessages` already documents.
- Ignore unknown entries. Leave them out of both the text parser and the step list.
- Do not call `item/tool/call`. Emit `item/started` and `item/completed` with `type: "dynamicToolCall"` so the existing `AgentSteps` path can show them. `namespace` is `sand` for these display rows. `tool` is the fixture name. `turn-lifecycle.ts` records `item/started`. It does not run the tool router.

**Turn end:**

- Keep the assistant-text stop rule.
- Also stop when the tail has a new assistant message for this prompt and no in-progress tool step.
- A permission card or an in-progress tool step does not count as a missing reply. Keep the turn running until the card is resolved, the step finishes, the user stops, or the 10 minute limit fires.
- Do not treat two identical empty polls as success. An empty reply remains the existing failure.
- Do not edit the Connect end-frame code from #30.

**Checks:** `biome check` on the changed files. `bun run typecheck:node`. `bun scripts/grok-bot-transcript-tools-e2e.ts`. `bun scripts/grok-bot-gateway-e2e.ts`. `bun scripts/grok-bot-agent-turn-e2e.ts` still passes with `directInference` behavior unchanged.

**Success:**

- A fixture tail with one finished sand tool and one assistant sentence produces one `dynamicToolCall` completed item and the assistant text.
- A fixture tail with only text still produces the same assistant message as today.
- An unknown entry does not create a tool item and does not throw.
- `provider-drivers.ts` still omits `directInference`.
- Cursor and other provider tests are not in this pull request.

### Phase 2 — Host local-exec loop, default off

The design spec supersedes the `grokBotHostTools` flag and the Shell refusal in this section. Auto-review is the gate. Shell is part of the combined ship.

**Files:**

- Create: `src/backend/grok-bot/grok-bot-local-exec.ts`
- Modify: `src/backend/grok-bot/grok-bot-agent-client.ts` to start and stop the client with the thread
- Modify: agent JSON read and write in `src/backend/agent-store.ts` and the local agent IPC types, following `mcpServerIds`
- Modify: `packages/ui` agent settings only to show one checkbox for a `grok-bot` agent
- Create: `scripts/grok-bot-local-exec-e2e.ts`
- Do not modify `src/backend/acp-client.ts` or other provider drivers

**Setting:**

- Name: `grokBotHostTools`
- Type: boolean
- Absent or `false`: the local-exec client does not start
- `true`: start it for that agent's sand gateway session
- Store it on the agent JSON document. No SQLite migration. No Team API field.
- The renderer receives the boolean only. It does not receive gateway tokens.

**Interface:**

```ts
export interface GrokBotLocalExecSession {
  readonly url: string;
  readonly token: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface GrokBotLocalExecOptions {
  readonly session: GrokBotLocalExecSession;
  readonly signal: AbortSignal;
  readonly decide: (frame: GrokBotLocalExecRequest) => Promise<"execute" | "ask" | "refuse">;
  readonly execute: (frame: GrokBotLocalExecRequest) => Promise<GrokBotLocalExecResponse>;
}

export function runGrokBotLocalExec(options: GrokBotLocalExecOptions): Promise<void>;
```

`GrokBotLocalExecRequest` uses the seven request kinds named above. `GrokBotLocalExecResponse` uses the response kinds named above. Copy the kind names. Do not copy BotAI's protobuf executor.

**Allowlist for this phase:**

| Frame | Decision when the flag is on |
| --- | --- |
| `welcome` | Store `providerId`. Send `hello`. Do not touch the disk. |
| `exec` whose described action is `read-file` or `list-directory` | `ask`, then `item/tool/call` only after approval. Refuse when the user denies. |
| `exec` for `run-command`, `send-input`, or `write-file` | `refuse` with a stable error string. Phase 4 removes this refusal. |
| `upload`, `download`, `device`, `cancel` of an unknown id | `refuse` or ignore `cancel` when no request is in flight. |
| `retire-approval` | Delete that approval id from the agent-local approval list. |

**Auth:** Use the gateway bearer and the stored gateway headers, including `x-anyrun-network-token` when present. Do not send the user sand access token on `/local-exec/*`.

**Single subscriber:** The E2E records the status when a second SSE client connects to the fake gateway. Against a real gateway this is unverified. If the live status is not 200, stop the OpenBot client and leave the existing subscriber in place. Do not retry in a loop. Log a redacted diagnostic.

**Success:**

- Flag absent: the E2E gateway receives no `GET /local-exec/requests`.
- Flag on: one `read-file` frame is approved, the tool router returns text, and `POST /local-exec/responses` contains that text and the same `requestId`.
- A `run-command` frame produces a refusal response and does not spawn a process.
- A stream turn is not started. `directInference` stays off.
- An existing local-agent MCP scope E2E still passes. Run `scripts/agent-mcp-scope-e2e.ts` because agent JSON shape changes.

### Phase 3 — OpenBot MCP picker for grok-bot agents

The design spec keeps host MCP in the combined ship for every agent. A missing Grok MCP frame does not remove MCP for other agents. Do not upload MCP config to the box.

Do this only after phase 2 can return a host result.

**Spike, inside this same pull request, before any advertise code:**

- Extend the fake gateway and add one live-shaped fixture for an MCP exec frame if a redacted capture exists.
- Search the gateway methods OpenBot already calls. Confirmed today: `sendPrompt` does not send a tool list.
- If no captured frame asks the host to run an MCP tool, stop the pull request after the spike notes. Do not enable `directInference`. Do not upload MCP config to the box.

**When a frame names an MCP tool:**

- Resolve servers with `McpGateway.forAgent` for that agent id. Keep the Computer Use and GitHub connector exceptions as they are.
- Execute through the existing `item/tool/call` path in `openbot-tool-router.ts`.
- Return the tool text on `/local-exec/responses`.
- An agent with an empty MCP selection runs no external MCP server. Same rule as local agents.
- The model can call the tool only if the box already offers that tool. This phase does not add a new advertise API. If the box never offers the OpenBot server, the spike stops, and advertisement waits for a separate decision.

**Files:** `grok-bot-local-exec.ts`, a small adapter next to it, `scripts/grok-bot-host-mcp-e2e.ts`. No change to Team API codecs.

**Success:**

- Selected server: one fixture MCP frame runs that server's tool and returns one result.
- Empty selection: the same frame is refused and the server is not started.
- Another agent's servers are not used.
- `scripts/agent-mcp-scope-e2e.ts` and `scripts/mcp-oauth-e2e.ts` still pass.

### Phase 4 — Computer hand-off and permission parity

#20 already opens the forever box and sends `handBackForeverBox`. This phase connects that UI to the turn.

**In scope:**

- A transcript computer hand-off entry, once a fixture confirms its fields, shows the existing Open and Hand back actions in the chat. Hand back still calls `handBackGrokBotComputer` with `trigger: "button"`.
- Permission mode for host actions: `ask` (default), `always` for one saved approval id, `never`.
- Persist approval ids that the gateway sends. Honor `retire-approval`.
- Allow `run-command` and `write-file` only after the mode permits them, and only inside the workspace root the tool router already enforces.
- New strings are i18n keys. The computer pane keys from #20 stay.

**Out of scope:** Chrome cookie export, Messages.app, Contacts, device `messages`, `contacts`, and `chrome-cookies` operations. Refuse those frames. OpenBot desktop Computer Use stays a separate control. Do not merge it with the forever box.

**Files:** `grok-bot-local-exec.ts`, `GrokBotComputerPane.tsx` or the chat tool row that already renders approvals, `scripts/grok-bot-host-permission-e2e.ts`.

**Success:**

- `never` refuses `read-file` and `run-command` with no tool execution.
- `ask` shows one approval and runs the tool once after allow.
- `always` runs a second call with the same approval id and does not ask again.
- `retire-approval` makes the next call ask again.
- Hand back sends `{ id, trigger: "button" }` once.
- A `device` frame for cookies or messages is refused.

## 4. Risks

| Risk | What we do |
| --- | --- |
| User sand token versus box credential | Production turns stay on `sendPrompt`. Local-exec uses the gateway bearer. Stream keeps the user token and stays off. |
| Double execution | Do not run `#runTool` and local-exec for the same call. Sand tools are not sent to `item/tool/call` in phase 1. They are display rows with namespace `sand`. |
| Second local-exec subscriber | Flag default off. On a non-200 subscribe, disconnect and do not retry. |
| Host tool blast radius | Phase 2 allows read and list only, after ask. Shell and write wait for phase 4. Device secrets stay refused. |
| MCP secrets in the box | Do not call `loadServers`. Host execution only, and only for `forAgent` servers. |
| Local agents regress | Do not change the `forAgent` filter, Cursor CLI files, or other provider drivers. Re-run the MCP scope E2E when agent JSON changes. |
| Stuck thinking | #30 covers the Connect stream. Phase 1 covers a gateway turn that is waiting on a tool step. Do not mark that turn failed for empty assistant text. |
| Transcript shape is unconfirmed | No live tail was captured for this plan. Phase 1 ships no mapper field that the checked-in fixture lacks. |
| Stale comments | Phase 1 updates the three comments listed above so the next change does not turn Stream back on by mistake. |
| i18n and trust boundary | No new raw strings in the renderer. No gateway token in IPC payloads. Preload continues to reject `accessToken`, `refreshToken`, and `gatewayToken` on account payloads. |

## 5. Success criteria by phase

| Phase | Done when |
| --- | --- |
| 1 | Gateway chats show sand tool rows from the transcript. Text-only chats stay the same. No host tool runs. |
| 2 | A flagged agent answers one approved read over local-exec. An unflagged agent opens no local-exec stream. Shell does not run. |
| 3 | A selected MCP server can answer a host MCP frame, or the spike records that the gateway never sends one and the pull request adds no advertise path. |
| 4 | Ask, always, never, and retire match the BotAI modes for the five local actions that this plan allows. Computer hand-back is available from the chat card. Cookie and message export stay refused. |

The design spec replaces the phase 2 Shell refusal, the one-pull-request-per-phase rule, and the phase 4 chat hand-back card. Cookie and message export stay refused.

## 6. First implementation pull request

Phase 1 is done. It landed on `main` as pull request #37. Do not open it again.

The next implementation follows the design spec. It includes phases 2, 3, and 4 in one effort.

The original instruction was phase 1 only. That instruction is complete. Phase 1 did not grant a host tool and did not change auth. It shows sand tool rows from the transcript.

## 7. Unconfirmed items

| Item | Where we looked | Result |
| --- | --- | --- |
| Live `getAgentTranscriptTail` JSON during a tool call | OpenBot parser and gateway E2E fixtures | Text fields only. No live sand capture. |
| Two local-exec clients at once | BotAI `local-exec-provider.ts` | One `providerId` per connection. Fan-out is not specified. |
| A gateway method that adds arbitrary OpenBot tool schemas | `sendGrokBotPrompt` body and BotAI `sendPrompt` | No tool-list field found on the send path. |
| Whether #30's diff still applies cleanly after #19–#22 | PR 30 file list | It edits `grok-bot-agent-client.ts` and `grok-bot-inference.ts`. Rebase onto main after it merges. |
