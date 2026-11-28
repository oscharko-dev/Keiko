"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { Icons } from "../../Icons";
import { useSettingsTranslate as useTranslate, type I18nTranslate } from "./settings-i18n";
import styles from "./McpSettingsPanel.module.css";
import { mcpConnectionStatus } from "./McpServerAvailability";
import { McpServerAuthorization } from "./McpServerAuthorization";
import { McpSettingsImport } from "./McpSettingsImport";
import { McpForm } from "./McpSettingsForm";
import {
  MCP_SETTINGS_PATH,
  EMPTY_MCP_FORM,
  changeServer,
  clearForm,
  connect,
  edit,
  perform,
  useMcpModel,
  type Model,
} from "./useMcpSettingsModel";

const {
  server: ServerIcon,
  edit: EditIcon,
  trash: TrashIcon,
  plus: PlusIcon,
  code: CodeIcon,
  plugins: PluginsIcon,
} = Icons;

interface ViewProps {
  readonly model: Model;
  readonly t: I18nTranslate;
}

type ServerViewProps = ViewProps & { readonly server: McpServerDefinition };
function McpServerCard({ model, t, server }: ServerViewProps): ReactNode {
  const connection = model.state.snapshot?.connections?.find((entry) => entry.name === server.name);
  const enabledState = server.enabled ? (connection?.state ?? "idle") : "disabled";
  const state = model.state.statusStale ? "unavailable" : enabledState;
  const status = mcpConnectionStatus(state, connection?.toolCount, t);
  const target =
    server.transport.kind === "remote"
      ? server.transport.url.split(/[?#]/u, 1)[0]
      : server.transport.command[0].split(/[\\/]/u).at(-1);
  return (
    <li className={styles.cmpCard}>
      <div className={styles.cmpCardHeader}>
        <span className={styles.cmpServerIcon} aria-hidden="true">
          <ServerIcon />
        </span>
        <div className={styles.cmpServerIdentity}>
          <h3>{server.name}</h3>
          <p className={styles.cmpTarget}>{target}</p>
        </div>
        <output className={styles.cmpBadge} data-state={state}>
          <span className={styles.cmpStatusDot} aria-hidden="true" />
          {status}
        </output>
      </div>
      <div className={styles.cmpCardFooter}>
        <span className={styles.cmpTransport}>
          {t(server.transport.kind === "remote" ? "settings.mcp.remote" : "settings.mcp.local")}
        </span>
        <McpServerActions model={model} t={t} server={server} />
      </div>
      <ServerAuthorization model={model} server={server} />
    </li>
  );
}
function ServerAuthorization({
  model,
  server,
}: Pick<ServerViewProps, "model" | "server">): ReactNode {
  if (server.transport.kind !== "remote" || server.transport.oauth === undefined) return null;
  const connection = model.state.snapshot?.connections?.find((entry) => entry.name === server.name);
  if (!server.enabled && connection?.authentication !== "authorized") return null;
  return (
    <McpServerAuthorization
      name={server.name}
      authorized={connection?.authentication === "authorized"}
      onChange={model.reload}
    />
  );
}
function McpServerActions({ model, t, server }: ServerViewProps): ReactNode {
  const busy = model.state.busy;
  return (
    <div className={styles.cmpActions}>
      <button
        type="button"
        disabled={busy || !server.enabled}
        onClick={() => {
          void perform(model, () => connect(model, server.name));
        }}
      >
        {t("settings.mcp.connect")}
      </button>
      <button
        type="button"
        disabled={busy || model.state.formOpen}
        onClick={(event) => {
          model.formOpener.current = event.currentTarget;
          edit(model, server);
        }}
      >
        <EditIcon />
        {t("settings.mcp.edit")}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void perform(model, () => changeServer(model, server, false));
        }}
      >
        {t(server.enabled ? "settings.mcp.disable" : "settings.mcp.enable")}
      </button>
      <McpRemoveAction model={model} t={t} server={server} />
    </div>
  );
}
function McpRemoveAction({ model, t, server }: ServerViewProps): ReactNode {
  const [confirm, setConfirm] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirm) cancel.current?.focus();
  }, [confirm]);
  if (!confirm)
    return (
      <button
        ref={opener}
        type="button"
        className={styles.cmpDanger}
        disabled={model.state.busy}
        onClick={() => setConfirm(true)}
      >
        <TrashIcon />
        {t("settings.mcp.remove")}
      </button>
    );
  return (
    <fieldset
      className={styles.cmpRemoveConfirm}
      style={{ margin: 0, minInlineSize: 0 }}
      aria-label={t("settings.mcp.removeTitle", { name: server.name })}
    >
      <p>{t("settings.mcp.removeHelp", { name: server.name })}</p>
      <button
        type="button"
        className={styles.cmpDanger}
        disabled={model.state.busy}
        onClick={() => void perform(model, () => changeServer(model, server, true))}
      >
        {t("settings.mcp.confirmRemove")}
      </button>
      <button
        ref={cancel}
        type="button"
        disabled={model.state.busy}
        onClick={() => {
          setConfirm(false);
          requestAnimationFrame(() => opener.current?.focus());
        }}
      >
        {t("settings.mcp.cancel")}
      </button>
    </fieldset>
  );
}
function McpOverview({ model, t }: ViewProps): ReactNode {
  const { snapshot, error } = model.state;
  if (snapshot === undefined)
    return error ? null : (
      <output className={styles.cmpEmpty} style={{ margin: 0 }}>
        {t("settings.mcp.loading")}
      </output>
    );
  if (snapshot.servers.length === 0)
    return (
      <div className={styles.cmpEmpty}>
        <ServerIcon />
        <h3>{t("settings.mcp.emptyTitle")}</h3>
        <p>{t("settings.mcp.emptyHelp")}</p>
      </div>
    );
  return (
    <div className={styles.cmpOverview}>
      <div className={styles.cmpListHeading}>
        <h3>{t("settings.mcp.configured")}</h3>
        <span>{t("settings.mcp.serverCount", { count: snapshot.servers.length })}</span>
      </div>
      <ul className={styles.cmpServers} aria-label={t("settings.mcp.configured")}>
        {snapshot.servers.map((server) => (
          <McpServerCard key={server.name} server={server} model={model} t={t} />
        ))}
      </ul>
    </div>
  );
}
function McpSettingsError({ model, t }: ViewProps): ReactNode {
  const { error, busy, needsPairing, credentialsRequired, connectionFailedAfterSave } = model.state;
  if (!error) return null;
  const general = credentialsRequired
    ? ({
        help: "settings.mcp.credentialsRequired",
        title: "settings.mcp.credentialsTitle",
      } as const)
    : ({ help: "settings.mcp.error", title: "settings.mcp.errorTitle" } as const);
  const { help, title } = needsPairing
    ? ({ help: "settings.mcp.sessionHelp", title: "settings.mcp.sessionTitle" } as const)
    : general;
  return (
    <div className={styles.cmpAlert} role="alert">
      <div>
        <strong>
          {t(connectionFailedAfterSave ? "settings.mcp.savedConnectionFailed" : title)}
        </strong>
        <p>
          {t(
            connectionFailedAfterSave && !needsPairing ? "settings.mcp.savedConnectionHelp" : help,
          )}
        </p>
      </div>
      {!credentialsRequired && (
        <button type="button" disabled={busy} onClick={model.reload}>
          {t("settings.mcp.reload")}
        </button>
      )}
    </div>
  );
}
function SetupActions({ model, t }: ViewProps): ReactNode {
  const { busy, formOpen } = model.state;
  const id = useId();
  function open(opener: HTMLElement, importOpen: boolean): void {
    model.formOpener.current = opener;
    model.patch({
      formOpen: true,
      editing: undefined,
      form: EMPTY_MCP_FORM,
      importOpen,
      formProblem: undefined,
      imported: undefined,
    });
  }
  return (
    <div className={styles.cmpSetupActions}>
      <button
        type="button"
        className={styles.cmpPrimary}
        disabled={busy || formOpen}
        aria-labelledby={`${id}-manual`}
        aria-describedby={`${id}-manual-help`}
        title={t("settings.mcp.manualHelp")}
        onClick={(event) => open(event.currentTarget, false)}
      >
        <PlusIcon />
        <span>
          <strong id={`${id}-manual`}>{t("settings.mcp.add")}</strong>
          <span id={`${id}-manual-help`}>{t("settings.mcp.manualHelp")}</span>
        </span>
      </button>
      <button
        type="button"
        disabled={busy || formOpen}
        aria-labelledby={`${id}-import`}
        aria-describedby={`${id}-import-help`}
        title={t("settings.mcp.importSetupHelp")}
        onClick={(event) => open(event.currentTarget, true)}
      >
        <CodeIcon />
        <span>
          <strong id={`${id}-import`}>{t("settings.mcp.importTitle")}</strong>
          <span id={`${id}-import-help`}>{t("settings.mcp.importSetupHelp")}</span>
        </span>
      </button>
    </div>
  );
}

