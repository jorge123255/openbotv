/** Native animation metadata from the synthetic sign-in fixture. */
export interface LogoAnimationRecord {
  type: "CSSTransition" | "CSSAnimation" | "Animation";
  animationName: string | null;
  transitionProperty: string | null;
  rootSvgTarget: boolean;
  rootFocused: boolean;
  focusVisible: boolean;
  pseudoElement: string | null;
  duration: number | null;
  activeDuration: number | null;
  endTime: number | null;
  delay: number | null;
  endDelay: number | null;
  iterationStart: number | null;
  iterations: number | null;
}

const FOCUS_SHADOW_MAX_MS = 0.01;
function microDuration(value: number | null): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= FOCUS_SHADOW_MAX_MS;
}

/** Allow only the measured keyboard focus ring; all other logo effects remain failures. */
function isLogoFocusShadowTransition(animation: LogoAnimationRecord): boolean {
  return (
    animation.type === "CSSTransition" &&
    animation.animationName === null &&
    animation.transitionProperty === "box-shadow" &&
    animation.rootSvgTarget === true &&
    animation.rootFocused === true &&
    animation.focusVisible === true &&
    animation.pseudoElement === null &&
    microDuration(animation.duration) &&
    microDuration(animation.activeDuration) &&
    microDuration(animation.endTime) &&
    animation.delay === 0 &&
    animation.endDelay === 0 &&
    animation.iterationStart === 0 &&
    animation.iterations === 1
  );
}

/** An empty list or the one measured focus transition is valid; mixed lists are not. */
export function logoAnimationsRespectReducedMotion(animations: readonly LogoAnimationRecord[]): boolean {
  return animations.length <= 1 && animations.every(isLogoFocusShadowTransition);
}
