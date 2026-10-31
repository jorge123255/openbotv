import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostToolAsk, HostToolDecision, McpServerConfig } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { ScreenCaptureHost } from "../agent/screen-capture";
import { callHostMcpTool } from "./host-mcp";
import { runHostCommand } from "./host-tool-executor";
import { thisComputer } from "./host-tool-machines";
import { loadHostToolPolicy } from "./host-tool-policy";
import { handleLocalExecFrame } from "./host-tool-runner";
import type { HostToolRequest } from "./host-tool-types";
import type { LocalExecRequestFrame, LocalExecResponseFrame } from "./local-exec-frames";

export async function handleGrokHostToolFrame(
  frame: LocalExecRequestFrame,
  context: { agentId: string; threadId: string; turnId: string },
  deps: {
    readonly userDataPath: string;
    readonly capture: ScreenCaptureHost | null;
    readonly thumbnail: (png: Uint8Array) => Uint8Array;
    readonly listMcp: (agentId: string) => readonly McpServerConfig[];
    readonly endpoint: (
      config: McpServerConfig,
      agentId: string,
    ) => Effect.Effect<{ url: string; authorization: string | null } | { error: string }, unknown>;
    readonly ask: (ask: HostToolAsk) => Promise<HostToolDecision>;
  },
): Promise<LocalExecResponseFrame | null> {
  const policy = await loadHostToolPolicy(join(deps.userDataPath, "host-tool-review.json"));
  const computer = thisComputer();
  return handleLocalExecFrame(
    frame,
    {
      policy,
      computer,
      execute: {
        root: homedir(),
        computer,
        run: runHostCommand,
        capture: async () => {
          if (!deps.capture) return { denied: true };
          try {
            const image = await Effect.runPromise(deps.capture.capture({ target: "screen" }));
            return { png: image.png, thumbnailPng: deps.thumbnail(image.png) };
          } catch {
            return { denied: true };
          }
        },
        writeShot: (png, thumbnail) => writeHostShot(deps.userDataPath, png, thumbnail),
      },
      now: () => Date.now(),
      ask: (request) => deps.ask(askFor(request)),
      emitRow: () => undefined,
      mcp: {
        configs: deps.listMcp(context.agentId),
        forAgent: (_configs, agentId) => [...deps.listMcp(agentId)],
        call: async (config, toolName, args) => {
          const resolved = await Effect.runPromise(deps.endpoint(config, context.agentId));
          if ("error" in resolved) throw new Error("refused");
          return callHostMcpTool({
            config,
            endpoint: config.transport === "http" ? resolved : null,
            toolName,
            arguments: args,
          });
        },
      },
    },
    context,
  );
}

function askFor(request: HostToolRequest): HostToolAsk {
  return {
    requestId: request.id,
    agentId: request.agentId,
    threadId: request.threadId,
    turnId: request.turnId,
    action: request.action,
    detail: request.command ?? request.path ?? request.chars ?? request.toolName ?? request.action,
  };
}

async function writeHostShot(
  userDataPath: string,
  png: Uint8Array,
  thumbnail: Uint8Array,
): Promise<{ path: string; thumbnailPath: string }> {
  const dir = join(userDataPath, "host-tool-shots");
  await mkdir(dir, { recursive: true });
  const stamp = Date.now().toString(36);
  const path = join(dir, `${stamp}.png`);
  const thumbnailPath = join(dir, `${stamp}-thumb.png`);
  await writeFile(path, png);
  await writeFile(thumbnailPath, thumbnail);
  return { path, thumbnailPath };
}
