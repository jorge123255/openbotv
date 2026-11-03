import { BloubBot } from "@norbert_bodziony/bloub";
import { type AvatarCharacter, bloubAvatarProfile } from "@openbot/brand/bloub-avatar";
import type { AvatarHue } from "@openbot/contracts/ipc";
import { render } from "@solidjs/web";
import { flush } from "solid-js";
import { CharacterAvatar } from "./features/agents/CharacterAvatar";

/**
 * When an avatar animates, which is a performance decision and not a state one: `hover` and `idle`
 * rest until a pointer or focus reaches them, `always` runs. What the avatar *expresses* is its
 * `AvatarMood` - see `@openbot/brand/bloub-avatar-motion`.
 */
export type AvatarMotion = "hover" | "always" | "idle";
export {
  AVATAR_HUE_CHOICES,
  AVATAR_HUE_OPTIONS,
  avatarCandidateSeeds,
  avatarHeadColor,
  avatarHueSwatch,
  type BloubAvatarProfile,
  bloubAvatarProfile,
  type SupportedAvatarSilhouetteId,
} from "@openbot/brand/bloub-avatar";
export {
  type AvatarMood,
  avatarMoodIsBusy,
  avatarMoodPresentation,
  SHAPE_SAFE_STATES,
  type ShapeSafeStateId,
} from "@openbot/brand/bloub-avatar-motion";

export function createStaticAvatarSvg(
  seed: string,
  hue: AvatarHue | null,
  character: AvatarCharacter = "shape",
): SVGSVGElement {
  if (character !== "shape") {
    const host = document.createElement("span");
    host.style.cssText = "position:fixed;left:-10000px;visibility:hidden";
    document.body.appendChild(host);
    const kind = character;
    const dispose = render(
      () => <CharacterAvatar kind={kind} seed={seed} hue={hue} mood="idle" motion="idle" followPointer={false} />,
      host,
    );
    try {
      flush();
      const source = host.querySelector("svg");
      if (!source) throw new Error("Character did not render an SVG avatar.");
      // Mentions and exported cards need a self-contained still image, including semantic colors.
      for (const node of source.querySelectorAll<SVGElement>("*")) {
        const computed = getComputedStyle(node);
        for (const property of [
          "fill",
          "stroke",
          "stroke-width",
          "opacity",
          "transform",
          "stop-color",
          "stroke-linecap",
          "stroke-linejoin",
        ])
          node.style.setProperty(property, computed.getPropertyValue(property));
      }
      const result = source.cloneNode(true);
      if (!(result instanceof SVGSVGElement)) throw new Error("Character did not clone an SVG avatar.");
      return result;
    } finally {
      dispose();
      host.remove();
    }
  }
  const host = document.createElement("span");
  const dispose = mountStaticAvatar(host, seed, hue);
  const svg = host.querySelector("svg");
  if (!svg) {
    dispose();
    throw new Error("Bloub did not render an SVG avatar.");
  }
  const result = svg.cloneNode(true);
  if (!(result instanceof SVGSVGElement)) {
    dispose();
    throw new Error("Bloub did not clone an SVG avatar.");
  }
  dispose();
  return result;
}

function mountStaticAvatar(host: HTMLElement, seed: string, hue: AvatarHue | null): () => void {
  const profile = bloubAvatarProfile(seed, hue);
  const dispose = render(
    () => (
      <BloubBot
        size={100}
        shape={profile.shape}
        color={profile.color}
        expression={profile.expression}
        frozenAt={0}
        ariaLabel=""
      />
    ),
    host,
  );
  flush();
  const svg = host.querySelector("svg");
  if (!svg) {
    dispose();
    throw new Error("Bloub did not render an SVG avatar.");
  }
  svg.removeAttribute("role");
  svg.removeAttribute("aria-label");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  return dispose;
}
