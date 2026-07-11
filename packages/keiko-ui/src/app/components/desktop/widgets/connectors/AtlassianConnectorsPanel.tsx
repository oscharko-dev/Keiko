// Issue #2245 (Epic #2238, ADR-0128) — the Atlassian connector management surface.
//
// Top-level composition: lists configured connectors (provider, label, base URL, added-at, health
// from the last verify), hosts the add-connector flow (write-only token + inline verify), exposes
// per-connector scope selection and sync, and renders the write-action approval surface. The API
// client is injectable (`client` prop) so tests substitute a mock; production binds the real
// same-origin BFF client.

"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@/lib/api";
import { useTranslate } from "@/lib/i18n";
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
}

interface ConnectorsController {
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
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    let active = true;
    client
      .listConnectors()
      .then((list) => {
        if (active) setConnectors(list);
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(caught instanceof ApiError ? caught.message : t("atlassianConnectors.retry"));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot load on mount by design.
  }, [client]);
  const onCreated = (metadata: AtlassianConnectorMetadata): void => {
    setConnectors((current) => [
      metadata,
      ...current.filter((c) => c.authRef !== metadata.authRef),
    ]);
  };
  const onDeleted = (authRef: string): void => {
    setConnectors((current) => current.filter((connector) => connector.authRef !== authRef));
  };
  return { connectors, loading, error, onCreated, onDeleted };
}

function ConnectorsSection({
  client,
  pollIntervalMs,
}: {
  readonly client: AtlassianConnectorsClient;
  readonly pollIntervalMs: number | undefined;
}): ReactNode {
  const t = useTranslate();
  const ctrl = useConnectors(client);
  const [adding, setAdding] = useState(false);
  return (
    <section className="acx-section" aria-labelledby="acx-connectors-title">
      <h2 className="acx-section-title" id="acx-connectors-title">
        {t("atlassianConnectors.section.connectors")}
      </h2>
      {ctrl.error !== undefined ? (
        <p className="acx-error" role="alert">
          {ctrl.error}
        </p>
      ) : null}
      {ctrl.loading ? <p className="acx-muted">{t("atlassianConnectors.loading")}</p> : null}
      {!ctrl.loading && ctrl.connectors.length === 0 && !adding ? (
        <p className="acx-empty">{t("atlassianConnectors.empty")}</p>
      ) : null}
      <ul className="acx-list">
        {ctrl.connectors.map((connector) => (
          <ConnectorCard
            key={connector.authRef}
            connector={connector}
            client={client}
            onDeleted={ctrl.onDeleted}
            {...(pollIntervalMs === undefined ? {} : { pollIntervalMs })}
          />
        ))}
      </ul>
      {adding ? (
        <AddConnectorForm
          client={client}
          onCreated={ctrl.onCreated}
          onClose={() => setAdding(false)}
        />
      ) : (
        <div className="acx-actions">
          <button type="button" className="lk-btn lk-btn-primary" onClick={() => setAdding(true)}>
            {t("atlassianConnectors.add.open")}
          </button>
        </div>
      )}
    </section>
  );
}

export function AtlassianConnectorsPanel({
  client = defaultAtlassianConnectorsClient,
  pollIntervalMs,
}: AtlassianConnectorsPanelProps): ReactNode {
  const t = useTranslate();
  return (
    <div className={`acx-panel ${styles.scope}`} data-testid="acx-panel">
      <header>
        <h1 className="acx-title">{t("atlassianConnectors.title")}</h1>
        <p className="acx-subtitle">{t("atlassianConnectors.subtitle")}</p>
      </header>
      <ConnectorsSection client={client} pollIntervalMs={pollIntervalMs} />
      <ConnectorApprovalsPanel client={client} />
    </div>
  );
}
