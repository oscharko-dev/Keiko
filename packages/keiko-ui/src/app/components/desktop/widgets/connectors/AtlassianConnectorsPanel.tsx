"use client";

import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
// Issue #2245 (Epic #2238, ADR-0128) — the Atlassian connector management surface.
//
// Top-level composition: lists configured connectors (provider, label, base URL, added-at, health
// from the last verify), hosts the add-connector flow (write-only token + inline verify), exposes
// per-connector scope selection and sync, and renders the write-action approval surface. The API
// client is injectable (`client` prop) so tests substitute a mock; production binds the real
// same-origin BFF client.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import {
  ATLASSIAN_CONNECTORS_CHANGED_EVENT,
  defaultAtlassianConnectorsClient,
  type AtlassianConnectorMetadata,
  type AtlassianConnectorsClient,
} from "@/lib/atlassian-connectors-api";
import { AddConnectorForm } from "./AddConnectorForm";
import { ConnectorApprovalsPanel } from "./ConnectorApprovalsPanel";
import { ConnectorCard } from "./ConnectorCard";
import styles from "./connectors.module.css";

export interface AtlassianConnectorsPanelProps {
  readonly client?: AtlassianConnectorsClient;
  readonly pollIntervalMs?: number;
  readonly jiraLive?: boolean;
}

interface ConnectorsController {
  readonly reload: () => void;
  readonly connectors: readonly AtlassianConnectorMetadata[];
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly onCreated: (metadata: AtlassianConnectorMetadata) => void;
  readonly onDeleted: (authRef: string) => void;
}

interface ConnectorListState {
  readonly connectors: readonly AtlassianConnectorMetadata[];
  readonly loading: boolean;
  readonly error?: string;
}
function useCredentialChanges(reload: () => void): void {
  useEffect(() => {
    window.addEventListener(ATLASSIAN_CONNECTORS_CHANGED_EVENT, reload);
    window.addEventListener("focus", reload);
    return (): void => {
      window.removeEventListener(ATLASSIAN_CONNECTORS_CHANGED_EVENT, reload);
      window.removeEventListener("focus", reload);
    };
  }, [reload]);
}
function useConnectors(client: AtlassianConnectorsClient): ConnectorsController {
  const t = useTranslate();
  const fallback = t("atlassianConnectors.retry");
  const requestRevision = useRef(0);
  const [view, setView] = useState<ConnectorListState>({ connectors: [], loading: true });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    const request = ++requestRevision.current;
    const current = (): boolean => active && request === requestRevision.current;
    setView((old) => ({ connectors: old.connectors, loading: true }));
    client
      .listConnectors()
      .then((connectors) => {
        if (current()) setView({ connectors, loading: false });
      })
      .catch(() => {
        if (current()) setView((old) => ({ ...old, loading: false, error: fallback }));
      });
    return (): void => {
      active = false;
    };
  }, [client, revision, fallback]);
  return {
    ...view,
    error: view.error,
    onCreated: (metadata): void => {
      requestRevision.current += 1;
      setView((old) => ({
        connectors: [metadata, ...old.connectors.filter((c) => c.authRef !== metadata.authRef)],
        loading: false,
      }));
    },
    onDeleted: (authRef): void => {
      requestRevision.current += 1;
      setView((old) => ({
        connectors: old.connectors.filter((c) => c.authRef !== authRef),
        loading: false,
      }));
    },
    reload: (): void => {
      requestRevision.current += 1;
      setRevision((value) => value + 1);
    },
  };
}
function ConnectorList({
  connectors,
  client,
  ctrl,
  pollIntervalMs,
  embedded,
}: {
  readonly connectors: readonly AtlassianConnectorMetadata[];
  readonly client: AtlassianConnectorsClient;
  readonly ctrl: ConnectorsController;
  readonly pollIntervalMs: number | undefined;
  readonly embedded: boolean;
}): ReactNode {
  return (
    <ul className={`acx-list ${styles.cmpPodList}`}>
      {connectors.map((connector) => (
        <ConnectorCard
          key={connector.authRef}
          connector={connector}
          client={client}
          onDeleted={ctrl.onDeleted}
          onUpdated={ctrl.onCreated}
          embedded={embedded}
          {...(pollIntervalMs === undefined ? {} : { pollIntervalMs })}
        />
      ))}
    </ul>
  );
}

function AddConnectorButton({
  jiraLive,
  setAdding,
}: {
  readonly jiraLive: boolean;
  readonly setAdding: (adding: boolean) => void;
}): ReactNode {
  const t = useTranslate();
  return (
    <button
      type="button"
      className={
        jiraLive
          ? `lk-btn lk-btn-primary lk-btn-lg ${styles.cmpCreatePodButton}`
          : "lk-btn lk-btn-primary"
      }
      onClick={() => setAdding(true)}
    >
      {t(jiraLive ? "atlassianConnectors.live.add" : "atlassianConnectors.add.open")}
    </button>
  );
}

