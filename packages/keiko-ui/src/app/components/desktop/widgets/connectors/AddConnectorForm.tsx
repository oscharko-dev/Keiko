// Issue #2245 (Epic #2238, ADR-0128 D2/D3) — the add-connector flow with a WRITE-ONLY token field.
//
// Security-critical (AC): the API token is held only in transient component state, rides the create
// request body exactly once, and is CLEARED and unmounted the instant the credential is created (the
// form advances to the verify phase, which never renders the token). It is never echoed into a
// response type, persisted, or logged. Base-URL entry mirrors the contract validation
// (`isSafeAtlassianConnectorBaseUrl`) with immediate inline feedback. After save, an inline
// verify-connection step renders the closed status union as actionable copy.

"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import {
  isSafeAtlassianConnectorBaseUrl,
  type AtlassianConnectorProvider,
} from "@oscharko-dev/keiko-contracts";
import { ApiError } from "@/lib/api";
import { useTranslate } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages.en";
import type {
  AtlassianConnectorMetadata,
  AtlassianConnectorsClient,
  AtlassianConnectorVerifyStatus,
} from "@/lib/atlassian-connectors-api";
import { providerLabelKey } from "./connector-labels";
import { TextField } from "./TextField";
import { VerifyConnectionStatus } from "./VerifyConnectionStatus";

export type AddConnectorClient = Pick<
  AtlassianConnectorsClient,
  "createConnector" | "verifyConnector"
>;

export interface AddConnectorFormProps {
  readonly client: AddConnectorClient;
  readonly onCreated: (metadata: AtlassianConnectorMetadata) => void;
  readonly onClose: () => void;
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

const EMAIL_PATTERN = /^\S+@\S+$/u;

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

function validateEntry(fields: EntryFields): FieldErrors {
  const errors: FieldErrors = {};
  if (fields.displayName.trim().length === 0) {
    errors.displayName = "atlassianConnectors.validation.displayName";
  }
  if (!isSafeAtlassianConnectorBaseUrl(fields.baseUrl)) {
    errors.baseUrl = "atlassianConnectors.validation.baseUrl";
  }
  if (!EMAIL_PATTERN.test(fields.email)) errors.email = "atlassianConnectors.validation.email";
  if (fields.token.length === 0) errors.token = "atlassianConnectors.validation.token";
  return errors;
}

interface EntryController {
  readonly fields: EntryFields;
  readonly errors: FieldErrors;
  readonly submitError: string | undefined;
  readonly busy: boolean;
  readonly setText: (name: TextFieldName, value: string) => void;
  readonly setProvider: (provider: AtlassianConnectorProvider) => void;
  readonly submit: (event: FormEvent) => void;
}

function useAddConnectorEntry(
  client: AddConnectorClient,
  onCreated: (metadata: AtlassianConnectorMetadata) => void,
  onVerifyPhase: (authRef: string) => void,
): EntryController {
  const t = useTranslate();
  const [fields, setFields] = useState<EntryFields>(DEFAULT_FIELDS);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const setText = (name: TextFieldName, value: string): void => {
    setFields((current) => ({ ...current, [name]: value }));
  };
  const setProvider = (provider: AtlassianConnectorProvider): void => {
    setFields((current) => ({ ...current, provider }));
  };
  const run = async (): Promise<void> => {
    setBusy(true);
    setSubmitError(undefined);
    try {
      const metadata = await client.createConnector({
        provider: fields.provider,
        displayName: fields.displayName.trim(),
        baseUrl: fields.baseUrl,
        accountEmail: fields.email,
        apiToken: fields.token,
      });
      // Token is dropped from state and unmounted here — the create request was its only hop.
      setFields(DEFAULT_FIELDS);
      onCreated(metadata);
      onVerifyPhase(metadata.authRef);
    } catch (caught) {
      setSubmitError(caught instanceof ApiError ? caught.message : t("atlassianConnectors.retry"));
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const nextErrors = validateEntry(fields);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) void run();
  };
  return { fields, errors, submitError, busy, setText, setProvider, submit };
}

function ProviderSelect({
  id,
  value,
  onChange,
}: {
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

function EntryForm({
  controller,
  onClose,
}: {
  readonly controller: EntryController;
  readonly onClose: () => void;
}): ReactNode {
  const t = useTranslate();
  const prefix = useId();
  const { fields, errors, submitError, busy } = controller;
  return (
    <form className="acx-form" data-testid="acx-add-form" onSubmit={controller.submit}>
      <ProviderSelect
        id={`${prefix}-provider`}
        value={fields.provider}
        onChange={controller.setProvider}
      />
      {TEXT_FIELDS.map((cfg) => (
        <TextField
          key={cfg.name}
          id={`${prefix}-${cfg.name}`}
          labelKey={cfg.labelKey}
          placeholderKey={cfg.placeholderKey}
          value={fields[cfg.name]}
          onChange={(value) => controller.setText(cfg.name, value)}
          errorKey={errors[cfg.name]}
          autoComplete="off"
          {...(cfg.type === undefined ? {} : { type: cfg.type })}
          {...(cfg.hintKey === undefined ? {} : { hintKey: cfg.hintKey })}
        />
      ))}
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
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AtlassianConnectorVerifyStatus | undefined>();
  const [error, setError] = useState<string | undefined>();
  const runVerify = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      setStatus((await client.verifyConnector(authRef)).status);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t("atlassianConnectors.retry"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="acx-form" data-testid="acx-add-verify">
      <div className="acx-actions">
        <button
          type="button"
          className="lk-btn lk-btn-primary"
          onClick={() => void runVerify()}
          disabled={busy}
        >
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

export function AddConnectorForm({ client, onCreated, onClose }: AddConnectorFormProps): ReactNode {
  const [phase, setPhase] = useState<Phase>({ kind: "entry" });
  const controller = useAddConnectorEntry(client, onCreated, (authRef) => {
    setPhase({ kind: "verify", authRef });
  });
  if (phase.kind === "verify") {
    return <VerifyPhase client={client} authRef={phase.authRef} onClose={onClose} />;
  }
  return <EntryForm controller={controller} onClose={onClose} />;
}
