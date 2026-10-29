"use client";

import {
  useOptionalWidgetTranslate as useTranslate,
  type WidgetMessageKey as MessageKey,
} from "@/lib/optional-widget-i18n";
// Issue #2245 (Epic #2238, ADR-0128 D2/D3) — the add-connector flow with a WRITE-ONLY token field.
//
// Security-critical (AC): the API token is held only in transient component state, rides the create
// request body exactly once, and is CLEARED and unmounted the instant the credential is created (the
// form advances to the verify phase, which never renders the token). It is never echoed into a
// response type, persisted, or logged. Base-URL entry mirrors the contract validation
// (`isSafeAtlassianConnectorBaseUrl`) with immediate inline feedback. After save, an inline
// verify-connection step renders the closed status union as actionable copy.

import { useId, useState, type ReactNode, type SubmitEvent } from "react";
import type { AtlassianConnectorProvider } from "@oscharko-dev/keiko-contracts";
import { isSafeAtlassianConnectorBaseUrl } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { ApiError } from "@/lib/api";

import type {
  CreateAtlassianConnectorInput,
  AtlassianConnectorMetadata,
  AtlassianConnectorsClient,
  AtlassianConnectorVerifyStatus,
} from "@/lib/atlassian-connectors-api";
import { providerLabelKey } from "./connector-labels";
import { TextField } from "./TextField";
import { VerifyConnectionStatus } from "./VerifyConnectionStatus";
import { useConnectorOperation } from "./useConnectorOperation";

export type AddConnectorClient = Pick<
  AtlassianConnectorsClient,
  "createConnector" | "verifyConnector"
>;

export interface AddConnectorFormProps {
  readonly client: AddConnectorClient;
  readonly onCreated: (metadata: AtlassianConnectorMetadata) => void;
  readonly onClose: () => void;
  readonly jiraLive?: boolean;
}

interface EntryFields {
  readonly provider: AtlassianConnectorProvider;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly email: string;
  readonly token: string;
}

type TextFieldName = "displayName" | "baseUrl" | "email" | "token";
type FieldErrors = Partial<Record<TextFieldName, MessageKey>>;
type Phase = { readonly kind: "entry" } | { readonly kind: "verify"; readonly authRef: string };

interface TextFieldConfig {
  readonly name: TextFieldName;
  readonly labelKey: MessageKey;
  readonly placeholderKey: MessageKey;
  readonly type?: "text" | "password" | "email";
  readonly hintKey?: MessageKey;
}

const DEFAULT_FIELDS: EntryFields = {
  provider: "confluence",
  displayName: "",
  baseUrl: "",
  email: "",
  token: "",
};

// Linear, backtracking-free: one-or-more non-space/non-`@` chars, a single `@`, then the same. The
// disjoint character classes remove the `\S+`/`\S+` ambiguity around `@` (no super-linear matching).
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/u;

const TEXT_FIELDS: readonly TextFieldConfig[] = [
  {
    name: "displayName",
    labelKey: "atlassianConnectors.add.displayName",
    placeholderKey: "atlassianConnectors.add.displayNamePlaceholder",
  },
  {
    name: "baseUrl",
    labelKey: "atlassianConnectors.add.baseUrl",
    placeholderKey: "atlassianConnectors.add.baseUrlPlaceholder",
  },
  {
    name: "email",
    labelKey: "atlassianConnectors.add.email",
    placeholderKey: "atlassianConnectors.add.emailPlaceholder",
    type: "email",
  },
  {
    name: "token",
    labelKey: "atlassianConnectors.add.token",
    placeholderKey: "atlassianConnectors.add.tokenPlaceholder",
    hintKey: "atlassianConnectors.add.tokenHint",
    type: "password",
  },
];

