# Migration executor capability and eligibility design

Status: source audit and required future report design. No VM provisioner, capability scanner or
eligibility evaluator is implemented here. No host was probed, VM created, credential read or
privilege changed. Local hosting remains an option; a destination does not automatically need to
create a VM for every agent. If that boundary is requested, it must be provided and verified before
execution is enabled. An unavailable requirement blocks cutover rather than changing the choice.
Unraid is an available candidate, but the destination host has not been selected. Do not probe,
configure or select it implicitly, or assume its container/VM capabilities have been verified.

## Current isolation

| Runtime | Confirmed boundary | Limit |
| --- | --- | --- |
| Native desktop or Linux server | Provider process and configured agent access | No VM-per-agent provisioner. A workspace folder is not an OS or credential boundary. |
| Workspace access | Provider-specific write controls | Reads and network remain open. Shared/temp and approved extra roots can be writable. This is not VM isolation. |
| Local child server | Separate process, database and workspace | Default CLI sign-ins and global skills remain shared; children stop with the desktop. |
| Docker server | One container for a complete OpenBot instance and its agents, as UID 1000 | Not one VM or container per agent. Agents inside that instance share its container boundary and data. |
| Existing Grok remote box | Provider gateway/session routes | Current code calls EnsureSandBox; it does not establish a verified VM allocation for each agent. |
| Proposed local Grok host, PR #52 | Documentation-only private gateway/container per userData | Transcript/notification separation is not a hypervisor boundary. It is not implemented VM-per-agent isolation. |

