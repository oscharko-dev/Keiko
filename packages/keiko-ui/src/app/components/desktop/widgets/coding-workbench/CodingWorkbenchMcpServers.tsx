"use client";

import type { ReactNode } from "react";
import type {
  CodingWorkbenchMcpServer,
  CodingWorkbenchMcpServerStatus,
} from "@oscharko-dev/keiko-contracts";
import {
  useCodingWorkbenchMcp,
  type CodingWorkbenchMcpAuthorization,
  type UseCodingWorkbenchMcpResult,
} from "@/lib/useCodingWorkbenchMcp";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import type { CodingWorkbenchMessageKey } from "./coding-workbench-i18n.en";
import styles from "./CodingWorkbenchWindow.module.css";

const MCP_LABEL_ID = "coding-workbench-mcp-label";

const STATUS_LABELS: Readonly<Record<CodingWorkbenchMcpServerStatus, CodingWorkbenchMessageKey>> = {
  connected: "codingWorkbench.mcp.status.connected",
  "needs-authorization": "codingWorkbench.mcp.status.needsAuthorization",
  failed: "codingWorkbench.mcp.status.failed",
  disabled: "codingWorkbench.mcp.status.disabled",
  pending: "codingWorkbench.mcp.status.pending",
};

type SettledOutcome = Extract<CodingWorkbenchMcpAuthorization, { phase: "settled" }>["outcome"];

const OUTCOME_LABELS: Readonly<Record<SettledOutcome, CodingWorkbenchMessageKey>> = {
  complete: "codingWorkbench.mcp.authorized",
  failed: "codingWorkbench.mcp.authorizationFailed",
  expired: "codingWorkbench.mcp.authorizationExpired",
  "url-refused": "codingWorkbench.mcp.refused.urlRefused",
  unavailable: "codingWorkbench.mcp.refused.unavailable",
  connected: "codingWorkbench.mcp.refused.connected",
  "not-oauth": "codingWorkbench.mcp.refused.notOauth",
};

/**
 * #3903 AC3 — a live run's MCP servers with their status, and the human's OAuth authorization of
 * one that needs it. The authorization page is the one Keiko validated against the operator's
 * expected issuer; it opens in a new tab, and the runtime's own callback completes it.
 */
export function CodingWorkbenchMcpServers({
  runId,
  revision,
}: {
  readonly runId: string | undefined;
  readonly revision: number | undefined;
}): ReactNode {
  const mcp = useCodingWorkbenchMcp({ runId, revision });
  return <McpServersView mcp={mcp} />;
}

export function McpServersView({ mcp }: { readonly mcp: UseCodingWorkbenchMcpResult }): ReactNode {
  const t = useCodingWorkbenchTranslate();
  if (mcp.status === "unavailable") {
    return (
      <p className={styles["cmp-skills-unavailable"]} role="note">
        {t("codingWorkbench.mcp.unavailable")}{" "}
        <button type="button" onClick={mcp.retry}>
          {t("codingWorkbench.mcp.retry")}
        </button>
      </p>
    );
  }
  if (mcp.servers.length === 0) return null;
  return (
    <details className={styles["cmp-skills-disclosure"]} open={needsAttention(mcp)}>
      <summary className={styles["cmp-skills-summary"]} id={MCP_LABEL_ID}>
        {t("codingWorkbench.mcp.summary", { count: mcp.servers.length })}
      </summary>
      <ul className={styles["cmp-skills-list"]} aria-labelledby={MCP_LABEL_ID}>
        {mcp.servers.map((server) => (
          <ServerRow key={server.name} server={server} mcp={mcp} t={t} />
        ))}
      </ul>
    </details>
  );
}

function needsAttention(mcp: UseCodingWorkbenchMcpResult): boolean {
  return (
    mcp.authorization !== undefined ||
    mcp.servers.some((server) => server.status === "needs-authorization")
  );
}

function ServerRow({
  server,
  mcp,
  t,
}: {
  readonly server: CodingWorkbenchMcpServer;
  readonly mcp: UseCodingWorkbenchMcpResult;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const authorization = mcp.authorization?.server === server.name ? mcp.authorization : undefined;
  return (
    <li className={styles["cmp-skill-row"]}>
      <span className={styles["cmp-skill-id"]}>{server.name}</span>
      <span className={styles["cmp-skill-readiness"]}>{t(STATUS_LABELS[server.status])}</span>
      <AuthorizationControl server={server} authorization={authorization} mcp={mcp} t={t} />
    </li>
  );
}

function AuthorizationControl({
  server,
  authorization,
  mcp,
  t,
}: {
  readonly server: CodingWorkbenchMcpServer;
  readonly authorization: CodingWorkbenchMcpAuthorization | undefined;
  readonly mcp: UseCodingWorkbenchMcpResult;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  if (authorization?.phase === "waiting") {
    return (
      <span className={styles["cmp-skill-category"]}>
        <a href={authorization.authorizationUrl} target="_blank" rel="noopener noreferrer">
          {t("codingWorkbench.mcp.openAuthorization")}
        </a>{" "}
        <output>{t("codingWorkbench.mcp.authorizing")}</output>{" "}
        <button type="button" onClick={mcp.cancel}>
          {t("codingWorkbench.mcp.cancel")}
        </button>
      </span>
    );
  }
  const settled =
    authorization?.phase === "settled" ? t(OUTCOME_LABELS[authorization.outcome]) : undefined;
  const authorizable = server.authorization === "oauth" && server.status === "needs-authorization";
  return (
    <span className={styles["cmp-skill-category"]}>
      {settled === undefined ? null : <output>{settled}</output>}{" "}
      {authorizable ? (
        <button
          type="button"
          disabled={authorization?.phase === "starting"}
          aria-label={t("codingWorkbench.mcp.authorizeLabel", { server: server.name })}
          onClick={() => {
            mcp.authorize(server.name);
          }}
        >
          {t("codingWorkbench.mcp.authorize")}
        </button>
      ) : null}
    </span>
  );
}
