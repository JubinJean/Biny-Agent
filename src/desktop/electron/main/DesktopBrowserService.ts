/**
 * 桌面端内嵌浏览器与 cookie 管理。
 *
 * 浏览器窗口跑在独立的持久 partition 上，用户在里面登录网站（Google、小红书……），登录态
 * 由 Electron 自己保存；同时这里把 cookie 同步写进共享 jar，`WebSearch` 的 Google provider
 * 和 `WebFetch` 就能读到同一份登录态 —— 登录一次，agent 侧直接可用。
 *
 * 几个刻意的选择：
 * - 用独立 partition 而不是默认 session：浏览的是任意站点，不能和应用自身的 session 混在一起；
 * - 浏览器窗口不挂应用 preload：那座桥是给渲染层用的，网页拿到就等于拿到主进程能力；
 * - cookie 变化后延迟合并再落盘：一次登录会连着触发几十次 changed 事件，逐次写盘没有意义。
 *
 * 导入导出用 Cookie-Editor 的 JSON 格式，用户可以和浏览器扩展互相搬运登录态。
 */
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { BrowserWindow, dialog, session, type Cookie, type CookiesSetDetails } from "electron";
import type { DesktopCookieJarStatus } from "../../protocol.js";
import type { BrowserAutomationEndpoint } from "../../../tools/browser.js";
import {
  parseCookieJar,
  serializeCookieJar,
  summarizeCookieJar,
  writeCookieJar,
  type StoredCookie
} from "../../../tools/web/cookieJar.js";

/** 独立的持久 partition：登录态跨重启保留，且与应用自身 session 完全隔离。 */
const browserPartition = "persist:biny-browser";
const homeUrl = "https://www.google.com";
/** 一次登录会连续触发大量 cookie 变化，攒一下再落盘。 */
const syncDebounceMs = 800;

export class DesktopBrowserService {
  private window: BrowserWindow | undefined;
  private automationServer: net.Server | undefined;
  private automationCredentials: BrowserAutomationEndpoint | undefined;
  /** 一个可见 BrowserWindow 对应一个上下文；来自不同 Runtime Host 的请求也必须在这里串行。 */
  private automationTail: Promise<void> = Promise.resolve();
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private syncTail = Promise.resolve();
  private cookieListenerAttached = false;
  /** 仅在本进程真的使用过这个 session 后才在退出时覆盖 jar，避免覆盖 CLI 新导入的内容。 */
  private browserSessionManaged = false;

  constructor(
    private readonly getJarPath: () => Promise<string>,
    private readonly assertCookieMutationAllowed: () => void = () => undefined
  ) {}