Containers share a kernel; a VM has its own operating-system kernel. A container runtime running
inside a VM does not make a separate VM for each agent. See
[Docker's container/VM explanation](https://docs.docker.com/get-started/docker-concepts/the-basics/what-is-a-container/#containers-versus-virtual-machines-vms).
Separate windows, workers, threads, processes or provider sessions do not by themselves establish
a container or VM boundary.

Code evidence:

- `packages/contracts/src/ipc-agents.ts:33–39`: access is `full` or `workspace`, default `full`.
- `src/backend/agent/workspace-sandbox.ts:8–20`: workspace mode limits writes; reads/network stay open.
- `src/backend/process-confinement.ts:323–364`: confined-process providers fail closed without the
  supported macOS mechanism. A Linux VM/container does not make that provider mode supported.
- `src/backend/agent/provider-runtime.ts:2339–2360`: providers can share a process; confinement or
  a separate provider account can require a separate process. A process is not a VM.
- `docker/compose.yaml`, `docs/docker.md`, and `docs/architecture/servers.md:818–860`: container and
  local-child scope, storage, lifetime and shared CLI dependencies.

Grok host tools need separate attention. `src/backend/host-tools/grok-host-tool-handler.ts:30–41`
uses the OpenBot host's home directory and userData policy. `host-tool-executor.ts:42–56,105–135`
starts ordinary host shell processes with inherited environment. This does not mean root-user
execution; it means execution as the app's OS user on the controller host. A guest VM would not
contain this route unless the bridge is disabled or explicitly routed into that guest.

## Required report, per agent and per shared instance

The report must distinguish an operator declaration from observed evidence. Unknown/unverified
values are explicit; a product name, hostname or design document is not evidence of isolation.
Keep secret values out of every report.

| Field group | Required values |
| --- | --- |
| Placement and identity | Source/destination local or self-hosted placement; host/agent/account references; exact pinned fork build/schema, OS and architecture |
| Required boundary | User choice: native process, provider write sandbox, shared instance container, dedicated agent container, or dedicated agent VM; required scope and accepted trust |
| Actual executor | Implemented boundary type/scope; executor/guest identity; evidence source/date/status; lifecycle owner; whether any fallback exists |
| Provider compatibility | Provider and account reference, primary/backup models, runtime version and enforcement support on the destination |
| Access and paths | Saved access mode; workspace/Shared/temp/additional/excluded roots; explicit mappings, permissions and network policy |
| Every tool route | Where shell, file edits, MCP, browser, screenshot/input, Computer Use and automation execute; credentials/resources each can reach; whether controller-host fallback is possible |
| Shared dependencies | Shared database/files and ownership IDs; channels/flows/routines; global skills; provider homes and cross-agent references |
| Credentials | Category, owner/scope and status: supported approved adapter, reauthentication required, unavailable or unknown; destination secret-store compatibility |
| Guest capability | Operator-managed VM/container identity, supported guest runtime, private disk and secret scope, CPU/memory/disk/PID limits, display/device needs, supervision and tested backup/restore |
| Migration evidence | Complete inventory/snapshot, credential/path results, offline rehearsal, source/destination fences, accepted-work capture and rollback verification |

Eligibility is `supported`, `blocked` or `unverified`, with fixed reason codes and evidence references.
`supported` refers only to the chosen, tested executor requirements; it does not mark the whole
migration complete or authorize execution by itself.

## Admission rules

- A requested agent VM with only native processes, a shared container, PR #52, or an unverified
  remote box is blocked: `ISOLATION_BOUNDARY_UNAVAILABLE`. Never label a container a VM or silently
  reduce an agent-scoped boundary to an instance-scoped boundary.
- Unsupported provider/access enforcement is blocked: `PROVIDER_ENFORCEMENT_UNSUPPORTED`. Never
  convert `workspace` to `full` automatically. Even a stronger outer VM boundary does not prove
  that the saved inner write policy is preserved.
- A tool route that can execute on the controller host, or fall back there, is blocked when a guest
  boundary is required: `HOST_TOOL_ROUTE_OUTSIDE_EXECUTOR`. Review shell, MCP and Computer Use
  separately from provider inference/session placement.
- Missing or unverified roots, credentials, runtimes, displays, resources or shared ownership are
  blockers. Keep IDs and references; do not clone/recreate agents to hide a compatibility loss.
- Broad saved approvals must not become automatic grants to another machine. Review the exact
  destination and new tool routes before any enable action.
- Inventory, secret, rehearsal, fencing and rollback gaps remain blockers even when the executor
  itself is eligible. The current startup interlock admits no full rehearsal or cutover.

For local hosting, the same checks apply to the existing local execution model; no new VM is
required unless the user chooses that requirement. Local execution still needs its host awake.
For a chosen server, supported OS/runtime and actual enforcement determine eligibility, not the
server's location or ownership alone. Nested virtualization, quotas and guest images cannot be
assumed available on an arbitrary VPS.

## VM-per-agent provisioner is separate work

A future provisioner needs a security design for fixed approved guest images, allocation/ownership,
resource limits, networking, per-agent storage/secrets, authenticated command routing, guest
health, backup/restore, deletion/recovery and durable fencing. Provider state and host tools must
remain inside the selected boundary. The controller/guest trust boundary and consent are explicit.

Do not expose a Docker or hypervisor socket, management credentials, host home, privileged container
or extra host devices to agents or the renderer to achieve this. This design does not authorize any
such access, including a libvirt socket. Privileged provisioning, if later approved, belongs to a
separate controlled service.

Do not copy the whole OpenBot instance into every guest: that duplicates the host identity, shared
database, credentials and routines. A controller with separate guest executors needs a defined
one-writer source of truth and stable agent-to-executor mapping. It is a different design from
running one complete OpenBot instance inside an operator-managed VM.

## Reference patterns, not destination evidence

A supplied read-only BotAI assessment reports local Docker and remote k3s connectors, persistent
storage, staged transfer/rollback and a per-agent runtime choice. It reports shared container/desktop
execution, not a VM for each agent. This checkout does not contain that assessment's source code,
so these third-party findings are reference-only and were not independently verified here.

The useful design separation is a controller that owns identity, orchestration and migration state,
with explicit executor selection and separately owned persistent storage. Staged transfer must
verify a destination before one-writer cutover and retain a rollback source. A runtime selector or
k3s connection label does not establish the isolation underneath it. Verify the actual executor
boundary, tool routes and credential/storage access; do not derive eligibility from UI labels.
