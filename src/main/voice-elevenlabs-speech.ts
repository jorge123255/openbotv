// ElevenLabs text-to-speech for spoken replies, and the voice list Settings shows.
//
// The same saved key as Scribe dictation. The plaintext stays in this process: a voice id and a voice
// name are the only values that go back to the renderer. Nothing here logs the key or a response body.
// The request shape matches the iPhone client in `apps/mobile/src/features/voice/model/elevenlabs.ts`.

import {
  ELEVENLABS_SPEECH_LIMITS,
  type ElevenLabsSpeechVoice,
  isElevenLabsSpeechVoice,
  type SpeechAudio,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { readLimitedBody } from "../backend/limited-body";
import type { SpeechPreferenceStore } from "./speech-preference-store";
import type { VoiceApiKeyStore } from "./voice-api-key-store";
import { VoiceOperationError } from "./voice-model-service";

const logger = createOpenBotLogger("voice-elevenlabs-speech");

const API = "https://api.elevenlabs.io";
/** Low latency for a conversation, in the languages that ElevenLabs reads. The iPhone uses this model. */
const SPEECH_MODEL = "eleven_flash_v2_5";
/** The sample rate of `pcm_24000`, which every ElevenLabs plan has. */
const SAMPLE_RATE = 24_000;
/** How long one part may take. A part is at most `SPEECH_LIMITS.maximumTextLength` characters. */
const SPEECH_TIMEOUT_MS = 60_000;
const LIST_TIMEOUT_MS = 20_000;
/** One page of the voice list. Further pages follow `next_page_token`, up to the voice cap. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
/** An error body is read only to classify it. It is not logged and not shown. */
const ERROR_BODY_LIMIT = 8_000;
/** One page of voice metadata. A page of 100 voices fits well under this. */
const LIST_BODY_LIMIT = 1_000_000;
/** About three minutes of 16-bit mono PCM at `SAMPLE_RATE`. A longer answer is refused. */
const SPEECH_BODY_LIMIT = SAMPLE_RATE * 2 * 180;

type ElevenLabsPermission = "voices_read" | "text_to_speech";

interface VoiceElevenLabsSpeechOptions {
  apiKeys: VoiceApiKeyStore;
  preferences: SpeechPreferenceStore;
  fetch?: typeof fetch;
}

/** Reads one part of a reply with ElevenLabs, and lists the voices of the saved key. */
export class VoiceElevenLabsSpeech {
  readonly #apiKeys: VoiceApiKeyStore;
  readonly #preferences: SpeechPreferenceStore;
  readonly #fetch: typeof fetch;

  constructor(options: VoiceElevenLabsSpeechOptions) {
    this.#apiKeys = options.apiKeys;
    this.#preferences = options.preferences;
    this.#fetch = options.fetch ?? fetch;
  }

  /** The voices of the account. A key that lists none is still valid. */
  readonly listVoices = Effect.fn("VoiceElevenLabs.listVoices")(function* (this: VoiceElevenLabsSpeech) {
    const key = this.#apiKeys.get();
    if (!key) return yield* fail(sourceText("error.voice.cloud.keyRequired"));
    const voices: ElevenLabsSpeechVoice[] = [];
    const seen = new Set<string>();
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_PAGES && voices.length < ELEVENLABS_SPEECH_LIMITS.voices; page += 1) {
      const query = new URLSearchParams({ page_size: String(PAGE_SIZE) });
      if (pageToken) query.set("next_page_token", pageToken);
      const body = yield* this.#json(`/v2/voices?${query}`, key, "voices_read");
      const parsed = voicePage(body);
      if (!parsed) return yield* fail(sourceText("error.voice.cloud.voicesFailed"));
      for (const voice of parsed.voices) {
        if (seen.has(voice.id) || voices.length >= ELEVENLABS_SPEECH_LIMITS.voices) continue;
        seen.add(voice.id);
        voices.push(voice);
      }
      if (!parsed.nextPageToken || parsed.nextPageToken === pageToken) break;
      pageToken = parsed.nextPageToken;
    }
    return voices;
  }).bind(this);

  /** One part of a reply: little-endian 16-bit mono PCM at 24 kHz, with the voice in the settings. */
  readonly speak = Effect.fn("VoiceElevenLabs.speak")(function* (this: VoiceElevenLabsSpeech, text: string) {
    const key = this.#apiKeys.get();
    const voice = this.#preferences.get().elevenLabsVoice;
    if (!key) return yield* fail(sourceText("error.voice.cloud.keyRequired"));
    if (!voice) return yield* fail(sourceText("error.voice.cloud.voiceRequired"));
    const startedAt = Date.now();
    const pcm = yield* this.#pcm(
      `/v1/text-to-speech/${encodeURIComponent(voice.id)}?output_format=pcm_${SAMPLE_RATE}`,
      key,
      JSON.stringify({ text, model_id: SPEECH_MODEL }),
    ).pipe(
      Effect.tap((audio) =>
        Effect.sync(() =>
          logger.info(
            `ElevenLabs speech of ${text.length} characters (${(audio.byteLength / 2 / SAMPLE_RATE).toFixed(1)}s) completed in ${Date.now() - startedAt}ms.`,
          ),
        ),
      ),
      Effect.tapError(() =>
        Effect.sync(() =>
          logger.error(`ElevenLabs speech of ${text.length} characters failed after ${Date.now() - startedAt}ms.`),
        ),
      ),
    );
    return { pcm, sampleRate: SAMPLE_RATE } satisfies SpeechAudio;
  }).bind(this);

  #json(path: string, key: string, permission: ElevenLabsPermission): Effect.Effect<unknown, VoiceOperationError> {
    return this.#call(path, key, permission, { method: "GET" }, LIST_TIMEOUT_MS, LIST_BODY_LIMIT).pipe(
      Effect.flatMap((bytes) =>
        Effect.try({
          try: (): unknown => JSON.parse(Buffer.from(bytes).toString("utf8")),
          catch: () => refused(sourceText("error.voice.cloud.voicesFailed")),
        }),
      ),
    );
  }

  #pcm(path: string, key: string, body: string): Effect.Effect<Uint8Array, VoiceOperationError> {
    return this.#call(
      path,
      key,
      "text_to_speech",
      { method: "POST", headers: { "Content-Type": "application/json" }, body },
      SPEECH_TIMEOUT_MS,
      SPEECH_BODY_LIMIT,
    ).pipe(
      Effect.flatMap((bytes) =>
        bytes.byteLength < 2 || bytes.byteLength % 2 !== 0
          ? fail(sourceText("error.voice.speech.failed"))
          : Effect.succeed(bytes),
      ),
    );
  }

  /** One ElevenLabs request. The key goes only in the header. The body is bytes, at most `limit`. */
  #call(
    path: string,
    key: string,
    permission: ElevenLabsPermission,
    init: RequestInit,
    timeoutMs: number,
    limit: number,
  ): Effect.Effect<Uint8Array, VoiceOperationError> {
    const timeoutMessage =
      permission === "voices_read"
        ? sourceText("error.voice.cloud.voicesFailed")
        : sourceText("error.voice.speech.timedOut");
    return Effect.acquireUseRelease(
      Effect.sync(() => new AbortController()),
      (controller) =>
        Effect.gen({ self: this }, function* () {
          const response = yield* Effect.tryPromise({
            try: () =>
              this.#fetch(`${API}${path}`, {
                ...init,
                headers: { ...init.headers, "xi-api-key": key },
                redirect: "manual",
                signal: controller.signal,
              }),
            catch: () => refused(sourceText("error.voice.cloud.unreachable")),
          });
          if (!response.ok) return yield* classifyRefusal(response, permission);
          const bytes = yield* readLimitedBody(response, limit, (reason) => reason).pipe(
            Effect.mapError((reason) =>
              refused(
                sourceText(
                  reason === "too-large"
                    ? permission === "voices_read"
                      ? "error.voice.cloud.voicesFailed"
                      : "error.voice.speech.failed"
                    : "error.voice.cloud.unreachable",
                ),
              ),
            ),
          );
          return new Uint8Array(bytes);
        }).pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () => fail(timeoutMessage),
          }),
        ),
      (controller) => Effect.sync(() => controller.abort()),
    );
  }
}

