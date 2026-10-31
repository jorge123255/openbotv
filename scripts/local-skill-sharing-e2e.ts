// Drives the real local library, parsers, preload decoders and installer in temporary workspaces.
// Run: bun scripts/local-skill-sharing-e2e.ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentSummary, LocalSkillShareOutcome } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { AgentLifecycleFailed } from "../src/backend/agent-service";
import { CentralAuthManager } from "../src/main/central-auth-manager";
import { parseLocalSkillShareReview, parseShareLocalSkill } from "../src/main/ipc/local-skill-inputs";
import { LocalSkillLibrary } from "../src/main/local-skill-library";
import { SkillMarketplaceService } from "../src/main/skill-marketplace-service";
import { decodeLocalSkillShareOutcomes, decodeLocalSkillShareReview } from "../src/preload/skills-decoding";

const root = await mkdtemp(join(tmpdir(), "openbot-skill-share-"));
const report: { passed: boolean; cases: string[] } = { passed: false, cases: [] };
const out = resolve(import.meta.dirname, "../.openbot-build/local-skill-sharing-e2e/report.json");
const run = Effect.runPromise;
const markdown = "---\nname: share-demo\ndescription: An isolated sharing fixture.\n---\nReview the changes.\n";
const agents: AgentSummary[] = Array.from({ length: 9 }, (_, index) => ({
  id: `fixture-${index}`,
  name: `Fixture ${index}`,
  title: "",
  description: "",
  notifications: false,
  provider: "codex",
  model: "gpt-5",
  reasoningEffort: "medium",
  threadId: null,
  workspacePath: join(root, String(index)),
  preview: "",
  updatedAt: null,
  avatarSeed: String(index),
  avatarHue: null,
  avatarUrl: null,
}));
const source = agents[0];
assert.ok(source);
const list = () => agents;
const library = new LocalSkillLibrary(join(root, "library"), list);
const refreshed: string[] = [];
const service = new SkillMarketplaceService(
  new CentralAuthManager({
    apiUrl: "https://example.invalid",
    storagePath: join(root, "auth.json"),
    canPersist: () => false,
    encrypt: (value) => Buffer.from(value),
    decrypt: (value) => value.toString("utf8"),
    fetch: async () => {
      throw new Error("Sharing must not contact the account service.");
    },
  }),
  list,
  (id) => {
    refreshed.push(id);
    return id === "fixture-7"
      ? Effect.fail(new AgentLifecycleFailed({ operation: "refresh agent runtime", cause: "synthetic failure" }))
      : Effect.void;
  },
  library,
);
const target = (index: number, path: string) => join(root, String(index), path);
const expectCopy = async (index: number, expected: string) => {
  for (const folder of [".agents/skills", ".claude/skills"])
    assert.equal(await readFile(target(index, `${folder}/share-demo/SKILL.md`), "utf8"), expected);
};
try {
  for (const agent of agents) await mkdir(agent.workspacePath, { recursive: true });
  await mkdir(target(0, "learned/share-demo"), { recursive: true });
  await writeFile(target(0, "learned/share-demo/SKILL.md"), markdown);
  // Private state outside the skill directory never enters the local library or sharing result.
  await writeFile(target(0, "MEMORY.md"), "Private fixture memory.");
  await writeFile(target(0, "routines.json"), "Private fixture schedule.");
  const skill = await run(library.create(source.id, "learned/share-demo"));
  const reviewInput = parseLocalSkillShareReview({ skillId: skill.id, revision: 1 });
  const review = decodeLocalSkillShareReview(await run(service.reviewLocalShare(reviewInput)));
  assert.equal(review.markdown, markdown);
  assert.equal(review.bundleSha256, skill.bundleSha256);
  assert.deepEqual(
    review.recipients.map((item) => item.agentId),
    agents.map((item) => item.id),
  );
  const share = (ids: string[], hash = review.bundleSha256) =>
    run(
      service.shareLocal(
        parseShareLocalSkill({ skillId: skill.id, revision: 1, bundleSha256: hash, agentIds: ids, reviewed: true }),
      ),
    );
  assert.throws(() =>
    parseShareLocalSkill({
      skillId: skill.id,
      revision: 1,
      bundleSha256: review.bundleSha256,
      agentIds: [],
      reviewed: true,
    }),
  );
  assert.throws(() =>
    parseShareLocalSkill({
      skillId: skill.id,
      revision: 1,
      bundleSha256: review.bundleSha256,
      agentIds: ["fixture-1", "fixture-1"],
      reviewed: true,
    }),
  );
  assert.throws(() =>
    parseShareLocalSkill({
      skillId: skill.id,
      revision: 1,
      bundleSha256: review.bundleSha256,
      agentIds: ["fixture-1"],
      reviewed: false,
    }),
  );
  await assert.rejects(share(["fixture-1"], "0".repeat(64)));
  assert.deepEqual(refreshed, []);
  report.cases.push("Exact pinned text and source; empty, duplicate, unreviewed and hash-mismatch requests refused");
  // A newer revision does not change the reviewed copy.
  await writeFile(target(0, "learned/share-demo/SKILL.md"), `${markdown}New revision.\n`);
  await run(library.revise(source.id, skill.id, 1, "learned/share-demo"));
  const first = decodeLocalSkillShareOutcomes(await share(["fixture-1", "fixture-2"]));
  assert.deepEqual(
    first.map((item) => item.status),
    ["installed", "installed"],
  );
  await expectCopy(1, markdown);
  await expectCopy(2, markdown);
  await assert.rejects(readFile(target(3, ".openbot/skills-lock.json")));
  await assert.rejects(readFile(target(1, "MEMORY.md")));
  await assert.rejects(readFile(target(1, "routines.json")));
  assert.deepEqual(refreshed, ["fixture-1", "fixture-2"]);
  report.cases.push(
    "Only explicit recipients receive revision 1 after revision 2 is published; private state stays at source",
  );
  await run(service.setEnabled({ agentId: "fixture-1", skillId: skill.id, enabled: false }));
  assert.equal((await share(["fixture-1"]))[0]?.status, "unchanged");
  assert.equal(
    (await run(service.listInstalled("fixture-1"))).find((item) => item.skillId === skill.id)?.enabled,
    false,
  );
  await writeFile(target(2, ".agents/skills/share-demo/SKILL.md"), "User edits.\n");
  assert.equal((await share(["fixture-2"]))[0]?.status, "blocked");
  assert.equal(await readFile(target(2, ".agents/skills/share-demo/SKILL.md"), "utf8"), "User edits.\n");
  await run(service.installLocal({ agentId: "fixture-3", skillId: skill.id, revision: 2 }));
  assert.equal((await share(["fixture-3"]))[0]?.status, "blocked");
  await expectCopy(3, `${markdown}New revision.\n`);
  report.cases.push("Disabled copies stay disabled; modified and different revision copies are not replaced");
  await mkdir(target(4, ".agents/skills/share-demo"), { recursive: true });
  await writeFile(target(4, ".agents/skills/share-demo/SKILL.md"), "Unowned fixture.\n");
  await mkdir(join(root, "outside"));
  await symlink(join(root, "outside"), target(5, ".agents"));
  // The removed recipient and a foreign id cannot resolve through the local agent service.
  const removed = agents.pop();
  assert.equal(removed?.id, "fixture-8");
  const partial: LocalSkillShareOutcome[] = await share([
    "fixture-4",
    "fixture-5",
    "fixture-6",
    "fixture-7",
    "fixture-8",
    "foreign-agent",
  ]);
  assert.deepEqual(
    partial.map((item) => item.status),
    ["check-required", "check-required", "installed", "check-required", "check-required", "check-required"],
  );
  assert.equal(await readFile(target(4, ".agents/skills/share-demo/SKILL.md"), "utf8"), "Unowned fixture.\n");
  await assert.rejects(readFile(join(root, "outside/skills/share-demo/SKILL.md")));
  await expectCopy(6, markdown);
  await expectCopy(7, markdown);
  report.cases.push(
    "Unowned folders, symlinks, removed and foreign recipients preserved; partial success and post-write refresh uncertainty reported",
  );
  await writeFile(target(0, "learned/share-demo/extra.txt"), "Not reviewed.\n");
  const withAsset = await run(library.revise(source.id, skill.id, 2, "learned/share-demo"));
  await assert.rejects(run(service.reviewLocalShare({ skillId: skill.id, revision: withAsset.version })));
  await assert.rejects(
    run(
      service.shareLocal({
        skillId: skill.id,
        revision: withAsset.version,
        bundleSha256: withAsset.bundleSha256,
        agentIds: ["fixture-6"],
        reviewed: true,
      }),
    ),
  );
  await rm(target(0, "learned/share-demo/extra.txt"));
  await writeFile(target(0, "learned/share-demo/SKILL.md"), `${markdown}api_key=synthetic-fixture-value\n`);
  const sensitive = await run(library.revise(source.id, skill.id, 3, "learned/share-demo"));
  await assert.rejects(run(service.reviewLocalShare({ skillId: skill.id, revision: sensitive.version })));
  await assert.rejects(
    run(
      service.shareLocal({
        skillId: skill.id,
        revision: sensitive.version,
        bundleSha256: sensitive.bundleSha256,
        agentIds: ["fixture-6"],
        reviewed: true,
      }),
    ),
  );
  report.cases.push("Extra files and detected sensitive text refused by both review and install paths");
  assert.throws(() => decodeLocalSkillShareOutcomes([{ agentId: "fixture-1", status: "new-state" }]));
  assert.throws(() => decodeLocalSkillShareReview({ ...review, bundleSha256: "invalid" }));
  report.cases.push("Preload rejects malformed review and outcome payloads");
  report.passed = true;
} finally {
  await mkdir(resolve(out, ".."), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