  /** 启动给 Runtime Host 使用的本地控制面；Unix socket 权限和随机令牌双重限制访问。 */
  async startAutomationServer(endpoint: string): Promise<BrowserAutomationEndpoint> {
    if (this.automationCredentials) return this.automationCredentials;
    try {
      await fs.unlink(endpoint);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const credentials = { endpoint, token: randomBytes(32).toString("hex") };
    const server = net.createServer((socket) => this.handleAutomationConnection(socket, credentials.token));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(endpoint);
    });
    await fs.chmod(endpoint, 0o600);
    this.automationServer = server;
    this.automationCredentials = credentials;
    return credentials;
  }

  /**
   * 打开浏览器窗口并导航到目标地址；窗口已存在则复用（再开一个只会让登录态看起来分裂）。
   * `url` 省略时打开首页。
   */
  async open(url?: string): Promise<void> {
    const target = url ?? homeUrl;
    this.attachCookieListener();
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      await this.window.loadURL(target);
      this.browserSessionManaged = true;
      return;
    }
    const window = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 480,
      minHeight: 400,
      title: "Biny 浏览器",
      show: false,
      webPreferences: {
        partition: browserPartition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    this.window = window;
    // 站内弹窗（OAuth 登录常用）留在同一个 partition 里开新窗口，否则登录流程会走不完。
    window.webContents.setWindowOpenHandler(({ url: requested }) => {
      if (!isHttpUrl(requested)) return { action: "deny" };
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 620,
          height: 760,
          webPreferences: { partition: browserPartition, contextIsolation: true, nodeIntegration: false, sandbox: true }
        }
      };
    });
    window.on("closed", () => {
      this.window = undefined;
      // 关窗时兜底同步一次：期间的 changed 事件可能还压在防抖窗口里没落盘。
      if (this.browserSessionManaged) void this.syncToJar();
    });
    window.once("ready-to-show", () => window.show());
    await window.loadURL(target);
    this.browserSessionManaged = true;
  }

  /** 把浏览器 session 里的 cookie 写进用户选定的文件（Cookie-Editor 可直接导入）。 */
  async exportToFile(parent: BrowserWindow | undefined): Promise<DesktopCookieJarStatus> {
    const cookies = await this.readSessionCookies();
    if (!cookies.length) throw new Error("浏览器里还没有可导出的 cookie。请先打开浏览器窗口登录网站。");
    const options: Electron.SaveDialogOptions = {
      title: "导出 Cookie",
      defaultPath: "biny-cookies.json",
      filters: [{ name: "Cookie JSON", extensions: ["json"] }]
    };
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return await this.status();
    this.assertCookieMutationAllowed();
    // 导出文件由用户自己保管，同样按 0600 落盘：里面是等同于登录凭据的东西。
    await fs.writeFile(result.filePath, serializeCookieJar(cookies), { encoding: "utf8", mode: 0o600 });
    await fs.chmod(result.filePath, 0o600);
    return await this.status();
  }

  /** 从 Cookie-Editor 导出的 JSON 导入登录态，写进浏览器 session 并同步到共享 jar。 */
  async importFromFile(parent: BrowserWindow | undefined): Promise<DesktopCookieJarStatus> {
    const options: Electron.OpenDialogOptions = {
      title: "导入 Cookie",
      filters: [{ name: "Cookie JSON", extensions: ["json"] }],
      properties: ["openFile"]
    };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) return await this.status();
    const cookies = parseCookieJar(await fs.readFile(filePath, "utf8"));
    this.assertCookieMutationAllowed();
    const browserSession = session.fromPartition(browserPartition);
    let imported = 0;
    const failures: string[] = [];
    for (const cookie of cookies) {
      try {
        await browserSession.cookies.set(toCookiesSetDetails(cookie));
        imported += 1;
      } catch (error) {
        failures.push(`${cookie.domain}${cookie.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!imported) {
      throw new Error(`没有导入任何 cookie。${failures[0] ?? ""}`);
    }
    this.browserSessionManaged = true;
    await this.syncToJar();
    return await this.status();
  }

  /** 清除浏览器 session 与共享 jar 里的全部 cookie（等同于在所有站点登出）。 */
  async clear(): Promise<DesktopCookieJarStatus> {
    this.assertCookieMutationAllowed();
    this.browserSessionManaged = true;
    await session.fromPartition(browserPartition).clearStorageData({ storages: ["cookies"] });
    await writeCookieJar(await this.getJarPath(), []);
    return await this.status();
  }

  async status(): Promise<DesktopCookieJarStatus> {
    const cookies = await this.readSessionCookies();
    let updatedAt: string | undefined;
    try {
      updatedAt = (await fs.stat(await this.getJarPath())).mtime.toISOString();
    } catch {
      updatedAt = undefined;
    }
    const summary = summarizeCookieJar(cookies, updatedAt);
    return { total: summary.total, domains: summary.domains.slice(0, 8), updatedAt: summary.updatedAt };
  }

  /** 退出前先把内存里的最新登录态落盘，再销毁浏览器窗口。 */
  async dispose(): Promise<void> {
    await this.stopAutomationServer();
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = undefined;
    if (this.browserSessionManaged) await this.syncToJar();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = undefined;
  }

  private async stopAutomationServer(): Promise<void> {
    const server = this.automationServer;
    this.automationServer = undefined;
    this.automationCredentials = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handleAutomationConnection(socket: net.Socket, token: string): void {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > 256 * 1024) {
        socket.destroy(new Error("Browser automation request is too large."));
        return;
      }
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void this.handleAutomationRequest(line, token, socket);
      }
    });
  }

  private async handleAutomationRequest(line: string, token: string, socket: net.Socket): Promise<void> {
    let id = "unknown";
    try {
      const request = asRecord(JSON.parse(line));
      id = readString(request.id, "id");
      if (request.token !== token) throw new Error("Browser automation authentication failed.");
      const method = readString(request.method, "method");
      const args = asRecord(request.args);
      const result = await this.enqueueAutomation(() => this.executeAutomation(method, args));
      socket.write(`${JSON.stringify({ id, ok: true, result })}\n`);
    } catch (error) {
      socket.write(`${JSON.stringify({ id, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }

  private enqueueAutomation<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const run = this.automationTail.then(operation, operation);
    this.automationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async executeAutomation(method: string, args: Record<string, unknown>): Promise<unknown> {
    if (method === "navigate") {
      const url = readString(args.url, "url");
      if (!isHttpUrl(url)) throw new Error("Browser navigation only supports HTTP and HTTPS URLs.");
      await this.open(url);
      return await this.pageState();
    }
    await this.ensureWindow();
    if (method === "read_dom") return await this.readDom(readNumber(args.maxCharacters, 24_000, 100_000));
    if (method === "click") return await this.click(readString(args.selector, "selector"));
    if (method === "fill") return await this.fill(readString(args.selector, "selector"), readString(args.value, "value"));
    if (method === "press") return await this.press(args.selector === undefined ? undefined : readString(args.selector, "selector"), readString(args.key, "key"));
    throw new Error(`Unsupported browser automation method: ${method}`);
  }

  private async ensureWindow(): Promise<BrowserWindow> {
    if (!this.window || this.window.isDestroyed()) await this.open();
    if (!this.window || this.window.isDestroyed()) throw new Error("Browser window is unavailable.");
    return this.window;
  }

  private async pageState(): Promise<{ url: string; title: string }> {
    const result = await this.evaluate("({ url: location.href, title: document.title })");
    const state = asRecord(result);
    return { url: readString(state.url, "url"), title: typeof state.title === "string" ? state.title : "" };
  }

  private async readDom(maxCharacters: number): Promise<unknown> {
    return await this.evaluate(`(() => {
      const cssPath = (element) => {
        if (element.id) return '#' + CSS.escape(element.id);
        const parts = [];
        let current = element;
        while (current && current.nodeType === 1 && parts.length < 6) {
          let part = current.tagName.toLowerCase();
          if (current.parentElement) {
            const siblings = Array.from(current.parentElement.children).filter((child) => child.tagName === current.tagName);
            if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
          }
          parts.unshift(part);
          current = current.parentElement;
        }
        return parts.join(' > ');
      };
      const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]')).slice(0, 200);
      return {
        url: location.href,
        title: document.title,
        text: (document.body?.innerText || '').slice(0, ${String(maxCharacters)}),
        interactive: nodes.map((element) => ({
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role') || undefined,
          name: element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.innerText?.trim().slice(0, 120) || undefined,
          selector: cssPath(element)
        }))
      };
    })()`);
  }

  private async click(selector: string): Promise<unknown> {
    return await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) throw new Error('No visible HTML element matched the selector.');
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.click();
      return { tag: element.tagName.toLowerCase(), text: element.innerText?.trim().slice(0, 200) || '' };
    })()`);
  }

  private async fill(selector: string, value: string): Promise<unknown> {
    return await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) throw new Error('No visible HTML element matched the selector.');
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.focus();
      if (element.isContentEditable) element.textContent = ${JSON.stringify(value)};
      else if ('value' in element) {
        const prototype = Object.getPrototypeOf(element);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor?.set) descriptor.set.call(element, ${JSON.stringify(value)});
        else element.value = ${JSON.stringify(value)};
      } else throw new Error('The matched element is not an editable field.');
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(value)} }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { tag: element.tagName.toLowerCase() };
    })()`);
  }

  private async press(selector: string | undefined, key: string): Promise<unknown> {
    if (selector) await this.evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) throw new Error('No visible HTML element matched the selector.'); element.focus(); })()`);
    await this.sendDebuggerCommand("Input.dispatchKeyEvent", { type: "keyDown", key, text: key.length === 1 ? key : undefined });
    await this.sendDebuggerCommand("Input.dispatchKeyEvent", { type: "keyUp", key });
    return await this.pageState();
  }

  private async evaluate(expression: string): Promise<unknown> {
    const result = asRecord(await this.sendDebuggerCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }));
    const exception = asRecord(result.exceptionDetails);
    if (Object.keys(exception).length) throw new Error(typeof exception.text === "string" ? exception.text : "Browser page evaluation failed.");
    const remote = asRecord(result.result);
    return remote.value;
  }

  private async sendDebuggerCommand(method: string, params: Record<string, unknown>): Promise<unknown> {
    const window = await this.ensureWindow();
    const debuggerSession = window.webContents.debugger;
    if (!debuggerSession.isAttached()) debuggerSession.attach("1.3");
    return await debuggerSession.sendCommand(method, params);
  }

  private async readSessionCookies(): Promise<StoredCookie[]> {
    const cookies = await session.fromPartition(browserPartition).cookies.get({});
    return cookies.map(toStoredCookie);
  }

  /**
   * 监听 cookie 变化，防抖后把整份 session cookie 覆盖写进 jar。
   * 只在首次打开浏览器时挂载，避免重复注册监听器。
   */
  private attachCookieListener(): void {
    if (this.cookieListenerAttached) return;
    this.cookieListenerAttached = true;
    session.fromPartition(browserPartition).cookies.on("changed", () => {
      this.browserSessionManaged = true;
      this.scheduleSyncToJar();
    });
  }

  private scheduleSyncToJar(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      void this.syncToJar();
    }, syncDebounceMs);
  }

  /** 覆盖写 jar。串行化是因为防抖兜底和关窗兜底可能同时触发，并发写会互相截断。 */
  private async syncToJar(): Promise<void> {
    const run = this.syncTail.then(async () => {
      try {
        this.assertCookieMutationAllowed();
      } catch {
        // 浏览器 session 可以继续登录，但共享 jar 必须保持本次 Agent 回合开始时的版本；
        // 等所有项目空闲后再同步最新整份 cookie，避免落下部分登录态。
        this.scheduleSyncToJar();
        return;
      }
      await writeCookieJar(await this.getJarPath(), await this.readSessionCookies());
    });
    this.syncTail = run.catch(() => undefined);
    await run.catch(() => undefined);
  }
}

function toStoredCookie(cookie: Cookie): StoredCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? "",
    path: cookie.path ?? "/",
    secure: cookie.secure ?? false,
    httpOnly: cookie.httpOnly ?? false,
    sameSite: toStoredSameSite(cookie.sameSite),
    expirationDate: cookie.expirationDate,
    hostOnly: cookie.hostOnly,
    session: cookie.session ?? cookie.expirationDate === undefined
  };
}

/**
 * 还原成 `cookies.set` 需要的形状。它要的是 URL 而不是 domain，所以按 domain 反推一个：
 * 前导点表示包含子域名，去掉点即可；secure 决定用 https 还是 http。
 */
function toCookiesSetDetails(cookie: StoredCookie): CookiesSetDetails {
  const host = cookie.domain.replace(/^\./, "");
  return {
    url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path}`,
    name: cookie.name,
    value: cookie.value,
    // hostOnly 的 cookie 不能带 domain，否则 Electron 会把它变成包含子域名的形式。
    domain: cookie.hostOnly ? undefined : cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expirationDate: cookie.expirationDate,
    sameSite: toElectronSameSite(cookie.sameSite)
  };
}

function toStoredSameSite(value: Cookie["sameSite"]): StoredCookie["sameSite"] {
  if (value === "no_restriction") return "no_restriction";
  if (value === "lax") return "lax";
  if (value === "strict") return "strict";
  return "unspecified";
}

function toElectronSameSite(value: StoredCookie["sameSite"]): CookiesSetDetails["sameSite"] {
  if (value === "no_restriction") return "no_restriction";
  if (value === "lax") return "lax";
  if (value === "strict") return "strict";
  return "unspecified";
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Browser automation requires ${name}.`);
  return value;
}

function readNumber(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Browser automation ${String(value)} is outside the supported range.`);
  }
  return value;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