function AddConnectorAction({
  client,
  ctrl,
  jiraLive,
  adding,
  setAdding,
}: {
  readonly client: AtlassianConnectorsClient;
  readonly ctrl: ConnectorsController;
  readonly jiraLive: boolean;
  readonly adding: boolean;
  readonly setAdding: (adding: boolean) => void;
}): ReactNode {
  if (adding)
    return (
      <AddConnectorForm
        client={client}
        onCreated={ctrl.onCreated}
        jiraLive={jiraLive}
        onClose={() => {
          setAdding(false);
          ctrl.reload();
        }}
      />
    );
  if (jiraLive) return null;
  return (
    <div className="acx-actions">
      <AddConnectorButton jiraLive={false} setAdding={setAdding} />
    </div>
  );
}

function ConnectorsHeading({
  jiraLive,
  headingId,
  adding,
  setAdding,
}: {
  readonly jiraLive: boolean;
  readonly headingId: string;
  readonly adding: boolean;
  readonly setAdding: (adding: boolean) => void;
}): ReactNode {
  const t = useTranslate();
  if (!jiraLive)
    return (
      <h2 className="acx-section-title" id={headingId}>
        {t("atlassianConnectors.section.connectors")}
      </h2>
    );
  return (
    <header className={`lk-header ${styles.cmpEmbeddedToolbar}`}>
      <h2 className={`lk-title ${styles.cmpPodTitle}`} id={headingId}>
        {t("atlassianConnectors.live.title")}
      </h2>
      {adding ? null : <AddConnectorButton jiraLive setAdding={setAdding} />}
    </header>
  );
}

function ConnectorsFeedback({
  state,
  empty,
  jiraLive,
}: {
  readonly state: Pick<ConnectorsController, "error" | "loading">;
  readonly empty: boolean;
  readonly jiraLive: boolean;
}): ReactNode {
  const t = useTranslate();
  return (
    <>
      {state.error !== undefined ? (
        <p className="acx-error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.loading ? <p className="acx-muted">{t("atlassianConnectors.loading")}</p> : null}
      {!state.loading && empty ? (
        <p className={`acx-empty ${styles.cmpPodEmpty}`}>
          {t(jiraLive ? "atlassianConnectors.live.empty" : "atlassianConnectors.empty")}
        </p>
      ) : null}
    </>
  );
}

function ConnectorsSection({
  client,
  pollIntervalMs,
  jiraLive,
}: {
  readonly client: AtlassianConnectorsClient;
  readonly pollIntervalMs: number | undefined;
  readonly jiraLive: boolean;
}): ReactNode {
  const ctrl = useConnectors(client);
  useCredentialChanges(ctrl.reload);
  const headingId = useId();
  const connectors = ctrl.connectors.filter(
    (item) => !jiraLive || (item.deployment === "data-center" && item.livePod !== undefined),
  );
  const [adding, setAdding] = useState(false);
  return (
    <section className={`acx-section ${styles.cmpPodSection}`} aria-labelledby={headingId}>
      <ConnectorsHeading
        jiraLive={jiraLive}
        headingId={headingId}
        adding={adding}
        setAdding={setAdding}
      />
      <ConnectorsFeedback
        state={ctrl}
        empty={connectors.length === 0 && !adding}
        jiraLive={jiraLive}
      />
      <ConnectorList
        connectors={connectors}
        client={client}
        ctrl={ctrl}
        pollIntervalMs={pollIntervalMs}
        embedded={jiraLive}
      />
      <AddConnectorAction
        client={client}
        ctrl={ctrl}
        jiraLive={jiraLive}
        adding={adding}
        setAdding={setAdding}
      />
    </section>
  );
}

/**
 * The Jira Live Pods section of the Knowledge Pods page: one page section among the pod list and
 * the pod sets, in the page's own section-heading style. It takes only the height of its content
 * and scrolls with the page; the standalone panel below fills and scrolls its own window.
 */
function JiraLivePodsSection({
  client,
  pollIntervalMs,
}: {
  readonly client: AtlassianConnectorsClient;
  readonly pollIntervalMs: number | undefined;
}): ReactNode {
  return (
    <div className={`acx-panel ${styles.scope} ${styles.cmpEmbedded}`} data-testid="acx-panel">
      <ConnectorsSection client={client} pollIntervalMs={pollIntervalMs} jiraLive />
    </div>
  );
}

export function AtlassianConnectorsPanel({
  client = defaultAtlassianConnectorsClient,
  pollIntervalMs,
  jiraLive = false,
}: AtlassianConnectorsPanelProps): ReactNode {
  const t = useTranslate();
  if (jiraLive) return <JiraLivePodsSection client={client} pollIntervalMs={pollIntervalMs} />;
  return (
    <div className={`acx-panel ${styles.scope}`} data-testid="acx-panel">
      <header>
        <h1 className="acx-title">{t("atlassianConnectors.title")}</h1>
        <p className="acx-subtitle">{t("atlassianConnectors.subtitle")}</p>
      </header>
      <ConnectorsSection client={client} pollIntervalMs={pollIntervalMs} jiraLive={false} />
      <ConnectorApprovalsPanel client={client} />
    </div>
  );
}
