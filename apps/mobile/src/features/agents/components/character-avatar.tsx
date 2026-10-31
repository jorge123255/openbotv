import { type AvatarCharacter, avatarHeadColor } from "@openbot/brand/bloub-avatar";
import { type AvatarMood, avatarMoodIsBusy } from "@openbot/brand/bloub-avatar-motion";
import type { AvatarHue } from "@openbot/contracts/ipc";
import { useEffect, useId } from "react";
import { AppState } from "react-native";
import Animated, {
  type SharedValue,
  useAnimatedProps,
  useFrameCallback,
  useSharedValue,
} from "react-native-reanimated";
import Svg, { Circle, Defs, Ellipse, G, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import { useCSSVariable } from "uniwind";
import { useAppDrawerShownOnUI } from "@/features/servers/components/app-drawer-activity";
import { DISCONNECTED_APPEARANCE } from "@/features/workspace/components/use-connection-appearance";
import { useMotionPreference } from "@/shared/lib/motion";
import { isAndroid } from "@/shared/lib/platform";
import { useScreenFocusedWhile } from "@/shared/lib/use-screen-focused-while";
import { thumbnailColor } from "../model/avatar-color";

interface CharacterProps {
  kind: Exclude<AvatarCharacter, "shape">;
  seed: string;
  hue: AvatarHue | null;
  size?: number;
  mood?: AvatarMood;
  disconnected?: boolean;
  animateIdle?: boolean;
}

// G's setNativeProps accepts matrix. Its extension parameter exposes that native prop to Reanimated.
const AnimatedGroup = Animated.createAnimatedComponent(G<{ matrix?: number[] }>);

/** Native art for the characters selected on desktop, with no new stored fields. */
export function CharacterAvatar(props: CharacterProps) {
  const motion = useMotionPreference("agentFaces");
  const moving =
    motion && !props.disconnected && (props.animateIdle !== false || avatarMoodIsBusy(props.mood ?? "idle"));
  const focused = useScreenFocusedWhile(moving);
  const clock = useSharedValue(0);
  const elapsed = useSharedValue(0);
  const drawerShown = useAppDrawerShownOnUI();
  const frame = useFrameCallback(({ timeSincePreviousFrame }) => {
    if (isAndroid && drawerShown.get()) return;
    const delta = Math.min(timeSincePreviousFrame ?? 0, 64);
    elapsed.set(elapsed.get() + delta);
    // Android redraws an SVG in software. Use the same 30 fps limit as shapes.
    if (isAndroid && elapsed.get() < 1000 / 30) return;
    clock.set(clock.get() + elapsed.get() / 1000);
    elapsed.set(0);
  }, false);
  useEffect(() => {
    const update = () => {
      frame.setActive(moving && focused && AppState.currentState === "active");
      clock.set(0);
      elapsed.set(0);
    };
    update();
    const subscription = AppState.addEventListener("change", update);
    return () => {
      subscription.remove();
      frame.setActive(false);
    };
  }, [clock, elapsed, focused, frame, moving]);
  return <CharacterArt {...props} clock={clock} />;
}

/** Picker thumbnails do not start an animation clock or subscribe to app activity. */
export function CharacterAvatarThumbnail(props: CharacterProps) {
  return <CharacterArt {...props} />;
}

function CharacterArt({
  kind,
  seed,
  hue,
  size = 48,
  mood = "idle",
  disconnected = false,
  clock,
}: CharacterProps & { clock?: SharedValue<number> }) {
  const id = `character-${useId().replaceAll(":", "")}`;
  const tokens = useCSSVariable([
    "--openbot-character-shell",
    "--openbot-character-visor",
    "--openbot-character-eye",
    "--openbot-danger",
  ]);
  const color = thumbnailColor(avatarHeadColor(seed, hue), disconnected);
  const shell = thumbnailColor(String(tokens[0]), disconnected);
  const visor = thumbnailColor(String(tokens[1]), disconnected);
  const eye = thumbnailColor(String(tokens[mood === "failed" ? 3 : 2]), disconnected);
  const armAngle = mood === "working" ? 32 : mood === "failed" || mood === "asleep" ? 48 : mood === "waiting" ? -16 : 0;
  const bodyProps = useAnimatedProps(() => ({
    matrix: [1, 0, 0, 1, 0, -2 * (1 - Math.cos(((clock?.get() ?? 0) * Math.PI) / 2))],
  }));
  const eyeProps = useAnimatedProps(() => {
    const phase = ((clock?.get() ?? 0) % 5.6) / 5.6;
    const scale = phase > 0.42 && phase < 0.46 ? 1 - (1 - Math.abs(phase - 0.44) / 0.02) * 0.88 : 1;
    return { matrix: [1, 0, 0, scale, 0, 61 * (1 - scale)] };
  });
  const armProps = useAnimatedProps(() => {
    const seconds = clock?.get() ?? 0;
    const degrees =
      armAngle +
      (clock
        ? mood === "working"
          ? Math.sin((seconds * Math.PI * 2) / 1.1) * 6
          : mood === "idle"
            ? Math.sin((seconds * Math.PI * 2) / 5) * 10
            : 0
        : 0);
    const angle = (degrees * Math.PI) / 180;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return { matrix: [c, s, -s, c, 103 - c * 103 + s * 109, 109 - s * 103 - c * 109] };
  });
  return (
    <Svg
      accessibilityElementsHidden
      accessible={false}
      pointerEvents="none"
      width={size}
      height={size}
      viewBox="0 0 160 160"
      opacity={disconnected ? DISCONNECTED_APPEARANCE.opacity : 1}
    >
      <Defs>
        <LinearGradient id={`${id}-shell`} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={shell} />
          <Stop offset="1" stopColor={color} />
        </LinearGradient>
        <LinearGradient id={`${id}-visor`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={visor} />
          <Stop offset="1" stopColor={color} />
        </LinearGradient>
      </Defs>
      <AnimatedGroup animatedProps={bodyProps} opacity={mood === "asleep" ? 0.65 : 1}>
        {kind === "robot" ? (
          <>
            <G
              fill={color}
              stroke={color}
              strokeWidth={9}
              strokeLinecap="round"
              strokeLinejoin="round"
              transform={mood === "working" ? "rotate(-28 58 109)" : undefined}
            >
              <Path d="M 58 109 Q 36 102 32 120" fill="none" />
              <Circle cx={32} cy={123} r={8} />
            </G>
            <AnimatedGroup
              animatedProps={armProps}
              transform={`rotate(${armAngle} 103 109)`}
              fill={color}
              stroke={color}
              strokeWidth={9}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <Path d="M 103 109 Q 122 104 126 90" fill="none" />
              <Path
                d="M 120 89 L 121 79 Q 123 75 126 80 L 129 88 L 134 81 Q 139 78 139 84 L 137 97 Q 135 105 127 103 Z"
                strokeWidth={3}
              />
            </AnimatedGroup>
            <Path d="M 61 101 Q 80 93 99 101 L 107 135 Q 80 148 53 135 Z" fill={`url(#${id}-shell)`} />
            <Path d="M 68 112 Q 80 106 92 112 L 95 129 Q 80 136 65 129 Z" fill={color} opacity={0.7} />
            <Path
              d="M 63 135 L 61 144 M 97 135 L 99 144 M 80 30 L 80 17"
              fill="none"
              stroke={color}
              strokeWidth={5}
              strokeLinecap="round"
            />
            <Circle cx={80} cy={12} r={7} fill={color} />
            <Rect x={22} y={48} width={13} height={36} rx={6} fill={color} />
            <Rect x={125} y={48} width={13} height={36} rx={6} fill={color} />
            <Rect
              x={31}
              y={28}
              width={98}
              height={77}
              rx={32}
              fill={`url(#${id}-shell)`}
              stroke={color}
              strokeWidth={2}
            />
          </>
        ) : (
          <Circle cx={80} cy={77} r={57} fill={`url(#${id}-shell)`} stroke={color} strokeWidth={3} />
        )}
        <G transform={kind === "orb" ? "translate(0 10)" : undefined}>
          <Rect x={43} y={44} width={74} height={46} rx={21} fill={`url(#${id}-visor)`} />
          <AnimatedGroup animatedProps={eyeProps} fill={eye}>
            {mood === "asleep" ? (
              <Path
                d="M 57 62 Q 63 68 69 62 M 91 62 Q 97 68 103 62"
                fill="none"
                stroke={eye}
                strokeWidth={3}
                strokeLinecap="round"
              />
            ) : (
              <>
                <Ellipse cx={63} cy={61} rx={6} ry={mood === "waiting" ? 9 : 7} />
                <Ellipse cx={97} cy={61} rx={6} ry={mood === "failed" ? 5 : 7} />
              </>
            )}
          </AnimatedGroup>
          <Path d={MOUTHS[mood]} fill="none" stroke={eye} strokeWidth={3} strokeLinecap="round" />
          <Path
            d="M 54 74 L 59 75 M 101 75 L 106 74"
            fill="none"
            stroke={color}
            strokeWidth={3}
            strokeLinecap="round"
          />
        </G>
        {avatarMoodIsBusy(mood) ? (
          <G fill={eye} stroke={eye} strokeWidth={2}>
            <Circle cx={18} cy={37} r={3} />
            <Circle cx={141} cy={41} r={2} />
            <Path d="M 137 22 V 32 M 132 27 H 142" />
          </G>
        ) : null}
      </AnimatedGroup>
    </Svg>
  );
}

const MOUTHS: Record<AvatarMood, string> = {
  asleep: "M 75 76 L 85 76",
  failed: "M 70 79 Q 80 69 90 79",
  waiting: "M 77 74 Q 86 69 87 76 Q 86 83 79 80 Q 75 78 77 74",
  responded: "M 67 72 Q 80 92 93 72",
  working: "M 72 75 Q 80 81 88 75",
  connecting: "M 75 75 Q 80 69 85 75 Q 80 83 75 75",
  idle: "M 70 74 Q 80 85 90 74",
};
