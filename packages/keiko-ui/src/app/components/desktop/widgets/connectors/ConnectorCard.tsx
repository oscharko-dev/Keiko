// Issue #2245 (Epic #2238) — one configured connector: identity, health (last verify), verify /
// manage-sync / delete controls, and the expandable scope+sync surface. The token is never part of
// the metadata this card renders (ADR-0128 D2), so nothing here can echo a secret.

"use client";

import { useState, type ReactNode } from "react";
import { ApiError } from "@/lib/api";
import { useTranslate } from "@/lib/i18n";
import type {
  AtlassianConnectorMetadata,
  AtlassianConnectorsClient,
  AtlassianConnectorVerifyStatus,
} from "@/lib/atlassian-connectors-api";
import { providerLabelKey, verifyStatusLabelKey } from "./connector-labels";
import { ConnectorSyncPanel } from "./ConnectorSyncPanel";
import { VerifyConnectionStatus } from "./VerifyConnectionStatus";

export interface ConnectorCardProps {
  readonly connector: AtlassianConnectorMetadata;
  readonly client: AtlassianConnectorsClient;
  readonly onDeleted: (authRef: string) => void;
  readonly pollIntervalMs?: number;
}

interface CardController {
  readonly expanded: boolean;
  readonly verifyStatus: AtlassianConnectorVerifyStatus | undefined;
  readonly confirming: boolean;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly toggle: () => void;
  readonly verify: () => void;
  readonly askDelete: () => void;
  readonly cancelDelete: () => void;
  readonly confirmDelete: () => void;
}

function useConnectorCard(
  client: AtlassianConnectorsClient,
  connector: AtlassianConnectorMetadata,
  onDeleted: (authRef: string) => void,
): CardController {
  const t = useTranslate();
  const [expanded, setExpanded] = useState(false);
  const [verifyStatus, setVerifyStatus] = useState<AtlassianConnectorVerifyStatus | undefined>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const fail = (caught: unknown): void => {
    setError(caught instanceof ApiError ? caught.message : t("atlassianConnectors.retry"));
  };
  const verify = (): void => {
    setBusy(true);
    setError(undefined);
    client
      .verifyConnector(connector.authRef)
      .then((result) => setVerifyStatus(result.status))
      .catch(fail)
      .finally(() => setBusy(false));
  };
  const confirmDelete = (): void => {
    setBusy(true);
    setError(undefined);
    client
      .deleteConnector(connector.authRef)
      .then(() => onDeleted(connector.authRef))
      .catch((caught: unknown) => {
        fail(caught);
        setBusy(false);
      });
  };
  return {
    expanded,
    verifyStatus,
    confirming,
    busy,
    error,
    toggle: () => setExpanded((value) => !value),
    verify,
    askDelete: () => setConfirming(true),
    cancelDelete: () => setConfirming(false),
    confirmDelete,
  };
}

function CardHeader({
  connector,
  verifyStatus,
}: {
  readonly connector: AtlassianConnectorMetadata;
  readonly verifyStatus: AtlassianConnectorVerifyStatus | undefined;
}): ReactNode {
  const t = useTranslate();
  const health =
    verifyStatus === undefined
      ? t("atlassianConnectors.list.healthUnknown")
      : t(verifyStatusLabelKey(verifyStatus));
  const added = new Date(connector.createdAt).toISOString().slice(0, 10);
  return (
    <div className="acx-card-head">
      <div>
        <p className="acx-card-title">{connector.displayName}</p>
        <p className="acx-meta">
          {`${t(providerLabelKey(connector.provider))} · ${connector.baseUrl}`}
          <br />
          {`${t("atlassianConnectors.list.added")}: ${added} · ${t("atlassianConnectors.list.health")}: ${health}`}
        </p>
      </div>
    </div>
  );
}

function DeleteConfirm({
  busy,
  onCancel,
  onConfirm,
}: {
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): ReactNode {
  const t = useTranslate();
  return (
    <div className="acx-notice" data-tone="danger" role="alertdialog" aria-label="delete-connector">
      <span>{t("atlassianConnectors.delete.confirm")}</span>
      <div className="acx-actions">
        <button type="button" className="lk-btn lk-btn-danger" disabled={busy} onClick={onConfirm}>
          {t("atlassianConnectors.delete.confirmButton")}
        </button>
        <button type="button" className="lk-btn" disabled={busy} onClick={onCancel}>
          {t("atlassianConnectors.delete.cancel")}
        </button>
      </div>
    </div>
  );
}

function CardActions({ ctrl }: { readonly ctrl: CardController }): ReactNode {
  const t = useTranslate();
  return (
    <div className="acx-actions">
      <button type="button" className="lk-btn" disabled={ctrl.busy} onClick={ctrl.verify}>
        {ctrl.busy
          ? t("atlassianConnectors.verify.verifying")
          : t("atlassianConnectors.verify.button")}
      </button>
      <button type="button" className="lk-btn" aria-expanded={ctrl.expanded} onClick={ctrl.toggle}>
        {t("atlassianConnectors.list.manage")}
      </button>
      <button type="button" className="lk-btn lk-btn-danger" onClick={ctrl.askDelete}>
        {t("atlassianConnectors.list.delete")}
      </button>
    </div>
  );
}

export function ConnectorCard({
  connector,
  client,
  onDeleted,
  pollIntervalMs,
}: ConnectorCardProps): ReactNode {
  const ctrl = useConnectorCard(client, connector, onDeleted);
  return (
    <li className="acx-card" data-testid="acx-connector" data-auth-ref={connector.authRef}>
      <CardHeader connector={connector} verifyStatus={ctrl.verifyStatus} />
      {ctrl.error !== undefined ? (
        <p className="acx-error" role="alert">
          {ctrl.error}
        </p>
      ) : null}
      {ctrl.verifyStatus !== undefined ? (
        <VerifyConnectionStatus status={ctrl.verifyStatus} />
      ) : null}
      {ctrl.confirming ? (
        <DeleteConfirm
          busy={ctrl.busy}
          onCancel={ctrl.cancelDelete}
          onConfirm={ctrl.confirmDelete}
        />
      ) : (
        <CardActions ctrl={ctrl} />
      )}
      {ctrl.expanded ? (
        <ConnectorSyncPanel
          client={client}
          authRef={connector.authRef}
          provider={connector.provider}
          {...(pollIntervalMs === undefined ? {} : { pollIntervalMs })}
        />
      ) : null}
    </li>
  );
}
