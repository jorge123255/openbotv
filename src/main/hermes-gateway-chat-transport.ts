import { randomUUID } from "node:crypto";
import { redactText, registerSecretValue } from "@openbot/logging";
import { Effect, type Schema, Semaphore } from "effect";
import WebSocket from "ws";
import {
  ChatCapabilities,
  ChatComplete,
  ChatDelta,
  ChatDescription,
  ChatEnvelope,
  ChatFrame,
  ChatHandle,
  ChatPrompt,
  ChatPromptEvent,
  ChatPromptResult,
  ChatReady,
  ChatReceipt,
  ChatSessionUpdate,
  ChatSettled,
  ChatSnapshot,
  decodeChat,
  HermesChatFailure,
} from "./hermes-gateway-chat-protocol";
import type { HermesGatewayFailure } from "./hermes-gateway-protocol";

type Prompt = typeof ChatPrompt.Type;
type Snapshot = typeof ChatSnapshot.Type;
type SessionState = { -readonly [K in keyof Snapshot]: Snapshot[K] };
type Receipt = typeof ChatReceipt.Type;
type Envelope = typeof ChatEnvelope.Type;
interface UncertainOperation {
  id: string;
  method: string;
}
interface SessionOptions {
  omit_messages?: boolean;
  text?: string;
  submission_id?: string;
  queued?: boolean;
  clarify_batch?: boolean;
  execution_generation?: number;
  prompt_id?: string;
  choice?: string;
  answer?: string;
}
interface RpcParams extends SessionOptions {
  profile?: string;
  session_id?: string | null;
  server_requests?: boolean;
  desktop_local?: boolean;
}
interface PendingCall {
  fail: () => void;
  receive: (value: unknown, error: boolean) => void;
}
type ChatEvent =
  | { type: "delta"; text: string | null; turnId?: string; segment?: number; offset?: number }
  | { type: "complete"; text: string; status?: string }
  | { type: "prompt"; prompt: Prompt }
  | { type: "prompt-settled"; promptId: string };
interface ChatDependencies {
  base: URL;
  profile: string;
  owner: AbortSignal;
  expiresAt: number | null;
  mintTicket: Effect.Effect<string, HermesGatewayFailure>;
  onClose: (transport: HermesGatewayChatTransport) => void;
}

/** Internal canonical transport. One account, profile and explicit session. No IPC, storage or retries. */
export class HermesGatewayChatTransport {
  readonly #deps: ChatDependencies;
  readonly #lifetime = new AbortController();
  readonly #control = Semaphore.makeUnsafe(1);
  readonly #pending = new Map<string, PendingCall>();
  readonly #spentPrompts = new Set<string>();
  readonly #completedAdmissions = new Set<string>();
  readonly #events: ChatEvent[] = [];
  #eventBytes = 0;
  #socket: WebSocket | null = null;
  #attempt: AbortController | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #expiry: ReturnType<typeof setTimeout> | null = null;
  #lastInbound = 0;
  #heartbeatId: string | null = null;
  #ready: (() => void) | null = null;
  #readyReject: (() => void) | null = null;
  #phase: "disconnected" | "connecting" | "ready" | "attached" | "closed" = "disconnected";
  #profileId: string | null = null;
  #sessionId: string | null = null;
  #snapshot: SessionState | null = null;
  #attaching = false;
  #staged: Envelope[] = [];
  #mutation: UncertainOperation | null = null;
  #uncertain: UncertainOperation | null = null;
  #reader: { receive: (event: ChatEvent) => void; fail: () => void } | null = null;
  readonly #ownerClosed = () => this.close();

