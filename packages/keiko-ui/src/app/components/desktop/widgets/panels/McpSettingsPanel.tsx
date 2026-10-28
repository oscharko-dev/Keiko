"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  McpServerDefinition,
  McpSettingsSnapshot,
  McpSettingsUpdate,
  McpServerConnectionView,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { bffFetchJson, isDeniedError } from "@/lib/http";
import { Icons } from "../../Icons";
import {
  codingAppSessionPairingSettled,
  useCodingAppSessionRedemptions,
} from "@/lib/coding-app-session-client";
import { useSettingsTranslate as useTranslate } from "./settings-i18n";
import styles from "./McpSettingsPanel.module.css";

const PATH = "/api/mcp/servers";
const EMPTY = {
  name: "",
  kind: "remote",
  url: "",
  command: "",
  args: "",
  token: "",
  environmentFile: "",
  legacy: false,
  privateNetwork: false,
};

type Form = typeof EMPTY;
interface State {
  readonly snapshot?: McpSettingsSnapshot | undefined;
  readonly form: Form;
  readonly editing?: string | undefined;
  readonly busy: boolean;
  readonly error: boolean;
  readonly statusStale: boolean;
  readonly needsPairing: boolean;
  readonly credentialsRequired: boolean;
  readonly formOpen: boolean;
}
interface Model {
  readonly state: State;
  readonly patch: (change: Partial<State>) => void;
  readonly lock: React.RefObject<boolean>;
  readonly readEpoch: React.RefObject<number>;
  readonly fileInput: React.RefObject<HTMLInputElement | null>;
  readonly nameInput: React.RefObject<HTMLInputElement | null>;
  readonly formOpener: React.RefObject<HTMLElement | null>;
  readonly reload: () => void;
}
type Translate = ReturnType<typeof useTranslate>;
interface ViewProps {
  readonly model: Model;
  readonly t: Translate;
}

