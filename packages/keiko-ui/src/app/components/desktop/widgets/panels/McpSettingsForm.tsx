"use client";

import { useId, type ReactNode } from "react";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { Icons } from "../../Icons";
import { useSettingsTranslate as useTranslate, type I18nTranslate } from "./settings-i18n";
import { change, clearForm, perform, submit, type Model } from "./useMcpSettingsModel";
import styles from "./McpSettingsPanel.module.css";

const { info: InfoIcon } = Icons;
interface ViewProps {
  readonly model: Model;
  readonly t: I18nTranslate;
}

function FieldHelp({ text, id }: { readonly text: string; readonly id?: string }): ReactNode {
  return (
    <span id={id} className={styles.cmpFieldHelp}>
      <InfoIcon />
      {text}
    </span>
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
  const t = useTranslate();
  const id = useId();
  const help = t(`settings.mcp.help.${field}`);
  const problem = model.state.formProblem === field;
  return (
    <div className={styles.cmpInputStack}>
      <label htmlFor={id} title={help}>
        {label}
      </label>
      <input
        id={id}
        ref={field === "name" ? model.nameInput : undefined}
        type={type}
        required={required}
        readOnly={field === "name" && model.state.editing !== undefined}
        autoComplete={field === "token" ? "new-password" : "off"}
        aria-describedby={`${id}-help`}
        aria-invalid={problem || (field === "name" && model.state.formProblem === "duplicate")}
        value={model.state.form[field]}
        onChange={(event) => change(model, field, event.target.value)}
      />
      <FieldHelp id={`${id}-help`} text={help} />
    </div>
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
      <label className={styles.cmpCheck} title={t("settings.mcp.help.oauth")}>
        <input
          type="checkbox"
          checked={form.oauth}
          onChange={(event) => change(model, "oauth", event.target.checked)}
        />
        {t("settings.mcp.oauth")}
      </label>
      {form.oauth && <FieldHelp text={t("settings.mcp.help.oauth")} />}
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
      <RemoteConnectionOptions model={model} t={t} />
    </>
  );
}
function RemoteConnectionOptions({ model, t }: ViewProps): ReactNode {
  const { form } = model.state;
  return (
    <details className={styles.cmpDisclosure}>
      <summary>{t("settings.mcp.connectionOptions")}</summary>
      <label className={styles.cmpCheck} title={t("settings.mcp.help.private")}>
        <input
          type="checkbox"
          checked={form.privateNetwork}
          onChange={(event) => change(model, "privateNetwork", event.target.checked)}
        />
        {t("settings.mcp.private")}
      </label>
      <FieldHelp text={t("settings.mcp.help.private")} />
      <label className={styles.cmpCheck} title={t("settings.mcp.help.legacy")}>
        <input
          type="checkbox"
          checked={form.legacy}
          onChange={(event) => change(model, "legacy", event.target.checked)}
        />
        {t("settings.mcp.legacy")}
      </label>
      <FieldHelp text={t("settings.mcp.help.legacy")} />
      <HeaderOptions model={model} t={t} />
    </details>
  );
}

function storedEntryNames(model: Model, kind: "headers" | "environment"): readonly string[] {
  const previous = model.state.snapshot?.servers.find(
    (server) => server.name === model.state.editing?.name,
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
  if (file === undefined) return;
  if (file.size > 64 * 1024) {
    model.patch({ formProblem: "envSize" });
    input.value = "";
    return;
  }
  void perform(model, async () => {
    try {
      change(model, "environmentFile", await file.text());
    } catch {
      reportClientDiagnostic("mcp-settings-env-file-read-failed");
      model.patch({ formProblem: "envRead" });
      input.value = "";
    }
  });
}

function LocalFields({ model, t }: ViewProps): ReactNode {
  const id = useId();
  return (
    <>
      <TextField model={model} field="command" label={t("settings.mcp.command")} required />
      <label title={t("settings.mcp.help.args")}>
        {t("settings.mcp.args")}
        <textarea
          rows={3}
          aria-describedby={`${id}-args`}
          value={model.state.form.args}
          onChange={(event) => change(model, "args", event.target.value)}
        />
      </label>
      <FieldHelp id={`${id}-args`} text={t("settings.mcp.help.args")} />
      <label title={t("settings.mcp.envHelp")}>
        {t("settings.mcp.env")}
        <input
          ref={model.fileInput}
          type="file"
          aria-describedby={`${id}-env`}
          onChange={(event) => importFile(model, event.target)}
        />
      </label>
      <FieldHelp id={`${id}-env`} text={t("settings.mcp.envHelp")} />
      <details className={styles.cmpDisclosure}>
        <summary>{t("settings.mcp.advanced")}</summary>
        <label title={t("settings.mcp.help.environmentValues")}>
          {t("settings.mcp.environmentValues")}
          <textarea
            rows={3}
            aria-describedby={`${id}-values`}
            value={model.state.form.environmentFile}
            onChange={(event) => change(model, "environmentFile", event.target.value)}
          />
        </label>
        <FieldHelp id={`${id}-values`} text={t("settings.mcp.help.environmentValues")} />
        <StoredEntries model={model} t={t} kind="environment" />
      </details>
    </>
  );
}
function ToolPolicies({ model, t }: ViewProps): ReactNode {
  const { form } = model.state;
  return (
    <>
      {" "}
      {Object.keys(form.toolPolicies).length > 0 && (
        <details className={styles.cmpDisclosure}>
          <summary title={t("settings.mcp.help.toolPermissions")}>
            {t("settings.mcp.toolPermissions")}
          </summary>
          <FieldHelp text={t("settings.mcp.help.toolPermissions")} />
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
function ConnectionType({ model, t }: ViewProps): ReactNode {
  const id = useId();
  return (
    <div className={styles.cmpInputStack}>
      <label htmlFor={id} title={t("settings.mcp.help.transport")}>
        {t("settings.mcp.transport")}
      </label>
      <select
        id={id}
        aria-describedby={`${id}-help`}
        value={model.state.form.kind}
        onChange={(event) => change(model, "kind", event.target.value)}
      >
        <option value="remote">{t("settings.mcp.remote")}</option>
        <option value="local">{t("settings.mcp.local")}</option>
      </select>
      <FieldHelp id={`${id}-help`} text={t("settings.mcp.help.transport")} />
    </div>
  );
}

export function McpForm({ model, t }: ViewProps): ReactNode {
  const { form, editing, busy, snapshot, formProblem } = model.state;
  const saveOnly = editing?.enabled === false || (form.kind === "remote" && form.oauth);
  return (
    <form
      className={styles.cmpFormCard}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void perform(model, () => submit(model));
      }}
    >
      <fieldset disabled={busy} className={styles.cmpForm}>
        <legend>{t(editing === undefined ? "settings.mcp.manual" : "settings.mcp.edit")}</legend>
        <TextField model={model} field="name" label={t("settings.mcp.name")} required />
        <ConnectionType model={model} t={t} />
        {form.kind === "remote" ? (
          <RemoteFields model={model} t={t} />
        ) : (
          <LocalFields model={model} t={t} />
        )}
        <ToolPolicies model={model} t={t} />
        {snapshot === undefined && (
          <p className={styles.cmpHelp}>{t("settings.mcp.saveUnavailable")}</p>
        )}
        {formProblem !== undefined && (
          <p className={styles.cmpFormProblem} role="alert">
            {t(`settings.mcp.problem.${formProblem}`)}
          </p>
        )}
        <div className={styles.cmpActions}>
          <button
            className={styles.cmpPrimary}
            type="submit"
            disabled={snapshot === undefined || model.state.needsPairing}
          >
            {t(saveOnly ? "settings.mcp.save" : "settings.mcp.saveConnect")}
          </button>
          <button type="button" onClick={() => clearForm(model)}>
            {t("settings.mcp.cancel")}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
