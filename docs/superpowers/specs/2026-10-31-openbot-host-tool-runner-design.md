# OpenBot host-tool runner

**Status:** Approved design. George locked the decisions on 2026-10-30 and 2026-10-31 (US Central).

**Plan:** [2026-10-30-grok-bot-host-tool-runner.md](../plans/2026-10-30-grok-bot-host-tool-runner.md)

**Pull request:** Draft [#32](https://github.com/jorge123255/openbotv/pull/32) on `cursor/grok-bot-host-tool-runner-cea5`. This document does not implement the runner. It does not mark that pull request ready.

**Phase 1:** Merged on `main` as [#37](https://github.com/jorge123255/openbotv/pull/37). Sand tool rows already show in a Grok Bot chat. This design starts at phases 2–4.

## Goal

OpenBot becomes the host-tool runner in the same role as the BotAI Mac host.

Any OpenBot agent can run Shell and a screen capture on any registered machine. The machine comes from `ListMachines`. The call names that machine with `machineId`. The same runner executes host MCP. Each call passes Auto-review. The modes are `ask`, `always`, and `never`. The default is `ask`.

The user sees the call as a tool row in that agent's chat.

The Grok Bot sand turn stays on `POST /api/sendPrompt`. `directInference` stays off.

## Scope

This design covers one later implementation. That implementation ships the plan's phases 2, 3, and 4 together. The brainstorm called this choice Approach C: local-exec, host MCP, and ask / always / never in one effort.

In scope:

- A tool adapter for every OpenBot agent provider.
- Host actions: Shell, screenshot, and host MCP. Phases 2 and 4 also allow `read-file`, `list-directory`, `write-file`, and `send-input` under the same Auto-review gate. Those four actions stay in this ship.
- Auto-review with modes `ask`, `always`, and `never`. The default is `ask`.
- A local-exec bridge to the daemon on the chosen `machineId`.
- An OpenBot-side MCP client for the servers that agent already selected.
- Tool rows that show stdout, the exit code, a screenshot path and thumbnail, a denial, or an error.
- The approve path: Shell `echo` and one screenshot on a registered Mac.

The demo to match is Grok Bot host peek: a Mac screenshot and Shell on a registered machine. The sand box computer is not that demo.

## Non-goals

- Side panel polish. The chat tool row is the UI for this ship.
- Hermes gateway work. That stays on draft [#44](https://github.com/jorge123255/openbotv/pull/44).
- The sand box computer. [#45](https://github.com/jorge123255/openbotv/pull/45) stays a separate, parallel path. Host tools do not replace it.
- A chat hand-back card for the sand desktop. The plan's phase 4 names that card. The sand box computer owns hand-back. This design does not add the card.
- `directInference` as a production turn. Do not advertise host tools on `InferenceService/Stream`.
- A copy of MCP or connector config into the sand box. Do not call BotAI `loadServers`.
- Device frames for cookies, Messages, Contacts, or Chrome cookies. The runner refuses those frames.
- `upload` and `download` frames. The runner refuses those frames.
- A new SQLite migration, a Team API field, or a Cloudflare copy of the rules.
- One pull request per phase. George replaced that rule. See [Shipping shape](#shipping-shape).

## Shipping shape

| Item | Decision |
| --- | --- |
| Phase 1 | Done on `main` via #37. Do not implement it again. |
| Phases 2, 3, and 4 | One implementation after this spec and a later plan. |
| Who can call host tools | Every OpenBot agent. Not only Grok Bot. |
| Gate | Auto-review. There is no `grokBotHostTools` flag. |
| Where Shell and screenshot run | The `machineId` from `ListMachines`. |
| Where MCP runs | This computer, in the OpenBot MCP client. |
| What the user sees | Tool rows in the agent chat. |
| Grok turn | `POST /api/sendPrompt`. `directInference` stays off. |
| Sand desktop | #45. Parallel. Not this runner. |

The plan's approach C is a different, rejected idea: push MCP config into the sand box. This design does not adopt that idea. "Approach C" in the 2026-10-31 brainstorm means only the one-ship decision in the table above.

## Architecture

```text
Agent turn
    -> tool adapter
         Shell, screenshot, file actions, or host MCP
    -> host-tool runner queue
    -> Auto-review (ask | always | never)
    -> on allow:
         Shell, screenshot, and file actions:
             local-exec on the chosen machineId
         host MCP:
             OpenBot MCP client on this computer
    -> tool row in that agent's chat

Grok sand path, unchanged by this runner:
    POST /api/sendPrompt
    sand box runs the model and sand tools
    #37 shows those sand tools as display rows
    #45 drives the sand desktop

Host tools run beside that path. They do not replace it.
```

Rules:

1. One owner per call. The runner executes a host call once. The provider runtime does not also execute that same call.
2. Sand display rows from #37 stay display rows. Their namespace stays `sand`. The runner does not send them to local-exec.
3. The sand box computer (#45) is not a host screenshot. A host screenshot is the screen of the registered machine.
4. `directInference` stays off in the Grok Bot production driver. The existing stream end-to-end script may still set the flag.
5. The renderer does not call the gateway. The main process keeps the local-exec tokens.
6. Local-exec uses the gateway bearer and the stored gateway headers, including `x-anyrun-network-token` when it is present. Local-exec does not send the user sand access token.
7. Logs, exports, and diagnostics redact tokens and do not include screenshot bytes.

The checksum id in `openbot-grok-bot-machine-id` is not the host-tool target. The host-tool target is the `machineId` from `ListMachines`.

## Components

### 1. Tool adapter

The adapter sits on every provider turn. It maps these calls into one host-tool request:

| Call | Runner action | Executor |
| --- | --- | --- |
| Shell | `shell` | Local-exec `run-command` |
| Screenshot | `screenshot` | Local-exec on the selected machine |
| Read file | `read-file` | Local-exec |
| List directory | `list-directory` | Local-exec |
| Write file | `write-file` | Local-exec |
| Send input | `send-input` | Local-exec |
| Host MCP | `mcp` | OpenBot MCP client |

A provider tool that is not in this table stays on that provider's own path.

A Grok host call arrives as a local-exec frame from the sand gateway. The adapter maps that frame into the same request. The Grok turn still uses `sendPrompt`. The adapter does not open `InferenceService/Stream` to collect the call.

Each request has one id. The response uses that same id.

### 2. Policy gate

The policy store is on this computer. It is per user, not per agent. It is a local document. It is not a SQLite migration and not a Team API field.

The shape matches Grok Bot Auto-review. Each saved rule is one action and one mode:

| Mode | Behavior |
| --- | --- |
| `ask` | Default when no rule matches. Show one approval card. Do not run the tool yet. |
| `always` | Run the action. Do not show a card. |
| `never` | Do not run the action. The tool row says denied. Do not show a card. |

There is no default of `always`.

The approval card offers three choices:

- **Allow once.** Run this call. Leave the stored mode at `ask`.
- **Always.** Run this call. Save `always` for this action for this user.
- **Never.** Do not run this call. Save `never` for this action for this user. The row says denied.

`always` and `never` apply to that action for every agent of this user on this computer. They do not apply to a single command line, a single server, or a single `machineId`.

A gateway `retire-approval` frame clears `always` for the action tied to that approval id. The next call for that action uses `ask`. It does not clear `never`.

While the card is open, the turn stays open. The wait ends on Allow once, Always, Never, or expiry. The card expires at the same deadline as the open turn. A Grok gateway turn already uses 10 minutes (`gatewayTurnTimeoutMs`). Other providers use that same 10 minute ask deadline. At expiry the row says denied and the turn continues.

Denied and expired calls do not run the tool.

The gate runs after the runner rejects a frame kind that this design does not execute. Device, upload, and download frames never reach `always`.

### 3. Local-exec bridge

The bridge follows the BotAI host pattern. The daemon on the registered machine is the host:

- The daemon reads work with `GET /local-exec/requests` (server-sent events).
- The daemon returns the result with `POST /local-exec/responses`.

The request and the response share one request id. Paths and frame names stay the BotAI names from the plan: request kinds `welcome`, `retire-approval`, `exec`, `upload`, `download`, `device`, and `cancel`; response kinds `hello`, `ping`, `client`, `control`, `file`, `file-error`, and `device-result`.

`welcome` stores `providerId` and returns `hello`. It does not touch the disk.

`ListMachines` lists the registered daemons. `machineId` selects one daemon. This design adds no third HTTP path. Delivery uses that same local-exec channel.

Machine choice:

1. Use the `machineId` on the request when `ListMachines` currently lists that id.
2. When the request omits `machineId` and the list has one machine, use that machine.
3. When the request omits `machineId` and the list has more than one machine, do not guess. The tool row is an error and the turn continues.
4. When the list is empty, or the id is absent from the list, the tool row is an error and the turn continues.

When the selected machine is this computer, this OpenBot process is the daemon. It reads the request, runs the allowed Shell, screenshot, or file action on this computer, and posts the response.

When the selected machine is a different registered machine, the daemon on that machine reads the request and runs it. This OpenBot waits for `POST /local-exec/responses` and puts that body on the tool row. Auto-review runs only in this OpenBot, before that daemon runs the tool. The remote daemon does not ask again.

A failed subscribe, a missing daemon, or a lost connection is an error row. The runner does not retry in a loop. If a second subscriber is rejected, this OpenBot disconnects and leaves the existing subscriber in place.

Shell and screenshot on that machine are the host-peek behavior. They are not the sand box `cua-driver` path.

### 4. MCP host

Host MCP runs in the OpenBot MCP client on this computer.

- Resolve servers with the agent's existing selection (`McpGateway.forAgent`).
- An empty selection refuses the call and does not start a server.
- The runner does not use another agent's servers.
- The runner does not upload server config or secrets to the sand box.
- The result returns on the host-tool response path. A Grok local-exec MCP frame also returns on `POST /local-exec/responses`.

MCP does not need a `machineId`.

### 5. Transcript rows

Phase 1 already shows sand tool rows from the gateway transcript. This ship does not change those rows into executions.

A host-tool row belongs to the agent that made the call. On success the row carries:

- Shell and other command actions: stdout and the exit code.
- Screenshot: a local path and a thumbnail. The bytes stay on this computer.
- MCP: the tool text from the OpenBot MCP client.
- File read and directory list: the text the daemon returned.

User-visible words come from `@openbot/i18n`. Main-process and backend errors use `sourceText`. The denied row uses a catalog key whose English source is `Denied`.

## Data flow

1. The provider emits a Shell, screenshot, file, or host MCP call, or the sand gateway emits a local-exec frame.
2. The adapter builds one host-tool request and queues it.
3. The runner drops frame kinds outside this design (`device` secrets, `upload`, `download`) and writes a refused row.
4. The policy gate applies `ask`, `always`, or `never`.
5. On allow, Shell, screenshot, and file actions go to the daemon for the chosen `machineId` through local-exec. Host MCP runs in the OpenBot MCP client on this computer.
6. The runner posts the result back. A sand-gateway call uses `POST /local-exec/responses` with the same request id. Every call also becomes a tool row in that agent's chat.
7. The turn continues after success, denial, expiry, and error.

## Errors

Each case finishes the tool row and lets the turn continue. None of these cases wait for a retry.

| Case | Row | Execution |
| --- | --- | --- |
| User denies the card, stored mode is `never`, or the card expires | Denied | None |
| `machineId` missing, unknown, or ambiguous | Error. The message says the machine is unavailable. | None |
| Daemon missing, subscribe fails, or the connection drops | Error. The message says the machine is offline. | None. No retry loop. |
| The operating system denies the screenshot | Error. The message says the screen capture was denied. | None |
| Device, upload, or download frame | Refused | None |
| Empty MCP selection, or a server that belongs to another agent | Refused | The server does not start |

## Testing

The repository default is an end-to-end script under `scripts/`, with a report under `.openbot-build/`. George set that default aside for two checks: the policy gate, and the local-exec request and response shape. Those two checks are unit tests. The smoke test stays an end-to-end script. This exception does not allow unit tests for the rest of the runner.

Policy-gate unit tests:

- No saved rule yields `ask`, and the tool does not run before Allow once or Always.
- `always` runs the action and does not open a card.
- `never` writes a denied row and does not run the tool.
- Deny and expiry write a denied row and continue the turn.
- `retire-approval` clears `always` and makes the next call ask again. It does not clear `never`.
- A device frame does not match an `always` rule.

Request and response unit tests:

- A Shell request and a screenshot request each carry `machineId` and one request id.
- `POST /local-exec/responses` repeats that request id.
- The read path is `GET /local-exec/requests`.
- The response does not contain the user sand access token.

End-to-end smoke, approve path, on a registered Mac:

- The target is one `machineId` from `ListMachines`.
- The user takes Allow once.
- Shell runs `echo host-tool-ok`. The tool row shows that text and exit code 0.
- One screenshot row shows a local path and a thumbnail.
- `directInference` stays off.
- The script writes a report under `.openbot-build/`.
- The sand box computer path is not part of this smoke.

The offline row and the operating-system screenshot denial are checks against a failed local-exec result. They do not need a second Mac. Each check ends on an error row.

## Constraints that stay

- Fork only. Do not open a pull request against `nightly-labs/openbot`.
- Released Team API adapters stay unchanged.
- No SQLite migration.
- Redact secrets on every log, export, and send path.
- Keep the renderer-to-main trust boundary.
- New user-visible text uses `@openbot/i18n`.
- PolyForm Noncommercial 1.0.0 stays.

## Relation to the plan and to pull request #32

The plan is the 2026-10-30 analysis of BotAI and of OpenBot on the gateway path. Draft #32 holds that plan. This spec is the product decision for the work that is still open.

Follow this spec when the plan disagrees. These plan statements are superseded:

| Plan statement | Design decision |
| --- | --- |
| One phase per pull request. | Phases 2–4 ship together. Phase 1 is already #37. |
| Host tools are for a Grok Bot agent, behind `grokBotHostTools`, default off. | Every OpenBot agent can call host tools. Auto-review is the gate. Default `ask`. |
| Phase 2 refuses `run-command`. | Shell is in this ship, after Auto-review. |
| The host is only this OpenBot process. | Shell and screenshot target any registered `machineId`. |
| Phase 4 adds a chat hand-back card. | Out of scope. #45 owns the sand desktop. |
| Do not add unit tests. | Unit tests are allowed for the policy gate and the request/response shape only. |

These plan statements stay in force:

- The Grok production turn is `POST /api/sendPrompt`.
- `directInference` stays off.
- MCP secrets stay on this computer.
- Local-exec does not use the user sand access token.
- Device secret frames stay refused.
- Phase 1 rows display sand tools and do not execute them.

The later implementation plan is a checklist. This spec is not that checklist. Do not start the implementation inside pull request #32.

## Unconfirmed items

| Item | Where we looked | Decision for the implementer |
| --- | --- | --- |
| `ListMachines` response fields | `src/backend/grok-bot/` on this branch, 2026-10-31. No `ListMachines` symbol. | Call the same Grok Bot `ListMachines` operation Grok Bot uses. Decode it at the boundary. Do not invent fields in this spec. An empty or failed list produces an error row. |
| A live local-exec capture | The plan's BotAI read at `63cc1e03586b07f5216b900f9e9f296ba0fddea7`. No live sand login for this spec. | Use the frame names in this spec. A field that a captured frame does not contain stays out of the decoder. |
| Two local-exec subscribers | The plan, from BotAI `local-exec-provider.ts`. Fan-out is not specified. | On a rejected subscribe, disconnect and do not retry. |
| How a call reaches a remote `machineId` | BotAI's host is the `GET` subscriber. This branch has no second submit route under `src/backend/grok-bot/`. | Use the existing Grok Bot local-exec channel for that `machineId`. The registered Mac that runs this OpenBot does not need that submit route. If the channel cannot address a different machine, ship the local daemon path and record the remote gap. Do not invent a new HTTP path. |
| Phase 1 code on this branch | `src/backend/grok-bot/grok-bot-transcript.ts` on `cursor/grok-bot-host-tool-runner-cea5`. No transcript tool-step mapper in this file. | Treat #37 on `main` as the phase 1 result. Do not re-implement phase 1 on the plan branch. |
