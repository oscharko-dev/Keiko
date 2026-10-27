"use client";

import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
// Issue #2245 (Epic #2238, ADR-0128) — the Atlassian connector management surface.
//
// Top-level composition: lists configured connectors (provider, label, base URL, added-at, health
// from the last verify), hosts the add-connector flow (write-only token + inline verify), exposes
// per-connector scope selection and sync, and renders the write-action approval surface. The API
// client is injectable (`client` prop) so tests substitute a mock; production binds the real
// same-origin BFF client.

import { useEffect, useId, useState, type ReactNode } from "react";
import { ApiError } from "@/lib/api";

import {
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

function useConnectors(client: AtlassianConnectorsClient): ConnectorsController {
  const t = useTranslate();
  const [connectors, setConnectors] = useState<readonly AtlassianConnectorMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    let active = true;
    client
      .listConnectors()
      .then((list) => {
        if (active) setConnectors(list);
      })
      .catch((error_: unknown) => {
        if (active) {
          setError(error_ instanceof ApiError ? error_.message : t("atlassianConnectors.retry"));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- explicit lifecycle refresh only; translation changes do not refetch.
  }, [client, revision]);
  const onCreated = (metadata: AtlassianConnectorMetadata): void => {
    setConnectors((current) => [
      metadata,
      ...current.filter((c) => c.authRef !== metadata.authRef),
    ]);
  };
  const onDeleted = (authRef: string): void => {
    setConnectors((current) => current.filter((connector) => connector.authRef !== authRef));
  };
  return {
    connectors,
    loading,
    error,
    onCreated,
    onDeleted,
    reload: () => setRevision((value) => value + 1),
  };
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
        <p className="acx-empty">{t("atlassianConnectors.empty")}</p>
      ) : null}
      <ul className="acx-list">
        {connectors.map((connector) => (
          <ConnectorCard
            key={`${connector.authRef}:${connector.generation ?? 1}`}
            connector={connector}
            client={client}
            onDeleted={ctrl.onDeleted}
            onChanged={ctrl.reload}
            {...(pollIntervalMs === undefined ? {} : { pollIntervalMs })}
          />
        ))}
      </ul>
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
