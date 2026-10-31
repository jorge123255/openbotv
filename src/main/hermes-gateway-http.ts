import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { registerSecretValues } from "@openbot/logging";
import { HermesGatewayFailure } from "./hermes-gateway-protocol";

export type GatewayRoute =
  | "/api/status"
  | "/api/auth/providers"
  | "/auth/password-login"
  | "/api/auth/me"
  | "/api/profiles"
  | "/api/auth/ws-ticket";

interface GatewayReply {
  body: string;
  cookies: readonly string[];
}

/** One fixed-origin request. Node transport keeps cookies out of Chromium's shared cookie jar. */
export function gatewayRequest(
  base: URL,
  route: GatewayRoute,
  signal: AbortSignal,
  cookie: string,
  body?: string,
): Promise<GatewayReply> {
  const url = new URL(`${base.origin}${base.pathname.replace(/\/$/u, "")}${route}`);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: body === undefined ? "GET" : "POST",
        signal,
        // Do not inherit NODE_TLS_REJECT_UNAUTHORIZED=0 or an application-wide TLS bypass.
        rejectUnauthorized: true,
        maxHeaderSize: 32_768,
        headers: {
          accept: "application/json",
          origin: base.origin,
          ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const fail = (code: HermesGatewayFailure["code"]) => {
          reject(new HermesGatewayFailure({ code }));
          response.destroy();
        };
        if (status >= 300 && status < 400) return fail("redirect");
        if (status === 401 || status === 403) return fail("authentication");
        if (status === 429) return fail("rate-limited");
        if (status !== 200 || !response.headers["content-type"]?.startsWith("application/json"))
          return fail("invalid-response");
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1_048_576) return fail("invalid-response");
          chunks.push(chunk);
        });
        response.on("error", () => reject(new HermesGatewayFailure({ code: "transport" })));
        response.on("end", () =>
          resolve({ body: Buffer.concat(chunks).toString("utf8"), cookies: response.headers["set-cookie"] ?? [] }),
        );
      },
    );
    // A wall-clock deadline covers slow headers and a response that never finishes.
    const deadline = setTimeout(() => request.destroy(new Error("deadline")), 8_000);
    request.on("close", () => clearTimeout(deadline));
    request.on("error", () => reject(new HermesGatewayFailure({ code: "transport" })));
    request.end(body);
  });
}

interface SessionCookie {
  value: string;
  expires: number;
  path: string;
}

/** This jar belongs to one immutable gateway connection, never a hostname or browser partition. */
export class HermesGatewayCookies {
  readonly #cookies = new Map<string, SessionCookie>();

  record(base: URL, headers: readonly string[]): void {
    for (const header of headers) {
      const [pair = "", ...attributes] = header.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const cookieName =
        /^(?:__Host-|__Secure-)?hermes_(session_(?:at|rt|provider)|webapp_signin)(?:_[A-Za-z0-9_-]+)?$/u.exec(name);
      if (!cookieName) continue;
      const attrs = new Map(
        attributes.map((attribute) => {
          const index = attribute.indexOf("=");
          return index < 0
            ? [attribute.trim().toLowerCase(), ""]
            : [attribute.slice(0, index).trim().toLowerCase(), attribute.slice(index + 1).trim()];
        }),
      );
      const path = attrs.get("path") ?? "/";
      if (
        attrs.has("domain") ||
        !attrs.has("httponly") ||
        (base.protocol === "https:" && !attrs.has("secure")) ||
        (base.protocol !== "https:" && (attrs.has("secure") || name.startsWith("__"))) ||
        (name.startsWith("__Host-") && path !== "/") ||
        (path !== "/" && path !== base.pathname) ||
        /[^\x21-\x7e]|[;,]/u.test(value)
      )
        continue;
      const age = attrs.get("max-age");
      const expires = age === undefined ? Date.parse(attrs.get("expires") ?? "") : Date.now() + Number(age) * 1_000;
      if (!value || !Number.isFinite(expires) || expires <= Date.now()) {
        this.#cookies.delete(name);
        continue;
      }
      const raw = unquoteCookie(value);
      if (raw === null || /[^\x21-\x7e]/u.test(raw)) continue;
      // The captured role comes from the start of the complete cookie name. Suffix text must
      // never turn an AT/RT/binding cookie into a nonsecret routing hint.
      const providerHint = cookieName[1] === "session_provider";
      // Remote cookie input must not register short words in the process-wide redactor. Official
      // AT/RT values and the 64-character Webapp binding exceed this floor. Short custom tokens
      // are unsupported rather than accepted without redaction. The routing hint is not a secret.
      if (!providerHint && raw.length < 16) continue;
      if (!providerHint) registerSecretValues([value, raw]);
      this.#cookies.set(name, { value, expires, path });
    }
  }

  header(path: string): string {
    const result: string[] = [];
    for (const [name, cookie] of this.#cookies) {
      if (cookie.expires <= Date.now()) this.#cookies.delete(name);
      else if (cookie.path === "/" || path === cookie.path || path.startsWith(`${cookie.path}/`))
        result.push(`${name}=${cookie.value}`);
    }
    return result.join("; ");
  }

  clear(): void {
    this.#cookies.clear();
  }
}

/** Python http.cookies/SimpleCookie quoting used by Starlette: keep wire bytes for transport. */
function unquoteCookie(value: string): string | null {
  if (!value.startsWith('"')) return value.includes('"') ? null : value;
  if (!value.endsWith('"') || value.length < 2) return null;
  return value
    .slice(1, -1)
    .replace(/\\([0-3][0-7]{2}|.)/gu, (_match, escaped: string) =>
      /^[0-3][0-7]{2}$/u.test(escaped) ? String.fromCharCode(Number.parseInt(escaped, 8)) : escaped,
    );
}
