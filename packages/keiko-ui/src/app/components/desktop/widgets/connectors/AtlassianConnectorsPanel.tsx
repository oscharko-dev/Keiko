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
}: {
  readonly connectors: readonly AtlassianConnectorMetadata[];
  readonly client: AtlassianConnectorsClient;
  readonly ctrl: ConnectorsController;
  readonly pollIntervalMs: number | undefined;
}): ReactNode {
  return (
    <ul className="acx-list">
      {connectors.map((connector) => (
        <ConnectorCard
          key={connector.authRef}
          connector={connector}
          client={client}
          onDeleted={ctrl.onDeleted}
          onUpdated={ctrl.onCreated}
          {...(pollIntervalMs === undefined ? {} : { pollIntervalMs })}
        />
      ))}
    </ul>
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
  const t = useTranslate();
  const ctrl = useConnectors(client);
  useCredentialChanges(ctrl.reload);
  const headingId = useId();
  const Heading = jiraLive ? "h4" : "h2";
  const connectors = ctrl.connectors.filter(
    (item) => !jiraLive || (item.deployment === "data-center" && item.livePod !== undefined),
  );
  const [adding, setAdding] = useState(false);
  return (
    <section className="acx-section" aria-labelledby={headingId}>
      <Heading className="acx-section-title" id={headingId}>
        {t("atlassianConnectors.section.connectors")}
      </Heading>
      {ctrl.error !== undefined ? (
        <p className="acx-error" role="alert">
          {ctrl.error}
        </p>
      ) : null}
      {ctrl.loading ? <p className="acx-muted">{t("atlassianConnectors.loading")}</p> : null}
      {!ctrl.loading && connectors.length === 0 && !adding ? (
        <p className="acx-empty">
          {t(jiraLive ? "atlassianConnectors.live.empty" : "atlassianConnectors.empty")}
        </p>
      ) : null}
      <ConnectorList
        connectors={connectors}
        client={client}
        ctrl={ctrl}
        pollIntervalMs={pollIntervalMs}
      />
      {adding ? (
        <AddConnectorForm
          client={client}
          onCreated={ctrl.onCreated}
          jiraLive={jiraLive}
          onClose={() => {
            setAdding(false);
            ctrl.reload();
          }}
        />
      ) : (
        <div className="acx-actions">
          <button type="button" className="lk-btn lk-btn-primary" onClick={() => setAdding(true)}>
            {t(jiraLive ? "atlassianConnectors.live.add" : "atlassianConnectors.add.open")}
          </button>
        </div>
      )}
    </section>
  );
}

export function AtlassianConnectorsPanel({
  client = defaultAtlassianConnectorsClient,
  pollIntervalMs,
  jiraLive = false,
}: AtlassianConnectorsPanelProps): ReactNode {
  const t = useTranslate();
  const Heading = jiraLive ? "h3" : "h1";
  return (
    <div className={`acx-panel ${styles.scope}`} data-testid="acx-panel">
      <header>
        <Heading className="acx-title">
          {t(jiraLive ? "atlassianConnectors.live.title" : "atlassianConnectors.title")}
        </Heading>
        <p className="acx-subtitle">
          {t(jiraLive ? "atlassianConnectors.live.subtitle" : "atlassianConnectors.subtitle")}
        </p>
      </header>
      <ConnectorsSection client={client} pollIntervalMs={pollIntervalMs} jiraLive={jiraLive} />
      {jiraLive ? null : <ConnectorApprovalsPanel client={client} />}
    </div>
  );
}