export function McpSettingsPanel(): ReactNode {
  const model = useMcpModel();
  const t = useTranslate();
  const { busy, formOpen, importOpen, imported } = model.state;
  return (
    <section className={styles.cmpPanel} aria-label={t("settings.mcp.title")} aria-busy={busy}>
      <header className={styles.cmpHeader}>
        <div>
          <h2>{t("settings.mcp.title")}</h2>
          <p>{t("settings.mcp.description")}</p>
        </div>
      </header>
      <div className={styles.cmpAvailability}>
        <PluginsIcon />
        <span>{t("settings.mcp.availability")}</span>
      </div>
      <SetupActions model={model} t={t} />
      <McpSettingsError model={model} t={t} />
      {imported !== undefined && (
        <p className={styles.cmpImportSuccess} role="status">
          {t("settings.mcp.importSuccess", { count: imported })}
        </p>
      )}
      {formOpen &&
        (importOpen === true ? (
          <McpSettingsImport
            path={`${MCP_SETTINGS_PATH}/import`}
            busy={busy}
            perform={(work) => void perform(model, work)}
            onSaved={(snapshot, count) => {
              model.readEpoch.current += 1;
              model.patch({ snapshot, statusStale: false, imported: count });
              clearForm(model);
            }}
            onCancel={() => clearForm(model)}
          />
        ) : (
          <McpForm model={model} t={t} />
        ))}
      <McpOverview model={model} t={t} />
    </section>
  );
}
