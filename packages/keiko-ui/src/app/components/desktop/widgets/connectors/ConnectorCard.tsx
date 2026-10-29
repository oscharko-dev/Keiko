"use client";

import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
// Issue #2245 (Epic #2238) — one configured connector: identity, health (last verify), verify /
// manage-sync / delete controls, and the expandable scope+sync surface. The token is never part of
// the metadata this card renders (ADR-0128 D2), so nothing here can echo a secret.

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

import { toSafeIsoString } from "@/lib/format";
import type {
  AtlassianConnectorMetadata,
  AtlassianConnectorsClient,
  AtlassianConnectorVerifyStatus,
} from "@/lib/atlassian-connectors-api";
import { providerLabelKey, verifyStatusLabelKey } from "./connector-labels";
import { ConnectorSyncPanel } from "./ConnectorSyncPanel";
import { VerifyConnectionStatus } from "./VerifyConnectionStatus";
import { useConnectorCard, type CardController } from "./useConnectorCard";
import { ConnectorUpdateForm } from "./ConnectorUpdateForm";
import { JiraPodWorkspaceAction } from "../cards/JiraPodWorkspaceAction";

export interface ConnectorCardProps {
  readonly connector: AtlassianConnectorMetadata;
  readonly client: AtlassianConnectorsClient;
  readonly onDeleted: (authRef: string) => void;
  readonly onUpdated: (metadata: AtlassianConnectorMetadata) => void;
  readonly pollIntervalMs?: number;
}

function CardHeader({
  connector,
  verifyStatus,
  verifying,
}: {
  readonly connector: AtlassianConnectorMetadata;
  readonly verifyStatus: AtlassianConnectorVerifyStatus | undefined;
  readonly verifying: boolean;
}): ReactNode {
  const t = useTranslate();
  const settledHealth =
    verifyStatus === undefined
      ? t("atlassianConnectors.list.healthUnknown")
      : t(verifyStatusLabelKey(verifyStatus));
  const health = verifying ? t("atlassianConnectors.verify.verifying") : settledHealth;
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
  live,
}: {
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly live: boolean;
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
    // Codex on PR #3089: an in-flight delete disables the visible Cancel button but Escape used
    // to still call onCancel, hiding the confirmation while the request was still running and
    // re-exposing CardActions' undisabled Manage/Delete controls. Ignore Escape while busy.
    if (event.key === "Escape" && !busy) {
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
      <span id={confirmMessageId}>
        {t(live ? "atlassianConnectors.live.removeConfirm" : "atlassianConnectors.delete.confirm")}
      </span>
      <div className="acx-actions">
        <button type="button" className="lk-btn lk-btn-danger" disabled={busy} onClick={onConfirm}>
          {t(live ? "atlassianConnectors.live.remove" : "atlassianConnectors.delete.confirmButton")}
        </button>
        <button ref={cancelRef} type="button" className="lk-btn" disabled={busy} onClick={onCancel}>
          {t(live ? "atlassianConnectors.live.keep" : "atlassianConnectors.delete.cancel")}
        </button>
      </div>
    </div>
  );
}

function CardActions({
  ctrl,
  canSync,
  live,
  connector,
}: {
  readonly connector: AtlassianConnectorMetadata;
  readonly ctrl: CardController;
  readonly canSync: boolean;
  readonly live: boolean;
}): ReactNode {
  const t = useTranslate();
  return (
    <div className="acx-actions">
      <button type="button" className="lk-btn" disabled={ctrl.busy} onClick={ctrl.verify}>
        {ctrl.operation === "verify"
          ? t("atlassianConnectors.verify.verifying")
          : t("atlassianConnectors.verify.button")}
      </button>
      {canSync ? (
        <button
          type="button"
          className="lk-btn"
          aria-expanded={ctrl.expanded}
          disabled={ctrl.busy}
          onClick={ctrl.toggle}
        >
          {t("atlassianConnectors.list.manage")}
        </button>
      ) : null}
      {live ? <LivePodActions ctrl={ctrl} connector={connector} /> : null}
      <button
        type="button"
        className="lk-btn lk-btn-danger"
        disabled={ctrl.busy}
        onClick={ctrl.askDelete}
      >
        {t(live ? "atlassianConnectors.live.remove" : "atlassianConnectors.list.delete")}
      </button>
    </div>
  );
}

