"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import { ApiError, setupGateway, type GatewaySetupInput } from "@/lib/api";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import type { ModelCapability, VoiceProviderLocality } from "@/lib/types";
import { Icons } from "../Icons";
import KeikoSelect from "../KeikoSelect";

// Human-readable message first; the machine code (useful for support) is kept
// separate and rendered as a secondary mono line, never as a raw
// "CODE: message" prefix in the first-run flow (audit C191 — pattern:
// RelationshipCreateDialog / error-and-denial-ux.md).
function errorDetails(error: unknown): { readonly message: string; readonly code?: string } {
  if (error instanceof ApiError) {
    return { message: error.message, code: error.code };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: "The gateway could not be configured." };
}

function deploymentNamesFromInput(value: string): readonly string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,]/u)
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );
}

function timeoutMsFromInput(value: string, label = "Request timeout"): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer in milliseconds.`);
  }
  return parsed;
}

function isMicrosoftFoundryUrl(value: string): boolean {
  try {
    return new URL(value.trim()).hostname.endsWith(".services.ai.azure.com");
  } catch {
    return false;
  }
}

function skippedModelSummary(skippedModelIds: readonly string[]): string {
  if (skippedModelIds.length === 0) return "";
  // "Could not verify", not "incompatible": a deployment can also be skipped for a transient reason
  // (rate-limit, timeout, content-filter), so the wording must not over-claim a permanent capability
  // verdict the smoke cannot prove.
  return ` Could not verify deployment${skippedModelIds.length === 1 ? "" : "s"}: ${skippedModelIds.join(", ")}.`;
}

function storedVoiceModels(models: readonly ModelCapability[]): readonly string[] {
  return models.filter((model) => model.kind === "voice").map((model) => model.id);
}

const VOICE_PROVIDER_LOCALITIES: readonly VoiceProviderLocality[] = [
  "azure-foundry",
  "customer-hosted",
  "local-only",
];

const VOICE_PROVIDER_LOCALITY_SECTIONS = [
  {
    options: [
      { value: "azure-foundry", label: "Microsoft Foundry" },
      { value: "customer-hosted", label: "Customer-hosted" },
      { value: "local-only", label: "Local-only" },
    ],
  },
] satisfies readonly [
  {
    readonly options: readonly {
      readonly value: VoiceProviderLocality;
      readonly label: string;
    }[];
  },
];

function isVoiceProviderLocality(value: string): value is VoiceProviderLocality {
  return VOICE_PROVIDER_LOCALITIES.includes(value as VoiceProviderLocality);
}

function trimOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

// The "Replace model gateway settings" / "Update voice dictation credentials"
// fields live inside collapsed <details>. Those fields are not rendered, so
// the Tab trap must skip them — otherwise Tab parks focus on an invisible
// input and the user appears to lose focus (GEN-UI-FOCUS-015). This matches
// the visibility intent of NewWindowDialog.focusableInside (which filters
// offsetParent === null), but tests the <details open> ancestor directly
// because jsdom always reports offsetParent === null and cannot compute
// layout. The <summary> that toggles the details stays reachable so the
// collapsed section can be opened by keyboard.
function focusableInside(root: HTMLElement): readonly HTMLElement[] {
  const nodes = root.querySelectorAll<HTMLElement>(
    "button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex='-1'])",
  );
  const out: HTMLElement[] = [];
  nodes.forEach((node) => {
    const details = node.tagName === "SUMMARY" ? null : node.closest("details");
    if (details !== null && !details.open) return;
    out.push(node);
  });
  return out;
}

function bumpDatasetOpenCounter(root: HTMLElement, countKey: string, flagAttribute: string): void {
  const previousCount = Number(root.dataset[countKey] ?? "0");
  root.dataset[countKey] = String(previousCount + 1);
  root.setAttribute(flagAttribute, "true");
}

function dropDatasetOpenCounter(root: HTMLElement, countKey: string, flagAttribute: string): void {
  const nextCount = Math.max(0, Number(root.dataset[countKey] ?? "1") - 1);
  if (nextCount === 0) {
    delete root.dataset[countKey];
    root.removeAttribute(flagAttribute);
  } else {
    root.dataset[countKey] = String(nextCount);
  }
}

interface VoiceCredentialInputFields {
  readonly voiceBaseUrl: string;
  readonly voiceApiKey: string;
  readonly voiceApiKeyHeaderName: string;
  readonly voiceModelId: string;
  readonly voiceRealtimeModelId: string;
  readonly voiceSpeechOutputModelId: string;
  readonly voiceTimeoutMs: string;
}

function hasVoiceCredentialInput(fields: VoiceCredentialInputFields): boolean {
  return (
    fields.voiceBaseUrl.trim() !== "" ||
    fields.voiceApiKey.trim() !== "" ||
    fields.voiceApiKeyHeaderName.trim() !== "" ||
    fields.voiceModelId.trim() !== "" ||
    fields.voiceRealtimeModelId.trim() !== "" ||
    fields.voiceSpeechOutputModelId.trim() !== "" ||
    fields.voiceTimeoutMs.trim() !== ""
  );
}

interface DerivedSubmitFields {
  readonly parsedDeploymentNames: readonly string[];
  readonly parsedImageInputModelIds: readonly string[];
  readonly parsedTimeoutMs: number | undefined;
  readonly parsedVoiceTimeoutMs: number | undefined;
}

type GatewaySuccessMode = "standard" | "voice";

interface CoreGatewayFields {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName: string;
}

function hasCoreGatewayFieldInput(
  fields: CoreGatewayFields,
  derived: Pick<DerivedSubmitFields, "parsedDeploymentNames" | "parsedImageInputModelIds">,
): boolean {
  return (
    fields.baseUrl.trim() !== "" ||
    fields.apiKey.trim() !== "" ||
    fields.apiKeyHeaderName.trim() !== "" ||
    derived.parsedDeploymentNames.length > 0 ||
    derived.parsedImageInputModelIds.length > 0
  );
}

interface AnyGatewayCredentialFields {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName: string;
  readonly timeoutMs: string;
  readonly parsedDeploymentNames: readonly string[];
  readonly parsedImageInputModelIds: readonly string[];
  readonly voiceCredentialInput: boolean;
}

function hasAnyGatewayCredentialInput(fields: AnyGatewayCredentialFields): boolean {
  return (
    fields.baseUrl.trim() !== "" ||
    fields.apiKey.trim() !== "" ||
    fields.apiKeyHeaderName.trim() !== "" ||
    fields.timeoutMs.trim() !== "" ||
    fields.parsedDeploymentNames.length > 0 ||
    fields.parsedImageInputModelIds.length > 0 ||
    fields.voiceCredentialInput
  );
}

interface CanSubmitInput {
  readonly busy: boolean;
  readonly success: string | undefined;
  readonly requiresGatewayCredentials: boolean;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly hasGatewayCredentialInput: boolean;
  readonly hasFigmaCredentialInput: boolean;
}

function computeCanSubmit(input: CanSubmitInput): boolean {
  if (input.busy || input.success !== undefined) return false;
  return input.requiresGatewayCredentials
    ? input.baseUrl.trim() !== "" && input.apiKey.trim() !== ""
    : input.hasGatewayCredentialInput || input.hasFigmaCredentialInput;
}

interface DialogCopy {
  readonly title: string;
  readonly description: string;
  readonly submitRequirements: string;
}

function computeDialogCopy(preserveExisting: boolean): DialogCopy {
  return {
    title: preserveExisting ? "Update Keiko credentials" : "Connect Keiko to your internal LLMs",
    description: preserveExisting
      ? "Leave stored gateway fields blank to keep the current value. Keiko never returns existing secrets to the browser."
      : "Keiko needs the internal gateway URL and API token before chat and agent workflows can run. The token is tested once and stored only on this machine.",
    submitRequirements: preserveExisting
      ? "Enter at least one field to update. Blank stored gateway fields keep their current value."
      : "Base URL and API token are required. The Figma access token is optional.",
  };
}

function validateFoundryDeploymentNames(
  baseUrl: string,
  parsedDeploymentNames: readonly string[],
): string | undefined {
  if (isMicrosoftFoundryUrl(baseUrl) && parsedDeploymentNames.length === 0) {
    return "Microsoft Foundry requires deployment names. Paste the names from the Deployments tab.";
  }
  return undefined;
}

type SubmitTimeoutsResult =
  | {
      readonly ok: true;
      readonly timeoutMs: number | undefined;
      readonly voiceTimeoutMs: number | undefined;
    }
  | { readonly ok: false; readonly message: string };

function parseSubmitTimeouts(timeoutMs: string, voiceTimeoutMs: string): SubmitTimeoutsResult {
  try {
    return {
      ok: true,
      timeoutMs: timeoutMsFromInput(timeoutMs),
      voiceTimeoutMs: timeoutMsFromInput(voiceTimeoutMs, "Voice request timeout"),
    };
  } catch (caught) {
    return {
      ok: false,
      message: caught instanceof Error ? caught.message : "Request timeout is invalid.",
    };
  }
}

interface VoiceCredentialPayloadInput {
  readonly voiceBaseUrl: string;
  readonly voiceApiKey: string;
  readonly voiceApiKeyHeaderName: string;
  readonly voiceModelId: string;
  readonly voiceRealtimeModelId: string;
  readonly voiceSpeechOutputModelId: string;
  readonly voiceOutputVoiceId: string;
  readonly voiceProviderLocality: VoiceProviderLocality;
  readonly voiceTimeoutMs: number | undefined;
}

function buildVoiceCredentialFields(
  input: VoiceCredentialPayloadInput,
): Pick<
  GatewaySetupInput,
  | "voiceBaseUrl"
  | "voiceApiKey"
  | "voiceApiKeyHeaderName"
  | "voiceSpeechToTextModelId"
  | "voiceRealtimeModelId"
  | "voiceSpeechOutputModelId"
  | "voiceOutputVoiceId"
  | "voiceProviderLocality"
  | "voiceTimeoutMs"
> {
  return {
    voiceBaseUrl: trimOrUndefined(input.voiceBaseUrl),
    voiceApiKey: trimOrUndefined(input.voiceApiKey),
    voiceApiKeyHeaderName: trimOrUndefined(input.voiceApiKeyHeaderName),
    voiceSpeechToTextModelId: trimOrUndefined(input.voiceModelId),
    voiceRealtimeModelId: trimOrUndefined(input.voiceRealtimeModelId),
    voiceSpeechOutputModelId: trimOrUndefined(input.voiceSpeechOutputModelId),
    voiceOutputVoiceId: trimOrUndefined(input.voiceOutputVoiceId),
    voiceProviderLocality: input.voiceProviderLocality,
    ...(input.voiceTimeoutMs === undefined ? {} : { voiceTimeoutMs: input.voiceTimeoutMs }),
  };
}

interface GatewayFormFields {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyHeaderName: string;
  readonly timeoutMs: string;
  readonly deploymentNames: string;
  readonly imageInputModelIds: string;
  readonly voiceBaseUrl: string;
  readonly voiceApiKey: string;
  readonly voiceApiKeyHeaderName: string;
  readonly voiceModelId: string;
  readonly voiceRealtimeModelId: string;
  readonly voiceSpeechOutputModelId: string;
  readonly voiceOutputVoiceId: string;
  readonly voiceProviderLocality: VoiceProviderLocality;
  readonly voiceTimeoutMs: string;
  readonly figmaAccessToken: string;
  readonly preserveExisting: boolean;
}

function buildSetupGatewayPayload(
  fields: GatewayFormFields,
  derived: DerivedSubmitFields,
  voiceCredentialFields: Partial<GatewaySetupInput>,
): GatewaySetupInput {
  return {
    baseUrl: trimOrUndefined(fields.baseUrl),
    apiKey: trimOrUndefined(fields.apiKey),
    apiKeyHeaderName: trimOrUndefined(fields.apiKeyHeaderName),
    ...(derived.parsedTimeoutMs === undefined ? {} : { timeoutMs: derived.parsedTimeoutMs }),
    deploymentNames: derived.parsedDeploymentNames,
    preserveExisting: fields.preserveExisting,
    ...(derived.parsedImageInputModelIds.length === 0
      ? {}
      : { imageInputModelIds: derived.parsedImageInputModelIds }),
    ...voiceCredentialFields,
    ...(fields.figmaAccessToken.trim() === ""
      ? {}
      : { figmaAccessToken: fields.figmaAccessToken.trim() }),
  };
}

function voiceCredentialFieldsForMode(
  fields: GatewayFormFields,
  derived: DerivedSubmitFields,
  mode: GatewaySuccessMode,
): Partial<GatewaySetupInput> {
  if (mode === "standard") {
    return {};
  }
  return buildVoiceCredentialFields({
    voiceBaseUrl: fields.voiceBaseUrl,
    voiceApiKey: fields.voiceApiKey,
    voiceApiKeyHeaderName: fields.voiceApiKeyHeaderName,
    voiceModelId: fields.voiceModelId,
    voiceRealtimeModelId: fields.voiceRealtimeModelId,
    voiceSpeechOutputModelId: fields.voiceSpeechOutputModelId,
    voiceOutputVoiceId: fields.voiceOutputVoiceId,
    voiceProviderLocality: fields.voiceProviderLocality,
    voiceTimeoutMs: derived.parsedVoiceTimeoutMs,
  });
}

function figmaOnlyMessage(t: I18nTranslate, mode: GatewaySuccessMode): string {
  if (mode === "voice") {
    return t("gatewaySetup.voice.success.audioAndFigma");
  }
  return "Verified Figma access token. Reloading Keiko…";
}

function figmaAndGatewaySettingsMessage(t: I18nTranslate, mode: GatewaySuccessMode): string {
  if (mode === "voice") {
    return t("gatewaySetup.voice.success.gatewayAudioAndFigma");
  }
  return "Updated model gateway settings and verified Figma access token. Reloading Keiko…";
}

function noFigmaNoGatewayCredentialsMessage(t: I18nTranslate, mode: GatewaySuccessMode): string {
  if (mode === "voice") {
    return t("gatewaySetup.voice.success.audio");
  }
  return "Updated model gateway settings. Reloading Keiko…";
}

function figmaAndVerifiedModelsMessage(
  t: I18nTranslate,
  mode: GatewaySuccessMode,
  verifiedModelSummary: string,
  skippedSummary: string,
): string {
  if (mode === "voice") {
    return t("gatewaySetup.voice.success.verifiedAudioAndFigma", {
      verified: verifiedModelSummary,
      skipped: skippedSummary,
    });
  }
  return `${verifiedModelSummary} and Figma access token. Reloading Keiko…${skippedSummary}`;
}

function verifiedModelsMessage(
  t: I18nTranslate,
  mode: GatewaySuccessMode,
  verifiedModelSummary: string,
  skippedSummary: string,
): string {
  if (mode === "voice") {
    return t("gatewaySetup.voice.success.verifiedAudio", {
      verified: verifiedModelSummary,
      skipped: skippedSummary,
    });
  }
  return `${verifiedModelSummary}. Reloading Keiko…${skippedSummary}`;
}

interface ResolveSuccessMessageInput {
  readonly t: I18nTranslate;
  readonly submittedFigmaCredential: boolean;
  readonly submittedGatewaySettings: boolean;
  readonly submittedGatewayCredentials: boolean;
  readonly mode: GatewaySuccessMode;
  readonly verifiedModelSummary: string;
  readonly skippedSummary: string;
}

function resolveSuccessMessage(input: ResolveSuccessMessageInput): string {
  const {
    t,
    submittedFigmaCredential,
    submittedGatewaySettings,
    submittedGatewayCredentials,
    mode,
    verifiedModelSummary,
    skippedSummary,
  } = input;
  if (submittedFigmaCredential && !submittedGatewaySettings) {
    return figmaOnlyMessage(t, mode);
  }
  if (submittedFigmaCredential && !submittedGatewayCredentials) {
    return figmaAndGatewaySettingsMessage(t, mode);
  }
  if (!submittedFigmaCredential && !submittedGatewayCredentials) {
    return noFigmaNoGatewayCredentialsMessage(t, mode);
  }
  if (submittedFigmaCredential) {
    return figmaAndVerifiedModelsMessage(t, mode, verifiedModelSummary, skippedSummary);
  }
  return verifiedModelsMessage(t, mode, verifiedModelSummary, skippedSummary);
}

type GatewaySubmissionOutcome =
  | { readonly kind: "validation-error"; readonly message: string }
  | { readonly kind: "success"; readonly message: string; readonly skippedModelCount: number };

async function performGatewaySubmission(
  fields: GatewayFormFields,
  t: I18nTranslate,
): Promise<GatewaySubmissionOutcome> {
  const parsedDeploymentNames = deploymentNamesFromInput(fields.deploymentNames);
  const foundryError = validateFoundryDeploymentNames(fields.baseUrl, parsedDeploymentNames);
  if (foundryError !== undefined) {
    return { kind: "validation-error", message: foundryError };
  }
  const timeoutsResult = parseSubmitTimeouts(fields.timeoutMs, fields.voiceTimeoutMs);
  if (!timeoutsResult.ok) {
    return { kind: "validation-error", message: timeoutsResult.message };
  }
  const derived: DerivedSubmitFields = {
    parsedDeploymentNames,
    parsedImageInputModelIds: deploymentNamesFromInput(fields.imageInputModelIds),
    parsedTimeoutMs: timeoutsResult.timeoutMs,
    parsedVoiceTimeoutMs: timeoutsResult.voiceTimeoutMs,
  };
  const successMode: GatewaySuccessMode = hasVoiceCredentialInput(fields) ? "voice" : "standard";
  const voiceCredentialFields = voiceCredentialFieldsForMode(fields, derived, successMode);
  const submittedGatewayCredentials =
    !fields.preserveExisting || hasCoreGatewayFieldInput(fields, derived);
  const submittedGatewaySettings =
    submittedGatewayCredentials || derived.parsedTimeoutMs !== undefined;
  const submittedFigmaCredential = fields.figmaAccessToken.trim() !== "";
  const result = await setupGateway(
    buildSetupGatewayPayload(fields, derived, voiceCredentialFields),
  );
  const count = result.testedModelIds.length;
  const verifiedModelSummary = `Verified ${String(count)} workflow chat model${count === 1 ? "" : "s"}`;
  return {
    kind: "success",
    message: resolveSuccessMessage({
      t,
      submittedFigmaCredential,
      submittedGatewaySettings,
      submittedGatewayCredentials,
      mode: successMode,
      verifiedModelSummary,
      skippedSummary: skippedModelSummary(result.skippedModelIds ?? []),
    }),
    skippedModelCount: (result.skippedModelIds ?? []).length,
  };
}

interface GatewayBaseUrlFieldProps {
  readonly preserveExisting: boolean;
  readonly value: string;
  readonly disabled: boolean;
  readonly inputRef: RefObject<HTMLInputElement>;
  readonly onChange: Dispatch<SetStateAction<string>>;
}

function GatewayBaseUrlField({
  preserveExisting,
  value,
  disabled,
  inputRef,
  onChange,
}: GatewayBaseUrlFieldProps): ReactNode {
  return (
    <label className="gw-field gw-span-2">
      <span>
        Base URL {preserveExisting ? <span className="dlg-opt">leave blank to keep</span> : null}
      </span>
      <input
        className="gw-input mono"
        value={value}
        placeholder={
          preserveExisting
            ? "Only enter a value to replace the stored gateway URL"
            : "https://llm-gateway.example.com/v1"
        }
        autoComplete="off"
        disabled={disabled}
        ref={inputRef}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

interface GatewayApiKeyFieldProps {
  readonly preserveExisting: boolean;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: Dispatch<SetStateAction<string>>;
}

function GatewayApiKeyField({
  preserveExisting,
  value,
  disabled,
  onChange,
}: GatewayApiKeyFieldProps): ReactNode {
  return (
    <label className="gw-field">
      <span>
        API token {preserveExisting ? <span className="dlg-opt">leave blank to keep</span> : null}
      </span>
      <input
        className="gw-input mono"
        type="password"
        value={value}
        placeholder={
          preserveExisting
            ? "Only enter a value to replace the stored token"
            : "Paste your API token"
        }
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

interface GatewayApiKeyHeaderFieldProps {
  readonly preserveExisting: boolean;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: Dispatch<SetStateAction<string>>;
}

function GatewayApiKeyHeaderField({
  preserveExisting,
  value,
  disabled,
  onChange,
}: GatewayApiKeyHeaderFieldProps): ReactNode {
  return (
    <label className="gw-field">
      <span>
        API key header <span className="dlg-opt">optional</span>
      </span>
      <input
        className="gw-input mono"
        value={value}
        placeholder={preserveExisting ? "Leave blank to keep stored header" : "Authorization"}
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

interface GatewayTimeoutFieldProps {
  readonly preserveExisting: boolean;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: Dispatch<SetStateAction<string>>;
}

function GatewayTimeoutField({
  preserveExisting,
  value,
  disabled,
  onChange,
}: GatewayTimeoutFieldProps): ReactNode {
  return (
    <label className="gw-field">
      <span>
        Request timeout (ms) <span className="dlg-opt">optional</span>
      </span>
      <input
        className="gw-input mono"
        inputMode="numeric"
        value={value}
        placeholder={preserveExisting ? "Leave blank to keep stored timeout" : "30000"}
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

interface GatewayDeploymentNamesFieldProps {
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: Dispatch<SetStateAction<string>>;
}

function GatewayDeploymentNamesField({
  value,
  disabled,
  onChange,
}: GatewayDeploymentNamesFieldProps): ReactNode {
  return (
    <label className="gw-field">
      <span>Deployment names for Microsoft Foundry</span>
      <textarea
        className="gw-input gw-textarea mono"
        value={value}
        placeholder="Paste deployment names, one per line"
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

interface GatewayImageInputModelsFieldProps {
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: Dispatch<SetStateAction<string>>;
}

function GatewayImageInputModelsField({
  value,
  disabled,
  onChange,
}: GatewayImageInputModelsFieldProps): ReactNode {
  return (
    <label className="gw-field">
      <span>
        Image-input models <span className="dlg-opt">optional</span>
      </span>
      <textarea
        className="gw-input gw-textarea mono"
        value={value}
        placeholder="Paste image-capable model names, one per line"
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

interface GatewayFieldsSectionProps {
  readonly preserveExisting: boolean;
  readonly busy: boolean;
  readonly success: string | undefined;
  readonly baseUrl: string;
  readonly setBaseUrl: Dispatch<SetStateAction<string>>;
  readonly baseUrlRef: RefObject<HTMLInputElement>;
  readonly apiKey: string;
  readonly setApiKey: Dispatch<SetStateAction<string>>;
  readonly apiKeyHeaderName: string;
  readonly setApiKeyHeaderName: Dispatch<SetStateAction<string>>;
  readonly timeoutMs: string;
  readonly setTimeoutMs: Dispatch<SetStateAction<string>>;
  readonly deploymentNames: string;
  readonly setDeploymentNames: Dispatch<SetStateAction<string>>;
  readonly imageInputModelIds: string;
  readonly setImageInputModelIds: Dispatch<SetStateAction<string>>;
}

function GatewayFieldsSection(props: GatewayFieldsSectionProps): ReactNode {
  const disabled = props.busy || props.success !== undefined;
  return (
    <div className="gw-grid">
      <GatewayBaseUrlField
        preserveExisting={props.preserveExisting}
        value={props.baseUrl}
        disabled={disabled}
        inputRef={props.baseUrlRef}
        onChange={props.setBaseUrl}
      />
      <GatewayApiKeyField
        preserveExisting={props.preserveExisting}
        value={props.apiKey}
        disabled={disabled}
        onChange={props.setApiKey}
      />
      <GatewayApiKeyHeaderField
        preserveExisting={props.preserveExisting}
        value={props.apiKeyHeaderName}
        disabled={disabled}
        onChange={props.setApiKeyHeaderName}
      />
      <GatewayTimeoutField
        preserveExisting={props.preserveExisting}
        value={props.timeoutMs}
        disabled={disabled}
        onChange={props.setTimeoutMs}
      />
      <GatewayDeploymentNamesField
        value={props.deploymentNames}
        disabled={disabled}
        onChange={props.setDeploymentNames}
      />
      <GatewayImageInputModelsField
        value={props.imageInputModelIds}
        disabled={disabled}
        onChange={props.setImageInputModelIds}
      />
    </div>
  );
}

interface GatewayStoredCredentialsProps {
  readonly storedApiKeyHeaderName: string | undefined;
  readonly visibleModelNames: readonly string[];
  readonly hiddenModelCount: number;
  readonly fields: ReactNode;
}

function GatewayStoredCredentials({
  storedApiKeyHeaderName,
  visibleModelNames,
  hiddenModelCount,
  fields,
}: GatewayStoredCredentialsProps): ReactNode {
  return (
    <>
      <div className="gw-current" aria-label="Stored model gateway credentials">
        <div className="gw-current-row">
          <span>Gateway URL</span>
          <strong>Stored</strong>
        </div>
        <div className="gw-current-row">
          <span>API token</span>
          <strong className="mono">••••••••••••</strong>
        </div>
        <div className="gw-current-row">
          <span>API key header</span>
          <strong className="mono">{storedApiKeyHeaderName ?? "authorization"}</strong>
        </div>
        <div className="gw-current-models">
          <span>Configured models</span>
          <div className="gw-model-chips">
            {visibleModelNames.length === 0 ? (
              <strong>Stored</strong>
            ) : (
              visibleModelNames.map((modelId) => (
                <strong key={modelId} className="mono">
                  {modelId}
                </strong>
              ))
            )}
            {hiddenModelCount > 0 ? <strong>+{hiddenModelCount.toString()}</strong> : null}
          </div>
        </div>
      </div>
      <details className="gw-replace">
        <summary>Replace model gateway settings</summary>
        {fields}
      </details>
    </>
  );
}

interface GatewayModelSectionProps {
  readonly preserveExisting: boolean;
  readonly storedApiKeyHeaderName: string | undefined;
  readonly visibleModelNames: readonly string[];
  readonly hiddenModelCount: number;
  readonly fields: ReactNode;
}

function GatewayModelSection({
  preserveExisting,
  storedApiKeyHeaderName,
  visibleModelNames,
  hiddenModelCount,
  fields,
}: GatewayModelSectionProps): ReactNode {
  return (
    <section className="gw-section" aria-labelledby="gw-model-section-title">
      <div className="gw-section-head">
        <div>
          <h2 id="gw-model-section-title">Model gateway</h2>
          <p>
            {preserveExisting
              ? "Blank gateway fields keep the stored value."
              : "Base URL and API token are required."}
          </p>
        </div>
      </div>
      {preserveExisting ? (
        <GatewayStoredCredentials
          storedApiKeyHeaderName={storedApiKeyHeaderName}
          visibleModelNames={visibleModelNames}
          hiddenModelCount={hiddenModelCount}
          fields={fields}
        />
      ) : (
        fields
      )}
    </section>
  );
}

interface VoiceGuidanceNoteProps {
  readonly t: I18nTranslate;
  readonly voiceModelId: string;
  readonly voiceRealtimeModelId: string;
  readonly voiceSpeechOutputModelId: string;
}

function VoiceGuidanceNote({
  t,
  voiceModelId,
  voiceRealtimeModelId,
  voiceSpeechOutputModelId,
}: VoiceGuidanceNoteProps): ReactNode {
  return (
    <div className="gw-note gw-span-2">
      {t("gatewaySetup.voice.guidance")}
      <br />
      {t("gatewaySetup.voice.selectedCapabilities", {
        dictate: t(voiceModelId.trim() === "" ? "common.off" : "common.on"),
        digitalVoice: t(voiceRealtimeModelId.trim() === "" ? "common.off" : "common.on"),
        readAloud: t(voiceSpeechOutputModelId.trim() === "" ? "common.off" : "common.on"),
      })}
    </div>
  );
}

interface VoiceDictateDeploymentFieldProps {
  readonly t: I18nTranslate;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: Dispatch<SetStateAction<string>>;
}

function VoiceDictateDeploymentField({
  t,
  value,
  disabled,
  onChange,
}: VoiceDictateDeploymentFieldProps): ReactNode {
  return (
    <label className="gw-field">
      <span>
        {t("gatewaySetup.voice.dictateDeployment")}{" "}
        <span className="dlg-opt">{t("common.optional")}</span>
      </span>
      <input
        className="gw-input mono"
        value={value}
        placeholder="your-transcription-deployment"
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

interface VoiceRealtimeDeploymentFieldProps {
  readonly t: I18nTranslate;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: Dispatch<SetStateAction<string>>;
}

function VoiceRealtimeDeploymentField({
  t,
  value,
  disabled,
  onChange,
}: VoiceRealtimeDeploymentFieldProps): ReactNode {
  return (
    <label className="gw-field">
      <span>
        {t("gatewaySetup.voice.realtimeDeployment")}{" "}
        <span className="dlg-opt">{t("common.optional")}</span>
      </span>
      <input
        className="gw-input mono"
        value={value}
        placeholder="your-realtime-deployment"
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

interface VoiceSpeechOutputDeploymentFieldProps {
  readonly t: I18nTranslate;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: Dispatch<SetStateAction<string>>;
}

function VoiceSpeechOutputDeploymentField({
  t,
  value,
  disabled,
  onChange,
}: VoiceSpeechOutputDeploymentFieldProps): ReactNode {
  return (
    <label className="gw-field">
      <span>
        {t("gatewaySetup.voice.speechOutputDeployment")}{" "}
        <span className="dlg-opt">{t("common.optional")}</span>
      </span>
      <input
        className="gw-input mono"
        value={value}
        placeholder="your-speech-output-deployment"
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

interface VoiceOutputVoiceFieldProps {
  readonly t: I18nTranslate;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: Dispatch<SetStateAction<string>>;
}

function VoiceOutputVoiceField({
  t,
  value,
  disabled,
  onChange,
}: VoiceOutputVoiceFieldProps): ReactNode {
  return (
    <label className="gw-field">
      <span>
        {t("gatewaySetup.voice.outputVoice")}{" "}
        <span className="dlg-opt">{t("gatewaySetup.voice.outputVoiceHint")}</span>
      </span>
      <input
        className="gw-input mono"
        value={value}
        placeholder="alloy"
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

interface VoiceProviderLocalityFieldProps {
  readonly labelId: string;
  readonly value: VoiceProviderLocality;
  readonly disabled: boolean;
  readonly onChange: Dispatch<SetStateAction<VoiceProviderLocality>>;
}

function VoiceProviderLocalityField({
  labelId,
  value,
  disabled,
  onChange,
}: VoiceProviderLocalityFieldProps): ReactNode {
  return (
    <div className="gw-field">
      <span id={labelId}>
        Provider locality <span className="dlg-opt">optional</span>
      </span>
      <KeikoSelect
        ariaLabelledBy={labelId}
        menuTitle="Provider locality"
        sections={VOICE_PROVIDER_LOCALITY_SECTIONS}
        showMenuHeader={false}
        triggerClassName="gw-input gw-provider-locality-select"
        menuClassName="gw-provider-locality-menu"
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (isVoiceProviderLocality(next)) onChange(next);
        }}
      />
    </div>
  );
}

interface VoiceEndpointUrlFieldProps {
  readonly t: I18nTranslate;
  readonly preserveExisting: boolean;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: Dispatch<SetStateAction<string>>;
}

function VoiceEndpointUrlField({
  t,
  preserveExisting,
  value,
  disabled,
  onChange,
}: VoiceEndpointUrlFieldProps): ReactNode {
  return (
    <label className="gw-field gw-span-2">
      <span>
        {t("gatewaySetup.voice.endpointUrl")}{" "}
        {preserveExisting ? <span className="dlg-opt">leave blank to keep</span> : null}
      </span>
      <input
        className="gw-input mono"
        value={value}
        placeholder={
          preserveExisting
            ? t("gatewaySetup.voice.endpointReplacePlaceholder")
            : "https://voice-gateway.example.com/openai/v1"
        }
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

interface VoiceCredentialFieldProps {
  readonly t: I18nTranslate;
  readonly preserveExisting: boolean;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: Dispatch<SetStateAction<string>>;
}

function VoiceCredentialField({
  t,
  preserveExisting,
  value,
  disabled,
  onChange,
}: VoiceCredentialFieldProps): ReactNode {
  return (
    <label className="gw-field">
      <span>
        {t("gatewaySetup.voice.credential")}{" "}
        {preserveExisting ? <span className="dlg-opt">leave blank to keep</span> : null}
      </span>
      <input
        className="gw-input mono"
        type="password"
        value={value}
        placeholder={
          preserveExisting
            ? t("gatewaySetup.voice.credentialReplacePlaceholder")
            : t("gatewaySetup.voice.credentialPlaceholder")
        }
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

interface VoiceAuthHeaderFieldProps {
  readonly t: I18nTranslate;
  readonly preserveExisting: boolean;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: Dispatch<SetStateAction<string>>;
}

function VoiceAuthHeaderField({
  t,
  preserveExisting,
  value,
  disabled,
  onChange,
}: VoiceAuthHeaderFieldProps): ReactNode {
  return (
    <label className="gw-field">
      <span>
        {t("gatewaySetup.voice.authHeader")} <span className="dlg-opt">{t("common.advanced")}</span>
      </span>
      <input
        className="gw-input mono"
        value={value}
        placeholder={preserveExisting ? "Leave blank to keep stored header" : "api-key"}
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

interface VoiceTimeoutFieldProps {
  readonly t: I18nTranslate;
  readonly preserveExisting: boolean;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: Dispatch<SetStateAction<string>>;
}

function VoiceTimeoutField({
  t,
  preserveExisting,
  value,
  disabled,
  onChange,
}: VoiceTimeoutFieldProps): ReactNode {
  return (
    <label className="gw-field">
      <span>
        {t("gatewaySetup.voice.timeout")} <span className="dlg-opt">{t("common.advanced")}</span>
      </span>
      <input
        className="gw-input mono"
        inputMode="numeric"
        value={value}
        placeholder={preserveExisting ? "Leave blank to keep stored timeout" : "30000"}
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

interface VoiceDeploymentFieldsProps {
  readonly t: I18nTranslate;
  readonly voiceModelId: string;
  readonly setVoiceModelId: Dispatch<SetStateAction<string>>;
  readonly voiceRealtimeModelId: string;
  readonly setVoiceRealtimeModelId: Dispatch<SetStateAction<string>>;
  readonly voiceSpeechOutputModelId: string;
  readonly setVoiceSpeechOutputModelId: Dispatch<SetStateAction<string>>;
  readonly voiceOutputVoiceId: string;
  readonly setVoiceOutputVoiceId: Dispatch<SetStateAction<string>>;
  readonly voiceProviderLocalityLabelId: string;
  readonly voiceProviderLocality: VoiceProviderLocality;
  readonly setVoiceProviderLocality: Dispatch<SetStateAction<VoiceProviderLocality>>;
  readonly disabled: boolean;
}

function VoiceDeploymentFields(props: VoiceDeploymentFieldsProps): ReactNode {
  return (
    <>
      <VoiceGuidanceNote
        t={props.t}
        voiceModelId={props.voiceModelId}
        voiceRealtimeModelId={props.voiceRealtimeModelId}
        voiceSpeechOutputModelId={props.voiceSpeechOutputModelId}
      />
      <VoiceDictateDeploymentField
        t={props.t}
        value={props.voiceModelId}
        disabled={props.disabled}
        onChange={props.setVoiceModelId}
      />
      <VoiceRealtimeDeploymentField
        t={props.t}
        value={props.voiceRealtimeModelId}
        disabled={props.disabled}
        onChange={props.setVoiceRealtimeModelId}
      />
      <VoiceSpeechOutputDeploymentField
        t={props.t}
        value={props.voiceSpeechOutputModelId}
        disabled={props.disabled}
        onChange={props.setVoiceSpeechOutputModelId}
      />
      <VoiceOutputVoiceField
        t={props.t}
        value={props.voiceOutputVoiceId}
        disabled={props.disabled}
        onChange={props.setVoiceOutputVoiceId}
      />
      <VoiceProviderLocalityField
        labelId={props.voiceProviderLocalityLabelId}
        value={props.voiceProviderLocality}
        disabled={props.disabled}
        onChange={props.setVoiceProviderLocality}
      />
    </>
  );
}

interface VoiceConnectionFieldsProps {
  readonly t: I18nTranslate;
  readonly preserveExisting: boolean;
  readonly voiceBaseUrl: string;
  readonly setVoiceBaseUrl: Dispatch<SetStateAction<string>>;
  readonly voiceApiKey: string;
  readonly setVoiceApiKey: Dispatch<SetStateAction<string>>;
  readonly voiceApiKeyHeaderName: string;
  readonly setVoiceApiKeyHeaderName: Dispatch<SetStateAction<string>>;
  readonly voiceTimeoutMs: string;
  readonly setVoiceTimeoutMs: Dispatch<SetStateAction<string>>;
  readonly disabled: boolean;
}

function VoiceConnectionFields(props: VoiceConnectionFieldsProps): ReactNode {
  return (
    <>
      <VoiceEndpointUrlField
        t={props.t}
        preserveExisting={props.preserveExisting}
        value={props.voiceBaseUrl}
        disabled={props.disabled}
        onChange={props.setVoiceBaseUrl}
      />
      <VoiceCredentialField
        t={props.t}
        preserveExisting={props.preserveExisting}
        value={props.voiceApiKey}
        disabled={props.disabled}
        onChange={props.setVoiceApiKey}
      />
      <VoiceAuthHeaderField
        t={props.t}
        preserveExisting={props.preserveExisting}
        value={props.voiceApiKeyHeaderName}
        disabled={props.disabled}
        onChange={props.setVoiceApiKeyHeaderName}
      />
      <VoiceTimeoutField
        t={props.t}
        preserveExisting={props.preserveExisting}
        value={props.voiceTimeoutMs}
        disabled={props.disabled}
        onChange={props.setVoiceTimeoutMs}
      />
    </>
  );
}

interface VoiceFieldsSectionProps {
  readonly t: I18nTranslate;
  readonly busy: boolean;
  readonly success: string | undefined;
  readonly preserveExisting: boolean;
  readonly voiceModelId: string;
  readonly setVoiceModelId: Dispatch<SetStateAction<string>>;
  readonly voiceRealtimeModelId: string;
  readonly setVoiceRealtimeModelId: Dispatch<SetStateAction<string>>;
  readonly voiceSpeechOutputModelId: string;
  readonly setVoiceSpeechOutputModelId: Dispatch<SetStateAction<string>>;
  readonly voiceOutputVoiceId: string;
  readonly setVoiceOutputVoiceId: Dispatch<SetStateAction<string>>;
  readonly voiceProviderLocalityLabelId: string;
  readonly voiceProviderLocality: VoiceProviderLocality;
  readonly setVoiceProviderLocality: Dispatch<SetStateAction<VoiceProviderLocality>>;
  readonly voiceBaseUrl: string;
  readonly setVoiceBaseUrl: Dispatch<SetStateAction<string>>;
  readonly voiceApiKey: string;
  readonly setVoiceApiKey: Dispatch<SetStateAction<string>>;
  readonly voiceApiKeyHeaderName: string;
  readonly setVoiceApiKeyHeaderName: Dispatch<SetStateAction<string>>;
  readonly voiceTimeoutMs: string;
  readonly setVoiceTimeoutMs: Dispatch<SetStateAction<string>>;
}

function VoiceFieldsSection(props: VoiceFieldsSectionProps): ReactNode {
  const disabled = props.busy || props.success !== undefined;
  return (
    <div className="gw-grid">
      <VoiceDeploymentFields
        t={props.t}
        voiceModelId={props.voiceModelId}
        setVoiceModelId={props.setVoiceModelId}
        voiceRealtimeModelId={props.voiceRealtimeModelId}
        setVoiceRealtimeModelId={props.setVoiceRealtimeModelId}
        voiceSpeechOutputModelId={props.voiceSpeechOutputModelId}
        setVoiceSpeechOutputModelId={props.setVoiceSpeechOutputModelId}
        voiceOutputVoiceId={props.voiceOutputVoiceId}
        setVoiceOutputVoiceId={props.setVoiceOutputVoiceId}
        voiceProviderLocalityLabelId={props.voiceProviderLocalityLabelId}
        voiceProviderLocality={props.voiceProviderLocality}
        setVoiceProviderLocality={props.setVoiceProviderLocality}
        disabled={disabled}
      />
      <VoiceConnectionFields
        t={props.t}
        preserveExisting={props.preserveExisting}
        voiceBaseUrl={props.voiceBaseUrl}
        setVoiceBaseUrl={props.setVoiceBaseUrl}
        voiceApiKey={props.voiceApiKey}
        setVoiceApiKey={props.setVoiceApiKey}
        voiceApiKeyHeaderName={props.voiceApiKeyHeaderName}
        setVoiceApiKeyHeaderName={props.setVoiceApiKeyHeaderName}
        voiceTimeoutMs={props.voiceTimeoutMs}
        setVoiceTimeoutMs={props.setVoiceTimeoutMs}
        disabled={disabled}
      />
    </div>
  );
}

interface VoiceStoredCredentialsProps {
  readonly t: I18nTranslate;
  readonly voiceModelNames: readonly string[];
  readonly fields: ReactNode;
}

function VoiceStoredCredentials({
  t,
  voiceModelNames,
  fields,
}: VoiceStoredCredentialsProps): ReactNode {
  return (
    <>
      <div className="gw-current" aria-label={t("gatewaySetup.voice.storedAria")}>
        <div className="gw-current-row">
          <span>{t("gatewaySetup.voice.audioModels")}</span>
          <strong>{voiceModelNames.length > 0 ? "Stored" : "Not configured"}</strong>
        </div>
        {voiceModelNames.length > 0 ? (
          <div className="gw-current-models">
            <span>Voice models</span>
            <div className="gw-model-chips">
              {voiceModelNames.map((modelId) => (
                <strong key={modelId} className="mono">
                  {modelId}
                </strong>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <details className="gw-replace">
        <summary>{t("gatewaySetup.voice.updateSettings")}</summary>
        {fields}
      </details>
    </>
  );
}

interface VoiceModelSectionProps {
  readonly t: I18nTranslate;
  readonly preserveExisting: boolean;
  readonly voiceModelNames: readonly string[];
  readonly fields: ReactNode;
}

function VoiceModelSection({
  t,
  preserveExisting,
  voiceModelNames,
  fields,
}: VoiceModelSectionProps): ReactNode {
  return (
    <section className="gw-section" aria-labelledby="gw-voice-section-title">
      <div className="gw-section-head">
        <div>
          <h2 id="gw-voice-section-title">{t("gatewaySetup.voice.title")}</h2>
          <p>{t("gatewaySetup.voice.description")}</p>
        </div>
      </div>
      {preserveExisting ? (
        <VoiceStoredCredentials t={t} voiceModelNames={voiceModelNames} fields={fields} />
      ) : (
        fields
      )}
    </section>
  );
}

interface FigmaSectionProps {
  readonly preserveExisting: boolean;
  readonly busy: boolean;
  readonly success: string | undefined;
  readonly figmaAccessToken: string;
  readonly setFigmaAccessToken: Dispatch<SetStateAction<string>>;
  readonly figmaAccessTokenRef: RefObject<HTMLInputElement>;
}

function FigmaSection({
  preserveExisting,
  busy,
  success,
  figmaAccessToken,
  setFigmaAccessToken,
  figmaAccessTokenRef,
}: FigmaSectionProps): ReactNode {
  return (
    <section className="gw-section" aria-labelledby="gw-figma-section-title">
      <div className="gw-section-head">
        <div>
          <h2 id="gw-figma-section-title">Figma Snapshot</h2>
          <p>Optional connector credential.</p>
        </div>
      </div>
      <label className="gw-field">
        <span>
          Figma access token <span className="dlg-opt">optional</span>
        </span>
        <input
          className="gw-input mono"
          type="password"
          value={figmaAccessToken}
          placeholder={
            preserveExisting
              ? "Stored Figma token is kept when blank"
              : "Paste a read-only Figma PAT when needed"
          }
          autoComplete="off"
          disabled={busy || success !== undefined}
          ref={figmaAccessTokenRef}
          onChange={(event) => setFigmaAccessToken(event.target.value)}
        />
      </label>
    </section>
  );
}

interface GatewaySetupStatusProps {
  readonly error: string | undefined;
  readonly errorCode: string | undefined;
  readonly success: string | undefined;
  readonly busy: boolean;
}

function GatewaySetupStatus({
  error,
  errorCode,
  success,
  busy,
}: GatewaySetupStatusProps): ReactNode {
  return (
    <>
      {error !== undefined ? (
        <div className="gw-error" role="alert">
          {error}
          {errorCode !== undefined ? <div className="gw-error-code mono">{errorCode}</div> : null}
        </div>
      ) : null}
      {success !== undefined ? (
        <div className="gw-success" role="status">
          {success}
        </div>
      ) : null}
      {busy ? (
        <div className="gw-pending" role="status">
          Testing credentials…
        </div>
      ) : null}
    </>
  );
}

interface GatewaySetupActionsProps {
  readonly onCancel: (() => void) | undefined;
  readonly busy: boolean;
  readonly success: string | undefined;
  readonly canSubmit: boolean;
}

function GatewaySetupActions({
  onCancel,
  busy,
  success,
  canSubmit,
}: GatewaySetupActionsProps): ReactNode {
  return (
    <div className="gw-actions">
      {onCancel !== undefined ? (
        <button
          className="gw-cancel"
          type="button"
          disabled={busy || success !== undefined}
          onClick={onCancel}
        >
          Cancel
        </button>
      ) : null}
      <button
        className="gw-submit"
        type="submit"
        disabled={!canSubmit}
        aria-busy={busy}
        aria-describedby="gw-submit-requirements"
      >
        {busy ? "Testing credentials…" : "Test & save"}
      </button>
    </div>
  );
}

export function GatewaySetupDialog({
  onCancel,
  preserveExisting = false,
  storedApiKeyHeaderName,
  storedModels = [],
}: {
  readonly onCancel?: (() => void) | undefined;
  readonly preserveExisting?: boolean | undefined;
  readonly storedApiKeyHeaderName?: string | undefined;
  readonly storedModels?: readonly ModelCapability[] | undefined;
}): ReactNode {
  const t = useTranslate();
  const dialogRef = useRef<HTMLDivElement>(null);
  const voiceProviderLocalityLabelId = useId();
  const baseUrlRef = useRef<HTMLInputElement>(null);
  const figmaAccessTokenRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const reloadTimerRef = useRef<number | undefined>(undefined);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyHeaderName, setApiKeyHeaderName] = useState("");
  const [timeoutMs, setTimeoutMs] = useState("");
  const [deploymentNames, setDeploymentNames] = useState("");
  const [imageInputModelIds, setImageInputModelIds] = useState("");
  const [voiceBaseUrl, setVoiceBaseUrl] = useState("");
  const [voiceApiKey, setVoiceApiKey] = useState("");
  const [voiceApiKeyHeaderName, setVoiceApiKeyHeaderName] = useState("");
  const [voiceModelId, setVoiceModelId] = useState("");
  const [voiceRealtimeModelId, setVoiceRealtimeModelId] = useState("");
  const [voiceSpeechOutputModelId, setVoiceSpeechOutputModelId] = useState("");
  const [voiceOutputVoiceId, setVoiceOutputVoiceId] = useState("alloy");
  const [voiceProviderLocality, setVoiceProviderLocality] =
    useState<VoiceProviderLocality>("azure-foundry");
  const [voiceTimeoutMs, setVoiceTimeoutMs] = useState("");
  const [figmaAccessToken, setFigmaAccessToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [errorCode, setErrorCode] = useState<string | undefined>();
  const [success, setSuccess] = useState<string | undefined>();

  useEffect(() => {
    const root = document.documentElement;
    bumpDatasetOpenCounter(root, "keikoModalOpenCount", "data-keiko-modal-open");
    bumpDatasetOpenCounter(root, "keikoGatewaySetupOpenCount", "data-keiko-gateway-setup-open");
    triggerRef.current = document.activeElement as HTMLElement | null;
    if (preserveExisting) {
      figmaAccessTokenRef.current?.focus();
    } else {
      baseUrlRef.current?.focus();
    }
    return () => {
      if (reloadTimerRef.current !== undefined) {
        window.clearTimeout(reloadTimerRef.current);
      }
      dropDatasetOpenCounter(root, "keikoModalOpenCount", "data-keiko-modal-open");
      dropDatasetOpenCounter(root, "keikoGatewaySetupOpenCount", "data-keiko-gateway-setup-open");
      triggerRef.current?.focus?.();
    };
  }, [preserveExisting]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;
    const onDialogKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        if (busy || success !== undefined || onCancel === undefined) return;
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = focusableInside(dialog);
      if (focusables.length === 0) return;
      const first = focusables[0] as HTMLElement;
      const last = focusables[focusables.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", onDialogKeyDown);
    return () => dialog.removeEventListener("keydown", onDialogKeyDown);
  }, [busy, onCancel, success]);

  // After a failed test the controls are re-enabled but nothing was focused
  // (the disabled submit dropped focus to <body>, killing the Tab trap) —
  // return focus to the Base URL field so the user can correct directly
  // (audit C186/C084).
  useEffect(() => {
    if (error !== undefined && !busy) {
      if (preserveExisting && baseUrl.trim() === "" && apiKey.trim() === "") {
        figmaAccessTokenRef.current?.focus();
      } else {
        baseUrlRef.current?.focus();
      }
    }
  }, [apiKey, baseUrl, busy, error, preserveExisting]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setErrorCode(undefined);
    setSuccess(undefined);
    // All controls (incl. the focused submit) become disabled while testing,
    // which would drop focus to <body> and break the Tab trap — park focus on
    // the dialog container instead (audit C186).
    dialogRef.current?.focus();
    try {
      const outcome = await performGatewaySubmission(
        {
          baseUrl,
          apiKey,
          apiKeyHeaderName,
          timeoutMs,
          deploymentNames,
          imageInputModelIds,
          voiceBaseUrl,
          voiceApiKey,
          voiceApiKeyHeaderName,
          voiceModelId,
          voiceRealtimeModelId,
          voiceSpeechOutputModelId,
          voiceOutputVoiceId,
          voiceProviderLocality,
          voiceTimeoutMs,
          figmaAccessToken,
          preserveExisting,
        },
        t,
      );
      if (outcome.kind === "validation-error") {
        setError(outcome.message);
        setBusy(false);
        return;
      }
      setBusy(false);
      setSuccess(outcome.message);
      reloadTimerRef.current = window.setTimeout(
        () => window.location.reload(),
        outcome.skippedModelCount === 0 ? 800 : 1800,
      );
    } catch (caught) {
      const details = errorDetails(caught);
      setError(details.message);
      setErrorCode(details.code);
      setBusy(false);
    }
  }

  // Issue #422: when this dialog is opened from the Settings panel, its
  // ancestors include `.ws-scene`, which applies CSS `zoom` and a translated
  // scene layer. Those can establish a containing block for `position: fixed`
  // descendants in Chromium, so the backdrop can end up sized to the zoomed
  // scene (which has zero intrinsic width/height) instead of the viewport.
  // Portalling to `document.body` makes the backdrop fixed to the viewport
  // regardless of where the dialog is mounted in the React tree.
  const parsedDeploymentNames = deploymentNamesFromInput(deploymentNames);
  const parsedImageInputModelIds = deploymentNamesFromInput(imageInputModelIds);
  const voiceCredentialInput = hasVoiceCredentialInput({
    voiceBaseUrl,
    voiceApiKey,
    voiceApiKeyHeaderName,
    voiceModelId,
    voiceRealtimeModelId,
    voiceSpeechOutputModelId,
    voiceTimeoutMs,
  });
  const requiresGatewayCredentials = !preserveExisting;
  const hasGatewayCredentialInput = hasAnyGatewayCredentialInput({
    baseUrl,
    apiKey,
    apiKeyHeaderName,
    timeoutMs,
    parsedDeploymentNames,
    parsedImageInputModelIds,
    voiceCredentialInput,
  });
  const hasFigmaCredentialInput = figmaAccessToken.trim() !== "";
  const canSubmit = computeCanSubmit({
    busy,
    success,
    requiresGatewayCredentials,
    baseUrl,
    apiKey,
    hasGatewayCredentialInput,
    hasFigmaCredentialInput,
  });
  const dialogCopy = computeDialogCopy(preserveExisting);
  const modelNames = storedModels.map((model) => model.id);
  const visibleModelNames = modelNames.slice(0, 6);
  const hiddenModelCount = Math.max(0, modelNames.length - visibleModelNames.length);
  const voiceModelNames = storedVoiceModels(storedModels);
  const gatewayFields = (
    <GatewayFieldsSection
      preserveExisting={preserveExisting}
      busy={busy}
      success={success}
      baseUrl={baseUrl}
      setBaseUrl={setBaseUrl}
      baseUrlRef={baseUrlRef}
      apiKey={apiKey}
      setApiKey={setApiKey}
      apiKeyHeaderName={apiKeyHeaderName}
      setApiKeyHeaderName={setApiKeyHeaderName}
      timeoutMs={timeoutMs}
      setTimeoutMs={setTimeoutMs}
      deploymentNames={deploymentNames}
      setDeploymentNames={setDeploymentNames}
      imageInputModelIds={imageInputModelIds}
      setImageInputModelIds={setImageInputModelIds}
    />
  );

  const voiceFields = (
    <VoiceFieldsSection
      t={t}
      busy={busy}
      success={success}
      preserveExisting={preserveExisting}
      voiceModelId={voiceModelId}
      setVoiceModelId={setVoiceModelId}
      voiceRealtimeModelId={voiceRealtimeModelId}
      setVoiceRealtimeModelId={setVoiceRealtimeModelId}
      voiceSpeechOutputModelId={voiceSpeechOutputModelId}
      setVoiceSpeechOutputModelId={setVoiceSpeechOutputModelId}
      voiceOutputVoiceId={voiceOutputVoiceId}
      setVoiceOutputVoiceId={setVoiceOutputVoiceId}
      voiceProviderLocalityLabelId={voiceProviderLocalityLabelId}
      voiceProviderLocality={voiceProviderLocality}
      setVoiceProviderLocality={setVoiceProviderLocality}
      voiceBaseUrl={voiceBaseUrl}
      setVoiceBaseUrl={setVoiceBaseUrl}
      voiceApiKey={voiceApiKey}
      setVoiceApiKey={setVoiceApiKey}
      voiceApiKeyHeaderName={voiceApiKeyHeaderName}
      setVoiceApiKeyHeaderName={setVoiceApiKeyHeaderName}
      voiceTimeoutMs={voiceTimeoutMs}
      setVoiceTimeoutMs={setVoiceTimeoutMs}
    />
  );

  const dialogTree = (
    <div className="gw-setup-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="gw-setup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gw-setup-title"
        aria-describedby="gw-setup-desc"
        // tabIndex -1: keeps focus (and thus the Escape/Tab-trap keydown
        // listener on this element) inside the dialog when a non-focusable
        // area is clicked or all controls are disabled (audit C007/C186).
        tabIndex={-1}
      >
        <form className="gw-form" onSubmit={(event) => void submit(event)}>
          <div className="gw-head">
            <div className="gw-setup-badge">
              <Icons.cube size={18} />
              {preserveExisting ? "Credential update" : "Model gateway setup"}
            </div>
            <h1 id="gw-setup-title">{dialogCopy.title}</h1>
            <p id="gw-setup-desc">{dialogCopy.description}</p>
          </div>

          <GatewayModelSection
            preserveExisting={preserveExisting}
            storedApiKeyHeaderName={storedApiKeyHeaderName}
            visibleModelNames={visibleModelNames}
            hiddenModelCount={hiddenModelCount}
            fields={gatewayFields}
          />

          <VoiceModelSection
            t={t}
            preserveExisting={preserveExisting}
            voiceModelNames={voiceModelNames}
            fields={voiceFields}
          />

          <FigmaSection
            preserveExisting={preserveExisting}
            busy={busy}
            success={success}
            figmaAccessToken={figmaAccessToken}
            setFigmaAccessToken={setFigmaAccessToken}
            figmaAccessTokenRef={figmaAccessTokenRef}
          />

          <div className="gw-note">
            Stored secrets stay local and are never returned to the browser. Supported API-key
            headers: Authorization, X-Litellm-Key, X-Api-Key, api-key.
          </div>
          {/* role=alert/status: the test result arrives after a long async wait
              while all controls are disabled — without a live region screen
              readers never hear it (audit C084). */}
          <GatewaySetupStatus error={error} errorCode={errorCode} success={success} busy={busy} />
          {/* FE-03: visually-hidden description tells AT users what is required
              when the submit button cannot be activated (WCAG 3.3.4). */}
          <span id="gw-submit-requirements" className="visually-hidden">
            {dialogCopy.submitRequirements}
          </span>
          <GatewaySetupActions
            onCancel={onCancel}
            busy={busy}
            success={success}
            canSubmit={canSubmit}
          />
        </form>
      </div>
    </div>
  );

  if (typeof document === "undefined") return dialogTree;
  return createPortal(dialogTree, document.body);
}
