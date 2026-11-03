"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  parseCodingWorkbenchMcpAuthorizationStart,
  parseCodingWorkbenchMcpAuthorizationStatus,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { bffFetchJson } from "@/lib/http";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
import { useSettingsTranslate as useTranslate } from "./settings-i18n";
interface Props {
  readonly name: string;
  readonly authorized: boolean;
  readonly onChange: () => void;
}
interface Pending {
  readonly id: string;
  readonly url: string;
}
type Action = "start" | "cancel" | "revoke";
function diagnostic(error: unknown): void {
  reportClientDiagnostic(`[keiko] mcp authorization failed: ${clientErrorSummary(error)}`, {
    correlationId: correlationIdOf(error),
  });
}
async function request(
  path: string,
  action: Action,
  pending: Pending | undefined,
): Promise<Pending | undefined> {
  if (action === "start") {
    const answer = parseCodingWorkbenchMcpAuthorizationStart(
      await bffFetchJson(path, { method: "POST" }),
    );
    if (answer?.outcome !== "started") throw new Error("MCP authorization unavailable");
    return { id: answer.attemptId, url: answer.authorizationUrl };
  }
  await bffFetchJson(`${path}/${action}`, {
    method: "POST",
    ...(pending === undefined ? {} : { body: JSON.stringify({ attemptId: pending.id }) }),
  });
  return undefined;
}
function useObservation(
  pending: Pending | undefined,
  path: string,
  settled: (success: boolean) => void,
): void {
  const completed = useRef(settled);
  completed.current = settled;
  useEffect(() => {
    if (pending === undefined) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      try {
        const answer = parseCodingWorkbenchMcpAuthorizationStatus(
          await bffFetchJson(`${path}/status`, {
            method: "POST",
            body: JSON.stringify({ attemptId: pending.id }),
            signal: controller.signal,
          }),
        );
        if (controller.signal.aborted) return;
        if (answer?.state === "pending") {
          timer = setTimeout(() => {
            void poll();
          }, 2000);
          return;
        }
        completed.current(answer?.state === "complete");
      } catch (error) {
        if (!controller.signal.aborted) {
          diagnostic(error);
          completed.current(false);
        }
      }
    };
    void poll();
    return (): void => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [pending, path]);
}
function useAuthorization(props: Props): {
  readonly pending: Pending | undefined;
  readonly failed: boolean;
  readonly busy: boolean;
  readonly perform: (action: Action) => Promise<void>;
} {
  const [pending, setPending] = useState<Pending>();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const path = `/api/mcp/servers/${encodeURIComponent(props.name)}/authorization`;
  useObservation(pending, path, (success) => {
    setPending(undefined);
    setFailed(!success);
    props.onChange();
  });
  const perform = async (action: Action): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setFailed(false);
    try {
      setPending(await request(path, action, pending));
      if (action !== "start") props.onChange();
    } catch (error) {
      diagnostic(error);
      setFailed(true);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return { pending, failed, busy, perform };
}
export function McpServerAuthorization(props: Props): ReactNode {
  const t = useTranslate();
  const { pending, failed, busy, perform } = useAuthorization(props);
  return (
    <div>
      <output>
        {t(props.authorized ? "settings.mcp.authorized" : "settings.mcp.authorizationRequired")}
      </output>{" "}
      {pending === undefined ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void perform(props.authorized ? "revoke" : "start");
          }}
        >
          {t(props.authorized ? "settings.mcp.signOut" : "settings.mcp.signIn")}
        </button>
      ) : (
        <>
          <a href={pending.url} target="_blank" rel="noopener noreferrer">
            {t("settings.mcp.openAuthorization")}
          </a>{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void perform("cancel");
            }}
          >
            {t("settings.mcp.cancel")}
          </button>
        </>
      )}
      {failed && <p role="alert">{t("settings.mcp.authorizationFailed")}</p>}
    </div>
  );
}