function fail(message: string): Effect.Effect<never, VoiceOperationError> {
  return Effect.fail(refused(message));
}

function refused(message: string): VoiceOperationError {
  return new VoiceOperationError({ cause: new Error(message) });
}

function classifyRefusal(
  response: Response,
  permission: ElevenLabsPermission,
): Effect.Effect<never, VoiceOperationError> {
  return readLimitedBody(response, ERROR_BODY_LIMIT, () => "unreadable" as const).pipe(
    Effect.catch(() => Effect.succeed(Buffer.alloc(0))),
    Effect.flatMap((body) => fail(refusalMessage(response.status, body.toString("utf8"), permission))),
  );
}

/** Why ElevenLabs refused. Only the presence of a known token is read; the text is not kept. */
function refusalMessage(status: number, body: string, permission: ElevenLabsPermission): string {
  if (status === 401 || status === 403) {
    if (body.includes("missing_permissions") || body.includes(permission))
      return sourceText(
        permission === "voices_read"
          ? "error.voice.cloud.missingVoicesPermission"
          : "error.voice.cloud.missingSpeechPermission",
      );
    return sourceText("error.voice.cloud.keyRejected");
  }
  if (status === 429 || body.includes("rate_limited") || body.includes("resource_exhausted"))
    return sourceText("error.voice.cloud.rateLimited");
  if (body.includes("quota_exceeded")) return sourceText("error.voice.cloud.quotaExceeded");
  if (body.includes("unaccepted_terms")) return sourceText("error.voice.cloud.termsRequired");
  return sourceText(permission === "voices_read" ? "error.voice.cloud.voicesFailed" : "error.voice.speech.failed");
}

/** One page of `/v2/voices`. Null when the body is not that page. */
function voicePage(body: unknown): { voices: ElevenLabsSpeechVoice[]; nextPageToken: string | null } | null {
  if (!isDynamicRecord(body) || !Array.isArray(body.voices)) return null;
  const voices: ElevenLabsSpeechVoice[] = [];
  for (const entry of body.voices) {
    if (!isDynamicRecord(entry) || !isString(entry.voice_id) || !isString(entry.name)) continue;
    const voice = { id: entry.voice_id, name: entry.name };
    if (isElevenLabsSpeechVoice(voice)) voices.push(voice);
  }
  const token = body.next_page_token;
  const nextPageToken =
    body.has_more === true && isString(token) && token.length > 0 && token.length <= 512 ? token : null;
  return { voices, nextPageToken };
}
