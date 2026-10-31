import { Schema } from "effect";

// Protocol source: NousResearch/hermes-agent@f30105a0b4b3d0c1baa6c464189755ccdbc1ac7f.
// This adapter is main-only. These types are not renderer or Team API contracts.
export class HermesGatewayFailure extends Schema.TaggedError<HermesGatewayFailure>()("HermesGatewayFailure", {
  code: Schema.Literals([
    "invalid-address",
    "tls-required",
    "transport",
    "redirect",
    "invalid-response",
    "authentication",
    "rate-limited",
    "unsupported-auth",
    "closed",
    "socket-rejected",
  ]),
}) {}

const ShortText = Schema.String.check(Schema.isMaxLength(256));
export const GatewayStatus = Schema.Struct({ auth_required: Schema.Boolean });
export const GatewayProviders = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({ name: ShortText, display_name: ShortText, supports_password: Schema.Boolean }),
  ).check(Schema.isMaxLength(32)),
});
export const GatewayIdentity = Schema.Struct({
  user_id: ShortText,
  provider: ShortText,
  expires_at: Schema.Number,
});
export const GatewayProfiles = Schema.Struct({
  profiles: Schema.Array(
    Schema.Struct({ name: ShortText, display_name: Schema.optionalKey(ShortText), is_default: Schema.Boolean }),
  ).check(Schema.isMaxLength(1_000)),
});
export const GatewayLogin = Schema.Struct({ ok: Schema.Literal(true) });
export const GatewayTicket = Schema.Struct({
  ticket: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{16,256}$/u)),
  ttl_seconds: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 30 })),
});

/** Require an explicit address. Never repair a URL that can hide credentials or change its route. */
export function gatewayAddress(address: string): URL {
  if (address.length > 2_048 || /[\s\\?#%]/u.test(address) || !/^https?:\/\//u.test(address))
    throw new HermesGatewayFailure({ code: "invalid-address" });
  const url = new URL(address);
  if (url.username || url.password || /(?:^|\/)\.{1,2}(?:\/|$)/u.test(address.slice(address.indexOf("://") + 3)))
    throw new HermesGatewayFailure({ code: "invalid-address" });
  // A LAN/VPN HTTP exception needs a separate, explicit transport decision. No DNS-based exception.
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]")
    throw new HermesGatewayFailure({ code: "tls-required" });
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url;
}

export function decodeGateway<A>(schema: Schema.Decoder<A>, body: string): A {
  try {
    return Schema.decodeUnknownSync(schema)(JSON.parse(body));
  } catch {
    // Never attach parser input, remote error text, headers or a transport cause.
    throw new HermesGatewayFailure({ code: "invalid-response" });
  }
}
