"use client";

import { useEffect, useState, type ReactNode } from "react";
import type {
  McpServerConnectionView,
  McpSettingsSnapshot,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { bffFetchJson } from "@/lib/http";
import {
  codingAppSessionPairingSettled,
  useCodingAppSessionRedemptions,
} from "@/lib/coding-app-session-client";
import { useSettingsTranslate as useTranslate, type I18nTranslate } from "./settings-i18n";

export function mcpConnectionStatus(
  state: McpServerConnectionView["state"] | "unavailable",
  count: number | null | undefined,
  t: I18nTranslate,
): string {
  if (state === "unavailable") return t("settings.mcp.statusUnavailable");
  if (state === "unsupported") return t("settings.mcp.localUnsupported");
  if (state === "connected") return t("settings.mcp.connected", { count: count ?? 0 });
  if (state === "disabled") return t("settings.mcp.disabled");
  if (state === "connecting") return t("settings.mcp.connecting");
  if (state === "failed") return t("settings.mcp.failed");
  return t("settings.mcp.unverified");
}

function AvailabilityRows({
  snapshot,
  t,
}: {
  readonly snapshot: McpSettingsSnapshot | undefined;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <ul>
      {snapshot?.servers.map((server) => {
        const connection = snapshot.connections?.find((entry) => entry.name === server.name);
        const status = !server.enabled ? "disabled" : (connection?.state ?? "idle");
        const label =
          server.enabled && connection?.authentication === "required"
            ? t("settings.mcp.authorizationRequired")
            : mcpConnectionStatus(status, connection?.toolCount, t);
        return (
          <li key={server.name} style={{ overflowWrap: "anywhere" }}>
            {server.name} · {label}
          </li>
        );
      })}
    </ul>
  );
}

/** A read-only projection of the central owner. This view never grants tool authority. */
export function McpServerAvailability(): ReactNode {
  const t = useTranslate();
  const [state, setState] = useState<{ snapshot?: McpSettingsSnapshot; failed?: boolean }>({});
  const [reload, setReload] = useState(0);
  const redemptions = useCodingAppSessionRedemptions();
  useEffect(() => {
    const controller = new AbortController();
    void codingAppSessionPairingSettled(controller.signal)
      .then(() =>
        bffFetchJson<McpSettingsSnapshot>("/api/mcp/servers", { signal: controller.signal }),
      )
      .then((snapshot) => {
        if (!controller.signal.aborted) setState({ snapshot });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ failed: true });
      });
    return (): void => controller.abort();
  }, [reload, redemptions]);
  const snapshot = state.snapshot;
  const loading = snapshot === undefined && state.failed !== true;
  return (
    <section aria-label={t("settings.mcp.title")} aria-busy={loading}>
      <strong>{t("settings.mcp.title")}</strong>
      <p>{t("settings.mcp.availability")}</p>
      {loading && <p>{t("settings.mcp.loading")}</p>}
      {state.failed === true && <output>{t("settings.mcp.statusUnavailable")}</output>}
      {snapshot?.servers.length === 0 && <p>{t("settings.mcp.emptyTitle")}</p>}
      <AvailabilityRows snapshot={snapshot} t={t} />
      <button
        type="button"
        disabled={loading}
        onClick={() => {
          setState({});
          setReload((value) => value + 1);
        }}
      >
        {t("settings.mcp.reload")}
      </button>
    </section>
  );
}