// Input syntax only: exact private-target admission stays with the server's operator policy.
function hasHttpsAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}
function connectorInput(
  fields: EntryFields,
  jiraLive: boolean,
  creationId: string,
): CreateAtlassianConnectorInput {
  const common = {
    displayName: fields.displayName.trim(),
    baseUrl: fields.baseUrl,
    apiToken: fields.token,
  };
  return jiraLive
    ? {
        ...common,
        provider: "jira",
        deployment: "data-center",
        authScheme: "bearer-pat",
        livePodCreationRequestId: creationId,
      }
    : { ...common, provider: fields.provider, accountEmail: fields.email };
}
function validateEntry(fields: EntryFields, jiraLive: boolean): FieldErrors {
  const errors: FieldErrors = {};
  if (fields.displayName.trim().length === 0) {
    errors.displayName = "atlassianConnectors.validation.displayName";
  }
  if (
    !(jiraLive ? hasHttpsAddress(fields.baseUrl) : isSafeAtlassianConnectorBaseUrl(fields.baseUrl))
  ) {
    errors.baseUrl = "atlassianConnectors.validation.baseUrl";
  }
  if (!jiraLive && !EMAIL_PATTERN.test(fields.email))
    errors.email = "atlassianConnectors.validation.email";
  if (fields.token.length === 0) errors.token = "atlassianConnectors.validation.token";
  return errors;
}

interface EntryController {
  readonly jiraLive: boolean;
  readonly fields: EntryFields;
  readonly errors: FieldErrors;
  readonly submitError: string | undefined;
  readonly busy: boolean;
  readonly setText: (name: TextFieldName, value: string) => void;
  readonly setProvider: (provider: AtlassianConnectorProvider) => void;
  readonly submit: (event: SubmitEvent) => void;
}

function useAddConnectorEntry(
  client: AddConnectorClient,
  onCreated: (metadata: AtlassianConnectorMetadata) => void,
  onVerifyPhase: (authRef: string) => void,
  jiraLive: boolean,
): EntryController {
  const t = useTranslate();
  const [fields, setFields] = useState<EntryFields>(DEFAULT_FIELDS);
  const [creationId] = useState(() => crypto.randomUUID());
  const operation = useConnectorOperation(creationId);
  const [errors, setErrors] = useState<FieldErrors>({});
  const setText = (name: TextFieldName, value: string): void => {
    setFields((current) => ({ ...current, [name]: value }));
  };
  const setProvider = (provider: AtlassianConnectorProvider): void => {
    setFields((current) => ({ ...current, provider }));
  };
  const run = (): void => {
    const input = connectorInput(fields, jiraLive, creationId);
    setFields((current) => ({ ...current, token: "" }));
    operation.run(
      "create",
      () => client.createConnector(input),
      (metadata) => {
        setFields(DEFAULT_FIELDS);
        onCreated(metadata);
        onVerifyPhase(metadata.authRef);
      },
      (error: unknown) =>
        !jiraLive && error instanceof ApiError ? error.message : t("atlassianConnectors.retry"),
    );
  };
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (operation.busy) return;
    const nextErrors = validateEntry(fields, jiraLive);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) run();
  };
  return {
    fields,
    errors,
    submitError: operation.error,
    busy: operation.busy,
    setText,
    setProvider,
    submit,
    jiraLive,
  };
}

function ProviderSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  readonly disabled: boolean;
  readonly id: string;
  readonly value: AtlassianConnectorProvider;
  readonly onChange: (provider: AtlassianConnectorProvider) => void;
}): ReactNode {
  const t = useTranslate();
  return (
    <div className="acx-field">
      <label className="acx-label" htmlFor={id}>
        {t("atlassianConnectors.add.provider")}
      </label>
      <select
        id={id}
        className="acx-select"
        disabled={disabled}
        value={value}
        onChange={(event) => {
          onChange(event.target.value as AtlassianConnectorProvider);
        }}
      >
        <option value="confluence">{t(providerLabelKey("confluence"))}</option>
        <option value="jira">{t(providerLabelKey("jira"))}</option>
      </select>
    </div>
  );
}