  constructor(deps: ChatDependencies) {
    this.#deps = deps;
    deps.owner.addEventListener("abort", this.#ownerClosed, { once: true });
    if (deps.expiresAt !== null) {
      const expire = () => {
        const remaining = (deps.expiresAt ?? 0) - Date.now();
        if (remaining <= 0) this.close();
        else this.#expiry = setTimeout(expire, Math.min(remaining, 2_147_483_647));
      };
      expire();
    }
    if (deps.owner.aborted) this.close();
  }

  state() {
    return {
      phase: this.#phase,
      profile: this.#deps.profile,
      sessionId: this.#sessionId,
      running: this.#snapshot?.running ?? false,
      generation: this.#snapshot?.execution_generation ?? null,
      uncertain: this.#uncertain ? { ...this.#uncertain } : null,
      prompts: this.#snapshot?.prompts.map((prompt) => this.#safePrompt(prompt)) ?? [],
    };
  }

  /** Explicit fresh-ticket dial. It never attaches a session or resends a prior request. */
  readonly connect = Effect.fn("HermesChat.connect")(function* (this: HermesGatewayChatTransport) {
    if (this.#phase === "closed") return yield* new HermesChatFailure({ code: "closed" });
    if (this.#phase !== "disconnected") return yield* new HermesChatFailure({ code: "busy" });
    const attempt = new AbortController();
    this.#attempt = attempt;
    this.#phase = "connecting";
    return yield* Effect.gen({ self: this }, function* () {
      const cancelled = Effect.callback<never, HermesChatFailure>((resume) => {
        const abort = () => resume(Effect.fail(new HermesChatFailure({ code: "closed" })));
        attempt.signal.addEventListener("abort", abort, { once: true });
        if (attempt.signal.aborted) abort();
        return Effect.sync(() => attempt.signal.removeEventListener("abort", abort));
      });
      const ticket = yield* Effect.raceFirst(this.#deps.mintTicket, cancelled);
      if (attempt.signal.aborted || this.#attempt !== attempt) return yield* new HermesChatFailure({ code: "closed" });
      registerSecretValue(ticket);
      yield* this.#io((signal) => this.#dial(ticket, signal));
      yield* this.#io(async (signal) => {
        // runtime.describe is a closed, unscoped RPC in the pinned source. Session RPCs always
        // carry the selected profile; their snapshots establish that profile's canonical identity.
        const description = await this.#rpc("runtime.describe", {}, ChatDescription, signal);
        this.#requireAttempt(attempt, signal);
        if (
          !description.capabilities.includes("durable-admission-v1") ||
          !description.capabilities.includes("event-replay-v1")
        )
          throw new HermesChatFailure({ code: "unsupported-protocol" });
        await this.#rpc(
          "client.capabilities",
          { server_requests: false, desktop_local: false },
          ChatCapabilities,
          signal,
        );
        this.#requireAttempt(attempt, signal);
        this.#phase = "ready";
      });
    }).pipe(
      Effect.onError(() =>
        Effect.sync(() => {
          if (this.#attempt === attempt) this.#drop();
        }),
      ),
    );
  }).bind(this);

  /** Snapshot only: no history import, aliases, session creation, replay or profile fallback. */
  readonly attach = Effect.fn("HermesChat.attach")(function (this: HermesGatewayChatTransport, sessionId: string) {
    return this.#io(async (signal) => {
      this.#requireReady();
      if (this.#mutation) throw new HermesChatFailure({ code: "busy" });
      if (!validId(sessionId)) throw new HermesChatFailure({ code: "invalid-input" });
      if (this.#sessionId !== null && this.#sessionId !== sessionId)
        throw new HermesChatFailure({ code: "session-mismatch" });
      this.#sessionId = sessionId;
      const attempt = this.#attempt;
      this.#attaching = true;
      this.#staged = [];
      this.#events.length = 0;
      this.#eventBytes = 0;
      this.#reader?.fail();
      try {
        const snapshot = await this.#rpc("session.resume", this.#params({ omit_messages: true }), ChatSnapshot, signal);
        this.#requireAttempt(attempt, signal);
        this.#checkSnapshot(snapshot);
        this.#snapshot = snapshot;
        this.#profileId = snapshot.info.profile_id;
        this.#phase = "attached";
        this.#attaching = false;
        for (const event of this.#staged) this.#sessionEvent(event);
        this.#staged = [];
        return this.state();
      } catch (error) {
        if (this.#attempt === attempt) this.#drop();
        throw error;
      } finally {
        this.#attaching = false;
      }
    }).pipe(this.#control.withPermits(1));
  }).bind(this);

  readonly submit = Effect.fn("HermesChat.submit")(function (this: HermesGatewayChatTransport, text: string) {
    return this.#io(async (signal) => {
      const snapshot = this.#requireSession(true);
      if (!text.trim() || text.length > 16_384 || Buffer.byteLength(text) > 32_768)
        throw new HermesChatFailure({ code: "invalid-input" });
      if (snapshot.running || snapshot.pending.some((row) => row.status !== "terminal"))
        throw new HermesChatFailure({ code: "busy" });
      const submissionId = randomUUID();
      const sequence = snapshot.last_sequence;
      const receipt = await this.#rpc(
        "prompt.submit",
        this.#params({ text, submission_id: submissionId, queued: false, clarify_batch: false }),
        ChatReceipt,
        signal,
        { id: submissionId, method: "prompt.submit" },
        (value) => this.#checkReceipt(value),
      );
      if (this.#snapshot === snapshot) {
        if (snapshot.last_sequence === sequence) snapshot.running = receipt.status === "started";
        if (receipt.status !== "terminal" && !this.#completedAdmissions.has(receipt.admission_id))
          snapshot.pending = [
            ...snapshot.pending.filter((row) => row.admission_id !== receipt.admission_id),
            { ...receipt, input_id: submissionId },
          ];
        // A completion can arrive before the receipt. Never rewind a newer event generation.
        if (receipt.execution_generation !== null && receipt.execution_generation > snapshot.execution_generation)
          snapshot.execution_generation = receipt.execution_generation;
      }
      return receipt;
    });
  }).bind(this);

  readonly respondApproval = Effect.fn("HermesChat.respondApproval")(function (
    this: HermesGatewayChatTransport,
    promptId: string,
    choice: string,
  ) {
    return this.#respond("approval", promptId, choice);
  }).bind(this);

  readonly respondClarification = Effect.fn("HermesChat.respondClarification")(function (
    this: HermesGatewayChatTransport,
    promptId: string,
    answer: string,
  ) {
    return this.#respond("clarify", promptId, answer);
  }).bind(this);

  readonly interrupt = Effect.fn("HermesChat.interrupt")(function (this: HermesGatewayChatTransport) {
    return this.#io(async (signal) => {
      const snapshot = this.#requireSession(false);
      const handle = await this.#rpc(
        "session.interrupt",
        this.#params({ execution_generation: snapshot.execution_generation }),
        ChatHandle,
        signal,
        { id: randomUUID(), method: "session.interrupt" },
        (value) => {
          this.#checkRef(value.ref);
          if (
            value.authority_epoch !== snapshot.authority_epoch ||
            value.execution_generation !== snapshot.execution_generation
          )
            throw new HermesChatFailure({ code: "invalid-response" });
        },
      );
      return { state: handle.execution_state };
    });
  }).bind(this);

  /** A caller must show the uncertain operation and obtain an explicit decision before this call. */
  acknowledgeUncertain(operationId: string): void {
    const snapshot = this.#requireSession(false);
    if (
      this.#uncertain?.id !== operationId ||
      snapshot.running ||
      snapshot.pending.some((row) => row.status !== "terminal")
    )
      throw new HermesChatFailure({ code: "uncertain" });
    this.#uncertain = null;
  }

  /** One bounded consumer. Cancelling a read cancels only that wait, never the remote turn. */
  readonly readEvent = Effect.fn("HermesChat.readEvent")(function (this: HermesGatewayChatTransport) {
    return this.#io(
      (signal) =>
        new Promise<ChatEvent>((resolve, reject) => {
          if (this.#reader) return reject(new HermesChatFailure({ code: "busy" }));
          const event = this.#events.shift();
          if (event) {
            this.#eventBytes -= Buffer.byteLength(JSON.stringify(event));
            return resolve(event);
          }
          if (this.#phase !== "attached") return reject(new HermesChatFailure({ code: "not-connected" }));
          const cleanup = () => {
            signal.removeEventListener("abort", cancel);
            this.#reader = null;
          };
          const cancel = () => {
            cleanup();
            reject(new HermesChatFailure({ code: "closed" }));
          };
          this.#reader = {
            receive: (value) => {
              cleanup();
              resolve(value);
            },
            fail: () => {
              cleanup();
              reject(new HermesChatFailure({ code: "not-connected" }));
            },
          };
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
        }),
    );
  }).bind(this);

  /** Local detach. A remote turn may continue; this is not an interrupt or remote sign-out. */
  disconnect(): void {
    this.#drop();
  }

  close(): void {
    if (this.#phase === "closed") return;
    this.#lifetime.abort();
    this.#drop();
    this.#phase = "closed";
    if (this.#expiry) clearTimeout(this.#expiry);
    this.#deps.owner.removeEventListener("abort", this.#ownerClosed);
    this.#deps.onClose(this);
  }

  #respond(kind: "approval" | "clarify", promptId: string, answer: string) {
    return this.#io(async (signal) => {
      const snapshot = this.#requireSession(true);
      const prompt = snapshot.prompts.find((item) => item.prompt_id === promptId && item.kind === kind);
      if (!prompt || prompt.execution_generation !== snapshot.execution_generation || this.#spentPrompts.has(promptId))
        throw new HermesChatFailure({ code: "stale-prompt" });
      // Scalar clarify only. Batch/multi-select and edit approvals need separate UI/contracts.
      if (
        prompt.multi_select ||
        (kind === "approval" && (!prompt.choices.includes(answer) || !["once", "deny"].includes(answer))) ||
        answer.length > 16_384
      )
        throw new HermesChatFailure({ code: "invalid-input" });
      if (this.#spentPrompts.size >= 256) throw new HermesChatFailure({ code: "limit" });
      this.#spentPrompts.add(promptId);
      const method = kind === "approval" ? "approval.respond" : "clarify.respond";
      const result = await this.#rpc(
        method,
        this.#params({
          execution_generation: prompt.execution_generation,
          prompt_id: promptId,
          ...(kind === "approval" ? { choice: answer } : { answer }),
        }),
        ChatPromptResult,
        signal,
        { id: promptId, method },
        (value) => {
          if (value.prompt_id !== promptId) throw new HermesChatFailure({ code: "invalid-response" });
        },
      );
      if (this.#snapshot === snapshot)
        snapshot.prompts = snapshot.prompts.filter((item) => item.prompt_id !== promptId);
      return result;
    });
  }

