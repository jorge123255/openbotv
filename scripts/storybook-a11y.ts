import type { AxeResults, RunOptions } from "axe-core";
import type { Page } from "playwright-core";
import type { ChannelLike } from "storybook/internal/channels";

declare global {
  interface Window {
    __STORYBOOK_ADDONS_CHANNEL__?: Pick<ChannelLike, "on" | "off" | "emit" | "listenerCount">;
  }
}

/** Uses the installed accessibility addon's queue, shared with its automatic story scans. */
export function runStorybookA11y(page: Page, selector: string, options: RunOptions): Promise<AxeResults> {
  return page.evaluate(
    ({ selector, options }) =>
      new Promise<AxeResults>((resolve, reject) => {
        const channel = window.__STORYBOOK_ADDONS_CHANNEL__;
        if (!channel?.listenerCount("storybook/a11y/manual")) {
          reject(new Error("The Storybook accessibility addon is not ready."));
          return;
        }
        // The addon returns this ID with the result. Distinct IDs keep concurrent requests separate.
        const requestId = `openbot-a11y-${crypto.randomUUID()}`;
        const cleanup = () => {
          window.clearTimeout(deadline);
          channel.off("storybook/a11y/result", completed);
          channel.off("storybook/a11y/error", failed);
        };
        const completed = (result: AxeResults, id: string) => {
          if (id !== requestId) return;
          cleanup();
          resolve(result);
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        const deadline = window.setTimeout(
          () => failed(new Error("The Storybook accessibility scan did not finish.")),
          30_000,
        );
        channel.on("storybook/a11y/result", completed);
        channel.on("storybook/a11y/error", failed);
        try {
          channel.emit("storybook/a11y/manual", requestId, { context: selector, options });
        } catch (error) {
          cleanup();
          reject(error);
        }
      }),
    { selector, options },
  );
}
