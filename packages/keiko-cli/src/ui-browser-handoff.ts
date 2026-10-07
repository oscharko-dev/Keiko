import { CODING_APP_SESSION_LAUNCHER_SECRET_ENV } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";
import { defaultOpenExternal, performBrowserHandoff } from "./lifecycle.js";
import { emitBrowserHandoff } from "./lifecycle-browser-activity.js";
import type { CliIo } from "./runner.js";
import { KEIKO_UI_LAUNCH_ID_ENV, takeBrowserOpenRequest } from "./state-paths.js";

export function createBrowserHandoffPoll(input: {
  readonly stateDir: string;
  readonly pid: number;
  readonly env: EnvSource;
  readonly baseUrl: string;
  readonly io: CliIo;
  readonly sink: SecurityLogSink | undefined;
  readonly openExternal?: (url: string) => void | Promise<void>;
}): () => void {
  let busy = false;
  return (): void => {
    const launchId = input.env[KEIKO_UI_LAUNCH_ID_ENV];
    const secret = input.env[CODING_APP_SESSION_LAUNCHER_SECRET_ENV];
    if (busy || launchId === undefined || secret === undefined) return;
    try {
      if (!takeBrowserOpenRequest(input.stateDir, input.pid, launchId)) return;
      busy = true;
      const open =
        input.openExternal ??
        ((url: string): Promise<void> => defaultOpenExternal(url, process.platform, input.env));
      void performBrowserHandoff(input.baseUrl, input.io, open, input.sink, secret).finally(() => {
        busy = false;
      });
    } catch (error) {
      emitBrowserHandoff(input.sink, { outcome: "failed", attestationProvided: false, error });
    }
  };
}
