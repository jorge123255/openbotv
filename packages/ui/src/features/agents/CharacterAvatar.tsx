import { type AvatarCharacter, avatarHeadColor } from "@openbot/brand/bloub-avatar";
import { type AvatarMood, avatarMoodIsBusy } from "@openbot/brand/bloub-avatar-motion";
import type { AvatarHue } from "@openbot/contracts/ipc";
import { prefersReducedMotion } from "@openbot/ui/utils";
import { createSignal, createUniqueId, Match, onSettled, Show, Switch } from "solid-js";
import type { AvatarMotion } from "../../bloub-avatar";

const pointerListeners = new Set<(event: PointerEvent) => void>();
const dispatchPointer = (event: PointerEvent) => {
  for (const listener of pointerListeners) listener(event);
};
function watchCharacterPointer(listener: (event: PointerEvent) => void): () => void {
  if (pointerListeners.size === 0) window.addEventListener("pointermove", dispatchPointer, { passive: true });
  pointerListeners.add(listener);
  return () => {
    pointerListeners.delete(listener);
    if (pointerListeners.size === 0) window.removeEventListener("pointermove", dispatchPointer);
  };
}

/** A code-drawn character. Its saved identity and hue are independent of its current pose. */
export function CharacterAvatar(props: {
  kind: Exclude<AvatarCharacter, "shape">;
  seed: string;
  hue: AvatarHue | null;
  mood: AvatarMood;
  motion: AvatarMotion;
  followPointer: boolean;
  class?: string;
  style?: Record<string, string>;
}) {
  let root: HTMLSpanElement | undefined;
  const id = createUniqueId();
  const [reduced, setReduced] = createSignal(prefersReducedMotion());
  const [visible, setVisible] = createSignal(true);
  const [interacting, setInteracting] = createSignal(false);
  const [awakeWindow, setAwakeWindow] = createSignal(true);
  const [gaze, setGaze] = createSignal({ x: 0, y: 0 });
  const moving = () =>
    !reduced() &&
    visible() &&
    awakeWindow() &&
    (props.motion === "always" || avatarMoodIsBusy(props.mood) || interacting());
  const organic = () => props.kind !== "robot" && props.kind !== "orb";
  const mouth = () => {
    switch (props.mood) {
      case "asleep":
        return "M 75 76 L 85 76";
      case "failed":
        return "M 70 79 Q 80 69 90 79";
      case "waiting":
        return "M 77 74 Q 86 69 87 76 Q 86 83 79 80 Q 75 78 77 74";
      case "responded":
        return "M 67 72 Q 80 92 93 72";
      case "working":
        return "M 72 75 Q 80 81 88 75";
      case "connecting":
        return "M 75 75 Q 80 69 85 75 Q 80 83 75 75";
      default:
        return "M 70 74 Q 80 85 90 74";
    }
  };
  const look = (event: PointerEvent) => {
    if (reduced() || !visible() || !awakeWindow() || event.pointerType === "touch") return;
    const box = root?.getBoundingClientRect();
    if (!box) return;
    if (!box.width || !box.height) return;
    const x = Math.max(-1, Math.min(1, (event.clientX - box.x - box.width / 2) / 240));
    const y = Math.max(-1, Math.min(1, (event.clientY - box.y - box.height / 2) / 240));
    setGaze({ x: x * 5, y: y * 3 });
  };
  onSettled(() => {
    const element = root;
    if (!element) return;
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const sync = () => {
      setReduced(media?.matches ?? false);
      if (media?.matches) {
        setGaze({ x: 0, y: 0 });
      }
    };
    const windowVisibility = () => setAwakeWindow(document.visibilityState !== "hidden");
    const target = element.closest("[data-avatar-hover], button, a, [role='button']") ?? element;
    const enter = () => setInteracting(true);
    const leave = () => setInteracting(false);
    const focus = (event: Event) => {
      if (event.target instanceof Element && event.target.matches(":focus-visible")) enter();
    };
    const observer = window.IntersectionObserver
      ? new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false))
      : undefined;
    observer?.observe(element);
    sync();
    windowVisibility();
    media?.addEventListener("change", sync);
    document.addEventListener("visibilitychange", windowVisibility);
    target.addEventListener("pointerenter", enter);
    target.addEventListener("pointerleave", leave);
    target.addEventListener("focusin", focus);
    target.addEventListener("focusout", leave);
    const stopFollowing = watchCharacterPointer((event) => {
      if (props.followPointer) look(event);
    });
    const localLook = (event: PointerEvent) => {
      if (!props.followPointer) look(event);
    };
    element.addEventListener("pointermove", localLook, { passive: true });
    return () => {
      observer?.disconnect();
      stopFollowing();
      media?.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", windowVisibility);
      target.removeEventListener("pointerenter", enter);
      target.removeEventListener("pointerleave", leave);
      target.removeEventListener("focusin", focus);
      target.removeEventListener("focusout", leave);
      element.removeEventListener("pointermove", localLook);
    };
  });
  return (
    <span
      ref={root}
      class={`${props.class ?? ""} agent-avatar-character`}
      data-character={props.kind}
      data-avatar="character"
      data-mood={props.mood}
      data-moving={moving() ? "" : undefined}
      aria-hidden="true"
      style={{
        ...props.style,
        "--character-color": avatarHeadColor(props.seed, props.hue),
        "--character-look-x": `${gaze().x}px`,
        "--character-look-y": `${gaze().y}px`,
      }}
    >
      <svg viewBox="0 0 160 160" class="character-svg" aria-hidden="true">
        <defs>
          <linearGradient id={`${id}-shell`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="var(--openbot-character-shell)" />
            <stop offset="1" stop-color="var(--character-color)" />
          </linearGradient>
          <linearGradient id={`${id}-visor`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="var(--openbot-character-visor)" />
            <stop offset="1" stop-color="var(--character-color)" />
          </linearGradient>
        </defs>
        <ellipse class="character-shadow" cx="80" cy="148" rx="38" ry="6" />
        <g class="character-body">
          <Show
            when={props.kind === "robot"}
            fallback={
              // Character silhouettes are brand artwork, not interface icons.
              <g
                class="character-soft-shell"
                fill={`url(#${id}-shell)`}
                stroke="var(--character-color)"
                stroke-width="2"
              >
                <Switch fallback={<circle cx="80" cy="77" r="57" />}>
                  <Match when={props.kind === "pebble"}>
                    <path d="M 25 91 C 18 66 39 35 63 31 C 95 23 124 45 134 72 C 148 109 116 135 80 136 C 48 139 20 122 25 91 Z" />
                    <ellipse
                      class="character-soft-highlight"
                      cx="52"
                      cy="51"
                      rx="13"
                      ry="6"
                      transform="rotate(-30 52 51)"
                    />
                  </Match>
                  <Match when={props.kind === "wisp"}>
                    <path d="M 35 77 C 17 61 32 33 55 40 C 61 15 99 13 111 39 C 139 33 150 69 130 83 C 146 107 123 131 104 120 C 92 144 62 138 58 122 C 28 137 13 105 35 90 Z" />
                  </Match>
                  <Match when={props.kind === "sprout"}>
                    <g class="character-leaves">
                      <path d="M 80 44 C 48 45 43 23 43 17 C 64 14 79 21 80 44 Z" />
                      <path d="M 80 44 C 79 15 101 9 117 11 C 116 31 103 43 80 44 Z" />
                    </g>
                    <path d="M 80 40 C 115 40 137 77 128 108 C 120 137 40 137 32 108 C 23 77 45 40 80 40 Z" />
                  </Match>
                  <Match when={props.kind === "comet"}>
                    <path class="character-tail" d="M 59 108 Q 30 135 12 122 Q 18 149 55 142 Q 78 138 89 113 Z" />
                    <circle cx="84" cy="76" r="54" />
                    <path
                      d="M 45 50 Q 56 33 73 32"
                      fill="none"
                      stroke="var(--openbot-character-shell)"
                      stroke-width="7"
                      stroke-linecap="round"
                    />
                  </Match>
                </Switch>
              </g>
            }
          >
            <g class="character-limb character-arm-left">
              <path d="M 58 109 Q 36 102 32 120" />
              <circle cx="32" cy="123" r="8" />
            </g>
            <g class="character-limb character-arm-right">
              <path d="M 103 109 Q 122 104 126 90" />
              <path
                class="character-hand"
                d="M 120 89 L 121 79 Q 123 75 126 80 L 129 88 L 134 81 Q 139 78 139 84 L 137 97 Q 135 105 127 103 Z"
              />
            </g>
            <path
              class="character-torso"
              d="M 61 101 Q 80 93 99 101 L 107 135 Q 80 148 53 135 Z"
              fill={`url(#${id}-shell)`}
            />
            <path class="character-chest" d="M 68 112 Q 80 106 92 112 L 95 129 Q 80 136 65 129 Z" />
            <path class="character-feet" d="M 63 135 L 61 144 M 97 135 L 99 144" />
            <g class="character-head">
              <path class="character-antenna" d="M 80 30 L 80 17" />
              <circle class="character-antenna-tip" cx="80" cy="12" r="7" />
              <rect class="character-ear" x="22" y="48" width="13" height="36" rx="6" />
              <rect class="character-ear" x="125" y="48" width="13" height="36" rx="6" />
              <rect
                x="31"
                y="28"
                width="98"
                height="77"
                rx="32"
                fill={`url(#${id}-shell)`}
                stroke="var(--character-color)"
                stroke-width="2"
              />
            </g>
          </Show>
          <g class="character-face" data-organic={organic() ? "" : undefined}>
            <Show when={!organic()}>
              <rect x="43" y="44" width="74" height="46" rx="21" fill={`url(#${id}-visor)`} />
            </Show>
            <g class="character-gaze">
              <g class="character-eyes">
                <Show
                  when={props.mood !== "asleep"}
                  fallback={<path class="character-sleep-eyes" d="M 57 62 Q 63 68 69 62 M 91 62 Q 97 68 103 62" />}
                >
                  <ellipse cx="63" cy="61" rx={props.kind === "pebble" ? 4 : 6} ry={props.mood === "waiting" ? 9 : 7} />
                  <ellipse cx="97" cy="61" rx={props.kind === "pebble" ? 4 : 6} ry={props.mood === "failed" ? 5 : 7} />
                </Show>
              </g>
              <path class="character-mouth" d={mouth()} />
              <path class="character-cheeks" d="M 54 74 L 59 75 M 101 75 L 106 74" />
            </g>
          </g>
          <Show when={props.mood === "working" || props.mood === "connecting"}>
            <g class="character-sparks">
              <circle cx="18" cy="37" r="3" />
              <circle cx="141" cy="41" r="2" />
              <path d="M 137 22 V 32 M 132 27 H 142" />
            </g>
          </Show>
        </g>
      </svg>
    </span>
  );
}
