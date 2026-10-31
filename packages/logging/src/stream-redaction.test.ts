// Protected send/log redaction: raw carry must never escape through chunk boundaries.
import { describe, expect, it } from "vitest";
import { RegisteredSecretStream, registerSecretValue } from "./index";

describe("registered secret streaming", () => {
  it("protects every split of raw, JSON and URL forms, including embedded newlines", () => {
    const secret = 'stream-review-"value /+%\\line\nsynthetic-credential-only';
    registerSecretValue(secret);
    const forms = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)];
    for (const form of forms)
      for (let split = 1; split < form.length; split++) {
        const stream = new RegisteredSecretStream();
        const prefix = stream.push(form.slice(0, split));
        expect(prefix === "").toBe(true);
        const suffix = stream.push(`${form.slice(split)}\n`);
        expect(suffix !== null).toBe(true);
        const output = `${prefix ?? ""}${suffix ?? ""}${stream.finish()}`;
        expect(forms.some((value) => output.includes(value))).toBe(false);
      }
  });

  it("does not cut through one complete match that overlaps another candidate", () => {
    const first = "overlap-review [shared]";
    const second = "[shared] extension-review";
    registerSecretValue(first);
    registerSecretValue(second);
    const stream = new RegisteredSecretStream();
    const early = stream.push("overlap-review [shared] extension-");
    expect(early === "").toBe(true);
    const late = stream.push("review\n");
    expect(late !== null).toBe(true);
    const output = `${early ?? ""}${late ?? ""}${stream.finish()}`;
    expect(output.includes(first) || output.includes(second)).toBe(false);
  });

  it("masks unfinished candidates at a stream boundary and discards carry on reset", () => {
    const secret = "unfinished-review-credential-value";
    registerSecretValue(secret);
    const stream = new RegisteredSecretStream();
    expect(stream.push(secret.slice(0, 12)) === "").toBe(true);
    const tail = stream.finish();
    expect(tail === "[redacted]").toBe(true);
    expect(tail.includes(secret.slice(0, 12))).toBe(false);
    stream.push(secret.slice(0, 12));
    stream.reset();
    const suffix = stream.push(`${secret.slice(12)}\n`);
    expect(suffix !== null && !`${tail}${suffix}`.includes(secret)).toBe(true);
  });

  it("keeps overlapping match chains whole when the retained suffix starts inside them", () => {
    const values = ["ABC", "FGH", "BCDEFGHIJ", "GHIJKL"];
    for (const value of values) registerSecretValue(value, { allowShort: true });
    const stream = new RegisteredSecretStream();
    expect(stream.push("ABCDEFGHIJK") === "").toBe(true);
    const output = `${stream.push("L\n") ?? ""}${stream.finish()}`;
    expect(values.some((value) => output.includes(value))).toBe(false);
  });

  it("stops a carry above the limit without releasing its contents", () => {
    const left = "bounded-stream-review-left";
    const right = "bounded-stream-review-right";
    registerSecretValue(left + right);
    registerSecretValue(right + left);
    const secret = (left + right).repeat(700);
    const stream = new RegisteredSecretStream();
    expect(stream.push(secret.slice(0, 32_768)) === "").toBe(true);
    expect(stream.push(secret.slice(32_768)) === null).toBe(true);
    expect(stream.push("must remain stopped") === null).toBe(true);
    expect(stream.finish() === "[redacted]").toBe(true);
  });

  it("uses credentials registered after construction but before the first chunk", () => {
    const stream = new RegisteredSecretStream();
    const secret = "late-registration-review-credential";
    registerSecretValue(secret);
    const first = stream.push(secret.slice(0, 7));
    const second = stream.push(`${secret.slice(7)}\n`);
    expect(first === "").toBe(true);
    expect(second !== null).toBe(true);
    expect(`${first ?? ""}${second ?? ""}${stream.finish()}`.includes(secret)).toBe(false);
  });
});