function LivePodActions({
  ctrl,
  connector,
}: {
  readonly ctrl: CardController;
  readonly connector: AtlassianConnectorMetadata;
}): ReactNode {
  const t = useTranslate();
  return (
    <>
      <JiraPodWorkspaceAction connector={connector} disabled={ctrl.busy} />
      <button
        type="button"
        className="lk-btn"
        disabled={ctrl.busy}
        onClick={() => ctrl.edit("rename")}
      >
        {t("atlassianConnectors.live.rename")}
      </button>
      <button
        type="button"
        className="lk-btn"
        disabled={ctrl.busy}
        onClick={() => ctrl.edit("rotate")}
      >
        {t("atlassianConnectors.live.replaceToken")}
      </button>
      <button type="button" className="lk-btn" disabled={ctrl.busy} onClick={ctrl.refresh}>
        {t("atlassianConnectors.live.refresh")}
      </button>
    </>
  );
}
function LivePodStatus({
  connector,
  ctrl,
}: {
  readonly connector: AtlassianConnectorMetadata;
  readonly ctrl: CardController;
}): ReactNode {
  const t = useTranslate();
  if (connector.deployment !== "data-center" || connector.livePod === undefined) return null;
  return (
    <>
      <p className="acx-hint">
        {t(
          connector.livePod.capabilities.includes("live-write")
            ? "atlassianConnectors.live.capabilities"
            : "atlassianConnectors.live.readCapabilities",
        )}
      </p>
      {connector.livePod.verificationStatus === "unverified" && !ctrl.busy ? (
        <output className="acx-notice" data-tone="warning">
          {t("atlassianConnectors.live.verifyRequired")}
        </output>
      ) : null}
      {ctrl.unconfirmed && !ctrl.busy ? (
        <output className="acx-notice" data-tone="warning">
          {t("atlassianConnectors.live.refreshRequired")}
        </output>
      ) : null}
    </>
  );
}
function CardManagement({
  connector,
  ctrl,
}: {
  readonly connector: AtlassianConnectorMetadata;
  readonly ctrl: CardController;
}): ReactNode {
  const live = connector.deployment === "data-center" && connector.livePod !== undefined;
  if (ctrl.confirming)
    return (
      <DeleteConfirm
        busy={ctrl.busy}
        live={live}
        onCancel={ctrl.cancelDelete}
        onConfirm={ctrl.confirmDelete}
      />
    );
  if (ctrl.editing !== undefined)
    return (
      <ConnectorUpdateForm
        key={`${connector.authRef}:${connector.generation}:${ctrl.editing}`}
        connector={connector}
        mode={ctrl.editing}
        busy={ctrl.busy}
        submit={ctrl.update}
        close={ctrl.cancelEdit}
        refresh={ctrl.refresh}
        unconfirmed={ctrl.unconfirmed}
      />
    );
  return (
    <CardActions
      ctrl={ctrl}
      canSync={connector.deployment !== "data-center"}
      live={live}
      connector={connector}
    />
  );
}

function currentVerifyStatus(
  connector: AtlassianConnectorMetadata,
  local: AtlassianConnectorVerifyStatus | undefined,
): AtlassianConnectorVerifyStatus | undefined {
  if (connector.deployment !== "data-center" || connector.livePod === undefined) return local;
  const pod = connector.livePod;
  return pod.verificationInProgress || pod.verificationStatus === "unverified"
    ? undefined
    : pod.verificationStatus;
}

export function ConnectorCard({
  connector,
  client,
  onDeleted,
  onUpdated,
  pollIntervalMs,
}: ConnectorCardProps): ReactNode {
  const ctrl = useConnectorCard(client, connector, onDeleted, onUpdated);
  const canSync = connector.deployment !== "data-center";
  const verifyStatus = ctrl.unconfirmed
    ? undefined
    : currentVerifyStatus(connector, ctrl.verifyStatus);
  const verifying =
    ctrl.operation === "verify" ||
    (connector.deployment === "data-center" && connector.livePod?.verificationInProgress === true);
  const syncPollProps = pollIntervalMs === undefined ? {} : { pollIntervalMs };
  return (
    <li className="acx-card" data-testid="acx-connector" data-auth-ref={connector.authRef}>
      <CardHeader connector={connector} verifyStatus={verifyStatus} verifying={verifying} />
      {ctrl.error !== undefined ? (
        <p className="acx-error" role="alert">
          {ctrl.error}
        </p>
      ) : null}
      {verifyStatus !== undefined ? <VerifyConnectionStatus status={verifyStatus} /> : null}
      <LivePodStatus connector={connector} ctrl={ctrl} />
      <CardManagement connector={connector} ctrl={ctrl} />
      {ctrl.expanded && canSync ? (
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
