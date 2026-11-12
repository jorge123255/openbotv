import { ELEVENLABS_SPEECH_LIMITS } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import type { ElevenLabsSpeechModelId, ElevenLabsVoice } from "./voice-settings";

export { elevenLabsVoiceParts } from "@openbot/contracts/ipc";

const API = "https://api.elevenlabs.io";
/** The `model_id` of each model, as desktop sends it. */
const SPEECH_MODELS: Record<ElevenLabsSpeechModelId, string> = {
  "elevenlabs-flash-v2.5": "eleven_flash_v2_5",
  "elevenlabs-multilingual-v2": "eleven_multilingual_v2",
  "elevenlabs-v3": "eleven_v3",
  "elevenlabs-v4-turbo": "eleven_v4_turbo",
  "elevenlabs-v4": "eleven_v4",
};
/** The sample rate of `pcm_24000`, which every ElevenLabs plan has. */
export const ELEVENLABS_SAMPLE_RATE = 24_000;

/**
 * The permissions of a restricted ElevenLabs key that the phone uses: Voices: Read lists the voices,
 * Text to Speech: Access reads the replies, and Speech to Text: Access recognizes the user's speech.
 * A key without restrictions has all of them.
 */
type ElevenLabsPermission = "voices_read" | "text_to_speech" | "speech_to_text";

const MISSING_PERMISSION = {
  voices_read: "missing-voices-permission",
  text_to_speech: "missing-speech-permission",
  speech_to_text: "missing-transcription-permission",
} as const;

type ElevenLabsFailure = "invalid-key" | (typeof MISSING_PERMISSION)[ElevenLabsPermission] | "network" | "failed";

/** The longest ElevenLabs reason that the phone shows. */
const REASON_MAX_LENGTH = 300;

/**
 * Why a request failed. `reason` is the `detail.message` that ElevenLabs sends with a refusal, such
 * as a plan that does not allow a voice, with the key removed. The message stays the code, so a log
 * never holds the reason.
 */
export class ElevenLabsError extends Error {
  constructor(
    readonly code: ElevenLabsFailure,
    readonly reason: string | null = null,
  ) {
    super(code);
  }
}

/** The `detail` of an ElevenLabs error answer: `{ status, message }`, or one text. */
function errorDetail(body: string, key: string): { status: string | null; reason: string | null } {
  let answer: unknown;
  try {
    answer = JSON.parse(body);
  } catch {
    return { status: null, reason: null };
  }
  const detail = isDynamicRecord(answer) ? answer.detail : null;
  const status = isDynamicRecord(detail) && isString(detail.status) ? detail.status : null;
  const message = isString(detail) ? detail : isDynamicRecord(detail) && isString(detail.message) ? detail.message : "";
  const reason = (key ? message.replaceAll(key, "…") : message).trim().slice(0, REASON_MAX_LENGTH);
  return { status, reason: reason || null };
}

async function request(
  path: string,
  key: string,
  permission: ElevenLabsPermission,
  init: RequestInit = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { ...init, headers: { ...init.headers, "xi-api-key": key } });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ElevenLabsError("network");
  }
  if (response.ok) return response;
  const body = await response.text().catch(() => "");
  const { status, reason } = errorDetail(body, key);
  if (response.status === 401 || response.status === 403) {
    // A restricted key without the permission answers `missing_permissions` and names it.
    if (body.includes("missing_permissions") || body.includes(permission))
      throw new ElevenLabsError(MISSING_PERMISSION[permission]);
    // A valid key can also be refused, for example when ElevenLabs stops the free plan of an
    // account. Its own reason is then more accurate than "invalid key".
    if (status === "invalid_api_key" || !reason) throw new ElevenLabsError("invalid-key");
  }
  throw new ElevenLabsError("failed", reason);
}

/** How many pages of 100 voices to follow. Desktop uses the same cap. */
const VOICE_PAGE_CAP = 10;

/**
 * The voices of the account: premade, cloned and saved. A key that lists none is still valid.
 * Pages follow `next_page_token` until the account is listed or the cap is reached.
 */
export async function listElevenLabsVoices(key: string): Promise<ElevenLabsVoice[]> {
  const voices: ElevenLabsVoice[] = [];
  const seen = new Set<string>();
  let pageToken: string | null = null;
  for (let page = 0; page < VOICE_PAGE_CAP && voices.length < ELEVENLABS_SPEECH_LIMITS.voices; page += 1) {
    const query = new URLSearchParams({ page_size: "100" });
    if (pageToken) query.set("next_page_token", pageToken);
    const response = await request(`/v2/voices?${query}`, key, "voices_read");
    const body = await response.json().catch(() => null);
    const parsed = voicePage(body);
    if (!parsed) throw new ElevenLabsError("failed");
    for (const voice of parsed.voices) {
      if (seen.has(voice.id) || voices.length >= ELEVENLABS_SPEECH_LIMITS.voices) continue;
      seen.add(voice.id);
      voices.push(voice);
    }
    if (!parsed.nextPageToken || parsed.nextPageToken === pageToken) break;
    pageToken = parsed.nextPageToken;
  }
  return voices;
}

/** One part of a reply as little-endian 16-bit mono PCM at `ELEVENLABS_SAMPLE_RATE`. */
export async function elevenLabsSpeech(
  key: string,
  voiceId: string,
  model: ElevenLabsSpeechModelId,
  text: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const response = await request(
    `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=pcm_${ELEVENLABS_SAMPLE_RATE}`,
    key,
    "text_to_speech",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: SPEECH_MODELS[model] }),
      signal,
    },
  );
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * A single-use token for one Scribe v2 Realtime session, so the key itself never goes into the
 * socket. ElevenLabs answers a key without Speech to Text here, where the refusal can be read.
 */
export async function scribeToken(key: string, signal: AbortSignal): Promise<string> {
  const response = await request("/v1/single-use-token/realtime_scribe", key, "speech_to_text", {
    method: "POST",
    signal,
  });
  const body = await response.json().catch(() => null);
  if (!isDynamicRecord(body) || !isString(body.token)) throw new ElevenLabsError("failed");
  return body.token;
}

/**
 * Tests both permissions before the key is saved: it lists the voices, and reads one character with
 * the first of them and Flash v2.5, which costs one character of the account's quota.
 */
export async function testElevenLabsKey(key: string): Promise<ElevenLabsVoice[]> {
  const voices = await listElevenLabsVoices(key);
  const first = voices[0];
  if (first) await elevenLabsSpeech(key, first.id, "elevenlabs-flash-v2.5", ".", new AbortController().signal);
  return voices;
}

/** One page of `/v2/voices`. Null when the body is not that page. Desktop reads the same shape. */
function voicePage(body: unknown): { voices: ElevenLabsVoice[]; nextPageToken: string | null } | null {
  if (!isDynamicRecord(body) || !Array.isArray(body.voices)) return null;
  const voices: ElevenLabsVoice[] = [];
  for (const entry of body.voices) {
    if (!isDynamicRecord(entry) || !isString(entry.voice_id) || !isString(entry.name)) continue;
    if (entry.voice_id.length === 0 || entry.voice_id.length > ELEVENLABS_SPEECH_LIMITS.voiceId) continue;
    if (entry.name.length === 0 || entry.name.length > ELEVENLABS_SPEECH_LIMITS.voiceName) continue;
    voices.push({ id: entry.voice_id, name: entry.name });
  }
  const token = body.next_page_token;
  const nextPageToken =
    body.has_more === true && isString(token) && token.length > 0 && token.length <= 512 ? token : null;
  return { voices, nextPageToken };
}
