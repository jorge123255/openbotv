import { type AvatarCharacter, avatarCharacter, avatarCharacterSeed } from "@openbot/brand/bloub-avatar";
import type { AvatarHue } from "@openbot/contracts/ipc";
import { Button } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { For } from "solid-js";
import { AgentAvatar } from "./AgentAvatar";

const CHARACTERS = ["shape", "robot", "orb"] as const;
const LABEL = {
  shape: "agentSettings.avatar.characterShapes",
  robot: "agentSettings.avatar.characterRobot",
  orb: "agentSettings.avatar.characterOrb",
} as const;

/** Uses the normal avatar save callback; selecting Shapes restores the same base identity. */
export function CharacterChoices(props: {
  seed: string;
  hue: AvatarHue | null;
  disabled?: boolean;
  hasImage?: boolean;
  onSelect: (seed: string) => void;
}) {
  const { t } = useText();
  const choice = (kind: AvatarCharacter) => avatarCharacterSeed(props.seed, kind);
  return (
    <fieldset class="character-choices" disabled={props.disabled}>
      <legend>{t("agentSettings.avatar.character")}</legend>
      <For each={CHARACTERS}>
        {(kind) => (
          <Button
            type="button"
            variant="ghost"
            class="character-choice"
            disabled={!choice(kind)}
            aria-label={t(LABEL[kind])}
            aria-pressed={!props.hasImage && avatarCharacter(props.seed).kind === kind ? "true" : "false"}
            title={!choice(kind) ? t("agentSettings.avatar.characterSeedLimit") : undefined}
            onClick={() => {
              const seed = choice(kind);
              if (seed) props.onSelect(seed);
            }}
          >
            <AgentAvatar seed={choice(kind) ?? props.seed} hue={props.hue} motion="hover" />
            {t(LABEL[kind])}
          </Button>
        )}
      </For>
    </fieldset>
  );
}
