import { createEffect, createSignal, flush, onCleanup, Show } from "solid-js";
import { APP_LOGO_CORNER, APP_LOGO_EYE_POINTS, APP_LOGO_SIZE } from "./app-logo-shape";

export type AppLogoAnimation = "none" | "blink" | "look-around" | "surprised";
export type AppLogoVariant = "production" | "dev" | "preview";

export interface AppLogoProps {
  variant: AppLogoVariant;
  artwork?: "upstream" | "botai";
  label?: string;
  animation?: AppLogoAnimation;
  interactive?: boolean;
  /**
   * An element around an interactive logo, such as a hero panel. The eyes follow the pointer anywhere
   * on it, and a click on it counts as a click on the logo. The logo stays the one control for the
   * keyboard and for screen readers.
   */
  pointerArea?: HTMLElement | undefined;
  class?: string;
}

/** How far the eyes move, as a share of the logo, when the pointer is at the edge of the area. */
const EYE_RANGE = { x: 2.4, y: 1.8 };
/** A larger area gives the eyes more room: the pointer can be far from the logo. */
const AREA_EYE_RANGE = { x: 9, y: 7 };

export function AppLogo(props: AppLogoProps) {
  const [clickReaction, setClickReaction] = createSignal(false);
  const [easterEgg, setEasterEgg] = createSignal(false);
  const className = () => ["app-logo", props.class].filter(Boolean).join(" ");
  const animation = () => props.animation ?? "none";
  let clickReactionTimer: number | undefined;
  let easterEggTimer: number | undefined;
  let logoElement: SVGSVGElement | undefined;
  let rapidClicks: number[] = [];

  function shouldReduceMotion(): boolean {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  }

  function setEyePosition(x: number, y: number): void {
    const range = props.pointerArea ? AREA_EYE_RANGE : EYE_RANGE;
    logoElement?.style.setProperty("--app-logo-eye-x", `${x * range.x}%`);
    logoElement?.style.setProperty("--app-logo-eye-y", `${y * range.y}%`);
  }

  function resetEyePosition(): void {
    setEyePosition(0, 0);
  }

  /** The eyes look at the pointer. Its distance is measured against the logo, or against the area. */
  function lookAt(event: PointerEvent, area: Element): void {
    if (!props.interactive || shouldReduceMotion()) return;
    if (event.pointerType && event.pointerType !== "mouse") return;
    const logo = logoElement?.getBoundingClientRect();
    if (!logo) return;
    const bounds = area.getBoundingClientRect();
    const centerX = logo.left + logo.width / 2;
    const centerY = logo.top + logo.height / 2;
    // From the centre of the logo to the far edge of the area is the full range.
    const reachX = Math.max(centerX - bounds.left, bounds.right - centerX);
    const reachY = Math.max(centerY - bounds.top, bounds.bottom - centerY);
    const x = Math.max(-1, Math.min(1, (event.clientX - centerX) / reachX));
    const y = Math.max(-1, Math.min(1, (event.clientY - centerY) / reachY));
    setEyePosition(x, y);
  }

  function handlePointerMove(event: PointerEvent): void {
    if (!props.pointerArea && logoElement) lookAt(event, logoElement);
  }

  function handlePointerLeave(): void {
    if (!props.pointerArea) resetEyePosition();
  }

  function triggerClickReaction(): void {
    if (!props.interactive || shouldReduceMotion()) return;
    window.clearTimeout(clickReactionTimer);
    flush(() => setClickReaction(false));
    void logoElement?.getBoundingClientRect();
    flush(() => setClickReaction(true));
    clickReactionTimer = window.setTimeout(() => setClickReaction(false), 360);
  }

  function registerRapidClick(): void {
    if (!props.interactive || shouldReduceMotion()) return;
    const now = performance.now();
    rapidClicks = [...rapidClicks.filter((time) => now - time < 900), now];
    if (rapidClicks.length < 5) return;

    rapidClicks = [];
    window.clearTimeout(easterEggTimer);
    flush(() => setEasterEgg(false));
    void logoElement?.getBoundingClientRect();
    flush(() => setEasterEgg(true));
    easterEggTimer = window.setTimeout(() => setEasterEgg(false), 1200);
  }

  function handleClick(): void {
    triggerClickReaction();
    registerRapidClick();
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    triggerClickReaction();
  }

  createEffect(
    () => props.pointerArea,
    (area) => {
      if (!area) return;
      const handleAreaPointerMove = (event: PointerEvent) => lookAt(event, area);
      // A click on the logo itself already reached `handleClick`.
      const handleAreaClick = (event: MouseEvent) => {
        if (event.target instanceof Node && logoElement?.contains(event.target)) return;
        handleClick();
      };
      area.addEventListener("pointermove", handleAreaPointerMove);
      area.addEventListener("pointerleave", resetEyePosition);
      area.addEventListener("click", handleAreaClick);
      return () => {
        area.removeEventListener("pointermove", handleAreaPointerMove);
        area.removeEventListener("pointerleave", resetEyePosition);
        area.removeEventListener("click", handleAreaClick);
      };
    },
  );

  onCleanup(() => {
    globalThis.clearTimeout(clickReactionTimer);
    globalThis.clearTimeout(easterEggTimer);
  });

  return (
    <svg
      ref={(element) => (logoElement = element)}
      class={className()}
      data-artwork={props.artwork}
      data-animation={animation()}
      data-click-reaction={clickReaction() ? "wink" : undefined}
      data-easter-egg={easterEgg() ? "party" : undefined}
      data-interactive={props.interactive ? "true" : undefined}
      data-variant={props.variant}
      viewBox={`0 0 ${APP_LOGO_SIZE} ${APP_LOGO_SIZE}`}
      aria-hidden={props.interactive ? undefined : "true"}
      aria-label={props.interactive ? (props.label ?? "Animate OpenBot logo") : undefined}
      role={props.interactive ? "button" : undefined}
      tabindex={props.interactive ? 0 : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onPointerLeave={handlePointerLeave}
      onPointerMove={handlePointerMove}
    >
      <Show
        when={props.artwork === "botai"}
        fallback={
          <>
            <rect
              class="app-logo-background"
              width={APP_LOGO_SIZE}
              height={APP_LOGO_SIZE}
              rx={APP_LOGO_CORNER}
              ry={APP_LOGO_CORNER}
            />
            <g class="app-logo-eye-motion">
              <polyline class="app-logo-eye app-logo-eye-left" points={APP_LOGO_EYE_POINTS.left} />
            </g>
            <g class="app-logo-eye-motion">
              <polyline class="app-logo-eye app-logo-eye-right" points={APP_LOGO_EYE_POINTS.right} />
            </g>
          </>
        }
      >
        <BotAiGlyph color="var(--app-logo-background)" />
      </Show>
    </svg>
  );
}

function BotAiGlyph(props: { color: string }) {
  return (
    <>
      <path
        d="M 60 186 V 66 Q 60 30 102 30 H 132 Q 192 30 192 78 Q 192 120 138 120 H 102 Q 54 120 54 162 Q 54 210 120 210 H 144 Q 204 210 204 162 Q 204 120 144 120"
        fill="none"
        stroke={props.color}
        stroke-width="30"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <g class="app-logo-eye-motion">
        <circle class="app-logo-botai-eye app-logo-eye-left" cx="108" cy="72" r="12" fill={props.color} />
      </g>
      <g class="app-logo-eye-motion">
        <circle class="app-logo-botai-eye app-logo-eye-right" cx="138" cy="162" r="12" fill={props.color} />
      </g>
    </>
  );
}

/** BotAI's linked B is GUI brand artwork. The upstream app icon stays in AppLogo. */
export function BotAiMark(props: { variant: AppLogoVariant; class?: string }) {
  return (
    <svg
      class={props.class}
      data-variant={props.variant}
      viewBox={`0 0 ${APP_LOGO_SIZE} ${APP_LOGO_SIZE}`}
      fill="none"
      aria-hidden="true"
    >
      <BotAiGlyph color="currentColor" />
    </svg>
  );
}
