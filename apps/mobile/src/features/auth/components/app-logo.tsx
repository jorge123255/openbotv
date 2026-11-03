import { BOTAI_LOGO_EYES, BOTAI_LOGO_PATH } from "@openbot/brand/app-logo-shape";
import { Pressable, View } from "react-native";
import Animated from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import { useCSSVariable } from "uniwind";

import { type AppLogoAnimation, useAppLogoMotion } from "@/features/auth/components/use-app-logo-motion";
import { useText } from "@/shared/lib/text";

export interface AppLogoProps {
  animation?: AppLogoAnimation;
  interactive?: boolean;
  size?: number;
}

const VIEWBOX_SIZE = 240;
function resolveColor(value: string | number | undefined, fallback: string): string {
  return String(value ?? fallback);
}

export function AppLogo({ animation = "none", interactive = false, size = VIEWBOX_SIZE }: AppLogoProps) {
  const { t } = useText();
  const backgroundColor = resolveColor(useCSSVariable("--openbot-logo-production"), "#d6adf2");
  const { handlePressIn, leftEyeAnimatedStyle, rightEyeAnimatedStyle } = useAppLogoMotion({ animation, size });
  const eyeLayerStyle = {
    height: size,
    left: 0,
    position: "absolute" as const,
    top: 0,
    width: size,
  };

  const logo = (
    <View
      style={{ height: size, width: size }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width={size} height={size} viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}>
        <Path
          d={BOTAI_LOGO_PATH}
          fill="none"
          stroke={backgroundColor}
          strokeWidth={30}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>

      <Animated.View
        pointerEvents="none"
        style={[
          eyeLayerStyle,
          {
            transformOrigin: [
              (BOTAI_LOGO_EYES.left.x * size) / VIEWBOX_SIZE,
              (BOTAI_LOGO_EYES.left.y * size) / VIEWBOX_SIZE,
              0,
            ],
          },
          leftEyeAnimatedStyle,
        ]}
      >
        <Svg width={size} height={size} viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}>
          <Circle
            cx={BOTAI_LOGO_EYES.left.x}
            cy={BOTAI_LOGO_EYES.left.y}
            r={BOTAI_LOGO_EYES.left.radius}
            fill={backgroundColor}
          />
        </Svg>
      </Animated.View>

      <Animated.View
        pointerEvents="none"
        style={[
          eyeLayerStyle,
          {
            transformOrigin: [
              (BOTAI_LOGO_EYES.right.x * size) / VIEWBOX_SIZE,
              (BOTAI_LOGO_EYES.right.y * size) / VIEWBOX_SIZE,
              0,
            ],
          },
          rightEyeAnimatedStyle,
        ]}
      >
        <Svg width={size} height={size} viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}>
          <Circle
            cx={BOTAI_LOGO_EYES.right.x}
            cy={BOTAI_LOGO_EYES.right.y}
            r={BOTAI_LOGO_EYES.right.radius}
            fill={backgroundColor}
          />
        </Svg>
      </Animated.View>
    </View>
  );

  if (!interactive) return logo;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("mobile.auth.logo.animateBotAi")}
      accessibilityHint={t("mobile.auth.logo.animateHint")}
      onPressIn={handlePressIn}
      pressRetentionOffset={12}
    >
      {logo}
    </Pressable>
  );
}
