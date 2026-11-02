// Real renderer context and mock-host response barriers. Run only in the offline VM or CI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { UpdateAgentInput } from "@openbot/contracts/ipc";
import type { AgentProfile } from "@openbot/ui/data";
import type { Page } from "playwright-core";
import type { AgentProfileRaceFixture } from "../src/renderer/stories/agent-profile-race-fixture";

type Patch = Omit<UpdateAgentInput, "agentId">;
const images = [
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAS0lEQVR4nO3OsQ0AIAwDwezCEEzCOExMTR02SApkufnC5csXY9+sduYq99sHAAAA7AD1QdcDAADAD1AfdD0AAAD8APVB1wMAAMAOeKz+FJct+8o2AAAAAElFTkSuQmCC",
] as const;
function safe(profiles: AgentProfile[]) {
  return profiles.map((profile) => ({
    ...profile,
    avatarUrl: profile.avatarUrl ? createHash("sha256").update(profile.avatarUrl).digest("hex") : null,
  }));
}
function chief(profiles: AgentProfile[]) {
  const profile = profiles.find((agent) => agent.id === "chief");
  assert.ok(profile);
  return profile;
}
export async function runAgentProfileResponseCases(
  page: Page,
  open: (story: string, ready: string) => Promise<void>,
  cases: string[],
): Promise<void> {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const read = () => page.evaluate(() => window.__agentProfileRace.read());
  const fresh = async (events = false) => {
    await open("app-profile-responses--ordering", ".roster-row");
    await page.waitForFunction(() => !!window.__agentProfileRace && window.__agentProfileRace.read().length === 3);
    await page.evaluate((enabled) => window.__agentProfileRace.setEventsEnabled(enabled), events);
    return read();
  };
  const update = (updates: Patch, agentId = "chief") =>
    page.evaluate(({ updates, agentId }) => window.__agentProfileRace.startUpdate(agentId, updates), {
      updates,
      agentId,
    });
  const avatar = (image: 0 | 1 | null) =>
    page.evaluate(
      (data) =>
        window.__agentProfileRace.startAvatar(
          "chief",
          data === null
            ? null
            : {
                mimeType: "image/png",
                bytes: Uint8Array.from(atob(data), (character) => character.charCodeAt(0)),
              },
        ),
      image === null ? null : images[image],
    );
  const arm = (kind: "update" | "avatar", mode: Parameters<AgentProfileRaceFixture["arm"]>[1] = "hold") =>
    page.evaluate(({ kind, mode }) => window.__agentProfileRace.arm(kind, mode), { kind, mode });
  const held = async () => {
    await page.waitForFunction(() => window.__agentProfileRace.held().length > 0);
    const ids = await page.evaluate(() => window.__agentProfileRace.held());
    const id = ids.at(-1);
    assert.ok(id);
    return id;
  };
  const done = async (id: number, state: "fulfilled" | "rejected" = "fulfilled") => {
    await page.waitForFunction(
      ({ id, state }) => window.__agentProfileRace.jobs().some((job) => job.id === id && job.state === state),
      { id, state },
    );
    // All context writes happen before the job settles. Let Solid commit those staged writes.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  };
  const release = async (id: number, job: number, state: "fulfilled" | "rejected" = "fulfilled") => {
    const before = await page.evaluate(() => window.__agentProfileRace.receipts());
    await page.evaluate((id) => window.__agentProfileRace.release(id), id);
    await done(job, state);
    assert.deepEqual(
      await page.evaluate(() => window.__agentProfileRace.receipts()),
      before,
      "Reply delivery must not write or emit another host event.",
    );
  };
  const preserveIdentity = (before: AgentProfile[], after: AgentProfile[]) => {
    assert.equal(after.length, before.length);
    for (const prior of before) {
      const next = after.find((agent) => agent.id === prior.id);
      assert.ok(next);
      for (const key of ["id", "avatarSeed", "avatarHue", "threadId", "workspacePath"] as const)
        assert.equal(next[key], prior[key]);
    }
  };
  const othersUnchanged = (before: AgentProfile[], after: AgentProfile[]) =>
    assert.deepEqual(
      safe(after.filter((agent) => agent.id !== "chief")),
      safe(before.filter((agent) => agent.id !== "chief")),
    );

  // No host events are delivered in these cases: successful response merging must work on its own.
  for (const order of ["old-first", "new-first", "same-turn"] as const) {
    const before = await fresh();
    await arm("update");
    const titleJob = await update({ title: "Saved independent title" });
    const titleReply = await held();
    await arm("avatar");
    const imageJob = await avatar(1);
    const imageReply = await held();
    if (order === "same-turn") {
      const counts = await page.evaluate(() => window.__agentProfileRace.receipts());
      await page.evaluate(
        (ids) => {
          for (const id of ids) window.__agentProfileRace.release(id);
        },
        [imageReply, titleReply],
      );
      await done(titleJob);
      await done(imageJob);
      assert.deepEqual(await page.evaluate(() => window.__agentProfileRace.receipts()), counts);
    } else {
      const sequence =
        order === "old-first"
          ? ([
              [titleReply, titleJob],
              [imageReply, imageJob],
            ] as const)
          : ([
              [imageReply, imageJob],
              [titleReply, titleJob],
            ] as const);
      for (const [reply, job] of sequence) await release(reply, job);
    }
    const after = await read();
    assert.equal(chief(after).title, "Saved independent title");
    assert.equal(chief(after).avatarUrl === chief(before).avatarUrl, false);
    preserveIdentity(before, after);
    othersUnchanged(before, after);
    cases.push(`Disjoint title/photo responses preserve both edits: ${order}, without host events.`);
  }

  for (const choice of ["sprout", "wisp"] as const) {
    const before = await fresh();
    await arm("update");
    const older = await update({ avatarCharacter: "pebble" });
    const reply = await held();
    await done(await update({ avatarCharacter: choice }));
    await release(reply, older);
    assert.equal(chief(await read()).avatarCharacter, choice);
    preserveIdentity(before, await read());
    cases.push(`Newer ${choice} character success survives old Pebble; includes a return to the baseline value.`);
  }

  await fresh();
  await arm("update");
  const successfulOlder = await update({ avatarCharacter: "pebble" });
  const successfulReply = await held();
  await arm("update", "reject");
  await done(await update({ avatarCharacter: "sprout" }), "rejected");
  await release(successfulReply, successfulOlder);
  assert.equal(chief(await read()).avatarCharacter, "pebble");
  assert.equal(await page.evaluate(() => window.__agentProfileRace.errors()), 1);
  cases.push("A newer failed request does not discard an older successful persisted edit; its current error remains.");

  for (const replacement of [1, null] as const) {
    const before = await fresh();
    await arm("avatar");
    const older = await avatar(0);
    const reply = await held();
    await done(await avatar(replacement));
    const newest = chief(await read()).avatarUrl;
    await release(reply, older);
    assert.equal(chief(await read()).avatarUrl === newest, true);
    assert.equal(newest === null, replacement === null);
    preserveIdentity(before, await read());
    othersUnchanged(before, await read());
    cases.push(`Older image response cannot undo ${replacement === null ? "newer removal" : "newer upload"}.`);
  }

  for (const kind of ["avatar", "update"] as const) {
    await fresh();
    await arm(kind, "hold-error");
    const oldFailure = kind === "avatar" ? await avatar(0) : await update({ name: "Rejected name" });
    const reply = await held();
    await done(await avatar(1));
    await release(reply, oldFailure, "rejected");
    assert.equal(await page.evaluate(() => window.__agentProfileRace.errors()), kind === "avatar" ? 0 : 1);
    cases.push(
      kind === "avatar"
        ? "An obsolete image error is suppressed after a newer successful upload."
        : "An unrelated newer upload does not suppress a current name error.",
    );
  }
  await fresh();
  await arm("update", "hold-error");
  const partialError = await update({ name: "Rejected name", avatarCharacter: "pebble" });
  const partialErrorReply = await held();
  await done(await update({ avatarCharacter: "sprout" }));
  await release(partialErrorReply, partialError, "rejected");
  assert.equal(await page.evaluate(() => window.__agentProfileRace.errors()), 1);
  cases.push("A multi-field failure remains relevant while one of its fields has no newer successful replacement.");

  await fresh();
  await arm("avatar", "reject");
  await done(await avatar(1), "rejected");
  assert.equal(await page.evaluate(() => window.__agentProfileRace.errors()), 1);
  cases.push("A current image failure still reports an error.");

  const crossBefore = await fresh(true);
  await arm("update");
  const chiefJob = await update({ description: "Saved Chief description" });
  const chiefReply = await held();
  await done(await update({ title: "Saved Research title" }, "research"));
  await page.evaluate(() => window.__agentProfileRace.select("research"));
  await release(chiefReply, chiefJob);
  const crossAfter = await read();
  assert.equal(chief(crossAfter).description, "Saved Chief description");
  assert.equal(crossAfter.find((agent) => agent.id === "research")?.title, "Saved Research title");
  assert.deepEqual(
    safe(crossAfter.filter((agent) => agent.id === "sales")),
    safe(crossBefore.filter((agent) => agent.id === "sales")),
  );
  preserveIdentity(crossBefore, crossAfter);
  cases.push("Chief completion after selecting Research preserves both agents and the third agent's full profile.");

  for (const mode of ["hold", "hold-error"] as const) {
    const before = await fresh();
    await arm("update", mode);
    const job = await update({ name: "Saved before hide" });
    const reply = await held();
    await page.evaluate(() => window.__agentProfileRace.hideUndo("chief"));
    await release(reply, job, mode === "hold" ? "fulfilled" : "rejected");
    assert.equal(chief(await read()).name, chief(before).name);
    assert.equal(await page.evaluate(() => window.__agentProfileRace.errors()), 0);
    await page.evaluate(() => window.__agentProfileRace.reload());
    await page.waitForFunction(
      (name) => window.__agentProfileRace.read().find((agent) => agent.id === "chief")?.name === name,
      mode === "hold" ? "Saved before hide" : chief(before).name,
    );
    cases.push(
      `Hide/undo invalidates an old ${mode === "hold" ? "success" : "error"}; authoritative reload still restores actual host data.`,
    );
  }
  await fresh();
  await arm("update");
  const removedJob = await update({ title: "Persisted before removal" });
  const removedReply = await held();
  await page.evaluate(() => window.__agentProfileRace.remove("chief"));
  await release(removedReply, removedJob);
  assert.equal(
    (await read()).some((agent) => agent.id === "chief"),
    false,
  );
  await page.evaluate(() => window.__agentProfileRace.reload());
  await page.waitForFunction(
    () => window.__agentProfileRace.read().find((agent) => agent.id === "chief")?.title === "Persisted before removal",
  );
  cases.push("Late success does not resurrect a removed agent; reloading the host preserves its saved data.");

  await fresh();
  await arm("update");
  const recreatedJob = await update({ name: "Old entity response" });
  const recreatedReply = await held();
  await page.evaluate(() => window.__agentProfileRace.remove("chief"));
  await page.waitForFunction(() => !window.__agentProfileRace.read().some((agent) => agent.id === "chief"));
  await page.evaluate(() => window.__agentProfileRace.reload());
  await page.waitForFunction(() => window.__agentProfileRace.read().some((agent) => agent.id === "chief"));
  await done(await update({ name: "New entity name" }));
  await release(recreatedReply, recreatedJob);
  assert.equal(chief(await read()).name, "New entity name");
  cases.push("A same-ID recreated profile ignores the prior store's held response.");

  for (const mode of ["hold", "hold-error"] as const) {
    await fresh();
    await arm("update", mode);
    const job = await update({ name: "Saved in disposed scope" });
    const reply = await held();
    const firstMount = await page.evaluate(() => window.__agentProfileRace.mount());
    await page.evaluate(() => window.__agentProfileRace.switchServer("other"));
    await page.waitForFunction((id) => {
      const fixture = window.__agentProfileRace;
      if (!fixture) return false;
      const mount = fixture.mount();
      return mount.id !== id && mount.serverId !== "local";
    }, firstMount.id);
    const secondMount = await page.evaluate(() => window.__agentProfileRace.mount());
    await page.evaluate(() => window.__agentProfileRace.switchServer("local"));
    await page.waitForFunction(
      (ids) => {
        const fixture = window.__agentProfileRace;
        if (!fixture) return false;
        const mount = fixture.mount();
        return (
          !ids.includes(mount.id) &&
          mount.serverId === "local" &&
          mount.settled &&
          window.__agentProfileRace.read().length === 3
        );
      },
      [firstMount.id, secondMount.id],
    );
    await done(await update({ name: "Saved in new scope" }));
    await release(reply, job, mode === "hold" ? "fulfilled" : "rejected");
    assert.equal(chief(await read()).name, "Saved in new scope");
    assert.equal(await page.evaluate(() => window.__agentProfileRace.errors()), 0);
    cases.push(`A→B→A scope disposal ignores the old ${mode === "hold" ? "success" : "error"} after a new-scope save.`);
  }

  await fresh();
  await arm("update");
  const beforeEventJob = await update({ title: "Old held title" });
  const beforeEventReply = await held();
  await page.evaluate(async () => {
    window.__agentProfileRace.setEventsEnabled(true);
    await window.openbot.agent.updateAgent({ agentId: "chief", title: "New authoritative event title" });
  });
  await page.waitForFunction(
    () =>
      window.__agentProfileRace.read().find((agent) => agent.id === "chief")?.title === "New authoritative event title",
  );
  await release(beforeEventReply, beforeEventJob);
  assert.equal(chief(await read()).title, "New authoritative event title");
  cases.push("An authoritative newer same-field event wins over an older response; later host data still applies.");

  const runtimeBefore = await fresh();
  const runtimeBase = chief(runtimeBefore);
  const queued = { provider: "claude", model: "claude-opus-5-5", reasoningEffort: "high" } as const;
  const returning = { provider: "codex", model: runtimeBase.model, reasoningEffort: "medium" } as const;
  await page.evaluate(
    ({ queued, returning, model }) =>
      window.__agentProfileRace.patchNextReply({
        provider: "codex",
        model,
        reasoningEffort: "medium",
        providerAccountId: undefined,
        pendingRuntime: queued,
        usageLimitReturn: returning,
        updatedAt: "2026-11-02T01:00:00.000Z",
      }),
    { queued, returning, model: runtimeBase.model },
  );
  await done(await update({ provider: "claude", model: queued.model }));
  const queuedProfile = chief(await read());
  assert.equal(queuedProfile.provider, "codex");
  assert.equal(queuedProfile.model, runtimeBase.model);
  assert.deepEqual(queuedProfile.pendingRuntime, queued);
  assert.deepEqual(queuedProfile.usageLimitReturn, returning);
  assert.equal(queuedProfile.updatedAt, "2026-11-02T01:00:00.000Z");
  cases.push(
    "A synthetic queued-runtime response applies host-derived runtime/return fields instead of copying literal input values.",
  );

  await arm("update");
  await page.evaluate(() => window.__agentProfileRace.patchNextReply({ updatedAt: "2026-11-02T02:00:00.000Z" }));
  const oldRuntime = await update({ provider: "claude", model: queued.model, reasoningEffort: "low" });
  const oldRuntimeReply = await held();
  await page.evaluate(() =>
    window.__agentProfileRace.patchNextReply({
      pendingRuntime: undefined,
      usageLimitReturn: undefined,
      updatedAt: "2026-11-02T03:00:00.000Z",
    }),
  );
  await done(await update({ provider: "codex", model: "gpt-6-luna", reasoningEffort: "high" }));
  const latestRuntime = chief(await read());
  assert.notEqual(latestRuntime.time, queuedProfile.time);
  await release(oldRuntimeReply, oldRuntime);
  const finalRuntime = chief(await read());
  for (const key of [
    "provider",
    "model",
    "reasoningEffort",
    "providerAccountId",
    "pendingRuntime",
    "usageLimitReturn",
    "updatedAt",
    "time",
  ] as const)
    assert.deepEqual(finalRuntime[key], latestRuntime[key]);
  assert.equal(finalRuntime.provider, "codex");
  assert.equal(finalRuntime.model, "gpt-6-luna");
  assert.equal(finalRuntime.pendingRuntime, undefined);
  assert.equal(finalRuntime.usageLimitReturn, undefined);
  assert.equal(finalRuntime.updatedAt, "2026-11-02T03:00:00.000Z");
  preserveIdentity(runtimeBefore, await read());
  othersUnchanged(runtimeBefore, await read());
  cases.push(
    "Runtime fields, optional removals and timestamp/time stay atomic when a completed older runtime reply arrives late.",
  );

  await fresh();
  await done(
    await update({ mcpServerIds: ["b", "a", "b"], allowAutomation: true, providerAccountId: "synthetic-account" }),
  );
  assert.deepEqual(chief(await read()).mcpServerIds, ["a", "b"]);
  assert.equal(chief(await read()).allowAutomation, true);
  assert.equal(chief(await read()).providerAccountId, "synthetic-account");
  const research = (await read()).find((agent) => agent.id === "research");
  assert.ok(research);
  await done(await update({ provider: "claude", model: research.model, mcpServerIds: null, allowAutomation: null }));
  const normalized = chief(await read());
  assert.equal(normalized.provider, "claude");
  assert.equal(normalized.model, research.model);
  assert.equal(normalized.providerAccountId, undefined);
  assert.equal(normalized.mcpServerIds, undefined);
  assert.equal(normalized.allowAutomation, undefined);
  cases.push(
    "Response-only merging keeps normalized arrays, null-to-absent defaults and provider-derived account removal.",
  );
  const mixedRemote = await page.evaluate(() =>
    window.__agentProfileRace.remoteRouting({
      agentId: "chief",
      avatarCharacter: "pebble",
      access: "full",
      quickAcknowledgement: true,
      name: "Never sent",
    }),
  );
  assert.deepEqual(mixedRemote, { calls: [], planCards: [], rejected: true, forwarded: null });
  const planCard = await page.evaluate(() =>
    window.__agentProfileRace.remoteRouting({
      agentId: "chief",
      quickAcknowledgement: true,
    }),
  );
  assert.deepEqual(planCard, {
    calls: ["plan-card"],
    planCards: [{ agentId: "chief", enabled: true }],
    rejected: false,
    forwarded: null,
  });
  const planCardAndName = await page.evaluate(() =>
    window.__agentProfileRace.remoteRouting({
      agentId: "chief",
      quickAcknowledgement: false,
      name: "Remote name",
    }),
  );
  assert.deepEqual(planCardAndName, {
    calls: ["plan-card", "profile"],
    planCards: [{ agentId: "chief", enabled: false }],
    rejected: false,
    forwarded: { agentId: "chief", name: "Remote name" },
  });
  const invalidDefault = await page.evaluate(() =>
    window.__agentProfileRace.remoteRouting({
      agentId: "chief",
      access: "full",
      quickAcknowledgement: null,
      name: "Never sent",
    }),
  );
  assert.deepEqual(invalidDefault, { calls: [], planCards: [], rejected: true, forwarded: null });
  cases.push(
    "Remote adapter rejects mixed local-only character metadata before any write, keeps plan-card changes on their dedicated route, and preflights unsupported defaults.",
  );
}
