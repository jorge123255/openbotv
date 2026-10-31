// Pinned gateway native_flow.py and routes.py: password login can use the native PKCE broker.
// No Electron import: the system-browser launcher is injected by the application composition root.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { sourceText } from "@openbot/i18n/source";
import { registerSecretValue, registerSecretValues } from "@openbot/logging";
import { gatewayRequest } from "./hermes-gateway-http";
import { decodeGateway, GatewayNativeTokens, HermesGatewayFailure } from "./hermes-gateway-protocol";

export type HermesGatewayBrowser = (url: string) => Promise<void>;

/** The gateway owns credential entry. The verifier, callback code and tokens stay in main. */
export async function authorizeHermesPassword(
  base: URL,
  provider: string,
  signal: AbortSignal,
  openBrowser: HermesGatewayBrowser,
) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const callbackPath = `/hermes-sign-in/${randomBytes(16).toString("hex")}`;
  registerSecretValues([verifier, state]);
  const server = createServer({ maxHeaderSize: 8_192 });
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  let expectedHost = "";
  let complete: (code: string) => void = () => {};
  let refuse: (error: HermesGatewayFailure) => void = () => {};
  let consumed = false;
  const callback = new Promise<string>((resolve, reject) => {
    complete = resolve;
    refuse = reject;
  });
  // A browser launcher failure can precede awaiting the callback. Keep its rejection observed.
  void callback.catch(() => {});
  server.on("request", (request, response) => {
    const reject = () => {
      response.writeHead(400, { "content-type": "text/plain", "cache-control": "no-store", connection: "close" });
      response.end(sourceText("error.hermesGateway.callback"));
    };
    if (
      consumed ||
      signal.aborted ||
      request.method !== "GET" ||
      request.headers.host !== expectedHost ||
      request.headers.origin ||
      !request.url?.startsWith(`${callbackPath}?`) ||
      request.url.length > 4_096
    )
      return reject();
    const url = new URL(request.url, `http://${expectedHost}`);
    if (
      url.pathname !== callbackPath ||
      url.searchParams.getAll("state").length !== 1 ||
      url.searchParams.getAll("code").length !== 1 ||
      url.searchParams.has("error")
    )
      return reject();
    const suppliedState = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    if (
      !/^[A-Za-z0-9_-]{43}$/u.test(suppliedState) ||
      !timingSafeEqual(Buffer.from(suppliedState), Buffer.from(state)) ||
      !/^[A-Za-z0-9_-]{16,256}$/u.test(code)
    )
      return reject();
    consumed = true;
    registerSecretValue(code);
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
      connection: "close",
    });
    response.end(sourceText("status.hermesGateway.returnToApp"));
    complete(code);
  });
  const cancel = () => refuse(new HermesGatewayFailure({ code: "cancelled" }));
  signal.addEventListener("abort", cancel, { once: true });
  const deadline = setTimeout(cancel, 180_000);
  try {
    if (signal.aborted) throw new HermesGatewayFailure({ code: "cancelled" });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address !== "object") throw new HermesGatewayFailure({ code: "transport" });
    expectedHost = `127.0.0.1:${address.port}`;
    const authorization = new URL(`${base.origin}${base.pathname.replace(/\/$/u, "")}/auth/native/authorize`);
    authorization.search = new URLSearchParams({
      provider,
      code_challenge: createHash("sha256").update(verifier, "ascii").digest("base64url"),
      code_challenge_method: "S256",
      redirect_uri: `http://${expectedHost}${callbackPath}`,
      state,
    }).toString();
    await Promise.race([openBrowser(authorization.href), callback]);
    const code = await callback;
    signal.throwIfAborted();
    const reply = await gatewayRequest(
      base,
      "/auth/native/token",
      signal,
      "",
      JSON.stringify({ code, code_verifier: verifier }),
    );
    const tokens = decodeGateway(GatewayNativeTokens, reply.body);
    registerSecretValues([tokens.access_token, tokens.refresh_token]);
    if (
      tokens.provider !== provider ||
      !Number.isFinite(tokens.expires_at * 1_000) ||
      tokens.expires_at * 1_000 <= Date.now()
    )
      throw new HermesGatewayFailure({ code: "authentication" });
    return tokens;
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", cancel);
    if (server.listening) {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    }
  }
}
