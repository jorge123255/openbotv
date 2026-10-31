import { avatarCharacter, avatarCharacterSeed, bloubAvatarProfile } from "@openbot/brand/bloub-avatar";
import { isAvatarSeed } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { createAvatarCandidates } from "./avatar-candidates";

describe("mobile character identity", () => {
  it("restores the same shape, expression and stored hue after each character choice", () => {
    const seed = "mobile:synthetic-agent";
    const original = bloubAvatarProfile(seed, 280);
    for (const kind of ["robot", "orb", "shape"] as const) {
      const selected = avatarCharacterSeed(seed, kind);
      expect(selected).not.toBeNull();
      if (selected === null) throw new Error("Expected a valid synthetic seed.");
      expect(avatarCharacter(selected)).toEqual({ kind, seed });
      expect(bloubAvatarProfile(selected, 280)).toEqual(original);
      expect(avatarCharacterSeed(selected, "shape")).toBe(seed);
      const reopened = JSON.parse(JSON.stringify({ avatarSeed: selected, avatarHue: 280 }));
      expect(bloubAvatarProfile(reopened.avatarSeed, reopened.avatarHue)).toEqual(original);
    }
  });

  it("keeps the original base choice available when a saved character returns to Shapes", () => {
    const seed = "mobile:synthetic-agent";
    const selected = `character:robot:${seed}`;
    const candidates = createAvatarCandidates(selected);
    expect(candidates.seeds[0]).toBe(avatarCharacterSeed(selected, "shape"));
    expect(candidates.seeds).toHaveLength(12);
    expect(candidates.seeds.every((value) => isAvatarSeed(value) && avatarCharacter(value).kind === "shape")).toBe(
      true,
    );
    const shuffled = createAvatarCandidates(selected, candidates);
    expect(shuffled.namespace).toBe(candidates.namespace);
    expect(shuffled.batch).toBe(1);
    expect(shuffled.seeds[0]).toBe(seed);
    expect(shuffled.seeds.slice(1)).not.toEqual(candidates.seeds.slice(1));
  });

  it("keeps a long legacy seed unchanged and offers valid replacement shapes", () => {
    const seed = "a".repeat(128);
    expect(isAvatarSeed(seed)).toBe(true);
    expect(avatarCharacterSeed(seed, "robot")).toBeNull();
    expect(avatarCharacterSeed(seed, "orb")).toBeNull();
    const candidates = createAvatarCandidates(seed);
    expect(candidates.seeds[0]).toBe(seed);
    expect(candidates.seeds.every(isAvatarSeed)).toBe(true);
    for (const replacement of candidates.seeds.slice(1)) {
      expect(avatarCharacterSeed(replacement, "robot")).not.toBeNull();
      expect(avatarCharacterSeed(replacement, "orb")).not.toBeNull();
    }
  });

  it("treats an incomplete character prefix as the original opaque shape identity", () => {
    const seed = "character:robot:";
    expect(avatarCharacter(seed)).toEqual({ kind: "shape", seed });
    expect(createAvatarCandidates(seed).seeds[0]).toBe(seed);
    expect(createAvatarCandidates(seed).seeds.every((value) => avatarCharacter(value).kind === "shape")).toBe(true);
  });
});
