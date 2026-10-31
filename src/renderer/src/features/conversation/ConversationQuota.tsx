import { providerDisplayName } from "@openbot/contracts/agent-providers";
import {
  type CustomProviderSummary,
  DEFAULT_CUSTOM_PROVIDER_HARNESS,
  DEFAULT_PROVIDER_ACCOUNT_ID,
  isOllamaCloudBaseUrl,
} from "@openbot/contracts/ipc";
import { providerAccountName } from "@openbot/ui/components/provider-accounts";
import { backupModelOption, backupModelOptions } from "@openbot/ui/features/conversation/BackupModels";
import { QuotaNotice, type QuotaRecommendation } from "@openbot/ui/features/conversation/QuotaNotice";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, onSettled, Show } from "solid-js";
import { useOllamaQuota } from "../usage/ollama-quota-context";
import { useConversationViewScope } from "./conversation-scope";

/** Saved official connections only. Main independently verifies credentials and the active catalog. */
export function ConversationQuota() {
  const { props, channel, sideThreadOpen } = useConversationViewScope();
  const connection = createMemo(() => {
    const agent = props.agent;
    if (channel || sideThreadOpen() || props.runtime || props.server?.kind !== "local" || !agent) return undefined;
    return props.customProviders?.find(
      (endpoint) =>
        (endpoint.harness ?? DEFAULT_CUSTOM_PROVIDER_HARNESS) === agent.provider &&
        endpoint.hasApiKey &&
        !(endpoint.headerNames?.length ?? 0) &&
        endpoint.models.some((model) => `${endpoint.id}/${model.id}` === agent.model) &&
        props.modelOptions.some((model) => model.id === agent.model && model.provider === agent.provider) &&
        isOllamaCloudBaseUrl(endpoint.baseUrl),
    );
  });
  return <Show when={connection()}>{(endpoint) => <LocalQuota connection={endpoint()} />}</Show>;
}

function LocalQuota(input: { connection: CustomProviderSummary }) {
  const { props, settingsProvider, settingsModel, selectAndConfirmModel } = useConversationViewScope();
  const quota = useOllamaQuota();
  const { t } = useText();
  let mounted = true;
  onSettled(() => () => {
    mounted = false;
  });
  function accountIdentity(provider: string, id: string): string | null {
    const status = props.agentStatus.providers?.find((candidate) => candidate.id === provider);
    if (!status || status.apiKeyInUse) return null;
    const account = status.accounts?.find((candidate) => candidate.id === id);
    const email =
      account?.email ?? (status.accounts === undefined && id === DEFAULT_PROVIDER_ACCOUNT_ID ? status.email : null);
    return email ? JSON.stringify([provider, id, email, account?.label ?? null]) : null;
  }
  const watchedAgent = createMemo(() => props.agent?.id);
  createEffect(watchedAgent, (id) => (id ? quota.watch(id) : undefined));
  const reading = () => {
    const id = watchedAgent();
    const value = id ? quota.state.readings[id] : null;
    return value?.connectionId === input.connection.id ? (value ?? null) : null;
  };
  const recommendation = (): QuotaRecommendation | undefined => {
    const agent = props.agent;
    if (!agent || agent.pendingRuntime || settingsProvider() !== agent.provider || settingsModel() !== agent.model)
      return undefined;
    const source = {
      modelOptions: props.modelOptions,
      providers: props.agentStatus.providers,
      limited: props.usageLimited,
    };
    const options = [
      ...(agent.backupModels?.order ?? []).map((choice) => backupModelOption(choice, source)),
      ...backupModelOptions(source, []),
    ];
    // Native Codex/Claude accounts cannot spend an Ollama Cloud pool. Other custom models may share it.
    const option = options.find(
      (candidate) =>
        candidate.state === "ready" &&
        ["codex", "claude"].includes(candidate.choice.provider) &&
        accountIdentity(
          candidate.choice.provider,
          candidate.choice.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID,
        ) !== null,
    );
    if (!option) return undefined;
    const choice = option.choice;
    const identity = accountIdentity(choice.provider, choice.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID);
    const targetStatus = props.agentStatus.providers?.find((provider) => provider.id === choice.provider);
    const targetAccount = targetStatus?.accounts?.find(
      (account) => account.id === (choice.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID),
    );
    const targetEmail = targetAccount?.email ?? targetStatus?.email;
    const accountLabel = providerAccountName(
      t,
      targetStatus?.accounts ?? [],
      choice.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID,
    );
    const initialPool = reading()?.poolId;
    const initialWarnings = reading()?.windows.flatMap((window) => (window.warningId ? [window.warningId] : [])) ?? [];
    const agentId = agent.id;
    const originalModel = agent.model;
    const originalProvider = agent.provider;
    return {
      key: JSON.stringify([agentId, option.key, identity]),
      model: option.model,
      provider: providerDisplayName(choice.provider),
      account: targetEmail && accountLabel !== targetEmail ? `${accountLabel} · ${targetEmail}` : accountLabel,
      onConfirm: async (isCurrent) => {
        const current = await quota.refresh(agentId);
        const available = backupModelOption(choice, {
          modelOptions: props.modelOptions,
          providers: props.agentStatus.providers,
          limited: props.usageLimited,
        });
        if (
          !mounted ||
          !isCurrent() ||
          accountIdentity(choice.provider, choice.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID) !== identity ||
          props.server?.kind !== "local" ||
          props.agent?.id !== agentId ||
          props.agent.model !== originalModel ||
          props.agent.provider !== originalProvider ||
          props.agent.pendingRuntime ||
          settingsModel() !== originalModel ||
          settingsProvider() !== originalProvider ||
          !current ||
          current.poolId !== initialPool ||
          current.state !== "fresh" ||
          !current.windows.some((window) => window.warningId && initialWarnings.includes(window.warningId)) ||
          available.state !== "ready"
        )
          return false;
        return selectAndConfirmModel(choice.model, choice.provider, choice.providerAccountId ?? null);
      },
    };
  };
  return (
    <QuotaNotice
      reading={reading()}
      connectionName={input.connection.name}
      now={quota.state.now}
      recommendation={recommendation()}
      switchQueued={
        Boolean(props.agent?.pendingRuntime) ||
        settingsModel() !== props.agent?.model ||
        settingsProvider() !== props.agent?.provider
      }
      onDismiss={(ids) => {
        void quota.dismiss(ids).catch(() => undefined);
      }}
    />
  );
}
