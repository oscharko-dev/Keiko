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
import { LivePodActions, LivePodHeader, livePodState } from "./LivePodCard";
import styles from "./connectors.module.css";

export interface ConnectorCardProps {
  readonly connector: AtlassianConnectorMetadata;
  readonly client: AtlassianConnectorsClient;
  readonly onDeleted: (authRef: string) => void;
  readonly onUpdated: (metadata: AtlassianConnectorMetadata) => void;
  readonly pollIntervalMs?: number;
  readonly embedded?: boolean;
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
}: {
  readonly ctrl: CardController;
  readonly canSync: boolean;
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
      <button
        type="button"
        className="lk-btn lk-btn-danger"
        disabled={ctrl.busy}
        onClick={ctrl.askDelete}
      >
        {t("atlassianConnectors.list.delete")}
      </button>
    </div>
  );
}

function CardManagement({
  connector,
  ctrl,
  actions,
}: {
  readonly connector: AtlassianConnectorMetadata;
  readonly ctrl: CardController;
  readonly actions: ReactNode;
}): ReactNode {
  const live = isLivePod(connector);
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
  return actions;
}

function isLivePod(connector: AtlassianConnectorMetadata): boolean {
  return connector.deployment === "data-center" && connector.livePod !== undefined;
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

function cardVerification(
  connector: AtlassianConnectorMetadata,
  ctrl: CardController,
): { status: AtlassianConnectorVerifyStatus | undefined; verifying: boolean } {
  return {
    status: ctrl.unconfirmed ? undefined : currentVerifyStatus(connector, ctrl.verifyStatus),
    verifying:
      ctrl.operation === "verify" ||
      (connector.deployment === "data-center" &&
        connector.livePod?.verificationInProgress === true),
  };
}

function CardError({ error }: { readonly error: string | undefined }): ReactNode {
  if (error === undefined) return null;
  return (
    <p className="acx-error" role="alert">
      {error}
    </p>
  );
}

/** An existing Pod obtains the retained compatibility facts only by an explicit verification. */
function CompatibilityNotice({
  connector,
}: {
  readonly connector: AtlassianConnectorMetadata;
}): ReactNode {
  const translate = useTranslate();
  if (connector.deployment !== "data-center" || connector.livePod?.compatibilityFacts !== "missing")
    return null;
  return (
    <p className="acx-hint" data-testid="acx-compatibility-missing">
      {translate("atlassianConnectors.live.compatibilityMissing")}
    </p>
  );
}

function LiveConnectorCard({
  connector,
  ctrl,
  embedded,
}: {
  readonly connector: AtlassianConnectorMetadata;
  readonly ctrl: CardController;
  readonly embedded: boolean;
}): ReactNode {
  const verification = cardVerification(connector, ctrl);
  const state = livePodState(
    verification.verifying,
    ctrl.unconfirmed && !ctrl.busy,
    verification.status,
  );
  const managing = ctrl.confirming || ctrl.editing !== undefined;
  return (
    <li
      className={`acx-card ${styles.cmpPodCard}`}
      data-testid="acx-connector"
      data-auth-ref={connector.authRef}
    >
      <LivePodHeader
        connector={connector}
        state={state}
        embedded={embedded}
        actions={
          managing ? null : (
            <LivePodActions connector={connector} ctrl={ctrl} state={state} embedded={embedded} />
          )
        }
      />
      <CardError error={ctrl.error} />
      <CompatibilityNotice connector={connector} />
      {managing ? <CardManagement connector={connector} ctrl={ctrl} actions={null} /> : null}
    </li>
  );
}

export function ConnectorCard({
  connector,
  client,
  onDeleted,
  onUpdated,
  pollIntervalMs,
  embedded = false,
}: ConnectorCardProps): ReactNode {
  const ctrl = useConnectorCard(client, connector, onDeleted, onUpdated);
  if (isLivePod(connector))
    return <LiveConnectorCard connector={connector} ctrl={ctrl} embedded={embedded} />;
  const canSync = connector.deployment !== "data-center";
  const { status, verifying } = cardVerification(connector, ctrl);
  const syncPollProps = pollIntervalMs === undefined ? {} : { pollIntervalMs };
  return (
    <li className="acx-card" data-testid="acx-connector" data-auth-ref={connector.authRef}>
      <CardHeader connector={connector} verifyStatus={status} verifying={verifying} />
      <CardError error={ctrl.error} />
      {status !== undefined ? <VerifyConnectionStatus status={status} /> : null}
      <CardManagement
        connector={connector}
        ctrl={ctrl}
        actions={<CardActions ctrl={ctrl} canSync={canSync} />}
      />
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
