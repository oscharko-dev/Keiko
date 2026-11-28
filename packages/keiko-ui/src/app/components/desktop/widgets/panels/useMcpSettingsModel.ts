"use client";

import { useEffect, useRef, useState } from "react";
import {
  isMcpLocalAbsolutePath,
  isMcpRemoteAddress,
  isMcpServerName,
  parseMcpSettingsUpdate,
  type McpServerDefinition,
  type McpSettingsSnapshot,
  type McpSettingsUpdate,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { bffFetchJson, isDeniedError } from "@/lib/http";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
import {
  codingAppSessionPairingSettled,
  useCodingAppSessionRedemptions,
} from "@/lib/coding-app-session-client";

export const MCP_SETTINGS_PATH = "/api/mcp/servers";
export const EMPTY_MCP_FORM = {
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

export type Form = typeof EMPTY_MCP_FORM;
type FormProblem =
  "name" | "duplicate" | "url" | "command" | "envSize" | "envRead" | "invalid" | "stale";
interface State {
  readonly snapshot?: McpSettingsSnapshot | undefined;
  readonly form: Form;
  readonly editing?: McpServerDefinition | undefined;
  readonly importOpen?: boolean | undefined;
  readonly imported?: number | undefined;
  readonly formProblem?: FormProblem | undefined;
  readonly busy: boolean;
  readonly error: boolean;
  readonly statusStale: boolean;
  readonly needsPairing: boolean;
  readonly credentialsRequired: boolean;
  readonly connectionFailedAfterSave?: boolean | undefined;
  readonly formOpen: boolean;
}
export interface Model {
  readonly state: State;
  readonly patch: (change: Partial<State>) => void;
  readonly lock: React.RefObject<boolean>;
  readonly readEpoch: React.RefObject<number>;
  readonly fileInput: React.RefObject<HTMLInputElement | null>;
  readonly nameInput: React.RefObject<HTMLInputElement | null>;
  readonly formOpener: React.RefObject<HTMLElement | null>;
  readonly reload: () => void;
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

export function useMcpModel(): Model {
  const sessionRedemptions = useCodingAppSessionRedemptions();
  const [state, setState] = useState<State>({
    form: EMPTY_MCP_FORM,
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
  useEffect(() => {
    if (state.formOpen || state.busy || formOpener.current === null) return;
    formOpener.current.focus();
    formOpener.current = null;
  }, [state.formOpen, state.busy]);
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
      .then(() =>
        bffFetchJson<McpSettingsSnapshot>(MCP_SETTINGS_PATH, { signal: controller.signal }),
      )
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
export async function perform(model: Model, work: () => Promise<void>): Promise<void> {
  if (model.lock.current) return;
  model.lock.current = true;
  model.patch({
    busy: true,
    error: false,
    credentialsRequired: false,
    connectionFailedAfterSave: false,
  });
  try {
    await work();
  } catch (error: unknown) {
    reportClientDiagnostic(`MCP settings request failed (${clientErrorSummary(error)})`, {
      correlationId: correlationIdOf(error),
      errorEvidence: clientErrorEvidence(error),
    });
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
  const value = await bffFetchJson<McpSettingsSnapshot>(MCP_SETTINGS_PATH, {
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
export async function connect(model: Model, name: string): Promise<void> {
  model.readEpoch.current += 1;
  model.patch({ statusStale: true });
  const result = await bffFetchJson<{ snapshot: McpSettingsSnapshot; toolCount: number }>(
    `${MCP_SETTINGS_PATH}/${encodeURIComponent(name)}/connect`,
    { method: "POST" },
  );
  model.readEpoch.current += 1;
  model.patch({ snapshot: result.snapshot, statusStale: false });
}
export function clearForm(model: Model): void {
  model.patch({
    form: EMPTY_MCP_FORM,
    editing: undefined,
    formOpen: false,
    importOpen: false,
    formProblem: undefined,
  });
  if (model.fileInput.current !== null) model.fileInput.current.value = "";
}
function remoteNeedsCredentials(
  form: Form,
  old: Extract<McpServerDefinition["transport"], { kind: "remote" }>,
): boolean {
  if (form.oauth || (URL.canParse(form.url) && old.url === new URL(form.url).href)) return false;
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
function formProblem(
  form: Form,
  snapshot: McpSettingsSnapshot,
  editing?: McpServerDefinition,
): FormProblem | undefined {
  if (!isMcpServerName(form.name)) return "name";
  const current = snapshot.servers.find((server) => server.name === form.name);
  if (editing === undefined && current !== undefined) return "duplicate";
  if (editing !== undefined && JSON.stringify(current) !== JSON.stringify(editing)) return "stale";
  if (form.kind === "local") return isMcpLocalAbsolutePath(form.command) ? undefined : "command";
  return isMcpRemoteAddress(form.url) ? undefined : "url";
}

function formUpdate(
  form: Form,
  snapshot: McpSettingsSnapshot,
  editing?: McpServerDefinition,
): McpSettingsUpdate | undefined {
  const update = definition(form, editing);
  const servers =
    editing === undefined
      ? [...snapshot.servers, update.server]
      : snapshot.servers.map((server) => (server.name === editing.name ? update.server : server));
  const environmentFiles =
    form.kind === "local" && form.environmentFile !== ""
      ? { [form.name]: form.environmentFile }
      : undefined;
  return parseMcpSettingsUpdate({
    expectedRevision: snapshot.revision,
    servers,
    secrets: update.secrets,
    environmentFiles,
  });
}

async function checkSavedConnection(model: Model, name: string): Promise<void> {
  try {
    await connect(model, name);
  } catch (error) {
    reportClientDiagnostic(
      `MCP connection check after save failed (${clientErrorSummary(error)})`,
      {
        correlationId: correlationIdOf(error),
        errorEvidence: clientErrorEvidence(error),
      },
    );
    model.patch({
      error: true,
      needsPairing: isDeniedError(error),
      connectionFailedAfterSave: true,
    });
  }
}

export async function submit(model: Model): Promise<void> {
  const { snapshot, form, editing } = model.state;
  if (snapshot === undefined) return;
  const problem = formProblem(form, snapshot, editing);
  if (problem !== undefined) {
    model.patch({ formProblem: problem });
    return;
  }
  if (requiresFreshCredentials(form, editing)) {
    model.patch({ error: true, needsPairing: false, credentialsRequired: true });
    return;
  }
  const update = formUpdate(form, snapshot, editing);
  if (update === undefined) {
    model.patch({ formProblem: "invalid" });
    return;
  }
  const committed = await save(model, update.servers, update.secrets, update.environmentFiles);
  clearForm(model);
  const saved = committed.servers.find((server) => server.name === form.name);
  if (saved?.enabled === true && (form.kind === "local" || !form.oauth))
    await checkSavedConnection(model, form.name);
}

export function edit(model: Model, server: McpServerDefinition): void {
  const transport = server.transport;
  model.patch({
    editing: server,
    formOpen: true,
    importOpen: false,
    formProblem: undefined,
    form: {
      ...EMPTY_MCP_FORM,
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
export function change(model: Model, key: keyof Form, value: string | boolean): void {
  const form = { ...model.state.form, [key]: value };
  if (key === "kind") {
    form.token = "";
    form.environmentFile = "";
    if (model.fileInput.current !== null) model.fileInput.current.value = "";
  }
  model.patch({ form, formProblem: undefined });
}
export async function changeServer(
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
  if (remove && model.state.editing?.name === server.name) clearForm(model);
}
