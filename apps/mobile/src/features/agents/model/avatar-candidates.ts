import { avatarCandidateSeeds, avatarCharacter } from "@openbot/brand/bloub-avatar";

interface AvatarCandidates {
  namespace: string;
  batch: number;
  seeds: string[];
}

export function createAvatarCandidates(seed: string, previous?: AvatarCandidates): AvatarCandidates {
  // Leave room for the generated suffix even for a released 128-character seed.
  const base = avatarCharacter(seed).seed;
  // An incomplete reserved prefix is still a released opaque seed, not a character.
  const namespace = previous?.namespace ?? (base.startsWith("character:") ? `shape:${base}` : base).slice(0, 64);
  const batch = previous ? previous.batch + 1 : 0;
  return { namespace, batch, seeds: avatarCandidateSeeds(namespace, base, batch) };
}
