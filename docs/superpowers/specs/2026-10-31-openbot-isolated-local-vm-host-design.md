# OpenBot isolated local-VM host

**Status:** Approved design. George locked the decisions on 2026-10-31.

**Plan:** None. A later plan can turn this spec into a checklist. This document does not implement the host.

**Pull request:** Draft [#52](https://github.com/jorge123255/openbotv/pull/52) on `cursor/isolated-local-vm-host-design-6e67`. This document does not mark that pull request ready. Merge and a rebuild need an explicit GO from George.

## Goal

A Grok turn that the user sends in OpenBot runs on a private local gateway. The reply stays in OpenBot.

The official Grok Bot app stays closed and unfocused. The turn does not enter that app's shared transcript. The turn does not raise that app's notifications or badges.

The sand account, the sand protocol, and the agent roster API stay the same. Isolation swaps the runtime host only.

## Scope

This design covers one later implementation. That implementation starts and owns a private sand gateway on this computer, and it sends every OpenBot Grok turn to that gateway.

In scope:

- A private local-docker host, in the same role as BotAI `local-docker` with `BOTAI_ISOLATED_RUNTIME=1`.
- The loopback gateway `http://127.0.0.1:1340`.
- `createAgent`, `listAgents`, `sendPrompt`, `GET /events`, the transcript tail, and the box computer on that gateway only.
- Skip of account-wide turn-finished push (`NotifySandAgentTurnFinished`).
- Grok Bot notification config forced off for agents on this host.
- Deep links that stay `redirectTarget=cli` and `openbot://`.
- Quit that stops the private host.
- An in-OpenBot error when the local host does not start. The error path does not call shared `EnsureSandBox`.
- The shipped host-tool runner keeps its current local-exec and Auto-review behavior. Its Grok subscribe uses the private gateway because the gateway session URL is that gateway.

## Non-goals

- Hermes gateway work. That stays on draft [#44](https://github.com/jorge123255/openbotv/pull/44). This design does not edit that branch.
- A change to the host-tool runner. Phases 2–4 shipped as [#49](https://github.com/jorge123255/openbotv/pull/49). `src/backend/host-tools/` stays as it is. This design changes the gateway session the runner already reads.
- A second runtime. The OpenBot Grok path does not offer `remote`, `custom`, or `remote-k3s`.
- LAN publish of the gateway, noVNC, or the exec daemon.
- A self-hosted APNs path, a BotAI mobile push relay, or a Cloudflare tunnel in front of this gateway.
- `directInference` as a production turn.
- A SQLite migration, a Team API field, a mobile change, or a `package.json` version bump.
- A rebuild, an install, or a release of OpenBot.
- A call that opens or focuses the official Grok Bot app.
- Reuse of BotAI's container `botai-local-vm` or of `~/.botai/local-docker-vm.json`.

## Decisions

| Item | Decision |
| --- | --- |
| Runtime | `local-docker` only. BotAI's default is already `local-docker`. OpenBot has no switch that selects a shared box. |
| Gateway | `http://127.0.0.1:1340` only. No port offset. |
| Container | Name `openbot-local-vm`. Label `app.openbot.desktop.local-vm=1`. |
| Image | The image string BotAI pins: `public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest`. |
| Isolation | The container environment sets `BOTAI_ISOLATED_RUNTIME=1`. OpenBot does not read a value that can clear it. |
| Account-wide push | The host does not call `NotifySandAgentTurnFinished` on `api2.cursor.sh`. |
| Notification config | Host config `isEnabled` stays false. Each agent on this host has `notifyOnAgentUpdates` false. |
| Deep link | `redirectTarget` stays `cli`. The only scheme is `openbot`. |
| Shared box RPC | The desktop does not POST `GrokBotService/EnsureSandBox` to `api2.cursor.sh`. |
| Stored session | The account file stores the loopback gateway and the local gateway token. A stored `*.cursorvm.com` URL is dropped before any request. |
| Host tools | Unchanged runner. `runLocalExecClient` already uses `session.url`. |
| Start failure | In-OpenBot error. No shared-box fallback. |
| Quit | `docker stop` the owned container. Volumes stay. |
| Bundle id | Stays `app.openbot.desktop`. Support data stays in the current userData directory. |
| Roster | Same sand account and the same gateway methods. The roster OpenBot shows is the private host's roster. The official Grok Bot app does not receive these creates or these turns. |

"Same agent roster" means the same protocol on the private host: `listAgents`, `createAgent`, `sendPrompt`, and `GET /events`. It does not mean the official Grok Bot app lists these agents. A live turn on the private host is invisible to other clients of the shared box.

## Architecture

```text
OpenBot start, Grok path (account already signed in, or the first Grok gateway call)
    -> ensure owned local-docker host
         container openbot-local-vm
         env BOTAI_ISOLATED_RUNTIME=1
         publish 127.0.0.1:1340 only (plus the other loopback ports below)
    -> health GET http://127.0.0.1:1340/health
    -> store gateway session { url: http://127.0.0.1:1340, local token }
    -> createAgent / listAgents / sendPrompt / GET /events / transcript / computer
         on that URL only

Inside the VM
    -> sand host runs the model with the box inference credential
    -> account-wide notification relay stays off
    -> a local EnsureSandBox answer, if the host asks for one, returns 127.0.0.1:1340
    -> that answer is not a proxy to api2.cursor.sh

Host tools, unchanged code
    -> GET /local-exec/requests and POST /local-exec/responses on session.url
    -> Auto-review stays ask | always | never

Quit
    -> docker stop openbot-local-vm when this process owns it
    -> drop nothing by calling EnsureSandBox
```

Rules:

1. One gateway for Grok turns. The URL is `http://127.0.0.1:1340`.
2. The desktop process owns the container. The renderer does not call Docker and does not call the gateway.
3. The sand account login stays the login OpenBot already has. The access token still talks to `api2.cursor.sh` for sign-in, refresh, and the dashboard usage RPCs. Those calls are not a turn and they are not `EnsureSandBox`.
4. The box mints its inference credential the way BotAI's local backend does: `/sand-box/inference-credential` goes to the Cursor account API. The desktop does not call `InferenceService/Stream`. `directInference` stays off.
5. `*.cursorvm.com` is not a legal gateway, event host, computer viewer, or local-exec host for this path.
6. Logs, exports, and diagnostics redact the gateway token, the account tokens, and the inference credential.

## Components

Evidence for the BotAI column is commit `63cc1e03586b07f5216b900f9e9f296ba0fddea7` in `jorge123255/botai`. Evidence for the OpenBot column is `origin/main` at `161f0a673`.

### 1. Local gateway

BotAI `source/shared/box-runtime.ts` sets `DEFAULT_SAND_BOX_RUNTIME` to `local-docker`.

BotAI `source/electron-main/box/local-docker-host-connector.ts` owns the VM:

| Fact | Value |
| --- | --- |
| Container | `botai-local-vm` for BotAI. OpenBot uses `openbot-local-vm`. |
| Owner label | `com.botai.local-vm=1` for BotAI. OpenBot uses `app.openbot.desktop.local-vm=1`. |
| Gateway | `http://127.0.0.1:1340` (`LOCAL_DOCKER_GATEWAY_URL`). |
| Loopback publishes | `127.0.0.1:1337`, `1339`, `1340`, `6080`, `6081`, `8790`. |
| Image | `public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest`. |
| Isolation env | `BOTAI_ISOLATED_RUNTIME=1` on `docker run`. |
| Gateway bind | `SAND_GATEWAY_BIND_HOST=0.0.0.0` inside the container, `SAND_HOST_PORT=1340`. The host publish is still `127.0.0.1`. |
| Ready check | `GET {gatewayUrl}/health` with `Authorization: Bearer {token}`, 2 second timeout. The start fails when the gateway is not ready within 3 minutes. |
| Token file | Beside the settings file, `local-docker-vm.json`, mode `0600`. The token is 32 random bytes, hex. `docker run` receives it from an env file, not from process arguments. |
| Stop | `stopLocalDockerBox` runs `docker stop` on an owned running container. It does not remove the container. It refuses an unowned name. |

OpenBot keeps those runtime facts and changes the owner:

- Container name `openbot-local-vm`.
- Label `app.openbot.desktop.local-vm=1`.
- Token file `<userData>/openbot-local-vm.json`. Env file `<userData>/openbot-local-vm.env`. Both mode `0600`.
- No `SAND_LOCAL_DOCKER_LAN_PUBLISH_HOST`. No `SAND_LOCAL_DOCKER_HOST_PORT_OFFSET`. No `SAND_LOCAL_DOCKER_NAMESPACE`.
- One in-flight start, matching BotAI `ensureInFlight`. A second caller waits for that start.
- The main process is the only starter. Put the owner next to the Grok account service. `GrokBotAccountService` in `src/main/grok-bot-account-service.ts` is that service. The Docker adapter is `Effect.tryPromise` around the `docker` executable. Do not add a Docker library.
- Register the gateway token with `registerSecretValue` before a log can carry it.

The host bundle that BotAI bind-mounts at `/home/box/sand-host` is not in this repository. The later implementation stages that host into the container from a pinned BotAI host at `63cc1e03586b07f5216b900f9e9f296ba0fddea7`, plus the notification change in [section 2](#2-isolation-flag). A missing bundle is a start failure.

OpenBot today does the opposite of this section. `src/backend/grok-bot/grok-bot-gateway.ts` `ensureSandbox` POSTs `/aiserver.v1.GrokBotService/EnsureSandBox` to `https://api2.cursor.sh`. `acceptGatewayUrl` accepts `https` on `cursorvm.com` and `*.cursorvm.com`. Loopback is accepted only when `allowLoopback` is true. `src/main/grok-bot-account-service.ts` `callOptions` passes `allowLoopback: false`. The later implementation replaces that product ensure with the local host. `allowLoopback` stays a test hook for a fake gateway. It is not a path to `api2.cursor.sh`.

### 2. Isolation flag

BotAI `source/shared/app-isolation.ts` defines `BOTAI_ISOLATED_RUNTIME`. The value `1` means the host's agent activity stays inside that app.

BotAI sets the variable on the local-docker container in `local-docker-host-connector.ts`.

BotAI `source/host/extensions/notifications/extension.ts` `startAccountWideNotificationRelay` reads the flag:

- When the flag is unset, the relay builds a Cursor backend client and sends `NotifySandAgentTurnFinished`.
- When the flag is set, and the backend is not a self-hosted origin or `SAND_GATEWAY_TOKEN` is empty, the relay logs that account-wide notifications are disabled and returns without a sender.
- When the flag is set and a self-hosted backend plus a gateway token are both present, BotAI can send self-hosted mobile push.

OpenBot does not set a self-hosted push backend and does not set APNs variables. The isolated branch therefore returns with no sender. The later implementation keeps that outcome. It does not add the self-hosted sender.

The local backend route table in BotAI `source/local-backend/routing.ts` maps `GrokBotService/NotifySandAgentTurnFinished` to a local handler, `broker.notifyTurnFinished`. The handler body was not read for this spec. The required behavior is locked here: that handler does not POST to `api2.cursor.sh`. Combined with the relay above, a finished turn on this host does not become an account-wide push.

`source/local-backend/routing.ts` also maps `GrokBotService/EnsureSandBox` to a local handler. BotAI `docs/local-backend.md` says that local handler returns `BOTAI_GATEWAY_PUBLIC_URL`. For this host that URL is `http://127.0.0.1:1340`. The desktop still does not call the shared method. If the process inside the VM calls `EnsureSandBox`, the answer is the loopback gateway. That method is not proxied upstream.

BotAI `source/host/agents/settings-file.ts` `defaultSandAgentComputerMode` returns `local-vm` when the flag is set, and `cloud` otherwise. This host uses `local-vm`. The box screen is the VM's loopback noVNC (`127.0.0.1:6080` and `127.0.0.1:6081`), not a `cursorvm.com` viewer.

### 3. Notification config

Two BotAI settings stay off for this host.

Host config, from `source/shared/host-settings.ts`:

```text
SAND_DISABLED_NOTIFICATION_CONFIG = { isEnabled: false, allowedApps: [], minIntervalMs: 5000, maxPerWindow: 10, windowMs: 300000 }
```

`source/shared/node/settings/sand-settings-store.ts` `getNotificationConfig` persists `{ isEnabled: false }` and returns that disabled object. `setNotificationConfig` writes the same disabled object. The OpenBot host keeps both functions. A caller cannot turn the config on.

Agent config, from `source/host/agents/settings-file.ts`: the field is `notifyOnAgentUpdates`. BotAI's default constant is `true`. `source/host/extensions/session/session-materialization.ts` writes `notifyOnAgentUpdates: true` when it creates an agent. This design changes that write on the isolated host to `false`.

On load, an agent file that still says `true` is rewritten to `false` before the host will notify. `setAgentNotificationsEnabled` and `setAgentNotifyOnUpdates` (`source/shared/rpc/coordinator.ts`) do not turn the flag on for an agent on this host.

OpenBot's own chat reply is separate. The user still sees the reply in OpenBot. This section is the Grok Bot notification config, the account-wide push, and the badge on the official app.

### 4. Deep links

Desktop BotAI uses `redirectTarget=cli` so the official Grok Bot `sand://` callback stays with Grok Bot. The poll completes the login.

OpenBot already does that:

- `src/backend/agent/cursor-login-poll.ts` sets `SAND_AUTH_REDIRECT_TARGET` to `cli`.
- `src/main/index.ts` `presentApplication` registers `openbot` only.

This design keeps both. The later implementation does not read an environment value that can set `redirectTarget` to `sand`. It does not call `app.setAsDefaultProtocolClient("sand")`. It does not emit a `sand://` URL. It does not call `shell.openExternal`, `open`, or a focus API for the official Grok Bot app as part of sign-in, create, or a turn.

`x-cursor-client-type: sand` stays an HTTP header on the account API. It is not a URL scheme.

### 5. Gateway session and account

Sign-in stays the current Grok Bot account file (`openbot-grok-bot-account-v1.json` under userData): PKCE, `loginDeepControl`, `GET /auth/poll`, `redirectTarget=cli`. The Cursor CLI auth file and the `cursor-access-token` keychain item stay on the Cursor provider path only.

After the local host is healthy, the account record's gateway is:

| Field | Value |
| --- | --- |
| `url` | `http://127.0.0.1:1340` |
| `token` | The local gateway token from `openbot-local-vm.json` |
| `headers` | The headers the local gateway requires. The user sand access token is not the gateway bearer. |

`acceptGatewayUrl` on the product path returns true only for `http://127.0.0.1:1340` with an empty username and an empty password. It returns false for `*.cursorvm.com`, for any other host, and for a URL that embeds a user or a password.

On load, a stored gateway whose host is `cursorvm.com` or ends with `.cursorvm.com` is discarded. OpenBot does not connect to that URL to release a box. There is no release RPC in this design. Dropping the cache is the leftover claim OpenBot can drop. Confirmed store: `GrokBotAccountStore` in `src/backend/grok-bot/grok-bot-account.ts`. Unconfirmed: whether Cursor keeps a sandbox after the client stops calling `EnsureSandBox`. Decision: do not call `EnsureSandBox` to find out or to release it.

A 401 or 417 from the local gateway does not call shared `EnsureSandBox`. Gateway calls use the local gateway bearer, not the user sand access token. The desktop re-reads `openbot-local-vm.json` and retries that same local URL once. A second failure uses the local-host error in [Errors](#errors). Account refresh stays on the account API (sign-in refresh, dashboard usage, and the box inference credential). A refreshed account token does not move the gateway to `*.cursorvm.com`.

Dashboard usage stays on the account token and `api2.cursor.sh` (`GetSandUsageStatus`, `GetCurrentPeriodUsage`, and the other dashboard reads the usage module already calls). Those reads do not allocate a box.

### 6. Turns, roster, and events

`GrokBotAgentClient` in `src/backend/grok-bot/grok-bot-agent-client.ts` stays the turn client.

- One OpenBot thread is one sand agent id from `POST /api/createAgent` on the private gateway.
- A turn is `POST /api/sendPrompt` on that gateway. The sand host inside the VM runs the model.
- The reply is still the text `send-message` card, stored as the assistant message in OpenBot.
- `GET /events` and `POST /api/getAgentTranscriptTail` use the same session URL.
- `directInference` stays unset in the production driver.

`listAgents` for the Grok settings section and for import uses the same private gateway. Import stays a local mirror of that roster. It does not create an agent on a shared box.

### 7. Host tools and the box computer

[#49](https://github.com/jorge123255/openbotv/pull/49) is the host-tool runner. On `origin/main`, `GrokBotAgentClient` calls `runLocalExecClient` with `baseUrl: session.url` (`src/backend/host-tools/local-exec-client.ts`). Paths stay `GET /local-exec/requests` and `POST /local-exec/responses`. Auto-review modes stay `ask`, `always`, and `never`. The default stays `ask`.

This design does not change those files. When `session.url` is `http://127.0.0.1:1340`, the runner and the box computer talk to the private gateway. The host-tool target is still the `machineId` from `ListMachines`. The local VM is not that machine. A host screenshot is still the registered machine's screen. The sand desktop is still the VM screen.

The box computer status, screenshot, and hand-back keep their current gateway paths. A viewer URL is legal only when its host is `127.0.0.1`.

## Data flow

1. The user signs in with the existing Grok Bot account flow. `redirectTarget` is `cli`. The scheme of any link OpenBot opens is `openbot`.
2. The Grok path ensures `openbot-local-vm`. The container has `BOTAI_ISOLATED_RUNTIME=1`.
3. `GET http://127.0.0.1:1340/health` succeeds with the local bearer.
4. The account store saves that URL and token. A previous `*.cursorvm.com` session is already gone.
5. `createAgent` or `sendPrompt` goes to `http://127.0.0.1:1340`.
6. The VM runs the turn. Its notification relay does not call `NotifySandAgentTurnFinished` on `api2.cursor.sh`. The agent flag `notifyOnAgentUpdates` is false.
7. OpenBot reads `GET /events` and the transcript tail from `127.0.0.1:1340` and shows the reply in the OpenBot chat.
8. When the runner is active, local-exec uses the same URL. Auto-review runs in OpenBot before a host tool runs.
9. On quit, dispose stops the owned container. The next launch starts it again. The volumes still hold the local roster.

## Leak surfaces

A Grok turn in OpenBot must stay inside OpenBot. These surfaces are closed:

| Surface | Required behavior |
| --- | --- |
| Official app focus | OpenBot does not open or focus the Grok Bot app. |
| Shared transcript | `createAgent`, `sendPrompt`, events, and the transcript tail use `http://127.0.0.1:1340` only. |
| Badge and notification | No `NotifySandAgentTurnFinished` to `api2.cursor.sh`. Host notification config stays disabled. Agent `notifyOnAgentUpdates` stays false. |
| Shared box | No product call to `api2.cursor.sh/.../EnsureSandBox`. No gateway URL under `*.cursorvm.com`. |
| Deep link | `redirectTarget=cli`. Scheme `openbot` only. |

Still allowed, because they are the sand account and the protocol, not the shared box:

- The same sand login, refresh, and dashboard usage RPCs on `api2.cursor.sh`.
- The box inference credential on the account API.
- `listAgents`, `createAgent`, `sendPrompt`, events, transcript, computer, and local-exec on the private gateway.
- The shipped host-tool runner and Auto-review.
- The reply inside OpenBot.

Must not:

- Call shared `EnsureSandBox`.
- Emit `sand://` or a `redirectTarget` other than `cli`.
- Fire `NotifySandAgentTurnFinished` or any other account-wide push for these turns.
- Leave Grok Bot notification config on for an agent on this host.
- Fall back to `*.cursorvm.com` when the local host fails.
- Attach to `botai-local-vm` or to a container this process does not own.
- Publish `1340`, `6080`, or `6081` on an address other than `127.0.0.1`.

## Lifecycle

### Start

The trigger is the Grok path, not every OpenBot launch.

- When the Grok Bot account is already signed in at startup, ensure the host then.
- When sign-in finishes later, ensure the host before the first `listAgents`, `createAgent`, `sendPrompt`, event stream, or computer call.
- Other providers do not start this container.

Ensure means: Docker answers `docker info`; the named container is missing, or it exists, carries `app.openbot.desktop.local-vm=1`, and uses the pinned image; then start or create it; then wait for `/health`.

An existing container with the name `openbot-local-vm` and a different label is a start failure. OpenBot does not remove it. An existing BotAI container on port `1340` is a start failure. OpenBot does not stop it and does not send the turn anywhere else.

### Quit

`GrokBotAccountService.dispose` is teardown ordinal `26` (`TEARDOWN_ORDER.grokBotAccount` in `src/main/application-services.ts`). That dispose also stops the private host.

Stop runs `docker stop openbot-local-vm` only when the container exists, is running, and has the owner label. An unowned container is left as it is. Stop does not call `EnsureSandBox`. Volumes `openbot-local-vm-workspace` and `openbot-local-vm-data` stay, so the local roster survives the next start.

`--restart unless-stopped` matches BotAI, so a Docker restart while OpenBot is running can bring the VM back. `docker stop` on quit stays stopped until the next Grok-path start.

Sign-out uses the same stop. It clears the cached gateway session. It does not delete the volumes and it does not upload them. One userData directory has one private host. The current account file already holds one sand account. The volumes keep that computer's local roster across sign-out. A later sign-in on this computer starts the same host. OpenBot does not wipe the roster on sign-out, because nothing backs up those transcripts.

A quit that arrives during start aborts the wait and stops the container when this process owns it.

### Rebuild

The bundle id stays `app.openbot.desktop` (`PACKAGED_BUNDLE_IDENTIFIER` in `src/main/application-services.ts`, checked by `scripts/verify-macos-package.ts`). userData stays the current Support directory. New files are `openbot-local-vm.json` and `openbot-local-vm.env` in that directory. An update does not move Support by changing the bundle id.

This spec does not rebuild the app. Hermes [#44](https://github.com/jorge123255/openbotv/pull/44) stays held.

## Errors

Each failure is an OpenBot error from `sourceText`. The turn does not run on a shared box. The runner does not retry in a loop.

| Case | What the user sees | What OpenBot does |
| --- | --- | --- |
| Docker is missing or `docker info` fails | `error.provider.grokBotLocalHostFailed`. English source: `The private Grok host did not start.` | No `EnsureSandBox`. No turn. |
| Port `1340` is in use, or the container name is unowned | Same local-host error. | Do not stop the other container. Do not pick another port. |
| Image pull fails, the container exits, or `/health` misses the 3 minute deadline | Same local-host error. | Stop the owned container when it is running. Keep the volumes. |
| The host was healthy and then dies before the next turn | `error.provider.grokBotLocalHostStopped`. English source: `The private Grok host is stopped.` | The next turn tries one ensure. A failed ensure uses the row above. |
| The host dies during a turn | The existing turn failure, `error.provider.grokBotTurnFailed`. | The event stream ends. No shared-box retry. |
| Local gateway 401 or 417 | One local retry, as in [section 5](#5-gateway-session-and-account). | No `EnsureSandBox`. |
| Account signed out | The existing `error.provider.grokBotNotSignedIn`. | No host start for that call. |

The two new keys go in the English `error/provider` catalog. Other locales follow the i18n rule for a new key. The renderer shows the message the main process already sends for Grok account failures. The IPC payload has no token and no Docker argument list.

## Acceptance tests

Scripted checks are end-to-end scripts under `scripts/`. Each script writes a JSON report under `.openbot-build/`. They follow `scripts/grok-bot-gateway-e2e.ts`: a loopback HTTP peer, and a record of every requested URL. They do not need a live sand login. Fixture tokens stay `grok-access-e2e` and a local gateway token of the same kind. No vitest file.

1. **Reply stays in OpenBot.** A script sends one prompt through `sendGrokBotPrompt` after the session URL is `http://127.0.0.1:1340`. The recorded requests are that host only. The report says `ensureSandBox: 0`, `cursorvm: 0`, `redirectTarget: "cli"`, and `sandScheme: 0`.

2. **Loopback only.** The same report lists the turn URL, the event URL, and `createAgent` as `http://127.0.0.1:1340/...`. No request host is `cursorvm.com` or a subdomain of it. No request path is `GrokBotService/EnsureSandBox` on `api2.cursor.sh`.

3. **No silent fallback.** The Docker double reports the host down. The next turn fails with `error.provider.grokBotLocalHostFailed` or `error.provider.grokBotLocalHostStopped`. The request log still has `ensureSandBox: 0` and `cursorvm: 0`.

4. **Host tools.** A fake `GET /local-exec/requests` and `POST /local-exec/responses` on `127.0.0.1:1340` receives the subscribe from `runLocalExecClient` when `session.url` is that gateway. The request uses the gateway bearer. It does not use the user sand access token. Auto-review is not reimplemented in this script. The script asserts the URL and the bearer only. Shell and screenshot behavior stay the #49 checks.

5. **Deep links.** The existing `scripts/cursor-login-poll-e2e.ts` and `scripts/grok-bot-account-e2e.ts` still report `redirectTarget` `cli`. A search of the new host module finds no `sand://` and no `setAsDefaultProtocolClient("sand")`.

Manual check, on a Mac where the official Grok Bot app is installed and Docker can run the pinned image:

- Send a Grok turn in OpenBot. The reply appears in OpenBot. The Grok Bot app stays closed and unfocused. It shows no new shared turn, no badge, and no notification.
- The turn's gateway connection is `127.0.0.1:1340`.
- Stop the local host. The next turn errors inside OpenBot.
- One host Shell and one screenshot still pass Auto-review on a registered machine.
- Sign-in still uses `redirectTarget=cli` and `openbot://`.

The manual check is the focus and badge proof. The scripts are the network and fallback proof. This design does not call the manual check done.

## Constraints that stay

- Fork only. Do not open a pull request against `nightly-labs/openbot`.
- Released Team API adapters stay unchanged.
- No SQLite migration. Migrations stay irreversible, and this design adds no schema change.
- Redact secrets on every log, export, and send path.
- Keep the renderer-to-main trust boundary. A new status string uses the existing Grok Bot IPC group, with a separate decoder in main and in the preload.
- New user-visible text uses `@openbot/i18n`. Main-process and backend errors use `sourceText`.
- PolyForm Noncommercial 1.0.0 stays. The Docker CLI is a process. Do not add a Docker dependency.
- Effect 4.0.0 for the new host operation: `Effect.fn`, one Effect-returning method, `Schema.TaggedError` for the start failure. No paired Promise method on the service.
- `app.openbot.desktop` stays. Hermes #44 stays held.

## Later implementation map

This pull request does not edit these files. The later implementation does.

| File | Change |
| --- | --- |
| New `src/backend/grok-bot/grok-bot-local-host.ts` | Start, health, stop. Owns the container name, the label, the token file, and the gateway URL. |
| `src/backend/grok-bot/grok-bot-gateway.ts` | Product ensure attaches to the local host. Drop a `*.cursorvm.com` session. Product `acceptGatewayUrl` allows only `http://127.0.0.1:1340`. |
| `src/main/grok-bot-account-service.ts` | Ensure on the Grok path. Stop inside `dispose` and on sign-out. |
| `packages/i18n` English `error/provider` | The two keys in [Errors](#errors). |
| `docs/architecture/providers.md` | The Grok Bot section names the private gateway instead of shared `EnsureSandBox`. |
| `scripts/grok-bot-isolated-host-e2e.ts` | The scripted acceptance checks. |
| Existing `scripts/grok-bot-*-e2e.ts` | The product path no longer calls shared `EnsureSandBox`. A fake peer may still listen on loopback. `allowLoopback` stays that test hook. It does not call `api2.cursor.sh`. |
| Staged sand host | `notifyOnAgentUpdates: false` when `BOTAI_ISOLATED_RUNTIME=1`. Local `EnsureSandBox` returns `http://127.0.0.1:1340`. `NotifySandAgentTurnFinished` does not leave the computer. |

`src/backend/host-tools/` is not in this table.

## Evidence

Each row was checked, or it says where the check stopped. The decision is locked either way. There is no open question for the implementer to choose.

| Item | Where we looked | Decision |
| --- | --- | --- |
| Local-docker default, gateway URL, ports, image, isolation env, health, token, stop | BotAI `local-docker-host-connector.ts` and `box-runtime.ts` at `63cc1e0`. | Use the values in [section 1](#1-local-gateway), with OpenBot's container name and label. |
| Skip of `NotifySandAgentTurnFinished` | BotAI `app-isolation.ts` and `notifications/extension.ts` at `63cc1e0`. | Set the flag. Do not add self-hosted push. |
| Local route for that RPC and for `EnsureSandBox` | BotAI `source/local-backend/routing.ts` and `docs/local-backend.md` at `63cc1e0`. | Both stay local. `EnsureSandBox` returns `http://127.0.0.1:1340`. |
| `notifyTurnFinished` handler body | The name is in `routing.ts`. The function body in `handlers.ts` was not read. | The handler does not POST to `api2.cursor.sh`. |
| Host notification config | BotAI `host-settings.ts` and `sand-settings-store.ts` at `63cc1e0`. | Keep `isEnabled: false`. |
| Agent notify default | BotAI `settings-file.ts` (`DEFAULT_NOTIFY_ON_AGENT_UPDATES = true`) and `session-materialization.ts` at `63cc1e0`. | The isolated host writes `false` and rewrites `true` to `false` on load. |
| OpenBot shared ensure | `grok-bot-gateway.ts` `postEnsure` and `acceptGatewayUrl` on `origin/main` `161f0a673`. | Remove that product call. |
| Host-tool subscribe URL | `grok-bot-agent-client.ts` `runLocalExecClient({ baseUrl: session.url })` on `origin/main` `161f0a673`. #49 is merged. | Do not edit the runner. |
| Deep link | `cursor-login-poll.ts` and `src/main/index.ts` on this fork. | Keep `cli` and `openbot`. |
| A Cursor release RPC for an old shared box | Not found under `src/backend/grok-bot/`. | Drop the cached URL. Do not call `EnsureSandBox`. |
| Sand-host bundle inside this repo | No `sand-host` tree in this fork on 2026-10-31. | Stage the pinned BotAI host. A missing bundle fails the start. |
