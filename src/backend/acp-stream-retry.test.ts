// @vitest-environment node
import { describe, expect, it } from "vitest";
import { acpStreamMayRetry } from "./acp-client";

const policy = { attemptsUsed: 0, maxAttempts: 4, deadlineMs: 400 };

describe("acpStreamMayRetry", () => {
  it("sends a dropped stream again when the turn has shown nothing", () => {
    expect(
      acpStreamMayRetry({
        ...policy,
        error: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
        producedOutput: false,
        stalled: false,
      }),
    ).toBe(true);
  });

  it("does not send a stream again after it already showed text", () => {
    expect(
      acpStreamMayRetry({
        ...policy,
        error: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
        producedOutput: true,
        stalled: false,
      }),
    ).toBe(false);
  });

  it("does not send a sign-in error again", () => {
    expect(
      acpStreamMayRetry({
        ...policy,
        error: new Error("authentication required"),
        producedOutput: false,
        stalled: false,
      }),
    ).toBe(false);
  });

  it("sends a silent prompt again and stops after the last attempt", () => {
    expect(
      acpStreamMayRetry({
        ...policy,
        error: new Error("The operation was aborted"),
        producedOutput: false,
        stalled: true,
      }),
    ).toBe(true);
    expect(
      acpStreamMayRetry({
        error: new Error("socket hang up"),
        producedOutput: false,
        stalled: false,
        attemptsUsed: 3,
        maxAttempts: 4,
        deadlineMs: 400,
      }),
    ).toBe(false);
  });
});
