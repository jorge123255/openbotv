// The ACP agent of `stream-stall-retry-e2e.ts`. Each prompt text names what the agent does:
// - `drop-once` fails the first prompt with a socket reset, then answers.
// - `overload-once` fails the first prompt as an overloaded engine, then answers.
// - `auth` fails every prompt as a sign-in error.
// - `auth-code` uses the auth-required code with a transient-looking message.
// - `auth-text` names authentication in an internal-error response.
// - `drop-after-text` sends answer text, then fails the stream. A retry would send it again.
// - `drop-always` fails every prompt with a socket reset.
// - `stall-once` sends nothing until `session/cancel`, then fails that prompt. The next prompt answers.
// - `hang` never answers and ignores `session/cancel`.
import { type AcpParams, type AcpPeer, type AcpRequest, logEntry, serveFakeAcpAgent } from "../acp-agent";

const MODELS = [{ modelId: "fake-alpha", name: "Fake Alpha" }];
let count = 0;
const droppedOnce = new Set<string>();
const overloadedOnce = new Set<string>();
let stallReleased = false;
const waiting = new Map<string, AcpRequest>();

function setup(sessionId: string) {
  return {
    sessionId,
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "fake-alpha",
        options: MODELS.map((model) => ({ value: model.modelId, name: model.name })),
      },
    ],
    models: { availableModels: MODELS, currentModelId: "fake-alpha" },
  };
}

function promptText(params: AcpParams): string {
  const text = (params.prompt ?? []).map((block) => block.text ?? "").join("");
  return text.replace(/^[\s\S]*<\/openbot-developer-instructions>/u, "").trim();
}

function failStream(peer: AcpPeer, request: AcpRequest, message: string): void {
  // -32000 is ACP authRequired. A fake transport failure uses internalError instead.
  peer.fail(request, { code: -32603, message });
}

function releaseStall(sessionId: string): void {
  const request = waiting.get(sessionId);
  if (!request) return;
  waiting.delete(sessionId);
  stallReleased = true;
  logEntry({ event: "stall-released", sessionId });
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32800, message: "The operation was aborted" },
    })}\n`,
  );
}

serveFakeAcpAgent(
  {
    initialize: (request, peer) =>
      peer.reply(request, {
        protocolVersion: 1,
        agentInfo: { name: "stream-stall", version: "1.0.0" },
        agentCapabilities: { loadSession: true },
        authMethods: [],
      }),
    "session/new": (request, peer) => {
      count += 1;
      logEntry({ event: "session/new" });
      peer.reply(request, setup(`s-${process.pid}-${count}`));
    },
    "session/load": (request, peer) => {
      logEntry({ event: "session/load", sessionId: request.params.sessionId ?? "" });
      peer.reply(request, setup(request.params.sessionId ?? ""));
    },
    "session/set_config_option": (request, peer) =>
      peer.reply(request, { configOptions: setup(request.params.sessionId ?? "").configOptions }),
    "session/prompt": (request, peer) => {
      const sessionId = request.params.sessionId ?? "";
      const text = promptText(request.params);
      logEntry({ event: "prompt", sessionId, text });
      if (text === "drop-once" && !droppedOnce.has(sessionId)) {
        droppedOnce.add(sessionId);
        failStream(peer, request, "socket hang up");
        return;
      }
      if (text === "overload-once" && !overloadedOnce.has(sessionId)) {
        overloadedOnce.add(sessionId);
        failStream(peer, request, "The engine is currently overloaded");
        return;
      }
      if (text === "auth" || text === "auth-code") {
        peer.fail(request, {
          code: -32000,
          message: text === "auth" ? "authentication required" : "socket hang up",
        });
        return;
      }
      if (text === "auth-text") {
        failStream(peer, request, "authentication required");
        return;
      }
      if (text === "drop-after-text") {
        peer.say(sessionId, "partial");
        failStream(peer, request, "socket hang up");
        return;
      }
      if (text === "drop-always") {
        failStream(peer, request, "socket hang up");
        return;
      }
      if (text === "stall-once" && !stallReleased) {
        waiting.set(sessionId, request);
        return;
      }
      if (text === "hang") return;
      const answer = text === "stall-once" ? "resumed" : text === "overload-once" ? "recovered-overload" : "recovered";
      peer.say(sessionId, answer);
      peer.reply(request, { stopReason: "end_turn" });
    },
  },
  {
    onNotification: (method, params) => {
      if (method !== "session/cancel") return;
      const sessionId = params.sessionId ?? "";
      logEntry({ event: "cancel", sessionId });
      releaseStall(sessionId);
    },
  },
);
