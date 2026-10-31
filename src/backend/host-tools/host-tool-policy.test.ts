import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sourceText } from "@openbot/i18n/source";
import { describe, expect, it } from "vitest";
import { HostToolPolicy, loadHostToolPolicy } from "./host-tool-policy";

describe("host tool policy", () => {
  it("asks when no rule matches and does not record a run", async () => {
    const policy = new HostToolPolicy();
    expect(policy.decide("shell")).toBe("ask");
    expect(policy.ran).toEqual([]);
  });

  it("runs always without a card and keeps the mode", async () => {
    const policy = new HostToolPolicy();
    policy.allowAlways("shell", "ap-1");
    expect(policy.decide("shell")).toBe("always");
    expect(policy.decide("screenshot")).toBe("ask");
  });

  it("denies never without a run", () => {
    const policy = new HostToolPolicy();
    policy.denyForever("shell");
    expect(policy.decide("shell")).toBe("never");
    expect(sourceText("error.backend.hostToolDenied")).toBe("Denied");
  });

  it("clears always on retire-approval and leaves never", () => {
    const policy = new HostToolPolicy();
    policy.allowAlways("shell", "ap-1");
    policy.denyForever("screenshot");
    policy.retireApproval("ap-1");
    expect(policy.decide("shell")).toBe("ask");
    expect(policy.decide("screenshot")).toBe("never");
    policy.retireApproval("missing");
    expect(policy.decide("screenshot")).toBe("never");
  });

  it("allow once does not change the stored mode", () => {
    const policy = new HostToolPolicy();
    policy.allowOnce("shell");
    expect(policy.decide("shell")).toBe("ask");
  });

  it("round-trips the document", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "host-tool-policy-"));
    const file = path.join(dir, "host-tool-review.json");
    const policy = await loadHostToolPolicy(file);
    policy.allowAlways("mcp", "ap-9");
    policy.denyForever("write-file");
    await policy.save();
    const again = await loadHostToolPolicy(file);
    expect(again.decide("mcp")).toBe("always");
    expect(again.decide("write-file")).toBe("never");
    const raw = await readFile(file, "utf8");
    expect(raw.includes("token")).toBe(false);
  });
});
