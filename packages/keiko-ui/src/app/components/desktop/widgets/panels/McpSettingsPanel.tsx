"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  McpServerDefinition,
  McpSettingsSnapshot,
  McpSettingsUpdate,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { bffFetchJson } from "@/lib/http";
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
  readonly verified: Readonly<Record<string, number>>;
}
interface Model {
  readonly state: State;
  readonly patch: (change: Partial<State>) => void;
  readonly lock: React.RefObject<boolean>;
  readonly fileInput: React.RefObject<HTMLInputElement | null>;
  readonly nameInput: React.RefObject<HTMLInputElement | null>;
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
    form.token === "" ? old : { Authorization: { secretEnv: reference, prefix: "Bearer " } };
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
    enabled: true,
    discovery: "automatic" as const,
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
  return {
    kind: "local",
    command: [form.command, ...(form.args === "" ? [] : form.args.split("\n"))],
    environment: old?.environment ?? {},
    ...(old?.secretEnvironment === undefined ? {} : { secretEnvironment: old.secretEnvironment }),
  };
}

function useMcpModel(): Model {
  const sessionRedemptions = useCodingAppSessionRedemptions();
  const [state, setState] = useState<State>({
    form: EMPTY,
    busy: false,
    error: false,
    verified: {},
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void codingAppSessionPairingSettled(controller.signal)
      .then(() => bffFetchJson<McpSettingsSnapshot>(PATH, { signal: controller.signal }))
      .then((snapshot): void => {
        if (!controller.signal.aborted)
          setState((current) => ({ ...current, snapshot, error: false, verified: {} }));
      })
      .catch(() => {
        if (!controller.signal.aborted) setState((current) => ({ ...current, error: true }));
      });
    return (): void => controller.abort();
  }, [reload, sessionRedemptions]);
  return {
    state,
    fileInput,
    nameInput,
    lock,
    patch: (change): void => setState((current) => ({ ...current, ...change })),
    reload: (): void => setReload((value) => value + 1),
  };
}
async function perform(model: Model, work: () => Promise<void>): Promise<void> {
  if (model.lock.current) return;
  model.lock.current = true;
  model.patch({ busy: true, error: false });
  try {
    await work();
  } catch {
    model.patch({ error: true });
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
  const value = await bffFetchJson<McpSettingsSnapshot>(PATH, {
    method: "PUT",
    body: JSON.stringify({
      expectedRevision: snapshot.revision,
      servers,
      secrets,
      ...(environmentFiles === undefined ? {} : { environmentFiles }),
    }),
  });
  model.patch({ snapshot: value, verified: {} });
  return value;
}
async function connect(model: Model, name: string): Promise<void> {
  const result = await bffFetchJson<{ snapshot: McpSettingsSnapshot; toolCount: number }>(
    `${PATH}/${encodeURIComponent(name)}/connect`,
    { method: "POST" },
  );
  model.patch({
    snapshot: result.snapshot,
    verified: { ...model.state.verified, [name]: result.toolCount },
  });
}
function clearForm(model: Model): void {
  model.patch({ form: EMPTY, editing: undefined });
  if (model.fileInput.current !== null) model.fileInput.current.value = "";
}
async function submit(model: Model): Promise<void> {
  const { snapshot, form, editing } = model.state;
  if (snapshot === undefined) return;
  const previous = snapshot.servers.find((server) => server.name === editing);
  if (editing === undefined && snapshot.servers.some((server) => server.name === form.name))
    throw new Error("Duplicate MCP server");
  const update = definition(form, previous);
  await save(
    model,
    [...snapshot.servers.filter((server) => server.name !== editing), update.server],
    update.secrets,
    form.environmentFile === "" ? undefined : { [form.name]: form.environmentFile },
  );
  clearForm(model);
  await connect(model, update.server.name);
}
function edit(model: Model, server: McpServerDefinition): void {
  const transport = server.transport;
  model.patch({
    editing: server.name,
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
  model.patch({ form: { ...model.state.form, [key]: value } });
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
function McpServerCard({ model, t, server }: ServerViewProps): ReactNode {
  const count = model.state.verified[server.name];
  const status =
    count === undefined
      ? t(server.enabled ? "settings.mcp.unverified" : "settings.mcp.disabled")
      : t("settings.mcp.connected", { count });
  return (
    <li>
      <strong>{server.name}</strong>
      <span role="status">{status}</span>
      <McpServerActions model={model} t={t} server={server} />
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
        onClick={() => edit(model, server)}
      >
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
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void perform(model, () => changeServer(model, server, true));
        }}
      >
        {t("settings.mcp.remove")}
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
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void perform(model, () => submit(model));
      }}
    >
      <fieldset disabled={busy || snapshot === undefined} className={styles.form}>
        <legend>{t(editing === undefined ? "settings.mcp.add" : "settings.mcp.edit")}</legend>
        <TextField model={model} field="name" label={t("settings.mcp.name")} required />
        <label>
          {t("settings.mcp.transport")}
          <select value={form.kind} onChange={(event) => change(model, "kind", event.target.value)}>
            <option value="remote">HTTPS</option>
            <option value="local">Local (stdio)</option>
          </select>
        </label>
        {form.kind === "remote" ? (
          <RemoteFields model={model} t={t} />
        ) : (
          <LocalFields model={model} t={t} />
        )}
        <div className={styles.actions}>
          <button type="submit">{t("settings.mcp.saveConnect")}</button>
          {editing !== undefined && (
            <button type="button" onClick={() => clearForm(model)}>
              {t("settings.mcp.cancel")}
            </button>
          )}
        </div>
      </fieldset>
    </form>
  );
}
export function McpSettingsPanel(): ReactNode {
  const model = useMcpModel();
  const t = useTranslate();
  const { error, busy, snapshot } = model.state;
  return (
    <section className={styles.panel} aria-label={t("settings.mcp.title")} aria-busy={busy}>
      <h2>{t("settings.mcp.title")}</h2>
      <p>{t("settings.mcp.description")}</p>
      {error && (
        <div role="alert">
          <p>{t("settings.mcp.error")}</p>
          <button type="button" disabled={busy} onClick={model.reload}>
            {t("settings.mcp.reload")}
          </button>
        </div>
      )}
      {snapshot === undefined && !error && <p role="status">{t("settings.mcp.loading")}</p>}
      <ul className={styles.servers}>
        {snapshot?.servers.map((server) => (
          <McpServerCard key={server.name} server={server} model={model} t={t} />
        ))}
      </ul>
      <McpForm model={model} t={t} />
    </section>
  );
}
