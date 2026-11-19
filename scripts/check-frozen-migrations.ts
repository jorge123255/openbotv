import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { frozenMigrationProblems, MIGRATIONS_DIR } from "./frozen-migrations";

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
}

const UPSTREAM_RELEASES = "https://github.com/nightly-labs/openbot.git";

function newestTag(tags: string): string | undefined {
  return /(?:^|\/)(v\d+\.\d+\.\d+)$/m.exec(tags)?.[1];
}

function releaseTags(remote: string): string {
  return git("ls-remote", "--tags", "--refs", "--sort=-v:refname", remote, "v*");
}

function newestReleaseTag(): { tag: string; remote: string } {
  for (const remote of ["origin", UPSTREAM_RELEASES]) {
    try {
      const tag = newestTag(releaseTags(remote));
      if (tag) return { tag, remote };
    } catch {
      // A missing remote is the same as a remote with no release tags.
    }
  }
  const tag = newestTag(git("tag", "--list", "--sort=-v:refname", "v*"));
  if (!tag) throw new Error("No v* release tag on origin or in this checkout.");
  return { tag, remote: "origin" };
}

const tagFlag = process.argv.indexOf("--tag");
const resolved = tagFlag === -1 ? newestReleaseTag() : { tag: process.argv[tagFlag + 1] ?? "", remote: "origin" };
const tag = resolved.tag;
try {
  git("rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`);
} catch {
  git("fetch", "--quiet", "--no-tags", "--depth=1", resolved.remote, `refs/tags/${tag}:refs/tags/${tag}`);
}

const releasedFiles = new Map<string, string>();
for (const path of git("ls-tree", "--name-only", tag, "--", `${MIGRATIONS_DIR}/`).split("\n").filter(Boolean)) {
  releasedFiles.set(path.slice(MIGRATIONS_DIR.length + 1), git("show", `${tag}:${path}`));
}
const current = new Map(
  readdirSync(MIGRATIONS_DIR).map((file) => [file, readFileSync(join(MIGRATIONS_DIR, file), "utf8")]),
);

const problems = frozenMigrationProblems(current, { tag, files: releasedFiles });
if (problems.length > 0) {
  process.stderr.write(
    [
      `These migrations break the frozen-migration rules (compared with ${tag}):`,
      ...problems.map((problem) => `- ${MIGRATIONS_DIR}/${problem}`),
      "",
      "See src/backend/AGENTS.md#frozen-migrations.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
const scope =
  releasedFiles.size > 0 ? `${releasedFiles.size} released files unchanged` : "no frozen files in the tag yet";
process.stdout.write(`Migrations are frozen: ${tag}, ${scope}.\n`);
