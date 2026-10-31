// Uses the real local library screen and mock desktop bridge in isolated Storybook.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const target = new URL(arg("url") ?? "http://localhost:6006");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
const channel = arg("browser-channel") ?? "chrome";
assert.ok(["chrome", "chromium"].includes(channel));
const output = resolve(import.meta.dirname, "../.openbot-build/local-skill-sharing-ui-e2e");
await mkdir(output, { recursive: true });
const report: { passed: boolean; cases: string[]; pageErrors: string[]; screenshots: string[] } = {
  passed: false,
  cases: [],
  pageErrors: [],
  screenshots: [],
};
const browser = await chromium.launch({ channel, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 }, reducedMotion: "reduce" });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["http:", "https:"].includes(url.protocol) && url.origin !== target.origin
      ? route.abort()
      : route.continue();
  });
  const story = async (theme: string) => {
    const url = new URL("/iframe.html", target);
    url.searchParams.set("id", "settings-local-skill-sharing--review-and-select");
    url.searchParams.set("viewMode", "story");
    url.searchParams.set("globals", `colorScheme:${theme}`);
    await page.goto(url.href);
    await page.getByRole("button", { name: "Share skill…", exact: true }).waitFor({ timeout: 60_000 });
  };
  const screenshot = async (name: string) => {
    const path = resolve(output, `${name}.png`);
    await page.screenshot({ path, fullPage: true, animations: "disabled" });
    report.screenshots.push(path);
  };
  await story("dark");
  await screenshot("library-with-share-action");
  await page.getByRole("button", { name: "Share skill…", exact: true }).click();
  const review = page.getByRole("region", { name: "Share Change review", exact: true });
  const content = review.getByRole("region", { name: "Exact SKILL.md content", exact: true });
  await content.waitFor();
  assert.ok((await content.innerText()).startsWith("---\nname: Change review\n"));
  const chief = review.getByRole("checkbox", { name: "Chief", exact: true });
  const research = review.getByRole("checkbox", { name: "Research", exact: true });
  const planner = review.getByRole("checkbox", { name: "Planner", exact: true });
  const acknowledgement = review.getByRole("checkbox", {
    name: "I reviewed this text and it contains no private information.",
    exact: true,
  });
  const share = review.getByRole("button", { name: "Share with selected agents", exact: true });
  assert.equal(await chief.isChecked(), false);
  assert.equal(await research.isChecked(), false);
  assert.equal(await planner.isChecked(), false);
  assert.equal(await share.isEnabled(), false);
  await chief.check();
  await research.check();
  assert.equal(await share.isEnabled(), false);
  await acknowledgement.check();
  assert.equal(await share.isEnabled(), true);
  await screenshot("review-selected-dark");
  await share.click();
  await review.getByText("Chief: Installed", { exact: true }).waitFor();
  await review.getByText("Research: Existing copy differs; unchanged", { exact: true }).waitFor();
  assert.equal(await share.isEnabled(), false);
  assert.equal(await planner.isChecked(), false);
  assert.deepEqual(
    await page.evaluate(async () => (await window.openbot.skills.listInstalled("planner")).map((item) => item.skillId)),
    [],
  );
  assert.equal(
    await page.evaluate(async () => (await window.openbot.skills.listInstalled("research"))[0]?.state),
    "modified",
  );
  await screenshot("partial-results-dark");
  report.cases.push(
    "No default recipients; explicit review and selection required; per-agent partial results preserve unselected and modified agents",
  );
  await story("light");
  await page.setViewportSize({ width: 560, height: 1000 });
  await page.getByRole("button", { name: "Share skill…", exact: true }).click();
  await content.waitFor();
  await screenshot("review-narrow-light");
  await share.scrollIntoViewIfNeeded();
  await screenshot("review-narrow-light-choices");
  report.cases.push("Review is readable at narrow width in the light theme");
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} finally {
  await browser.close();
  await writeFile(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
