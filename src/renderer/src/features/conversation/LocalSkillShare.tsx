import type { LocalSkillShareOutcome, LocalSkillShareReview, MarketplaceSkillDetail } from "@openbot/contracts/ipc";
import { Button, Checkbox, ErrorReference } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { errorReference } from "@openbot/user-errors";
import { createStore, createUniqueId, For, onSettled, Show } from "solid-js";
import { skillsPort } from "../../skills-port";
import "./local-skill-share.css";

/** A new mount pins one library revision. No recipient is selected by default. */
export function LocalSkillShare(props: {
  skill: MarketplaceSkillDetail;
  onClose: () => void;
  onInstalled: () => Promise<void>;
}) {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<{
    review: LocalSkillShareReview | null;
    agentIds: string[];
    reviewed: boolean;
    busy: boolean;
    submitted: boolean;
    outcomes: LocalSkillShareOutcome[];
    error: string;
    reference: string | null;
  }>({
    review: null,
    agentIds: [],
    reviewed: false,
    busy: false,
    submitted: false,
    outcomes: [],
    error: "",
    reference: null,
  });
  const reviewId = createUniqueId();
  let active = true;
  onSettled(() => {
    void skillsPort()
      .skills.localShareReview({ skillId: props.skill.id, revision: props.skill.version })
      .then(
        (review) => {
          if (active) setState((current) => ({ ...current, review }));
        },
        (error) => {
          if (active)
            setState((current) => ({
              ...current,
              error: errorMessage(error, t("skill.local.loadFailed")),
              reference: errorReference(error),
            }));
        },
      );
    return () => {
      active = false;
    };
  });
  async function share() {
    const review = state.review;
    if (!review || state.busy || state.submitted || !state.reviewed || !state.agentIds.length) return;
    // Hold the exact displayed content and explicit recipients across the asynchronous call.
    const input = {
      skillId: review.skillId,
      revision: review.revision,
      bundleSha256: review.bundleSha256,
      agentIds: [...state.agentIds],
      reviewed: true as const,
    };
    setState((current) => ({ ...current, busy: true, submitted: true, error: "", reference: null }));
    try {
      const outcomes = await skillsPort().skills.localShare(input);
      if (!active) return;
      setState((current) => ({ ...current, outcomes }));
      await props.onInstalled();
    } catch (error) {
      if (active)
        setState((current) => ({
          ...current,
          error: errorMessage(error, t("skill.share.failed")),
          reference: errorReference(error),
        }));
    } finally {
      if (active) setState((current) => ({ ...current, busy: false }));
    }
  }
  function status(outcome: LocalSkillShareOutcome) {
    switch (outcome.status) {
      case "installed":
        return t("skill.share.installed");
      case "unchanged":
        return t("skill.share.unchanged");
      case "blocked":
        return t("skill.share.blocked");
      case "check-required":
        return t("skill.share.checkRequired");
    }
  }
  return (
    <section
      class="local-skill-share agent-skill-detail"
      aria-label={t("skill.share.title", { name: props.skill.name })}
    >
      <Button variant="ghost" disabled={state.busy} onClick={() => props.onClose()}>
        {t("skill.share.close")}
      </Button>
      <h3>{t("skill.share.title", { name: props.skill.name })}</h3>
      <p>{t("skill.share.scope")}</p>
      <Show when={state.error}>
        <p role="alert" class="agent-memory-error">
          {state.error}
          <ErrorReference reference={state.reference} />
        </p>
      </Show>
      <Show
        when={state.review}
        fallback={
          <Show when={!state.error}>
            <p role="status">{t("skill.share.loading")}</p>
          </Show>
        }
      >
        {(review) => (
          <>
            <p>{t("skill.share.source", { id: review().skillId, revision: review().revision })}</p>
            <p>{t("skill.share.hash", { hash: review().bundleSha256 })}</p>
            <section aria-label={t("skill.share.content")}>
              <pre class="local-skill-share-content" tabindex={0}>
                {review().markdown}
              </pre>
            </section>
            <p>{t("skill.share.noOverwrite")}</p>
            <fieldset disabled={state.busy || state.submitted}>
              <legend>{t("skill.share.recipients")}</legend>
              <For each={review().recipients}>
                {(recipient) => (
                  <label class="local-skill-share-choice" for={`${reviewId}-${recipient.agentId}`}>
                    <Checkbox
                      id={`${reviewId}-${recipient.agentId}`}
                      checked={state.agentIds.includes(recipient.agentId)}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setState((current) => ({
                          ...current,
                          agentIds: checked
                            ? [...current.agentIds, recipient.agentId]
                            : current.agentIds.filter((id) => id !== recipient.agentId),
                        }));
                      }}
                    />
                    <span>{recipient.name}</span>
                  </label>
                )}
              </For>
              <label class="local-skill-share-choice" for={`${reviewId}-reviewed`}>
                <Checkbox
                  id={`${reviewId}-reviewed`}
                  checked={state.reviewed}
                  onChange={(event) => {
                    const reviewed = event.currentTarget.checked;
                    setState((current) => ({ ...current, reviewed }));
                  }}
                />
                <span>{t("skill.share.reviewed")}</span>
              </label>
            </fieldset>
            <Button
              disabled={state.busy || state.submitted || !state.reviewed || !state.agentIds.length}
              onClick={() => void share()}
            >
              {t("skill.share.confirm")}
            </Button>
            <ul aria-live="polite">
              <For each={state.outcomes}>
                {(outcome) => (
                  <li>
                    {review().recipients.find((item) => item.agentId === outcome.agentId)?.name ?? outcome.agentId}:{" "}
                    {status(outcome)}
                  </li>
                )}
              </For>
            </ul>
          </>
        )}
      </Show>
    </section>
  );
}
