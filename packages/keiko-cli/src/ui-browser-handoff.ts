import { CODING_APP_SESSION_LAUNCHER_SECRET_ENV } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";
import { randomUUID } from "node:crypto";
import {
  withActivityLogCorrelation,
  withActivityLogParentCorrelation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { defaultOpenExternal, performBrowserHandoff } from "./lifecycle.js";
import { emitBrowserHandoff } from "./lifecycle-browser-activity.js";
import type { CliIo } from "./runner.js";
import {
  KEIKO_UI_LAUNCH_ID_ENV,
  takeBrowserOpenRequest,
  type BrowserOpenRequestOutcome,
} from "./state-paths.js";

interface BrowserHandoffPollInput {
  readonly stateDir: string;
  readonly pid: number;
  readonly env: EnvSource;
  readonly baseUrl: string;
  readonly io: CliIo;
  readonly sink: SecurityLogSink | undefined;
  readonly openExternal?: (url: string) => void | Promise<void>;
}

export function createBrowserHandoffPoll(input: BrowserHandoffPollInput): () => void {
  let busy = false;
  let refused: string | undefined;
  return (): void => {
    const launchId = input.env[KEIKO_UI_LAUNCH_ID_ENV];
    const secret = input.env[CODING_APP_SESSION_LAUNCHER_SECRET_ENV];
    if (busy || launchId === undefined || secret === undefined) return;
    try {
      const request = takeBrowserOpenRequest(input.stateDir, input.pid, launchId);
      if (request.state === "refused") {
        if (refused !== request.reason)
          emitBrowserHandoff(handoffSink(input.sink), {
            outcome: "refused",
            attestationProvided: false,
            reason: request.reason,
          });
        refused = request.reason;
        return;
      }
      refused = undefined;
      if (request.state === "absent") return;
      busy = true;
      void openRequestedBrowser(input, request, secret).finally(() => {
        busy = false;
      });
    } catch (error) {
      busy = false;
      emitBrowserHandoff(handoffSink(input.sink), {
        outcome: "failed",
        attestationProvided: false,
        error,
      });
    }
  };
}

async function openRequestedBrowser(
  input: BrowserHandoffPollInput,
  request: Extract<BrowserOpenRequestOutcome, { state: "accepted" }>,
  secret: string,
): Promise<void> {
  const sink = handoffSink(input.sink, request.correlationId);
  try {
    const open =
      input.openExternal ??
      ((url: string): Promise<void> => defaultOpenExternal(url, process.platform, input.env));
    const baseUrl = new URL(input.baseUrl);
    if (request.host !== undefined) baseUrl.hostname = request.host;
    await performBrowserHandoff(baseUrl.origin, input.io, open, sink, secret);
  } catch (error) {
    emitBrowserHandoff(sink, { outcome: "failed", attestationProvided: false, error });
  }
}

function handoffSink(
  sink: SecurityLogSink | undefined,
  parentCorrelationId?: string,
): SecurityLogSink | undefined {
  if (sink === undefined) return undefined;
  const correlationId = randomUUID();
  return {
    write(event): void {
      const child = withActivityLogCorrelation(event, correlationId);
      sink.write(
        parentCorrelationId === undefined
          ? child
          : withActivityLogParentCorrelation(child, parentCorrelationId),
      );
    },
  };
}
