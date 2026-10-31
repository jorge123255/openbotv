import { BrowserWindow, session as electronSession, shell } from "electron";

/**
 * The Grok Bot computer screen: BotAI's "BotAI's Computer" noVNC viewer, in its own window.
 *
 * BotAI embeds the viewer in a `<webview>` on the `persist:sand-forever-box` partition and injects
 * `x-anyrun-network-token` on every request (`source/electron-main/vnc/vnc-trust.ts`). OpenBot keeps
 * `webviewTag` off, so the viewer gets a sandboxed window on the same kind of dedicated partition:
 * no preload, no node, no other OpenBot storage. Navigation is pinned to the viewer's origin.
 */
const GROK_BOT_COMPUTER_PARTITION = "persist:grok-bot-computer";
const WIDTH = 1280;
const HEIGHT = 840;

export class GrokBotComputerWindow {
  #window: BrowserWindow | null = null;
  #tokens = new Map<string, string>();
  #configured = false;

  /** Shows the screen. The same window is reused and pointed at the newest URL. */
  open(vncUrl: string, networkToken: string | null, title: string): void {
    const url = new URL(vncUrl);
    if (url.protocol !== "https:") throw new Error("Grok Bot computer screen must be https.");
    if (networkToken) this.#tokens.set(url.host, networkToken);
    const session = this.#session();
    const current = this.#window;
    if (current && !current.isDestroyed()) {
      if (current.webContents.getURL() !== vncUrl) void current.loadURL(vncUrl);
      current.show();
      current.focus();
      return;
    }
    const window = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      title,
      show: true,
      backgroundColor: "#000000",
      webPreferences: {
        session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
      },
    });
    const origin = url.origin;
    window.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:\/\//iu.test(target)) void shell.openExternal(target);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, target) => {
      if (URL.parse(target)?.origin !== origin) event.preventDefault();
    });
    window.webContents.on("page-title-updated", (event) => event.preventDefault());
    window.on("closed", () => {
      if (this.#window === window) this.#window = null;
    });
    this.#window = window;
    void window.loadURL(vncUrl);
  }

  isOpen(): boolean {
    return this.#window !== null && !this.#window.isDestroyed();
  }

  close(): void {
    const window = this.#window;
    this.#window = null;
    if (window && !window.isDestroyed()) window.destroy();
  }

  #session() {
    const session = electronSession.fromPartition(GROK_BOT_COMPUTER_PARTITION);
    if (this.#configured) return session;
    this.#configured = true;
    session.webRequest.onBeforeSendHeaders((details, callback) => {
      const host = URL.parse(details.url)?.host;
      const token = host ? this.#tokens.get(host) : undefined;
      const requestHeaders = { ...details.requestHeaders };
      if (token) requestHeaders["x-anyrun-network-token"] = token;
      callback({ requestHeaders });
    });
    // The viewer needs the clipboard for copy/paste into the box; nothing else.
    session.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(permission === "clipboard-read" || permission === "clipboard-sanitized-write"),
    );
    session.on("will-download", (event) => event.preventDefault());
    return session;
  }
}