  #io<A>(work: (signal: AbortSignal) => Promise<A>) {
    return Effect.tryPromise({
      try: (signal) => {
        if (this.#lifetime.signal.aborted) throw new HermesChatFailure({ code: "closed" });
        return work(AbortSignal.any([signal, this.#lifetime.signal, ...(this.#attempt ? [this.#attempt.signal] : [])]));
      },
      catch: (error) => (error instanceof HermesChatFailure ? error : new HermesChatFailure({ code: "transport" })),
    });
  }

  #requireReady(): void {
    if (this.#phase !== "ready" && this.#phase !== "attached") throw new HermesChatFailure({ code: "not-connected" });
  }

  #requireAttempt(attempt: AbortController | null, signal: AbortSignal): void {
    if (!attempt || this.#attempt !== attempt || signal.aborted || this.#socket?.readyState !== WebSocket.OPEN)
      throw new HermesChatFailure({ code: "not-connected" });
  }

  #requireSession(write: boolean): SessionState {
    if (this.#phase !== "attached" || this.#attaching || !this.#snapshot)
      throw new HermesChatFailure({ code: "not-connected" });
    if (write && this.#uncertain) throw new HermesChatFailure({ code: "uncertain" });
    if (this.#mutation) throw new HermesChatFailure({ code: "busy" });
    return this.#snapshot;
  }

  #params(extra: SessionOptions = {}) {
    return { profile: this.#deps.profile, session_id: this.#sessionId, ...extra };
  }

  #checkRef(ref: { profile_id: string; session_id: string }): void {
    if (ref.profile_id !== this.#profileId) throw new HermesChatFailure({ code: "profile-mismatch" });
    if (ref.session_id !== this.#sessionId) throw new HermesChatFailure({ code: "session-mismatch" });
  }

  #checkSnapshot(snapshot: Snapshot): void {
    if (snapshot.session_id !== this.#sessionId) throw new HermesChatFailure({ code: "session-mismatch" });
    if (
      snapshot.info.profile_name !== this.#deps.profile ||
      (this.#profileId !== null && snapshot.info.profile_id !== this.#profileId)
    )
      throw new HermesChatFailure({ code: "profile-mismatch" });
    for (const row of snapshot.pending) {
      if (
        row.ref.profile_id !== snapshot.info.profile_id ||
        row.ref.session_id !== snapshot.session_id ||
        row.authority_epoch !== snapshot.authority_epoch
      )
        throw new HermesChatFailure({ code: "invalid-response" });
    }
    if (snapshot.prompts.some((prompt) => prompt.execution_generation !== snapshot.execution_generation))
      throw new HermesChatFailure({ code: "invalid-response" });
  }

  #checkReceipt(receipt: Receipt): void {
    this.#checkRef(receipt.ref);
    if (receipt.authority_epoch !== this.#snapshot?.authority_epoch)
      throw new HermesChatFailure({ code: "invalid-response" });
  }

  #rpc<A>(
    method: string,
    params: RpcParams,
    schema: Schema.Decoder<A>,
    signal: AbortSignal,
    mutation?: UncertainOperation,
    validate?: (value: A) => void,
  ): Promise<A> {
    return new Promise((resolve, reject) => {
      const socket = this.#socket;
      if (!socket || socket.readyState !== WebSocket.OPEN || signal.aborted)
        return reject(new HermesChatFailure({ code: "not-connected" }));
      if (this.#pending.size >= 4 || (mutation && this.#mutation))
        return reject(new HermesChatFailure({ code: "busy" }));
      const id = randomUUID();
      let sent = false;
      let settled = false;
      const cleanup = () => {
        clearTimeout(deadline);
        signal.removeEventListener("abort", aborted);
        this.#pending.delete(id);
      };
      const fail = (code: HermesChatFailure["code"]) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (mutation && sent) this.#uncertain = { ...mutation };
        if (mutation) this.#mutation = null;
        reject(new HermesChatFailure({ code: mutation && sent ? "uncertain" : code }));
      };
      const aborted = () => {
        fail("closed");
        this.#drop();
      };
      const deadline = setTimeout(() => {
        fail("timeout");
        this.#drop();
      }, 8_000);
      this.#pending.set(id, {
        fail: () => fail("transport"),
        receive: (value, error) => {
          if (settled) return;
          try {
            if (error) throw new HermesChatFailure({ code: "rpc-rejected" });
            const decoded = decodeChat(schema, value);
            validate?.(decoded);
            settled = true;
            cleanup();
            if (mutation) this.#mutation = null;
            resolve(decoded);
          } catch (error) {
            fail(error instanceof HermesChatFailure ? error.code : "invalid-response");
            this.#drop();
          }
        },
      });
      signal.addEventListener("abort", aborted, { once: true });
      if (mutation) this.#mutation = mutation;
      // From the first send attempt onwards, delivery may have happened. Never infer safe replay
      // from the send callback, an error frame, a timeout, or a lost socket.
      sent = true;
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), (error) => {
          if (error && !settled) {
            fail("transport");
            this.#drop();
          }
        });
      } catch {
        fail("transport");
        this.#drop();
      }
    });
  }

  #dial(ticket: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.#phase === "closed" || signal.aborted) return reject(new HermesChatFailure({ code: "closed" }));
      const base = this.#deps.base;
      const url = new URL(`${base.origin}${base.pathname.replace(/\/$/u, "")}/api/ws`);
      url.protocol = base.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url, ["hermes-gateway-v1", `hermes-gateway-ticket.${ticket}`], {
        origin: base.origin,
        rejectUnauthorized: true,
        followRedirects: false,
        handshakeTimeout: 8_000,
        maxPayload: 262_144,
        perMessageDeflate: false,
      });
      this.#socket = socket;
      const cleanup = () => {
        clearTimeout(deadline);
        signal.removeEventListener("abort", aborted);
        this.#ready = null;
        this.#readyReject = null;
      };
      const fail = () => {
        cleanup();
        reject(new HermesChatFailure({ code: "unsupported-protocol" }));
        this.#drop();
      };
      const aborted = () => fail();
      const deadline = setTimeout(fail, 8_000);
      this.#readyReject = () => {
        cleanup();
        reject(new HermesChatFailure({ code: "transport" }));
      };
      this.#ready = () => {
        cleanup();
        this.#lastInbound = Date.now();
        this.#heartbeat = setInterval(() => {
          if (this.#socket !== socket) return;
          if (Date.now() - this.#lastInbound > 45_000) return this.#drop();
          this.#heartbeatId = randomUUID();
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: this.#heartbeatId, method: "gateway.ping" }), (error) => {
            if (error && this.#socket === socket) this.#drop();
          });
        }, 15_000);
        resolve();
      };
      signal.addEventListener("abort", aborted, { once: true });
      socket.on("open", () => {
        if (socket.protocol !== "hermes-gateway-v1") fail();
      });
      socket.on("message", (data, binary) => {
        if (this.#socket !== socket) return;
        try {
          if (binary || socket.protocol !== "hermes-gateway-v1")
            throw new HermesChatFailure({ code: "invalid-response" });
          // Hermes coalesces newline-delimited JSON frames into one WebSocket message.
          const lines = data
            .toString()
            .split("\n")
            .filter((line) => line.trim());
          if (lines.length > 128) throw new HermesChatFailure({ code: "limit" });
          for (const line of lines) {
            this.#frame(decodeChat(ChatFrame, JSON.parse(line)));
            if (this.#socket !== socket) break;
          }
          this.#lastInbound = Date.now();
        } catch {
          this.#drop();
        }
      });
      socket.on("error", () => {
        if (this.#socket === socket) this.#drop();
      });
      socket.on("close", () => {
        if (this.#socket === socket) this.#drop();
      });
      socket.on("unexpected-response", (_request, response) => {
        response.destroy();
        if (this.#socket === socket) this.#drop();
      });
      if (signal.aborted) fail();
    });
  }

  #frame(frame: typeof ChatFrame.Type): void {
    if ((this.#socket?.bufferedAmount ?? 0) > 1_048_576) throw new HermesChatFailure({ code: "limit" });
    if (frame.method === "event" && frame.id === undefined) {
      const event = decodeChat(ChatEnvelope, frame.params);
      if (event.type === "gateway.ready") {
        if (!this.#ready) throw new HermesChatFailure({ code: "invalid-response" });
        decodeChat(ChatReady, event.payload);
        this.#ready();
      } else if (event.session_id) {
        if (this.#attaching) {
          if (this.#staged.length >= 64) throw new HermesChatFailure({ code: "limit" });
          this.#staged.push(event);
        } else if (this.#phase === "attached") this.#sessionEvent(event);
      }
      return;
    }
    if (frame.method !== undefined) {
      // We advertised no server-request support. Decline unimplemented setup/sudo/batch handlers;
      // never interpret a server request as permission to execute a host action.
      if (frame.id !== undefined && frame.id !== null)
        this.#socket?.send(
          JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Method not supported" } }),
        );
      return;
    }
    if (typeof frame.id !== "string") throw new HermesChatFailure({ code: "invalid-response" });
    if (frame.id === this.#heartbeatId) {
      this.#heartbeatId = null;
      return;
    }
    this.#pending.get(frame.id)?.receive(frame.result, frame.error !== undefined);
  }

  #sessionEvent(event: Envelope): void {
    const snapshot = this.#snapshot;
    if (!snapshot || event.session_id !== this.#sessionId) return;
    if (event.profile !== undefined && event.profile !== this.#deps.profile && event.profile !== this.#profileId)
      throw new HermesChatFailure({ code: "profile-mismatch" });
    if (event.type === "session.replay_gap") throw new HermesChatFailure({ code: "invalid-response" });
    if (
      event.replay_epoch !== snapshot.replay_epoch ||
      event.seq === undefined ||
      event.seq > snapshot.last_sequence + 1 ||
      (event.authority_epoch !== undefined && event.authority_epoch !== snapshot.authority_epoch)
    )
      throw new HermesChatFailure({ code: "invalid-response" });
    if (event.seq <= snapshot.last_sequence) return;
    snapshot.last_sequence = event.seq;
    // The owner can publish this update after clearing its active execution stamp. Its payload
    // still fences controls and pending admissions; a queued cancellation has no generation.
    const update = event.type === "session.info" ? decodeChat(ChatSessionUpdate, event.payload) : null;
    if (update) {
      if (update.authority_epoch !== snapshot.authority_epoch)
        throw new HermesChatFailure({ code: "invalid-response" });
      for (const row of update.pending) {
        this.#checkRef(row.ref);
        if (row.authority_epoch !== snapshot.authority_epoch) throw new HermesChatFailure({ code: "invalid-response" });
      }
    }
    const generation = update?.execution_generation ?? event.execution_generation;
    if (generation !== undefined) {
      if (generation < snapshot.execution_generation) return;
      if (generation > snapshot.execution_generation) snapshot.prompts = [];
      snapshot.execution_generation = generation;
    }
    if (update) {
      snapshot.running = update.running;
      snapshot.pending = update.pending;
      return;
    }
    if (
      ["message.start", "message.delta", "approval.request", "clarify.request"].includes(event.type) &&
      generation === undefined
    )
      throw new HermesChatFailure({ code: "invalid-response" });
    if (event.type === "message.start") snapshot.running = true;
    if (event.type === "message.delta") {
      const delta = decodeChat(ChatDelta, event.payload);
      this.#emit({
        type: "delta",
        text: delta.text === null ? null : redactText(delta.text),
        ...(delta.turn_id === undefined ? {} : { turnId: delta.turn_id }),
        ...(delta.segment === undefined ? {} : { segment: delta.segment }),
        ...(delta.offset === undefined ? {} : { offset: delta.offset }),
      });
    } else if (event.type === "message.complete") {
      if (generation === undefined) {
        // A queued row can settle beside a different running execution. It cannot end that turn
        // or clear its approval cards. This stage does not project queued completion bubbles.
        if (event.admission_id)
          snapshot.pending = snapshot.pending.filter((row) => row.admission_id !== event.admission_id);
        return;
      }
      const complete = decodeChat(ChatComplete, event.payload);
      snapshot.running = false;
      snapshot.prompts = [];
      if (event.admission_id) {
        if (this.#completedAdmissions.size >= 256) throw new HermesChatFailure({ code: "limit" });
        this.#completedAdmissions.add(event.admission_id);
        snapshot.pending = snapshot.pending.filter((row) => row.admission_id !== event.admission_id);
      } else if (snapshot.pending.length > 0) {
        // Without an admission identity, only an explicit fresh snapshot can settle pending rows.
        this.#phase = "ready";
      }
      this.#emit({
        type: "complete",
        text: redactText(complete.text),
        ...(complete.status === undefined ? {} : { status: complete.status }),
      });
    } else if (event.type === "approval.request" || event.type === "clarify.request") {
      const prompt = decodeChat(ChatPrompt, {
        ...decodeChat(ChatPromptEvent, event.payload),
        kind: event.type === "approval.request" ? "approval" : "clarify",
      });
      if (generation === undefined || prompt.execution_generation !== snapshot.execution_generation)
        throw new HermesChatFailure({ code: "invalid-response" });
      snapshot.prompts = [...snapshot.prompts.filter((item) => item.prompt_id !== prompt.prompt_id), prompt];
      if (snapshot.prompts.length > 32) throw new HermesChatFailure({ code: "limit" });
      this.#emit({ type: "prompt", prompt: this.#safePrompt(prompt) });
    } else if (event.type === "approval.settled" || event.type === "clarify.settled") {
      const settled = decodeChat(ChatSettled, event.payload);
      snapshot.prompts = snapshot.prompts.filter((item) => item.prompt_id !== settled.prompt_id);
      this.#emit({ type: "prompt-settled", promptId: settled.prompt_id });
    }
  }

  #safePrompt(prompt: Prompt): Prompt {
    return {
      ...prompt,
      choices: [...prompt.choices],
      ...(prompt.command === undefined ? {} : { command: redactText(prompt.command) }),
      ...(prompt.description === undefined ? {} : { description: redactText(prompt.description) }),
      ...(prompt.question === undefined ? {} : { question: redactText(prompt.question) }),
    };
  }

  #emit(event: ChatEvent): void {
    if (this.#reader) this.#reader.receive(event);
    else {
      const size = Buffer.byteLength(JSON.stringify(event));
      if (this.#events.length >= 128 || this.#eventBytes + size > 1_048_576)
        throw new HermesChatFailure({ code: "limit" });
      this.#events.push(event);
      this.#eventBytes += size;
    }
  }

  #drop(): void {
    const attempt = this.#attempt;
    this.#attempt = null;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    this.#heartbeatId = null;
    this.#readyReject?.();
    this.#readyReject = null;
    this.#ready = null;
    const socket = this.#socket;
    this.#socket = null;
    socket?.terminate();
    for (const call of [...this.#pending.values()]) call.fail();
    this.#pending.clear();
    this.#events.length = 0;
    this.#eventBytes = 0;
    this.#staged = [];
    this.#snapshot = null;
    this.#reader?.fail();
    if (this.#phase !== "closed") this.#phase = "disconnected";
    attempt?.abort();
  }
}

function validId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && /^[A-Za-z0-9._:-]+$/u.test(value);
}