function remoteDefinition(
  form: Form,
  previous: McpServerDefinition | undefined,
): Pick<McpServerDefinition, "transport"> & { secrets: McpSettingsUpdate["secrets"] } {
  const reference = `KEIKO_MCP_SECRET_${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
  const old = previous?.transport.kind === "remote" ? previous.transport.headers : undefined;
  const headers =
    form.token === ""
      ? old
      : {
          ...Object.fromEntries(
            Object.entries(old ?? {}).filter(([name]) => name.toLowerCase() !== "authorization"),
          ),
          Authorization: { secretEnv: reference, prefix: "Bearer " },
        };
  return {
    transport: {
      kind: "remote",
      url: form.url,
      ...(headers === undefined ? {} : { headers }),
      ...(form.legacy ? { protocol: "sse" as const } : {}),
      ...(form.privateNetwork ? { network: "private" as const } : {}),
    },
    secrets: form.token === "" ? {} : { [reference]: { server: form.name, value: form.token } },
  };
}
function definition(
  form: Form,
  previous: McpServerDefinition | undefined,
): { server: McpServerDefinition; secrets: McpSettingsUpdate["secrets"] } {
  const common = {
    name: form.name,
    description: previous?.description,
    enabled: previous?.enabled ?? true,
    ...(previous === undefined || previous.discovery === "automatic"
      ? { discovery: "automatic" as const }
      : {}),
    tools: previous?.tools ?? {},
  };
  if (form.kind === "remote") {
    const remote = remoteDefinition(form, previous);
    return { server: { ...common, transport: remote.transport }, secrets: remote.secrets };
  }
  return { server: { ...common, transport: localDefinition(form, previous) }, secrets: {} };
}
function localDefinition(
  form: Form,
  previous: McpServerDefinition | undefined,
): McpServerDefinition["transport"] {
  const old = previous?.transport.kind === "local" ? previous.transport : undefined;
  const command: [string, ...string[]] = [
    form.command,
    ...(form.args === "" ? [] : form.args.split("\n")),
  ];
  const keepSecrets = old !== undefined && JSON.stringify(old.command) === JSON.stringify(command);
  return {
    kind: "local",
    command,
    environment: old?.environment ?? {},
    ...(keepSecrets && old.secretEnvironment !== undefined
      ? { secretEnvironment: old.secretEnvironment }
      : {}),
  };
}

function useMcpModel(): Model {
  const sessionRedemptions = useCodingAppSessionRedemptions();
  const [state, setState] = useState<State>({
    form: EMPTY,
    busy: false,
    error: false,
    statusStale: true,
    needsPairing: false,
    credentialsRequired: false,
    formOpen: false,
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const readEpoch = useRef(0);
  const formOpener = useRef<HTMLElement>(null);
  const [reload, setReload] = useState(0);
  useMcpLoad(setState, readEpoch, reload, sessionRedemptions);
  useEffect(() => {
    if (state.formOpen) nameInput.current?.focus();
  }, [state.formOpen, state.editing]);
  useMcpRefresh(state, setReload);
  return {
    state,
    formOpener,
    fileInput,
    nameInput,
    lock,
    readEpoch,
    patch: (change): void => setState((current) => ({ ...current, ...change })),
    reload: (): void => setReload((value) => value + 1),
  };
}
function useMcpLoad(
  setState: React.Dispatch<React.SetStateAction<State>>,
  readEpoch: React.RefObject<number>,
  reload: number,
  sessionRedemptions: number,
): void {
  useEffect(() => {
    const controller = new AbortController();
    const epoch = readEpoch.current;
    void codingAppSessionPairingSettled(controller.signal)
      .then(() => bffFetchJson<McpSettingsSnapshot>(PATH, { signal: controller.signal }))
      .then((snapshot): void => {
        if (!controller.signal.aborted && epoch === readEpoch.current)
          setState((current) => ({
            ...current,
            snapshot,
            statusStale: false,
            error: false,
            needsPairing: false,
          }));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && epoch === readEpoch.current)
          setState((current) => ({
            ...current,
            error: true,
            statusStale: true,
            needsPairing: isDeniedError(error),
          }));
      });
    return (): void => controller.abort();
  }, [reload, sessionRedemptions, readEpoch, setState]);
}
function useMcpRefresh(
  state: State,
  setReload: React.Dispatch<React.SetStateAction<number>>,
): void {
  useEffect(() => {
    if (state.formOpen || state.busy || state.error || state.snapshot === undefined) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setReload((value) => value + 1);
    }, 10_000);
    return (): void => clearInterval(timer);
  }, [state.formOpen, state.busy, state.error, state.snapshot, setReload]);
}
async function perform(model: Model, work: () => Promise<void>): Promise<void> {
  if (model.lock.current) return;
  model.lock.current = true;
  model.patch({ busy: true, error: false, credentialsRequired: false });
  try {
    await work();
  } catch (error: unknown) {
    model.patch({ error: true, needsPairing: isDeniedError(error) });
  } finally {
    model.lock.current = false;
    model.patch({ busy: false });
  }
}
async function save(
  model: Model,
  servers: readonly McpServerDefinition[],
  secrets: McpSettingsUpdate["secrets"] = {},
  environmentFiles?: Readonly<Record<string, string>>,
): Promise<McpSettingsSnapshot> {
  const snapshot = model.state.snapshot;
  if (snapshot === undefined) throw new Error("MCP settings are unavailable");
  model.readEpoch.current += 1;
  model.patch({ statusStale: true });
  const value = await bffFetchJson<McpSettingsSnapshot>(PATH, {
    method: "PUT",
    body: JSON.stringify({
      expectedRevision: snapshot.revision,
      servers,
      secrets,
      ...(environmentFiles === undefined ? {} : { environmentFiles }),
    }),
  });
  model.readEpoch.current += 1;
  model.patch({ snapshot: value, statusStale: false });
  return value;
}
async function connect(model: Model, name: string): Promise<void> {
  model.readEpoch.current += 1;
  model.patch({ statusStale: true });
  const result = await bffFetchJson<{ snapshot: McpSettingsSnapshot; toolCount: number }>(
    `${PATH}/${encodeURIComponent(name)}/connect`,
    { method: "POST" },
  );
  model.readEpoch.current += 1;
  model.patch({ snapshot: result.snapshot, statusStale: false });
}
function clearForm(model: Model): void {
  model.patch({ form: EMPTY, editing: undefined, formOpen: false });
  if (model.fileInput.current !== null) model.fileInput.current.value = "";
  requestAnimationFrame(() => model.formOpener.current?.focus());
}
function remoteNeedsCredentials(
  form: Form,
  old: Extract<McpServerDefinition["transport"], { kind: "remote" }>,
): boolean {
  if (old.url === form.url) return false;
  const headers = Object.keys(old.headers ?? {});
  return (
    headers.some((key) => key.toLowerCase() !== "authorization") ||
    (headers.length > 0 && form.token === "")
  );
}
function localNeedsCredentials(
  form: Form,
  old: Extract<McpServerDefinition["transport"], { kind: "local" }>,
): boolean {
  const changed =
    JSON.stringify(old.command) !==
    JSON.stringify([form.command, ...(form.args === "" ? [] : form.args.split("\n"))]);
  return (
    changed && Object.keys(old.secretEnvironment ?? {}).length > 0 && form.environmentFile === ""
  );
}
function requiresFreshCredentials(form: Form, previous: McpServerDefinition | undefined): boolean {
  if (previous === undefined) return false;
  const old = previous.transport;
  if (old.kind === "remote") return form.kind === "remote" && remoteNeedsCredentials(form, old);
  return form.kind === "local" && localNeedsCredentials(form, old);
}
async function submit(model: Model): Promise<void> {
  const { snapshot, form, editing } = model.state;
  if (snapshot === undefined) return;
  const previous = snapshot.servers.find((server) => server.name === editing);
  if (editing === undefined && snapshot.servers.some((server) => server.name === form.name))
    throw new Error("Duplicate MCP server");
  if (requiresFreshCredentials(form, previous)) {
    model.patch({ error: true, needsPairing: false, credentialsRequired: true });
    return;
  }
  const update = definition(form, previous);
  await save(
    model,
    [...snapshot.servers.filter((server) => server.name !== editing), update.server],
    update.secrets,
    form.kind !== "local" || form.environmentFile === ""
      ? undefined
      : { [form.name]: form.environmentFile },
  );
  clearForm(model);
  if (update.server.enabled) await connect(model, update.server.name);
}
function edit(model: Model, server: McpServerDefinition): void {
  const transport = server.transport;
  model.patch({
    editing: server.name,
    formOpen: true,
    form: {
      ...EMPTY,
      name: server.name,
      kind: transport.kind,
      ...(transport.kind === "local"
        ? { command: transport.command[0], args: transport.command.slice(1).join("\n") }
        : {
            url: transport.url,
            legacy: transport.protocol === "sse",
            privateNetwork: transport.network === "private",
          }),
    },
  });
  if (model.fileInput.current !== null) model.fileInput.current.value = "";
  model.nameInput.current?.focus();
}
function change(model: Model, key: keyof Form, value: string | boolean): void {
  const form = { ...model.state.form, [key]: value };
  if (key === "kind") {
    form.token = "";
    form.environmentFile = "";
    if (model.fileInput.current !== null) model.fileInput.current.value = "";
  }
  model.patch({ form });
}
async function changeServer(
  model: Model,
  server: McpServerDefinition,
  remove: boolean,
): Promise<void> {
  const servers = model.state.snapshot?.servers ?? [];
  await save(
    model,
    remove
      ? servers.filter((entry) => entry.name !== server.name)
      : servers.map((entry) =>
          entry.name === server.name ? { ...entry, enabled: !entry.enabled } : entry,
        ),
  );
  if (remove && model.state.editing === server.name) clearForm(model);
}
type ServerViewProps = ViewProps & { readonly server: McpServerDefinition };
function connectionStatus(
  state: McpServerConnectionView["state"] | "unavailable",
  count: number | null | undefined,
  t: Translate,
): string {
  if (state === "unavailable") return t("settings.mcp.statusUnavailable");
  if (state === "connected") return t("settings.mcp.connected", { count: count ?? 0 });
  if (state === "disabled") return t("settings.mcp.disabled");
  if (state === "connecting") return t("settings.mcp.connecting");
  if (state === "failed") return t("settings.mcp.failed");
  return t("settings.mcp.unverified");
}
function McpServerCard({ model, t, server }: ServerViewProps): ReactNode {
  const connection = model.state.snapshot?.connections?.find((entry) => entry.name === server.name);
  const state = model.state.statusStale
    ? "unavailable"
    : server.enabled
      ? (connection?.state ?? "idle")
      : "disabled";
  const status = connectionStatus(state, connection?.toolCount, t);
  const target =
    server.transport.kind === "remote"
      ? server.transport.url.replace(/[?#].*$/u, "")
      : server.transport.command[0].split(/[\\/]/u).at(-1);
  return (
    <li className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.serverIcon} aria-hidden="true">
          <Icons.server />
        </span>
        <div className={styles.serverIdentity}>
          <h3>{server.name}</h3>
          <p className={styles.target}>{target}</p>
        </div>
        <span className={styles.badge} data-state={state} role="status">
          <span className={styles.statusDot} aria-hidden="true" />
          {status}
        </span>
      </div>
      <div className={styles.cardFooter}>
        <span className={styles.transport}>
          {t(server.transport.kind === "remote" ? "settings.mcp.remote" : "settings.mcp.local")}
        </span>
        <McpServerActions model={model} t={t} server={server} />
      </div>
    </li>
  );
}
function McpServerActions({ model, t, server }: ServerViewProps): ReactNode {
  const busy = model.state.busy;
  return (
    <div className={styles.actions}>
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
        disabled={
          busy || (server.transport.kind === "remote" && server.transport.oauth !== undefined)
        }
        onClick={(event) => {
          model.formOpener.current = event.currentTarget;
          edit(model, server);
        }}
      >
        <Icons.edit />
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
        className={styles.danger}
        disabled={model.state.busy}
        onClick={() => setConfirm(true)}
      >
        <Icons.trash />
        {t("settings.mcp.remove")}
      </button>
    );
  return (
    <div
      className={styles.removeConfirm}
      role="group"
      aria-label={t("settings.mcp.removeTitle", { name: server.name })}
    >
      <p>{t("settings.mcp.removeHelp", { name: server.name })}</p>
      <button
        type="button"
        className={styles.danger}
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
    </div>
  );
}
function TextField({
  model,
  label,
  field,
  type = "text",
  required = false,
}: {
  readonly model: Model;
  readonly label: string;
  readonly field: "name" | "url" | "token" | "command";
  readonly type?: string;
  readonly required?: boolean;
}): ReactNode {
  return (
    <label>
      {label}
      <input
        ref={field === "name" ? model.nameInput : undefined}
        type={type}
        required={required}
        readOnly={field === "name" && model.state.editing !== undefined}
        autoComplete={field === "token" ? "new-password" : "off"}
        pattern={field === "name" ? "[a-z][a-z0-9_\\-]{0,63}" : undefined}
        value={model.state.form[field]}
        onChange={(event) => change(model, field, event.target.value)}
      />
    </label>
  );
}
function RemoteFields({ model, t }: ViewProps): ReactNode {
  const { form } = model.state;
  return (
    <>
      <TextField model={model} field="url" label={t("settings.mcp.url")} type="url" required />
      <TextField model={model} field="token" label={t("settings.mcp.token")} type="password" />
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={form.privateNetwork}
          onChange={(event) => change(model, "privateNetwork", event.target.checked)}
        />
        {t("settings.mcp.private")}
      </label>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={form.legacy}
          onChange={(event) => change(model, "legacy", event.target.checked)}
        />
        {t("settings.mcp.legacy")}
      </label>
    </>
  );
}
function importFile(model: Model, input: HTMLInputElement): void {
  const file = input.files?.[0];
  change(model, "environmentFile", "");
  if (file === undefined) return;
  if (file.size > 64 * 1024) {
    model.patch({ error: true });
    input.value = "";
    return;
  }
  void perform(model, async () => {
    change(model, "environmentFile", await file.text());
  });
}
function LocalFields({ model, t }: ViewProps): ReactNode {
  return (
    <>
      <TextField model={model} field="command" label={t("settings.mcp.command")} required />
      <label>
        {t("settings.mcp.args")}
        <textarea
          rows={3}
          value={model.state.form.args}
          onChange={(event) => change(model, "args", event.target.value)}
        />
      </label>
      <label>
        {t("settings.mcp.env")}
        <input
          ref={model.fileInput}
          type="file"
          onChange={(event) => importFile(model, event.target)}
        />
      </label>
      <p>{t("settings.mcp.envHelp")}</p>
    </>
  );
}
function McpForm({ model, t }: ViewProps): ReactNode {
  const { form, editing, busy, snapshot } = model.state;
  const disabledServer =
    snapshot?.servers.find((server) => server.name === editing)?.enabled === false;
  return (
    <form
      className={styles.formCard}
      onSubmit={(event) => {
        event.preventDefault();
        void perform(model, () => submit(model));
      }}
    >
      <fieldset disabled={busy} className={styles.form}>
        <legend>{t(editing === undefined ? "settings.mcp.add" : "settings.mcp.edit")}</legend>
        <TextField model={model} field="name" label={t("settings.mcp.name")} required />
        <label>
          {t("settings.mcp.transport")}
          <select value={form.kind} onChange={(event) => change(model, "kind", event.target.value)}>
            <option value="remote">{t("settings.mcp.remote")}</option>
            <option value="local">{t("settings.mcp.local")}</option>
          </select>
        </label>
        {form.kind === "remote" ? (
          <RemoteFields model={model} t={t} />
        ) : (
          <LocalFields model={model} t={t} />
        )}
        {snapshot === undefined && (
          <p className={styles.help}>{t("settings.mcp.saveUnavailable")}</p>
        )}
        <div className={styles.actions}>
          <button
            className={styles.primary}
            type="submit"
            disabled={snapshot === undefined || model.state.needsPairing}
          >
            {t(disabledServer ? "settings.mcp.save" : "settings.mcp.saveConnect")}
          </button>
          <button type="button" onClick={() => clearForm(model)}>
            {t("settings.mcp.cancel")}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
function McpOverview({ model, t }: ViewProps): ReactNode {
  const { snapshot, error } = model.state;
  if (snapshot === undefined)
    return error ? null : (
      <p className={styles.empty} role="status">
        {t("settings.mcp.loading")}
      </p>
    );
  if (snapshot.servers.length === 0)
    return (
      <div className={styles.empty}>
        <Icons.server />
        <h3>{t("settings.mcp.emptyTitle")}</h3>
        <p>{t("settings.mcp.emptyHelp")}</p>
      </div>
    );
  return (
    <div className={styles.overview}>
      <div className={styles.listHeading}>
        <h3>{t("settings.mcp.configured")}</h3>
        <span>{t("settings.mcp.serverCount", { count: snapshot.servers.length })}</span>
      </div>
      <ul className={styles.servers} aria-label={t("settings.mcp.configured")}>
        {snapshot.servers.map((server) => (
          <McpServerCard key={server.name} server={server} model={model} t={t} />
        ))}
      </ul>
    </div>
  );
}
function McpSettingsError({ model, t }: ViewProps): ReactNode {
  const { error, busy, needsPairing, credentialsRequired } = model.state;
  if (!error) return null;
  const help = needsPairing
    ? "settings.mcp.sessionHelp"
    : credentialsRequired
      ? "settings.mcp.credentialsRequired"
      : "settings.mcp.error";
  const title = needsPairing
    ? "settings.mcp.sessionTitle"
    : credentialsRequired
      ? "settings.mcp.credentialsTitle"
      : "settings.mcp.errorTitle";
  return (
    <div className={styles.alert} role="alert">
      <div>
        <strong>{t(title)}</strong>
        <p>{t(help)}</p>
      </div>
      {!credentialsRequired && (
        <button type="button" disabled={busy} onClick={model.reload}>
          {t("settings.mcp.reload")}
        </button>
      )}
    </div>
  );
}
export function McpSettingsPanel(): ReactNode {
  const model = useMcpModel();
  const t = useTranslate();
  const { busy, formOpen } = model.state;
  return (
    <section className={styles.panel} aria-label={t("settings.mcp.title")} aria-busy={busy}>
      <header className={styles.header}>
        <div>
          <h2>{t("settings.mcp.title")}</h2>
          <p>{t("settings.mcp.description")}</p>
        </div>
        <button
          type="button"
          className={styles.primary}
          disabled={busy || formOpen}
          onClick={(event) => {
            model.formOpener.current = event.currentTarget;
            model.patch({ formOpen: true, editing: undefined, form: EMPTY });
          }}
        >
          <Icons.plus />
          {t("settings.mcp.add")}
        </button>
      </header>
      <div className={styles.availability}>
        <Icons.plugins />
        <span>{t("settings.mcp.availability")}</span>
      </div>
      <McpSettingsError model={model} t={t} />
      <McpOverview model={model} t={t} />
      {formOpen && <McpForm model={model} t={t} />}
    </section>
  );
}
