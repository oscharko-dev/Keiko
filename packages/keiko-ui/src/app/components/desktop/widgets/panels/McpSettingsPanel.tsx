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
import { McpServerAuthorization } from "./McpServerAuthorization";

const {
  server: ServerIcon,
  edit: EditIcon,
  trash: TrashIcon,
  plus: PlusIcon,
  plugins: PluginsIcon,
} = Icons;

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
  oauth: false,
  issuer: "",
  clientId: "",
  scope: "",
  headerName: "Authorization",
  headerPrefix: "Bearer ",
  removedHeaders: [] as string[],
  removedEnvironment: [] as string[],
  toolPolicies: {} as McpServerDefinition["tools"],
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
  if (form.oauth) return oauthDefinition(form);
  const reference = `KEIKO_MCP_SECRET_${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
  const previousHeaders =
    previous?.transport.kind === "remote" ? previous.transport.headers : undefined;
  const old = Object.fromEntries(
    Object.entries(previousHeaders ?? {}).filter(([name]) => !form.removedHeaders.includes(name)),
  );
  const headers =
    form.token === ""
      ? old
      : {
          ...Object.fromEntries(
            Object.entries(old).filter(
              ([name]) => name.toLowerCase() !== form.headerName.toLowerCase(),
            ),
          ),
          [form.headerName]: {
            secretEnv: reference,
            ...credentialPrefix(form.headerPrefix),
          },
        };
  return {
    transport: {
      kind: "remote",
      url: form.url,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(form.legacy ? { protocol: "sse" as const } : {}),
      ...(form.privateNetwork ? { network: "private" as const } : {}),
    },
    secrets: form.token === "" ? {} : { [reference]: { server: form.name, value: form.token } },
  };
}
function credentialPrefix(prefix: string): { readonly prefix?: string } {
  return prefix === "" ? {} : { prefix };
}
function oauthDefinition(
  form: Form,
): Pick<McpServerDefinition, "transport"> & { secrets: McpSettingsUpdate["secrets"] } {
  return {
    transport: {
      kind: "remote",
      url: form.url,
      ...(form.legacy ? { protocol: "sse" as const } : {}),
      ...(form.privateNetwork ? { network: "private" as const } : {}),
      oauth: {
        issuer: form.issuer,
        ...(form.clientId === "" ? {} : { clientId: form.clientId }),
        ...(form.scope === "" ? {} : { scope: form.scope }),
      },
    },
    secrets: {},
  };
}
function definition(
  form: Form,
  previous: McpServerDefinition | undefined,
): { server: McpServerDefinition; secrets: McpSettingsUpdate["secrets"] } {
  const common = {
    ...(previous?.credentialGeneration === undefined
      ? {}
      : { credentialGeneration: previous.credentialGeneration }),
    name: form.name,
    description: previous?.description,
    enabled: previous?.enabled ?? true,
    ...(previous === undefined || previous.discovery === "automatic"
      ? { discovery: "automatic" as const }
      : {}),
    tools: form.toolPolicies,
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
    environment: Object.fromEntries(
      Object.entries(old?.environment ?? {}).filter(
        ([name]) => !form.removedEnvironment.includes(name),
      ),
    ),
    ...(keepSecrets && old.secretEnvironment !== undefined
      ? {
          secretEnvironment: Object.fromEntries(
            Object.entries(old.secretEnvironment).filter(
              ([name]) => !form.removedEnvironment.includes(name),
            ),
          ),
        }
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
  const headers = Object.keys(old.headers ?? {}).filter(
    (name) => !form.removedHeaders.includes(name),
  );
  return headers.some(
    (key) => key.toLowerCase() !== form.headerName.toLowerCase() || form.token === "",
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
    changed &&
    Object.keys(old.secretEnvironment ?? {}).some(
      (name) => !form.removedEnvironment.includes(name),
    ) &&
    form.environmentFile === ""
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
  if (
    update.server.enabled &&
    !(update.server.transport.kind === "remote" && update.server.transport.oauth !== undefined)
  )
    await connect(model, update.server.name);
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
      toolPolicies: server.tools,
      ...(transport.kind === "local"
        ? { command: transport.command[0], args: transport.command.slice(1).join("\n") }
        : {
            url: transport.url,
            legacy: transport.protocol === "sse",
            privateNetwork: transport.network === "private",
            oauth: transport.oauth !== undefined,
            issuer: transport.oauth?.issuer ?? "",
            clientId: transport.oauth?.clientId ?? "",
            scope: transport.oauth?.scope ?? "",
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
  const enabledState = server.enabled ? (connection?.state ?? "idle") : "disabled";
  const state = model.state.statusStale ? "unavailable" : enabledState;
  const status = connectionStatus(state, connection?.toolCount, t);
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
  if (!server.enabled || server.transport.kind !== "remote" || server.transport.oauth === undefined)
    return null;
  const connection = model.state.snapshot?.connections?.find((entry) => entry.name === server.name);
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
        disabled={busy}
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
function TextField({
  model,
  label,
  field,
  type = "text",
  required = false,
}: {
  readonly model: Model;
  readonly label: string;
  readonly field:
    | "name"
    | "url"
    | "token"
    | "command"
    | "issuer"
    | "clientId"
    | "scope"
    | "headerName"
    | "headerPrefix";
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
        pattern={field === "name" ? String.raw`[a-z][a-z0-9_\-]{0,63}` : undefined}
        value={model.state.form[field]}
        onChange={(event) => change(model, field, event.target.value)}
      />
    </label>
  );
}
function HeaderOptions({ model, t }: ViewProps): ReactNode {
  const { form } = model.state;
  return (
    <>
      {" "}
      {!form.oauth && (
        <details>
          <summary>{t("settings.mcp.advanced")}</summary>
          <TextField
            model={model}
            field="headerName"
            label={t("settings.mcp.headerName")}
            required
          />
          <TextField model={model} field="headerPrefix" label={t("settings.mcp.headerPrefix")} />
          <StoredEntries model={model} t={t} kind="headers" />
        </details>
      )}
    </>
  );
}
function RemoteFields({ model, t }: ViewProps): ReactNode {
  const { form } = model.state;
  return (
    <>
      <TextField model={model} field="url" label={t("settings.mcp.url")} type="url" required />
      <HeaderOptions model={model} t={t} />
      <label className={styles.cmpCheck}>
        <input
          type="checkbox"
          checked={form.oauth}
          onChange={(event) => change(model, "oauth", event.target.checked)}
        />
        {t("settings.mcp.oauth")}
      </label>
      {form.oauth ? (
        <>
          <TextField
            model={model}
            field="issuer"
            label={t("settings.mcp.issuer")}
            type="url"
            required
          />
          <TextField model={model} field="clientId" label={t("settings.mcp.clientId")} />
          <TextField model={model} field="scope" label={t("settings.mcp.scope")} />
        </>
      ) : (
        <TextField model={model} field="token" label={t("settings.mcp.token")} type="password" />
      )}
      <label className={styles.cmpCheck}>
        <input
          type="checkbox"
          checked={form.privateNetwork}
          onChange={(event) => change(model, "privateNetwork", event.target.checked)}
        />
        {t("settings.mcp.private")}
      </label>
      <label className={styles.cmpCheck}>
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
function storedEntryNames(model: Model, kind: "headers" | "environment"): readonly string[] {
  const previous = model.state.snapshot?.servers.find(
    (server) => server.name === model.state.editing,
  );
  const transport = previous?.transport;
  if (transport === undefined) return [];
  if (kind === "headers")
    return transport.kind === "remote" ? Object.keys(transport.headers ?? {}) : [];
  if (transport.kind !== "local") return [];
  return [
    ...new Set([
      ...Object.keys(transport.environment),
      ...Object.keys(transport.secretEnvironment ?? {}),
    ]),
  ];
}
function StoredEntries({
  model,
  t,
  kind,
}: ViewProps & { readonly kind: "headers" | "environment" }): ReactNode {
  const names = storedEntryNames(model, kind);
  const field = kind === "headers" ? "removedHeaders" : "removedEnvironment";
  return (
    <>
      {names
        .filter((name) => !model.state.form[field].includes(name))
        .map((name) => (
          <div key={name}>
            {name}{" "}
            <button
              type="button"
              aria-label={t("settings.mcp.removeEntry", { name })}
              onClick={() =>
                model.patch({
                  form: { ...model.state.form, [field]: [...model.state.form[field], name] },
                })
              }
            >
              {t("settings.mcp.remove")}
            </button>
          </div>
        ))}
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
      <details>
        <summary>{t("settings.mcp.advanced")}</summary>
        <label>
          {t("settings.mcp.environmentValues")}
          <textarea
            rows={3}
            value={model.state.form.environmentFile}
            onChange={(event) => change(model, "environmentFile", event.target.value)}
          />
        </label>
        <StoredEntries model={model} t={t} kind="environment" />
      </details>
      <p>{t("settings.mcp.envHelp")}</p>
    </>
  );
}
function ToolPolicies({ model, t }: ViewProps): ReactNode {
  const { form } = model.state;
  return (
    <>
      {" "}
      {Object.keys(form.toolPolicies).length > 0 && (
        <details>
          <summary>{t("settings.mcp.toolPermissions")}</summary>
          {Object.entries(form.toolPolicies).map(([name, risk]) => (
            <label key={name}>
              {name}
              <select
                value={risk}
                onChange={(event) =>
                  model.patch({
                    form: {
                      ...form,
                      toolPolicies: {
                        ...form.toolPolicies,
                        [name]: event.target.value === "read" ? "read" : "write",
                      },
                    },
                  })
                }
              >
                <option value="write">{t("settings.mcp.writePermission")}</option>
                <option value="read">{t("settings.mcp.readPermission")}</option>
              </select>
            </label>
          ))}
        </details>
      )}
    </>
  );
}
function McpForm({ model, t }: ViewProps): ReactNode {
  const { form, editing, busy, snapshot } = model.state;
  const disabledServer =
    snapshot?.servers.find((server) => server.name === editing)?.enabled === false;
  return (
    <form
      className={styles.cmpFormCard}
      onSubmit={(event) => {
        event.preventDefault();
        void perform(model, () => submit(model));
      }}
    >
      <fieldset disabled={busy} className={styles.cmpForm}>
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
          <p className={styles.cmpHelp}>{t("settings.mcp.saveUnavailable")}</p>
        )}
        <ToolPolicies model={model} t={t} />
        <div className={styles.cmpActions}>
          <button
            className={styles.cmpPrimary}
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
  const { error, busy, needsPairing, credentialsRequired } = model.state;
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
    <section className={styles.cmpPanel} aria-label={t("settings.mcp.title")} aria-busy={busy}>
      <header className={styles.cmpHeader}>
        <div>
          <h2>{t("settings.mcp.title")}</h2>
          <p>{t("settings.mcp.description")}</p>
        </div>
        <button
          type="button"
          className={styles.cmpPrimary}
          disabled={busy || formOpen}
          onClick={(event) => {
            model.formOpener.current = event.currentTarget;
            model.patch({ formOpen: true, editing: undefined, form: EMPTY });
          }}
        >
          <PlusIcon />
          {t("settings.mcp.add")}
        </button>
      </header>
      <div className={styles.cmpAvailability}>
        <PluginsIcon />
        <span>{t("settings.mcp.availability")}</span>
      </div>
      <McpSettingsError model={model} t={t} />
      <McpOverview model={model} t={t} />
      {formOpen && <McpForm model={model} t={t} />}
    </section>
  );
}
