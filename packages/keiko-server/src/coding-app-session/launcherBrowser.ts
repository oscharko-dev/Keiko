import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { resolveWindowsUrlOpener, type WindowsBrowserApp } from "@oscharko-dev/keiko-security";
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session-pairing";
import {
  mintLauncherPairingAttestation,
  SESSION_PAIRING_LAUNCHER_SECRET_ENV,
} from "./launcherSessionPairingPort.js";

const BROWSERS = new Set(["default", "chrome", "firefox", "edge", "safari"] as const);
export type LauncherBrowserTarget = "default" | "chrome" | "firefox" | "edge" | "safari";
export type LauncherBrowserOutcome = "opened" | "busy" | "unavailable" | "failed";
export interface LauncherBrowser {
  readonly open: (target: LauncherBrowserTarget, origin: string) => Promise<LauncherBrowserOutcome>;
}
export function isLauncherBrowserTarget(value: unknown): value is LauncherBrowserTarget {
  return typeof value === "string" && BROWSERS.has(value as LauncherBrowserTarget);
}

/** Only an exact loopback origin at the server-owned public port may receive launcher proof. */
function ownsOrigin(origin: string, port: number): boolean {
  return ["localhost", "127.0.0.1"].some((host) => origin === `http://${host}:${String(port)}`);
}

export function createLauncherBrowser(input: {
  readonly secret: string;
  readonly port: number;
  readonly open: (target: LauncherBrowserTarget, url: string) => Promise<void>;
  readonly now?: () => number;
}): LauncherBrowser {
  const now = input.now ?? ((): number => performance.now());
  let nextOpen = Number.NEGATIVE_INFINITY;
  let opening = false;
  return {
    async open(target, origin): Promise<LauncherBrowserOutcome> {
      if (!isLauncherBrowserTarget(target) || !ownsOrigin(origin, input.port)) return "unavailable";
      const time = now();
      if (opening || time < nextOpen) return "busy";
      nextOpen = time + 10_000;
      opening = true;
      try {
        const proof = mintLauncherPairingAttestation({
          secret: input.secret,
          requestId: `req_open-${randomUUID()}`,
          issuedAtMs: Date.now(),
        });
        await input.open(target, `${origin}/${encodeCodingAppSessionPairingFragment(proof)}`);
        return "opened";
      } catch {
        // Native errors may include the proof-bearing URL. Only a closed outcome leaves this port.
        throw new TypeError("Browser launcher failed");
      } finally {
        opening = false;
      }
    },
  };
}

/** No shell, caller-selected executable, URL destination, or extra arguments. */
export function nativeBrowserCommand(
  target: LauncherBrowserTarget,
  url: string,
  platform: NodeJS.Platform,
): { command: string; args: string[]; timeoutMs?: number } | undefined {
  if (platform === "darwin") {
    const ids = {
      chrome: "com.google.Chrome",
      firefox: "org.mozilla.firefox",
      edge: "com.microsoft.edgemac",
      safari: "com.apple.Safari",
    };
    return {
      command: "/usr/bin/open",
      args: target === "default" ? [url] : ["-b", ids[target], url],
    };
  }
  if (platform === "win32") {
    if (target === "safari") return undefined;
    const apps: Record<Exclude<LauncherBrowserTarget, "safari">, WindowsBrowserApp | undefined> = {
      default: undefined,
      chrome: "chrome.exe",
      firefox: "firefox.exe",
      edge: "msedge.exe",
    };
    const app = apps[target];
    // The shared Windows opener bounds `Start-Process` from the program's first statement and the
    // inbox PowerShell host start separately (#4358); 5 s for both killed it before it ran.
    const opener = resolveWindowsUrlOpener(url, process.env, app);
    return { command: opener.command, args: [...opener.args], timeoutMs: opener.timeoutMs };
  }
  if (platform !== "linux" || target === "safari") return undefined;
  return {
    command: {
      default: "xdg-open",
      chrome: "google-chrome",
      firefox: "firefox",
      edge: "microsoft-edge",
    }[target],
    args: [url],
  };
}

function desktopEnvironment(): NodeJS.ProcessEnv {
  // Browser processes need their desktop environment, never Keiko's launcher or provider secrets.
  return Object.fromEntries(
    [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "SystemRoot",
      "SYSTEMROOT",
      "WINDIR",
      "TEMP",
      "TMP",
      "DISPLAY",
      "WAYLAND_DISPLAY",
      "XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
    ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  );
}

function openNativeBrowser(target: LauncherBrowserTarget, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = nativeBrowserCommand(target, url, process.platform);
    if (command === undefined) {
      reject(new TypeError("Browser opener unavailable"));
      return;
    }
    const env = desktopEnvironment();
    if (process.platform === "linux") {
      // A browser binary may own its window for hours. Bound the spawn acknowledgement, never kill
      // the launched browser when the short handoff budget ends.
      const child = spawn(command.command, command.args, {
        shell: false,
        detached: true,
        stdio: "ignore",
        env,
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new TypeError("Browser opener timed out"));
      }, 5_000);
      child.once("error", () => {
        clearTimeout(timer);
        reject(new TypeError("Browser opener failed"));
      });
      child.once("spawn", () => {
        clearTimeout(timer);
        child.unref();
        resolve();
      });
      return;
    }
    execFile(
      command.command,
      command.args,
      { shell: false, timeout: command.timeoutMs ?? 5_000, maxBuffer: 1024, env },
      (error) => {
        if (error === null) resolve();
        else reject(new TypeError("Browser opener failed"));
      },
    );
  });
}

export function resolveLauncherBrowser(env: EnvSource): LauncherBrowser | undefined {
  const secret = env[SESSION_PAIRING_LAUNCHER_SECRET_ENV];
  const port = Number(env.KEIKO_UI_PORT);
  if (
    env.NODE_ENV === "test" ||
    secret === undefined ||
    secret.length < 32 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    return undefined;
  return createLauncherBrowser({
    secret,
    port,
    open: openNativeBrowser,
  });
}
