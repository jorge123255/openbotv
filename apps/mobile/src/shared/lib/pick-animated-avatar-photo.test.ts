import { AVATAR_IMAGE_LIMITS } from "@openbot/contracts/input-limits";
import { base64ToBytes } from "@openbot/team-client/base64";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickAnimatedAvatarPhoto } from "./pick-animated-avatar-photo";

const native = vi.hoisted(() => ({
  pick: vi.fn(),
  construct: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  read: vi.fn<(length: number) => Promise<Uint8Array>>(),
  size: 0,
}));

vi.mock("expo-document-picker", () => ({ getDocumentAsync: native.pick }));
vi.mock("expo-file-system", () => ({
  FileMode: { ReadOnly: "r" },
  File: class {
    size = native.size;
    constructor(uri: string) {
      native.construct(uri);
    }
    open(mode: string) {
      native.open(mode);
      return { readBytes: native.read, close: native.close };
    }
  },
}));
vi.mock("./text", () => ({ currentText: () => ({ t: (key: string) => key }) }));

const INVALID = "mobile.agent.photo.animationInvalid";
const TOO_LARGE = "mobile.agent.photo.animationSize";
const DIMENSIONS = "mobile.agent.photo.animationDimensions";

function uint(value: number, length: number) {
  return Uint8Array.from({ length }, (_, index) => (value >>> (index * 8)) & 255);
}

function ascii(value: string) {
  return Uint8Array.from([...value].map((character) => character.charCodeAt(0)));
}

function concat(parts: readonly Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function chunk(tag: string, data: Uint8Array) {
  return concat([ascii(tag), uint(data.length, 4), data, new Uint8Array(data.length % 2)]);
}

/** Three original 1 × 1 VP8 frames, with distinct timing, blend and disposal values. */
function animation(width = 1, height = 1) {
  const still = base64ToBytes("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA");
  const data = concat([
    chunk("VP8X", concat([Uint8Array.of(0x02, 0, 0, 0), uint(width - 1, 3), uint(height - 1, 3)])),
    chunk("ANIM", Uint8Array.of(0, 0, 0, 0, 3, 0)),
    ...[0, 80, 160].map((duration, index) =>
      chunk("ANMF", concat([new Uint8Array(12), uint(duration, 3), Uint8Array.of(index), still.subarray(12)])),
    ),
  ]);
  return concat([ascii("RIFF"), uint(data.length + 4, 4), ascii("WEBP"), data]);
}

function select(bytes: Uint8Array, reportedSize = bytes.length) {
  native.size = reportedSize;
  native.pick.mockResolvedValue({
    canceled: false,
    assets: [{ uri: "file:///synthetic/avatar.webp", name: "avatar.webp", size: reportedSize, mimeType: "image/webp" }],
  });
  let offset = 0;
  native.read.mockImplementation(async (length) => {
    // Short reads exercise the adapter's complete, bounded copy.
    const part = bytes.slice(offset, offset + Math.min(length, 47));
    offset += part.length;
    return part;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  select(animation());
});

describe("original animated avatar import", () => {
  it("keeps all frame bytes, timing, loop count and type in the preview and upload", async () => {
    const bytes = animation();
    select(bytes);
    const original = bytes.slice();
    const photo = await pickAnimatedAvatarPhoto();
    expect(photo?.mimeType).toBe("image/webp");
    expect(photo?.bytes).toEqual(original);
    expect(base64ToBytes(photo?.base64 ?? "")).toEqual(original);
    expect(photo?.uri).toBe(`data:image/webp;base64,${photo?.base64}`);
    expect(bytes).toEqual(original);
    expect(native.close).toHaveBeenCalledOnce();
    expect(native.open).toHaveBeenCalledWith("r");
    expect(native.pick).toHaveBeenCalledWith({ type: "image/webp", multiple: false, copyToCacheDirectory: true });
  });

  it("returns no draft and reads no file when the picker is canceled", async () => {
    native.pick.mockResolvedValue({ canceled: true, assets: null });
    expect(await pickAnimatedAvatarPhoto()).toBeNull();
    expect(native.construct).not.toHaveBeenCalled();
    expect(native.read).not.toHaveBeenCalled();
  });

  it.each(["picker", "file"])("refuses oversized %s metadata before opening a file", async (owner) => {
    const bytes = animation();
    select(bytes, owner === "picker" ? AVATAR_IMAGE_LIMITS.storedBytes + 1 : bytes.length);
    native.size = owner === "file" ? AVATAR_IMAGE_LIMITS.storedBytes + 1 : bytes.length;
    await expect(pickAnimatedAvatarPhoto()).rejects.toThrow(TOO_LARGE);
    expect(native.open).not.toHaveBeenCalled();
  });

  it("bounds a file with false small metadata and closes it before refusing it", async () => {
    const bytes = new Uint8Array(AVATAR_IMAGE_LIMITS.storedBytes + 100);
    select(bytes, 1);
    let read = 0;
    native.read.mockImplementation(async (length) => {
      read += length;
      return new Uint8Array(length);
    });
    await expect(pickAnimatedAvatarPhoto()).rejects.toThrow(TOO_LARGE);
    expect(read).toBe(AVATAR_IMAGE_LIMITS.storedBytes + 1);
    expect(native.close).toHaveBeenCalledOnce();
  });

  it("accepts the exact stored-byte and canvas limits without resizing", async () => {
    const original = animation(512, 512);
    const padding = chunk("JUNK", new Uint8Array(AVATAR_IMAGE_LIMITS.storedBytes - original.length - 8));
    const bytes = concat([original, padding]);
    bytes.set(uint(bytes.length - 8, 4), 4);
    select(bytes);
    const photo = await pickAnimatedAvatarPhoto();
    expect(photo?.bytes).toEqual(bytes);
    expect(photo?.bytes.length).toBe(AVATAR_IMAGE_LIMITS.storedBytes);
  });

  it.each([
    [513, 1],
    [1, 513],
  ])("refuses a %i × %i canvas without dropping frames", async (width, height) => {
    select(animation(width, height));
    await expect(pickAnimatedAvatarPhoto()).rejects.toThrow(DIMENSIONS);
    expect(native.close).toHaveBeenCalledOnce();
  });

  it("rejects raw GIF and static WebP instead of flattening them", async () => {
    for (const bytes of [
      base64ToBytes("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
      base64ToBytes("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"),
    ]) {
      select(bytes);
      await expect(pickAnimatedAvatarPhoto()).rejects.toThrow(INVALID);
    }
  });

  it("refuses truncated, out-of-canvas and malformed animation containers", async () => {
    const original = animation();
    const wrongLength = original.slice();
    wrongLength.set(uint(original.length + 8, 4), 4);
    const outsideCanvas = original.slice();
    outsideCanvas[52] = 1; // First ANMF frame starts at X = 2, outside a 1-pixel canvas.
    const badChunkSize = original.slice();
    badChunkSize.set(uint(0xffffffff, 4), 48);
    const missingAnimationFlag = original.slice();
    missingAnimationFlag[20] = 0;
    for (const bytes of [original.subarray(0, 25), wrongLength, outsideCanvas, badChunkSize, missingAnimationFlag]) {
      select(bytes);
      await expect(pickAnimatedAvatarPhoto()).rejects.toThrow(INVALID);
    }
  });

  it("closes the selected file if a native read fails", async () => {
    native.read.mockRejectedValue(new Error("Synthetic read failure"));
    await expect(pickAnimatedAvatarPhoto()).rejects.toThrow("Synthetic read failure");
    expect(native.close).toHaveBeenCalledOnce();
  });
});
