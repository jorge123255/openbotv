import { sourceText } from "@openbot/i18n/source";
import {
  decodeRequestFrame,
  type GatewayHeaderSession,
  LOCAL_EXEC_REQUESTS_PATH,
  LOCAL_EXEC_RESPONSES_PATH,
  type LocalExecRequestFrame,
  type LocalExecResponseFrame,
  localExecHeaders,
  responsePostBody,
} from "./local-exec-frames";

export interface LocalExecClientOptions {
  readonly baseUrl: string;
  readonly session: GatewayHeaderSession;
  readonly signal: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly onFrame: (frame: LocalExecRequestFrame) => Promise<LocalExecResponseFrame | null>;
  readonly hello: () => LocalExecResponseFrame;
}

/**
 * One subscribe to `GET /local-exec/requests`. A rejected subscribe throws.
 * This function does not open another GET.
 */
export async function runLocalExecClient(options: LocalExecClientOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = { ...localExecHeaders(options.session), accept: "text/event-stream" };
  let response: Response;
  try {
    response = await fetchImpl(`${options.baseUrl}${LOCAL_EXEC_REQUESTS_PATH}`, {
      method: "GET",
      headers,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal.aborted) return;
    throw error;
  }
  if (!response.ok || response.body === null) {
    throw new Error(sourceText("error.backend.hostToolMachineOffline"));
  }

  let providerId: string | undefined;
  const post = async (frames: readonly LocalExecResponseFrame[]): Promise<void> => {
    if (options.signal.aborted) return;
    const posted = await fetchImpl(`${options.baseUrl}${LOCAL_EXEC_RESPONSES_PATH}`, {
      method: "POST",
      headers: { ...localExecHeaders(options.session), "content-type": "application/json" },
      body: JSON.stringify(responsePostBody(providerId, frames)),
      signal: options.signal,
    });
    if (!posted.ok) throw new Error(sourceText("error.backend.hostToolMachineOffline"));
  };

  try {
    await post([options.hello()]);
  } catch (error) {
    if (options.signal.aborted) return;
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handleBlock = async (block: string): Promise<void> => {
    const frame = frameFromSseBlock(block);
    if (frame === null) return;
    if (frame.kind === "welcome") {
      providerId = frame.providerId;
      return;
    }
    if (frame.kind === "retire-approval") {
      await options.onFrame(frame);
      return;
    }
    const reply = await options.onFrame(frame);
    if (reply === null) return;
    await post([reply]);
  };

  try {
    while (!options.signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) {
        if (buffer.trim().length > 0) await handleBlock(buffer);
        return;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) await handleBlock(block);
    }
  } catch (error) {
    if (options.signal.aborted) return;
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function frameFromSseBlock(block: string): LocalExecRequestFrame | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");
  if (data.length === 0) return null;
  try {
    return decodeRequestFrame(JSON.parse(data));
  } catch {
    return null;
  }
}
