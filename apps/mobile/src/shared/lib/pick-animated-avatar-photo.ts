import { isValidAvatarImage } from "@openbot/contracts/avatar-images";
import { AVATAR_IMAGE_LIMITS } from "@openbot/contracts/input-limits";
import { bytesToBase64 } from "@openbot/team-client/base64";
import * as DocumentPicker from "expo-document-picker";
import { File, FileMode } from "expo-file-system";
import type { AvatarPhoto } from "./pick-avatar-photo";
import { currentText } from "./text";

interface AnimatedAvatarPhoto extends Omit<AvatarPhoto, "mimeType"> {
  mimeType: "image/webp";
}

/** Imports the original WebP bytes. No crop, image decoder or encoder runs on this path. */
export async function pickAnimatedAvatarPhoto(): Promise<AnimatedAvatarPhoto | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: "image/webp",
    multiple: false,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) invalidImage();
  const file = new File(asset.uri);
  const limit = AVATAR_IMAGE_LIMITS.storedBytes;
  if ((asset.size ?? 0) > limit || file.size > limit) tooManyBytes();

  // Do not trust picker metadata or read the file again for base64. A growing file stays bounded.
  const buffer = new Uint8Array(limit + 1);
  const handle = file.open(FileMode.ReadOnly);
  let length = 0;
  try {
    while (length < buffer.length) {
      const part = await handle.readBytes(Math.min(64 * 1024, buffer.length - length));
      if (part.length === 0) break;
      buffer.set(part, length);
      length += part.length;
    }
  } finally {
    handle.close();
  }
  if (length > limit) tooManyBytes();
  const bytes = buffer.subarray(0, length);
  checkAnimation(bytes);
  const base64 = bytesToBase64(bytes);
  // Preview exactly the bytes that Save uploads, even if the picker cache later changes.
  return { uri: `data:image/webp;base64,${base64}`, name: "avatar.webp", mimeType: "image/webp", bytes, base64 };
}

/** Checks container bounds, not the compressed pixel bitstream. Native decoding can still fail. */
function checkAnimation(bytes: Uint8Array) {
  if (!isValidAvatarImage("image/webp", bytes) || bytes.length < 30) invalidImage();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) invalidImage();
  const chunks = webpChunks(bytes, view, 12, bytes.length);
  const header = chunks.next().value;
  if (header?.tag !== "VP8X" || header.end - header.start !== 10 || !((bytes[20] ?? 0) & 0x02)) invalidImage();
  const width = u24(bytes, 24) + 1;
  const height = u24(bytes, 27) + 1;
  if (width > AVATAR_IMAGE_LIMITS.outputPixels || height > AVATAR_IMAGE_LIMITS.outputPixels)
    throw new Error(currentText().t("mobile.agent.photo.animationDimensions"));
  let animation = false;
  let frames = 0;
  for (const chunk of chunks) {
    if (chunk.tag === "VP8X" || chunk.tag === "VP8 " || chunk.tag === "VP8L") invalidImage();
    if (chunk.tag === "ANIM") {
      if (animation || chunk.end - chunk.start !== 6) invalidImage();
      animation = true;
    }
    if (chunk.tag !== "ANMF") continue;
    if (!animation || chunk.end - chunk.start < 24) invalidImage();
    const x = u24(bytes, chunk.start) * 2;
    const y = u24(bytes, chunk.start + 3) * 2;
    if (x + u24(bytes, chunk.start + 6) + 1 > width || y + u24(bytes, chunk.start + 9) + 1 > height) invalidImage();
    let pixels = false;
    for (const frame of webpChunks(bytes, view, chunk.start + 16, chunk.end)) {
      if (frame.tag !== "VP8 " && frame.tag !== "VP8L") continue;
      if (pixels || frame.start === frame.end) invalidImage();
      pixels = true;
    }
    if (!pixels) invalidImage();
    frames += 1;
  }
  if (!animation || frames === 0) invalidImage();
}

function* webpChunks(bytes: Uint8Array, view: DataView, start: number, end: number) {
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) invalidImage();
    const size = view.getUint32(offset + 4, true);
    const next = offset + 8 + size;
    const padded = next + (size % 2);
    if (padded > end || (size % 2 !== 0 && bytes[next] !== 0)) invalidImage();
    yield { tag: String.fromCharCode(...bytes.subarray(offset, offset + 4)), start: offset + 8, end: next };
    offset = padded;
  }
}

function u24(bytes: Uint8Array, offset: number) {
  return (bytes[offset] ?? 0) + (bytes[offset + 1] ?? 0) * 256 + (bytes[offset + 2] ?? 0) * 65536;
}

function invalidImage(): never {
  throw new Error(currentText().t("mobile.agent.photo.animationInvalid"));
}

function tooManyBytes(): never {
  throw new Error(currentText().t("mobile.agent.photo.animationSize"));
}
