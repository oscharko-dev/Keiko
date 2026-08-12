// Issue #2245 (Epic #2238) — one configured connector: identity, health (last verify), verify /
// manage-sync / delete controls, and the expandable scope+sync surface. The token is never part of
// the metadata this card renders (ADR-0128 D2), so nothing here can echo a secret.

"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ApiError } from "@/lib/api";
import { useTranslate } from "@/lib/i18n";
import { toSafeIsoString } from "@/lib/format";
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
  const fail = (error_: unknown): void => {
    setError(error_ instanceof ApiError ? error_.message : t("atlassianConnectors.retry"));
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
      .catch((error_: unknown) => {
        fail(error_);
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
  // F3 — createdAt comes straight off the BFF response with no runtime shape validation
  // (AtlassianConnectorMetadata.createdAt is a compile-time-only `number`); `.toISOString()`
  // throws RangeError on an Invalid Date and this route has no error boundary above it. Fail
  // closed to a placeholder instead of letting one malformed record white-screen the whole list.
  const addedIso = toSafeIsoString(connector.createdAt);
  const added = addedIso === undefined ? "—" : addedIso.slice(0, 10);
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
  const confirmMessageId = useId();
  // Mirror AgentGateCard: cancel is the safe destructive default, so focus it on mount and let
  // Escape invoke the same handler (KEIKO-0508). aria-labelledby carries the existing translated
  // confirm copy instead of a hardcoded "delete-connector" label the reader never sees.
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
    }
  };
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape-to-cancel on the alertdialog container mirrors the Cancel button for keyboard users
    <div
      className="acx-notice"
      data-tone="danger"
      role="alertdialog"
      aria-labelledby={confirmMessageId}
      onKeyDown={handleKeyDown}
    >
      <span id={confirmMessageId}>{t("atlassianConnectors.delete.confirm")}</span>
      <div className="acx-actions">
        <button type="button" className="lk-btn lk-btn-danger" disabled={busy} onClick={onConfirm}>
          {t("atlassianConnectors.delete.confirmButton")}
        </button>
        <button ref={cancelRef} type="button" className="lk-btn" disabled={busy} onClick={onCancel}>
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
  const syncPollProps = pollIntervalMs === undefined ? {} : { pollIntervalMs };
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
          {...syncPollProps}
        />
      ) : null}
    </li>
  );
}