function EntryFieldsView({
  controller,
  prefix,
}: {
  readonly controller: EntryController;
  readonly prefix: string;
}): ReactNode {
  const t = useTranslate();
  const { fields, errors, busy } = controller;
  return (
    <>
      {!controller.jiraLive ? (
        <ProviderSelect
          id={`${prefix}-provider`}
          value={fields.provider}
          disabled={busy}
          onChange={controller.setProvider}
        />
      ) : null}
      {controller.jiraLive ? (
        <p className="acx-hint">{t("atlassianConnectors.live.patHint")}</p>
      ) : null}
      {TEXT_FIELDS.filter((cfg) => !controller.jiraLive || cfg.name !== "email").map((cfg) => (
        <TextField
          key={cfg.name}
          id={`${prefix}-${cfg.name}`}
          labelKey={cfg.labelKey}
          placeholderKey={cfg.placeholderKey}
          value={fields[cfg.name]}
          onChange={(value) => controller.setText(cfg.name, value)}
          errorKey={errors[cfg.name]}
          autoComplete="off"
          disabled={busy}
          {...(cfg.type === undefined ? {} : { type: cfg.type })}
          {...(cfg.hintKey === undefined ? {} : { hintKey: cfg.hintKey })}
        />
      ))}
    </>
  );
}

function EntryForm({
  controller,
  onClose,
}: {
  readonly controller: EntryController;
  readonly onClose: () => void;
}): ReactNode {
  const t = useTranslate();
  const prefix = useId();
  const { submitError, busy } = controller;
  return (
    <form className="acx-form" data-testid="acx-add-form" onSubmit={controller.submit}>
      <EntryFieldsView controller={controller} prefix={prefix} />
      {submitError !== undefined ? (
        <p className="acx-error" role="alert">
          {submitError}
        </p>
      ) : null}
      <div className="acx-actions">
        <button type="submit" className="lk-btn lk-btn-primary" disabled={busy}>
          {busy ? t("atlassianConnectors.add.saving") : t("atlassianConnectors.add.submit")}
        </button>
        <button type="button" className="lk-btn" onClick={onClose} disabled={busy}>
          {t("atlassianConnectors.add.cancel")}
        </button>
      </div>
    </form>
  );
}

function VerifyPhase({
  client,
  authRef,
  onClose,
}: {
  readonly client: AddConnectorClient;
  readonly authRef: string;
  readonly onClose: () => void;
}): ReactNode {
  const t = useTranslate();
  const operation = useConnectorOperation(authRef);
  const { busy, error } = operation;
  const [status, setStatus] = useState<AtlassianConnectorVerifyStatus | undefined>();
  const runVerify = (): void =>
    operation.run(
      "verify",
      () => client.verifyConnector(authRef),
      (result) => setStatus(result.status),
    );
  return (
    <div className="acx-form" data-testid="acx-add-verify">
      <div className="acx-actions">
        <button type="button" className="lk-btn lk-btn-primary" onClick={runVerify} disabled={busy}>
          {busy
            ? t("atlassianConnectors.verify.verifying")
            : t("atlassianConnectors.verify.button")}
        </button>
        <button type="button" className="lk-btn" onClick={onClose}>
          {t("atlassianConnectors.add.cancel")}
        </button>
      </div>
      {error !== undefined ? (
        <p className="acx-error" role="alert">
          {error}
        </p>
      ) : null}
      {status !== undefined ? <VerifyConnectionStatus status={status} /> : null}
    </div>
  );
}

export function AddConnectorForm({
  client,
  onCreated,
  onClose,
  jiraLive = false,
}: AddConnectorFormProps): ReactNode {
  const [phase, setPhase] = useState<Phase>({ kind: "entry" });
  const controller = useAddConnectorEntry(
    client,
    onCreated,
    (authRef) => {
      if (jiraLive) onClose();
      else setPhase({ kind: "verify", authRef });
    },
    jiraLive,
  );
  const close = (): void => {
    controller.setText("token", "");
    onClose();
  };
  if (phase.kind === "verify") {
    return <VerifyPhase client={client} authRef={phase.authRef} onClose={close} />;
  }
  return <EntryForm controller={controller} onClose={close} />;
}
