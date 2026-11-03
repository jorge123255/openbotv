import {
  AVATAR_CHARACTERS,
  type AvatarCharacter,
  avatarCandidateSeeds,
  bloubAvatarProfile,
} from "@openbot/brand/bloub-avatar";
import type { AvatarMood } from "@openbot/brand/bloub-avatar-motion";
import { Button, Input } from "@openbot/ui";
import { avatarImageDataUrl, normalizeAvatarFile } from "@openbot/ui/avatar-image";
import { createStaticAvatarSvg } from "@openbot/ui/bloub-avatar";
import { AgentAvatar } from "@openbot/ui/features/agents/AgentAvatar";
import { TeamPersonAvatar } from "@openbot/ui/features/team/TeamPersonAvatar";
import { createSignal, createStore, For, onSettled, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { STORY_AGENTS, STORY_PRESENCE } from "./fixtures";

const agentMeta = {
  title: "Identity/AgentAvatar",
  component: AgentAvatar,
  parameters: { layout: "centered" },
} satisfies Meta<typeof AgentAvatar>;

export default agentMeta;
type AgentStory = StoryObj<typeof agentMeta>;

export const Generated: AgentStory = {
  args: { agent: STORY_AGENTS[0], motion: "hover" },
};

export const Thinking: AgentStory = {
  args: { agent: STORY_AGENTS[1], motion: "always", class: "size-12" },
};

export const IndependentMotion: AgentStory = {
  render: () => {
    const [state, setState] = createStore({
      seeds: ["agent-alpha", "agent-beta", "agent-gamma", "agent-delta"],
      updates: 0,
      visible: true,
    });
    return (
      <div class="grid gap-6 p-8">
        <div class="flex gap-3">
          <Button
            onClick={() =>
              setState((draft) => {
                draft.seeds.reverse();
              })
            }
          >
            Reverse agents
          </Button>
          <Button
            onClick={() =>
              setState((draft) => {
                draft.updates += 1;
              })
            }
          >
            Update conversation
          </Button>
          <Button
            onClick={() =>
              setState((draft) => {
                draft.visible = !draft.visible;
              })
            }
          >
            {state.visible ? "Hide avatars" : "Show avatars"}
          </Button>
        </div>
        <p>Conversation updates: {state.updates}</p>
        <Show when={state.visible}>
          <For each={["idle", "always", "hover"] as const}>
            {(motion) => (
              <section class="grid gap-3" aria-label={`${motion} avatars`}>
                <strong>{motion}</strong>
                <div class="flex gap-5">
                  <For each={state.seeds}>
                    {(seed) => (
                      <Button variant="ghost" aria-label={`${motion} ${seed}`}>
                        <AgentAvatar seed={seed} motion={motion} class="size-12" hue={215} />
                        {seed}
                      </Button>
                    )}
                  </For>
                </div>
              </section>
            )}
          </For>
        </Show>
      </div>
    );
  },
};

export const CustomImageFallback: AgentStory = {
  args: { agent: { ...STORY_AGENTS[2], avatarUrl: "mock-avatar://missing" } },
};

const AVATAR_SIZES = [16, 18, 24, 32, 36, 42, 62] as const;
const AVATAR_MOODS = [
  "idle",
  "working",
  "waiting",
  "failed",
  "responded",
  "connecting",
  "asleep",
] as const satisfies readonly AvatarMood[];

/**
 * One seed across every mood and every size.
 *
 * This is the story that proves the point of the mood table: reading down a column, the silhouette
 * is the same in all seven rows and only the face changes. A row that draws a different body is a
 * state that should not be in `SHAPE_SAFE_STATES`.
 */
export const SizesAndMoods: AgentStory = {
  render: () => {
    return (
      <div
        class="grid gap-6 p-8"
        style={{ background: "var(--openbot-bg-canvas)", color: "var(--openbot-text-primary)" }}
      >
        {AVATAR_MOODS.map((mood) => {
          return (
            <section class="grid gap-3" aria-label={`${mood} avatar sizes`}>
              <strong class="text-sm capitalize">{mood}</strong>
              <div class="flex items-end gap-5">
                {AVATAR_SIZES.map((size) => (
                  <div class="grid justify-items-center gap-2">
                    <AgentAvatar
                      seed="story-avatar"
                      hue={215}
                      mood={mood}
                      motion="idle"
                      style={{ width: `${size}px`, height: `${size}px` }}
                    />
                    <small style={{ color: "var(--openbot-text-muted)" }}>{size}</small>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    );
  },
};

/** The live moods, with their rings and breathing, as the app actually renders them. */
export const Moods: AgentStory = {
  render: () => (
    <div class="flex items-center gap-8 p-8">
      {AVATAR_MOODS.map((mood) => (
        <div class="grid justify-items-center gap-3">
          <AgentAvatar seed="story-avatar" hue={215} mood={mood} motion="always" class="size-12" />
          <small style={{ color: "var(--openbot-text-muted)" }}>{mood}</small>
        </div>
      ))}
    </div>
  ),
};

export const PersonAvatars: AgentStory = {
  render: () => (
    <div class="flex items-center gap-4">
      {STORY_PRESENCE.members.slice(0, 3).map((member) => (
        <TeamPersonAvatar member={member} large />
      ))}
    </div>
  ),
};

/** Large faces make gaze and mouth alignment visible without changing identity. */
export const PointerFaces: AgentStory = {
  render: () => (
    <div class="flex items-center gap-8 p-8">
      {AVATAR_MOODS.map((mood) => (
        <section aria-label={mood} class="grid justify-items-center gap-3">
          <AgentAvatar
            seed="story-avatar"
            hue={215}
            mood={mood}
            motion="always"
            followPointer
            style={{ width: "96px", height: "96px" }}
          />
          <small>{mood}</small>
        </section>
      ))}
    </div>
  ),
};

const SAVED_IMAGE_KEY = "openbot:story:avatar-image";

/** Exercises the real image normalizer and browser reload, without a host profile. */
export const SavedAnimatedImage: AgentStory = {
  render: () => {
    const [state, setState] = createStore({ url: localStorage.getItem(SAVED_IMAGE_KEY), error: "" });
    const save = async (file: File | undefined) => {
      if (!file) return;
      try {
        const url = avatarImageDataUrl(await normalizeAvatarFile(file));
        localStorage.setItem(SAVED_IMAGE_KEY, url);
        setState((draft) => {
          draft.url = url;
          draft.error = "";
        });
      } catch {
        setState((draft) => {
          draft.error = "Image normalization failed.";
        });
      }
    };
    return (
      <section aria-label="Saved avatar fixture" class="grid gap-6 p-8">
        <p>Browser fixture storage only. This does not test the host profile.</p>
        <Input
          type="file"
          aria-label="Upload avatar fixture"
          accept="image/gif,image/webp"
          onChange={(event) => void save(event.currentTarget.files?.[0])}
        />
        <AgentAvatar
          seed="saved-image-fixture"
          url={state.url}
          motion="always"
          style={{ width: "96px", height: "96px" }}
        />
        <p role="alert">{state.error}</p>
        <Button
          onClick={() => {
            localStorage.removeItem(SAVED_IMAGE_KEY);
            setState((draft) => {
              draft.url = null;
            });
          }}
        >
          Clear saved fixture
        </Button>
      </section>
    );
  },
};

/** Every supported silhouette uses the same live gaze and state changes as a saved bot. */
export const SilhouetteFaces: AgentStory = {
  render: () => {
    const [mood, setMood] = createSignal<AvatarMood>("idle");
    const seeds = avatarCandidateSeeds("visual-review", "chief", 0);
    return (
      <div class="grid gap-6 p-8">
        <div class="flex gap-3">
          {AVATAR_MOODS.map((entry) => (
            <Button aria-pressed={mood() === entry ? "true" : "false"} onClick={() => setMood(entry)}>
              {entry}
            </Button>
          ))}
        </div>
        <div class="flex flex-wrap gap-8">
          {seeds.map((seed) => (
            <section class="grid justify-items-center gap-3" aria-label={bloubAvatarProfile(seed, null).shape}>
              <AgentAvatar
                seed={seed}
                mood={mood()}
                motion="always"
                followPointer
                style={{ width: "96px", height: "96px" }}
              />
              <small>{bloubAvatarProfile(seed, null).shape}</small>
            </section>
          ))}
        </div>
      </div>
    );
  },
};

/** New optional characters alongside the unchanged generated identity, with live state controls. */
export const LivingCharacters: AgentStory = {
  render: () => {
    const [mood, setMood] = createSignal<AvatarMood>("idle");
    return (
      <div class="grid gap-6 p-8">
        <div class="flex gap-3">
          {AVATAR_MOODS.map((entry) => (
            <Button aria-pressed={mood() === entry ? "true" : "false"} onClick={() => setMood(entry)}>
              {entry}
            </Button>
          ))}
        </div>
        <div class="flex flex-wrap gap-8">
          {AVATAR_CHARACTERS.map((kind) => (
            <section aria-label={kind} class="grid justify-items-center gap-3">
              <AgentAvatar
                seed="chief"
                character={kind}
                hue={245}
                mood={mood()}
                motion="always"
                followPointer
                style={{ width: "180px", height: "180px" }}
              />
              <small>{kind}</small>
            </section>
          ))}
        </div>
      </div>
    );
  },
};

function StaticCharacterPreview(props: { seed: string; character?: AvatarCharacter }) {
  let host!: HTMLSpanElement;
  onSettled(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) host.replaceChildren(createStaticAvatarSvg(props.seed, 245, props.character));
    });
    return () => {
      active = false;
      host.replaceChildren();
    };
  });
  return <span class="agent-avatar" ref={host} style={{ width: "96px", height: "96px" }} />;
}

export const StaticCharacters: AgentStory = {
  render: () => (
    <div class="flex gap-8 p-8">
      {AVATAR_CHARACTERS.filter((kind) => kind !== "shape").map((kind) => (
        <StaticCharacterPreview seed="chief" character={kind} />
      ))}
    </div>
  ),
};

export const CharacterImage: AgentStory = {
  args: {
    seed: "chief",
    character: "robot",
    url: "data:image/gif;base64,R0lGODlhCAAIAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQADAAAACwAAAAACAAIAAAIDwABCBxIsKDBgwgTKkwYEAAh+QQBDAABACwAAAAACAAIAIEAgAAAAAAAAAAAAAAIDwABCBxIsKDBgwgTKkwYEAAh+QQBDAABACwAAAAACAAIAIEAAP8AAAAAAAAAAAAIDwABCBxIsKDBgwgTKkwYEAA7",
    motion: "always",
    style: { width: "96px", height: "96px" },
  },
};

/** An uploaded image takes precedence over every optional family. */
export const CharacterImageFamilies: AgentStory = {
  render: () => (
    <div class="flex flex-wrap gap-8 p-8">
      {AVATAR_CHARACTERS.map((kind) => (
        <AgentAvatar {...CharacterImage.args} seed="chief" character={kind} />
      ))}
    </div>
  ),
};
