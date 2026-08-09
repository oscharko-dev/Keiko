"use client";

import {
  useEffect,
  useId,
  useCallback,
  useRef,
  useState,
  type ClipboardEvent,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import {
  selectRealtimeVoiceCapability,
  selectSpeechOutputCapability,
} from "@oscharko-dev/keiko-contracts";
import { ApiError, setupGateway, type GatewaySetupInput } from "@/lib/api";
import { useTranslate, type MessageValues } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages.en";
import {
  OPTIONAL_WIDGET_EN_MESSAGES,
  type OptionalWidgetMessageKey,
} from "@/lib/i18n-messages.optional.en";
import { useOptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import type { ModelCapability, VoiceProviderLocality } from "@/lib/types";
import { Icons } from "../Icons";
import KeikoSelect from "../KeikoSelect";
import { useTheme } from "../hooks/useTheme";
import { NATIVE_BLOCK_STYLE } from "../native-element-styles";
import dynamic from "next/dynamic";
import { notifyGatewayConfigUpdated } from "../widgets/shared/gatewaySetupBus";
import { DynamicChunkLoadFailure } from "../DynamicChunkLoadFailure";
import type { GatewayConfigUploadFields } from "./gatewayConfigParsing";

// The upload path (control + fail-closed parser) is not first-paint-critical: loading it as its
// own chunk keeps the setup page inside the static-export first-load budget (bundle gate). A
// failed upload-chunk load must not make the feature silently disappear from an otherwise
// working dialog — the shared fallback surfaces the redacted error and a retry (#3031).
const GatewayConfigUpload = dynamic(
  () => import("./GatewayConfigUpload").then((mod) => mod.GatewayConfigUpload),
  { ssr: false, loading: DynamicChunkLoadFailure },
);
import styles from "./GatewaySetupDialog.module.css";

/**
 * The dialog is loaded only through next/dynamic boundaries, so its own copy lives in the
 * lazily-loaded optional widget catalog (initial-page gzip ceiling, ADR-0042 D3.6) while a
 * handful of shared keys (common.*, rail.*) stay in the eager catalog. This translator serves
 * both: membership in the optional EN catalog — the key source of truth for both locales —
 * decides the route, so no prefix guessing and no double bookkeeping at the call sites.
 */
type GatewaySetupTranslate = (
  key: MessageKey | OptionalWidgetMessageKey,
  values?: MessageValues,
) => string;

function useGatewaySetupTranslate(): GatewaySetupTranslate {
  const tGlobal = useTranslate();
  const tOptional = useOptionalWidgetTranslate();
  return useCallback(
    (key: MessageKey | OptionalWidgetMessageKey, values?: MessageValues): string =>
      key in OPTIONAL_WIDGET_EN_MESSAGES
        ? tOptional(key as OptionalWidgetMessageKey, values)
        : tGlobal(key as MessageKey, values),
    [tGlobal, tOptional],
  );
}

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const CubeIcon = Icons.cube;
const MoonIcon = Icons.moon;
const SunIcon = Icons.sun;

type FormSubmitEvent = { preventDefault: () => void };

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

function storedRealtimeModelId(models: readonly ModelCapability[]): string | undefined {
  return selectRealtimeVoiceCapability(models)?.id;
}

function storedSpeechOutputModelId(models: readonly ModelCapability[]): string | undefined {
  return selectSpeechOutputCapability(models)?.id;
}

function storedSemanticRealtimeModelId(models: readonly ModelCapability[]): string | undefined {
  const electedRealtime = selectRealtimeVoiceCapability(models);
  return electedRealtime?.supportsSemanticTurnDetection === true ? electedRealtime.id : undefined;
}

function storedSemanticTurnDetection(models: readonly ModelCapability[]): boolean {
  return storedSemanticRealtimeModelId(models) !== undefined;
}

function storedWorkflowEligibleModelIds(models: readonly ModelCapability[]): string {
  return models
    .filter((model) => model.kind === "chat" && model.workflowEligible === true)
    .map((model) => model.id)
    .join("\n");
}

function semanticTurnDetectionForIdentity(
  preserveExisting: boolean,
  storedModels: readonly ModelCapability[],
  replacementRealtimeModelId: string,
  replacementBaseUrl = "",
): boolean {
  const storedModelId = storedSemanticRealtimeModelId(storedModels);
  if (!preserveExisting || storedModelId === undefined) {
    return false;
  }
  const submittedModelId = replacementRealtimeModelId.trim();
  if (submittedModelId === "") return replacementBaseUrl.trim() === "";
  return submittedModelId === storedModelId && replacementBaseUrl.trim() === "";
}

const STORED_VOICE_ENDPOINT_IDENTITY = Symbol("stored-voice-endpoint");
type ProviderIdentity = string | typeof STORED_VOICE_ENDPOINT_IDENTITY;
interface ProviderIdentityReference {
  current: ProviderIdentity | undefined;
}

function modelIdentity(
  value: string,
  storedModelId: string | undefined,
): ProviderIdentity | undefined {
  return value.trim() || storedModelId;
}

function endpointIdentity(
  value: string,
  preserveExisting: boolean,
  hasStoredVoiceProvider: boolean,
): ProviderIdentity | undefined {
  const submitted = value.trim();
  if (submitted !== "") return submitted;
  return preserveExisting && hasStoredVoiceProvider ? STORED_VOICE_ENDPOINT_IDENTITY : undefined;
}

function transitionProviderIdentity(
  reference: ProviderIdentityReference,
  next: ProviderIdentity | undefined,
  resetDependencies: () => void,
  commit: boolean,
): void {
  if (reference.current !== undefined && reference.current !== next) {
    resetDependencies();
  }
  if (commit) reference.current = next;
}

type SelectableVoiceCapability =
  "supportsSpeechInput" | "supportsRealtimeVoice" | "supportsSpeechOutput";

function voiceCapabilitySelected(
  replacementModelId: string,
  preserveExisting: boolean,
  storedModels: readonly ModelCapability[],
  capability: SelectableVoiceCapability,
): boolean {
  if (replacementModelId.trim() !== "") return true;
  return (
    preserveExisting &&
    storedModels.some((model) => model.kind === "voice" && model[capability] === true)
  );
}

function voiceCapabilityStatus(
  t: GatewaySetupTranslate,
  replacementModelId: string,
  preserveExisting: boolean,
  storedModels: readonly ModelCapability[],
  capability: SelectableVoiceCapability,
): string {
  return t(
    voiceCapabilitySelected(replacementModelId, preserveExisting, storedModels, capability)
      ? "common.on"
      : "common.off",
  );
}

const VOICE_PROVIDER_LOCALITIES: ReadonlySet<VoiceProviderLocality> = new Set([
  "azure-foundry",
  "customer-hosted",
  "local-only",
]);

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
  return VOICE_PROVIDER_LOCALITIES.has(value as VoiceProviderLocality);
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
  readonly voiceRealtimeTranscriptionModelId: string;
  readonly voiceSpeechOutputModelId: string;
  readonly voiceTimeoutMs: string;
  readonly voiceSemanticTurnDetectionConfigured: boolean;
  readonly voiceSpeechSynthesisInstructionsConfigured: boolean;
  readonly voiceOutputVoiceIdConfigured: boolean;
  readonly voiceProviderLocalityConfigured: boolean;
}

function hasVoiceCredentialInput(fields: VoiceCredentialInputFields): boolean {
  const textInputs = [
    fields.voiceBaseUrl,
    fields.voiceApiKey,
    fields.voiceApiKeyHeaderName,
    fields.voiceModelId,
    fields.voiceRealtimeModelId,
    fields.voiceRealtimeTranscriptionModelId,
    fields.voiceSpeechOutputModelId,
    fields.voiceTimeoutMs,
  ];
  const configuredFlags = [
    fields.voiceSemanticTurnDetectionConfigured,
    fields.voiceSpeechSynthesisInstructionsConfigured,
    fields.voiceOutputVoiceIdConfigured,
    fields.voiceProviderLocalityConfigured,
  ];
  return textInputs.some((value) => value.trim() !== "") || configuredFlags.includes(true);
}

function hasExplicitVoiceDeployment(fields: VoiceCredentialInputFields): boolean {
  return (
    fields.voiceModelId.trim() !== "" ||
    fields.voiceRealtimeModelId.trim() !== "" ||
    fields.voiceSpeechOutputModelId.trim() !== ""
  );
}

interface DerivedSubmitFields {
  readonly parsedDeploymentNames: readonly string[];
  readonly parsedImageInputModelIds: readonly string[];
  readonly parsedWorkflowEligibleModelIds: readonly string[];
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
  derived: Pick<
    DerivedSubmitFields,
    "parsedDeploymentNames" | "parsedImageInputModelIds" | "parsedWorkflowEligibleModelIds"
  >,
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
  readonly parsedWorkflowEligibleModelIds: readonly string[];
  readonly workflowEligibleModelIdsConfigured: boolean;
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
    fields.workflowEligibleModelIdsConfigured ||
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
  } catch (error_) {
    return {
      ok: false,
      message: error_ instanceof Error ? error_.message : "Request timeout is invalid.",
    };
  }
}

interface VoiceCredentialPayloadInput {
  readonly voiceBaseUrl: string;
  readonly voiceApiKey: string;
  readonly voiceApiKeyHeaderName: string;
  readonly voiceModelId: string;
  readonly voiceRealtimeModelId: string;
  readonly voiceRealtimeTranscriptionModelId: string;
  readonly voiceSupportsSemanticTurnDetection: boolean;
  readonly voiceSemanticTurnDetectionConfigured: boolean;
  readonly voiceSupportsSpeechSynthesisInstructions: boolean;
  readonly voiceSpeechSynthesisInstructionsConfigured: boolean;
  readonly voiceSpeechOutputModelId: string;
  readonly voiceOutputVoiceId: string;
  readonly voiceOutputVoiceIdConfigured: boolean;
  readonly voiceProviderLocality: VoiceProviderLocality;
  readonly voiceProviderLocalityConfigured: boolean;
  readonly voiceTimeoutMs: number | undefined;
  readonly preserveExisting: boolean;
}

// Only an EXPLICIT tuning statement travels — true sets, false clears, unconfigured leaves the
// stored template in charge; both flags are file-scoped exactly alike (#3037).
function voiceTuningPayloadFields(
  input: VoiceCredentialPayloadInput,
): Pick<
  GatewaySetupInput,
  "voiceSupportsSemanticTurnDetection" | "voiceSupportsSpeechSynthesisInstructions"
> {
  return {
    ...(input.voiceSemanticTurnDetectionConfigured
      ? { voiceSupportsSemanticTurnDetection: input.voiceSupportsSemanticTurnDetection }
      : {}),
    ...(input.voiceSpeechSynthesisInstructionsConfigured
      ? { voiceSupportsSpeechSynthesisInstructions: input.voiceSupportsSpeechSynthesisInstructions }
      : {}),
  };
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
  | "voiceRealtimeTranscriptionModelId"
  | "voiceSupportsSemanticTurnDetection"
  | "voiceSupportsSpeechSynthesisInstructions"
  | "voiceSpeechOutputModelId"
  | "voiceOutputVoiceId"
  | "voiceProviderLocality"
  | "voiceTimeoutMs"
> {
  const voiceBaseUrl = trimOrUndefined(input.voiceBaseUrl);
  const voiceApiKey = trimOrUndefined(input.voiceApiKey);
  const voiceApiKeyHeaderName = trimOrUndefined(input.voiceApiKeyHeaderName);
  const voiceSpeechToTextModelId = trimOrUndefined(input.voiceModelId);
  const voiceRealtimeModelId = trimOrUndefined(input.voiceRealtimeModelId);
  const voiceRealtimeTranscriptionModelId = trimOrUndefined(
    input.voiceRealtimeTranscriptionModelId,
  );
  const voiceSpeechOutputModelId = trimOrUndefined(input.voiceSpeechOutputModelId);
  const voiceOutputVoiceId = trimOrUndefined(input.voiceOutputVoiceId);
  return {
    ...(voiceBaseUrl === undefined ? {} : { voiceBaseUrl }),
    ...(voiceApiKey === undefined ? {} : { voiceApiKey }),
    ...(voiceApiKeyHeaderName === undefined ? {} : { voiceApiKeyHeaderName }),
    ...(voiceSpeechToTextModelId === undefined ? {} : { voiceSpeechToTextModelId }),
    ...(voiceRealtimeModelId === undefined ? {} : { voiceRealtimeModelId }),
    ...(voiceRealtimeTranscriptionModelId === undefined
      ? {}
      : { voiceRealtimeTranscriptionModelId }),
    ...voiceTuningPayloadFields(input),
    ...(voiceSpeechOutputModelId === undefined ? {} : { voiceSpeechOutputModelId }),
    ...(voiceOutputVoiceId === undefined || !input.voiceOutputVoiceIdConfigured
      ? {}
      : { voiceOutputVoiceId }),
    ...(!input.preserveExisting || input.voiceProviderLocalityConfigured
      ? { voiceProviderLocality: input.voiceProviderLocality }
      : {}),
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
  readonly imageInputModelIdsConfigured: boolean;
  /** Imported embedding-kind ids asserted to the setup route (empty when nothing was imported). */
  readonly importedEmbeddingModelIds: readonly string[];
  readonly workflowEligibleModelIds: string;
  readonly workflowEligibleModelIdsConfigured: boolean;
  readonly voiceBaseUrl: string;
  readonly voiceApiKey: string;
  readonly voiceApiKeyHeaderName: string;
  readonly voiceModelId: string;
  readonly voiceRealtimeModelId: string;
  readonly voiceRealtimeTranscriptionModelId: string;
  readonly voiceSupportsSemanticTurnDetection: boolean;
  readonly voiceSemanticTurnDetectionConfigured: boolean;
  readonly voiceSupportsSpeechSynthesisInstructions: boolean;
  readonly voiceSpeechSynthesisInstructionsConfigured: boolean;
  readonly voiceSpeechOutputModelId: string;
  readonly voiceOutputVoiceId: string;
  readonly voiceOutputVoiceIdConfigured: boolean;
  readonly voiceProviderLocality: VoiceProviderLocality;
  readonly voiceProviderLocalityConfigured: boolean;
  readonly voiceTimeoutMs: string;
  /** Voice endpoint protocol imported from a config upload (empty = nothing imported). */
  readonly importedVoiceEndpointStyle: string;
  readonly importedVoiceApiVersion: string;
  readonly importedVoiceRealtimeAuthMode: string;
  /** The uploaded endpoint URL the imported protocol is bound to. */
  readonly importedVoiceEndpointBaseUrl: string;
  /** Generic endpoint protocol imported from a config upload, bound to its gateway URL (#3042). */
  readonly importedEndpointStyle: string;
  readonly importedApiVersion: string;
  readonly importedEndpointBaseUrl: string;
  readonly figmaAccessToken: string;
  readonly preserveExisting: boolean;
  readonly hasStoredVoiceProvider: boolean;
  readonly storedRealtimeModelId: string | undefined;
}

function endpointMigrationValidationError(
  fields: GatewayFormFields,
  t: GatewaySetupTranslate,
): string | undefined {
  if (!fields.preserveExisting || !fields.hasStoredVoiceProvider) return undefined;
  if (fields.voiceBaseUrl.trim() === "") return undefined;
  if (
    fields.voiceApiKey.trim() !== "" &&
    fields.voiceProviderLocalityConfigured &&
    hasExplicitVoiceDeployment(fields)
  ) {
    return undefined;
  }
  return t("gatewaySetup.voice.endpointMigrationRequired");
}

function realtimeTranscriptionRequired(fields: GatewayFormFields): boolean {
  const submittedRealtime = fields.voiceRealtimeModelId.trim();
  if (submittedRealtime === "") return false;
  if (!fields.preserveExisting) return true;
  if (fields.voiceBaseUrl.trim() !== "") return true;
  return submittedRealtime !== fields.storedRealtimeModelId;
}

// The imported endpoint protocol rides only on a submit that still points at EXACTLY the
// uploaded endpoint — a manually retyped URL must not inherit the file's protocol, and sending
// the protocol alone would activate the server's voice path with no voice fields.
function importedVoiceEndpointPayload(fields: GatewayFormFields): Partial<GatewaySetupInput> {
  const submittedBaseUrl = fields.voiceBaseUrl.trim();
  if (submittedBaseUrl === "" || submittedBaseUrl !== fields.importedVoiceEndpointBaseUrl) {
    return {};
  }
  return {
    ...(fields.importedVoiceEndpointStyle === ""
      ? {}
      : { voiceEndpointStyle: fields.importedVoiceEndpointStyle }),
    ...(fields.importedVoiceApiVersion === ""
      ? {}
      : { voiceApiVersion: fields.importedVoiceApiVersion }),
    ...(fields.importedVoiceRealtimeAuthMode === ""
      ? {}
      : { voiceRealtimeAuthMode: fields.importedVoiceRealtimeAuthMode }),
  };
}

// The imported GENERIC protocol rides only on a submit that still points at EXACTLY the
// uploaded gateway URL — a manually retyped URL must not inherit the file's protocol (#3042).
function importedEndpointPayload(fields: GatewayFormFields): Partial<GatewaySetupInput> {
  const submittedBaseUrl = fields.baseUrl.trim();
  if (submittedBaseUrl === "" || submittedBaseUrl !== fields.importedEndpointBaseUrl) {
    return {};
  }
  return {
    ...(fields.importedEndpointStyle === "" ? {} : { endpointStyle: fields.importedEndpointStyle }),
    ...(fields.importedApiVersion === "" ? {} : { apiVersion: fields.importedApiVersion }),
  };
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
    ...(derived.parsedImageInputModelIds.length === 0 && !fields.imageInputModelIdsConfigured
      ? {}
      : { imageInputModelIds: derived.parsedImageInputModelIds }),
    ...(fields.importedEmbeddingModelIds.length === 0
      ? {}
      : { embeddingModelIds: fields.importedEmbeddingModelIds }),
    ...importedVoiceEndpointPayload(fields),
    ...importedEndpointPayload(fields),
    ...(!fields.workflowEligibleModelIdsConfigured
      ? {}
      : { workflowEligibleModelIds: derived.parsedWorkflowEligibleModelIds }),
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
    voiceRealtimeTranscriptionModelId: fields.voiceRealtimeTranscriptionModelId,
    voiceSupportsSemanticTurnDetection: fields.voiceSupportsSemanticTurnDetection,
    voiceSemanticTurnDetectionConfigured: fields.voiceSemanticTurnDetectionConfigured,
    voiceSupportsSpeechSynthesisInstructions: fields.voiceSupportsSpeechSynthesisInstructions,
    voiceSpeechSynthesisInstructionsConfigured: fields.voiceSpeechSynthesisInstructionsConfigured,
    voiceSpeechOutputModelId: fields.voiceSpeechOutputModelId,
    voiceOutputVoiceId: fields.voiceOutputVoiceId,
    voiceOutputVoiceIdConfigured: fields.voiceOutputVoiceIdConfigured,
    voiceProviderLocality: fields.voiceProviderLocality,
    voiceProviderLocalityConfigured: fields.voiceProviderLocalityConfigured,
    voiceTimeoutMs: derived.parsedVoiceTimeoutMs,
    preserveExisting: fields.preserveExisting,
  });
}

function figmaOnlyMessage(t: GatewaySetupTranslate, mode: GatewaySuccessMode): string {
  if (mode === "voice") {
    return t("gatewaySetup.voice.success.audioAndFigma");
  }
  return "Verified Figma access token. Reloading Keiko…";
}

function figmaAndGatewaySettingsMessage(
  t: GatewaySetupTranslate,
  mode: GatewaySuccessMode,
): string {
  if (mode === "voice") {
    return t("gatewaySetup.voice.success.gatewayAudioAndFigma");
  }
  return "Updated model gateway settings and verified Figma access token. Reloading Keiko…";
}

function noFigmaNoGatewayCredentialsMessage(
  t: GatewaySetupTranslate,
  mode: GatewaySuccessMode,
): string {
  if (mode === "voice") {
    return t("gatewaySetup.voice.success.audio");
  }
  return "Updated model gateway settings. Reloading Keiko…";
}

function figmaAndVerifiedModelsMessage(
  t: GatewaySetupTranslate,
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
  t: GatewaySetupTranslate,
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
  readonly t: GatewaySetupTranslate;
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
  t: GatewaySetupTranslate,
): Promise<GatewaySubmissionOutcome> {
  const parsedDeploymentNames = deploymentNamesFromInput(fields.deploymentNames);
  const foundryError = validateFoundryDeploymentNames(fields.baseUrl, parsedDeploymentNames);
  if (foundryError !== undefined) {
    return { kind: "validation-error", message: foundryError };
  }
  const endpointMigrationError = endpointMigrationValidationError(fields, t);
  if (endpointMigrationError !== undefined) {
    return { kind: "validation-error", message: endpointMigrationError };
  }
  if (
    fields.voiceRealtimeTranscriptionModelId.trim() !== "" &&
    fields.voiceRealtimeModelId.trim() === ""
  ) {
    return {
      kind: "validation-error",
      message: t("gatewaySetup.voice.realtimeRequired"),
    };
  }
  if (
    !fields.preserveExisting &&
    hasVoiceCredentialInput(fields) &&
    !hasExplicitVoiceDeployment(fields)
  ) {
    return {
      kind: "validation-error",
      message: t("gatewaySetup.voice.deploymentRequired"),
    };
  }
  if (
    realtimeTranscriptionRequired(fields) &&
    fields.voiceRealtimeTranscriptionModelId.trim() === ""
  ) {
    return {
      kind: "validation-error",
      message: t("gatewaySetup.voice.realtimeTranscriptionRequired"),
    };
  }
  if (
    fields.voiceSpeechOutputModelId.trim() !== "" &&
    (!fields.voiceOutputVoiceIdConfigured || fields.voiceOutputVoiceId.trim() === "")
  ) {
    return {
      kind: "validation-error",
      message: t("gatewaySetup.voice.outputVoiceRequired"),
    };
  }
  const timeoutsResult = parseSubmitTimeouts(fields.timeoutMs, fields.voiceTimeoutMs);
  if (!timeoutsResult.ok) {
    return { kind: "validation-error", message: timeoutsResult.message };
  }
  const derived: DerivedSubmitFields = {
    parsedDeploymentNames,
    parsedImageInputModelIds: deploymentNamesFromInput(fields.imageInputModelIds),
    parsedWorkflowEligibleModelIds: deploymentNamesFromInput(fields.workflowEligibleModelIds),
    parsedTimeoutMs: timeoutsResult.timeoutMs,
    parsedVoiceTimeoutMs: timeoutsResult.voiceTimeoutMs,
  };
  const successMode: GatewaySuccessMode = hasVoiceCredentialInput(fields) ? "voice" : "standard";
  const voiceCredentialFields = voiceCredentialFieldsForMode(fields, derived, successMode);
  const submittedGatewayCredentials =
    !fields.preserveExisting || hasCoreGatewayFieldInput(fields, derived);
  const submittedGatewaySettings =
    submittedGatewayCredentials ||
    derived.parsedTimeoutMs !== undefined ||
    fields.imageInputModelIdsConfigured ||
    fields.workflowEligibleModelIdsConfigured;
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
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onChange: Dispatch<SetStateAction<string>>;
}

function pasteCredentialWithoutWhitespace(
  event: ClipboardEvent<HTMLInputElement>,
  onChange: Dispatch<SetStateAction<string>>,
): void {
  const pasted = event.clipboardData.getData("text");
  const sanitized = pasted.replace(/\s/gu, "");
  if (sanitized === pasted) return;

  event.preventDefault();
  const input = event.currentTarget;
  input.setRangeText(sanitized);
  onChange(input.value);
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
        onPaste={
          preserveExisting
            ? undefined
            : (event): void => pasteCredentialWithoutWhitespace(event, onChange)
        }
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
        onPaste={
          preserveExisting
            ? undefined
            : (event): void => pasteCredentialWithoutWhitespace(event, onChange)
        }
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

interface GatewayWorkflowEligibleModelsFieldProps extends GatewayImageInputModelsFieldProps {
  readonly t: GatewaySetupTranslate;
}

function GatewayWorkflowEligibleModelsField({
  t,
  value,
  disabled,
  onChange,
}: GatewayWorkflowEligibleModelsFieldProps): ReactNode {
  return (
    <label className="gw-field">
      <span>
        {t("gatewaySetup.workflowEligibleModels")}{" "}
        <span className="dlg-opt">{t("common.optional")}</span>
      </span>
      <textarea
        className="gw-input gw-textarea mono"
        value={value}
        placeholder={t("gatewaySetup.workflowEligibleModelsPlaceholder")}
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

interface GatewayFieldsSectionProps {
  readonly t: GatewaySetupTranslate;
  readonly preserveExisting: boolean;
  readonly busy: boolean;
  readonly success: string | undefined;
  readonly baseUrl: string;
  readonly setBaseUrl: Dispatch<SetStateAction<string>>;
  readonly baseUrlRef: RefObject<HTMLInputElement | null>;
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
  readonly workflowEligibleModelIds: string;
  readonly setWorkflowEligibleModelIds: Dispatch<SetStateAction<string>>;
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
      <GatewayWorkflowEligibleModelsField
        t={props.t}
        value={props.workflowEligibleModelIds}
        disabled={disabled}
        onChange={props.setWorkflowEligibleModelIds}
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
  readonly t: GatewaySetupTranslate;
  readonly preserveExisting: boolean;
  readonly storedModels: readonly ModelCapability[];
  readonly voiceModelId: string;
  readonly voiceRealtimeModelId: string;
  readonly voiceSpeechOutputModelId: string;
}

function VoiceGuidanceNote({
  t,
  preserveExisting,
  storedModels,
  voiceModelId,
  voiceRealtimeModelId,
  voiceSpeechOutputModelId,
}: VoiceGuidanceNoteProps): ReactNode {
  return (
    <div className="gw-note gw-span-2">
      {t("gatewaySetup.voice.guidance")}
      <br />
      {t("gatewaySetup.voice.selectedCapabilities", {
        dictate: voiceCapabilityStatus(
          t,
          voiceModelId,
          preserveExisting,
          storedModels,
          "supportsSpeechInput",
        ),
        digitalVoice: voiceCapabilityStatus(
          t,
          voiceRealtimeModelId,
          preserveExisting,
          storedModels,
          "supportsRealtimeVoice",
        ),
        readAloud: voiceCapabilityStatus(
          t,
          voiceSpeechOutputModelId,
          preserveExisting,
          storedModels,
          "supportsSpeechOutput",
        ),
      })}
    </div>
  );
}

interface VoiceDictateDeploymentFieldProps {
  readonly t: GatewaySetupTranslate;
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
  readonly t: GatewaySetupTranslate;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: Dispatch<SetStateAction<string>>;
  readonly onBlur?: (() => void) | undefined;
}

function VoiceRealtimeDeploymentField({
  t,
  value,
  disabled,
  onChange,
  onBlur,
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
        onBlur={onBlur}
      />
    </label>
  );
}

function VoiceRealtimeTranscriptionDeploymentField({
  t,
  value,
  disabled,
  requiredForRealtime,
  onChange,
}: Omit<VoiceRealtimeDeploymentFieldProps, "onBlur"> & {
  readonly requiredForRealtime: boolean;
}): ReactNode {
  return (
    <label className="gw-field">
      <span>
        {t("gatewaySetup.voice.realtimeTranscriptionDeployment")}{" "}
        <span className="dlg-opt">
          {requiredForRealtime
            ? t("gatewaySetup.voice.realtimeTranscriptionRequiredLabel")
            : t("common.optional")}
        </span>
      </span>
      <input
        className="gw-input mono"
        value={value}
        placeholder={t("gatewaySetup.voice.realtimeTranscriptionDeploymentPlaceholder")}
        autoComplete="off"
        disabled={disabled}
        aria-required={requiredForRealtime}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

interface VoiceSpeechOutputDeploymentFieldProps {
  readonly t: GatewaySetupTranslate;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: Dispatch<SetStateAction<string>>;
  readonly onBlur: () => void;
}

function VoiceSpeechOutputDeploymentField({
  t,
  value,
  disabled,
  onChange,
  onBlur,
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
        onBlur={onBlur}
      />
    </label>
  );
}

interface VoiceOutputVoiceFieldProps {
  readonly t: GatewaySetupTranslate;
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
        placeholder="provider-voice-id"
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
  readonly t: GatewaySetupTranslate;
  readonly preserveExisting: boolean;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: Dispatch<SetStateAction<string>>;
  readonly onBlur: () => void;
}

function VoiceEndpointUrlField({
  t,
  preserveExisting,
  value,
  disabled,
  onChange,
  onBlur,
}: VoiceEndpointUrlFieldProps): ReactNode {
  return (
    <label className="gw-field gw-span-2">
      <span>
        {t("gatewaySetup.voice.endpointUrl")}{" "}
        {preserveExisting ? (
          <span className="dlg-opt">{t("gatewaySetup.voice.preserveExistingHint")}</span>
        ) : null}
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
        onBlur={onBlur}
      />
    </label>
  );
}

interface VoiceCredentialFieldProps {
  readonly t: GatewaySetupTranslate;
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
        {preserveExisting ? (
          <span className="dlg-opt">{t("gatewaySetup.voice.preserveExistingHint")}</span>
        ) : null}
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
  readonly t: GatewaySetupTranslate;
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
        placeholder={
          preserveExisting ? t("gatewaySetup.voice.authHeaderPreservePlaceholder") : "api-key"
        }
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

interface VoiceTimeoutFieldProps {
  readonly t: GatewaySetupTranslate;
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
        placeholder={
          preserveExisting ? t("gatewaySetup.voice.timeoutPreservePlaceholder") : "30000"
        }
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

interface VoiceDeploymentFieldsProps {
  readonly t: GatewaySetupTranslate;
  readonly preserveExisting: boolean;
  readonly storedModels: readonly ModelCapability[];
  readonly voiceModelId: string;
  readonly setVoiceModelId: Dispatch<SetStateAction<string>>;
  readonly voiceRealtimeModelId: string;
  readonly setVoiceRealtimeModelId: Dispatch<SetStateAction<string>>;
  readonly commitVoiceRealtimeModelId: () => void;
  readonly voiceRealtimeTranscriptionModelId: string;
  readonly setVoiceRealtimeTranscriptionModelId: Dispatch<SetStateAction<string>>;
  readonly voiceSupportsSemanticTurnDetection: boolean;
  readonly setVoiceSupportsSemanticTurnDetection: (enabled: boolean) => void;
  readonly voiceSpeechOutputModelId: string;
  readonly setVoiceSpeechOutputModelId: Dispatch<SetStateAction<string>>;
  readonly commitVoiceSpeechOutputModelId: () => void;
  readonly voiceOutputVoiceId: string;
  readonly setVoiceOutputVoiceId: Dispatch<SetStateAction<string>>;
  readonly voiceProviderLocalityLabelId: string;
  readonly voiceProviderLocality: VoiceProviderLocality;
  readonly setVoiceProviderLocality: Dispatch<SetStateAction<VoiceProviderLocality>>;
  readonly disabled: boolean;
}

interface VoiceSemanticTurnDetectionFieldProps {
  readonly t: GatewaySetupTranslate;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (enabled: boolean) => void;
}

function VoiceSemanticTurnDetectionField({
  t,
  checked,
  disabled,
  onChange,
}: VoiceSemanticTurnDetectionFieldProps): ReactNode {
  return (
    <label className="gw-field gw-span-2">
      <span>
        {t("gatewaySetup.voice.semanticTurnDetection")}{" "}
        <span className="dlg-opt">{t("common.advanced")}</span>
      </span>
      <span className="gw-note">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />{" "}
        {t("gatewaySetup.voice.semanticTurnDetectionHint")}
      </span>
    </label>
  );
}

function VoiceDeploymentFields(props: VoiceDeploymentFieldsProps): ReactNode {
  return (
    <>
      <VoiceGuidanceNote
        t={props.t}
        preserveExisting={props.preserveExisting}
        storedModels={props.storedModels}
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
        onBlur={props.commitVoiceRealtimeModelId}
      />
      <VoiceRealtimeTranscriptionDeploymentField
        t={props.t}
        value={props.voiceRealtimeTranscriptionModelId}
        disabled={props.disabled}
        requiredForRealtime={props.voiceRealtimeModelId.trim() !== ""}
        onChange={props.setVoiceRealtimeTranscriptionModelId}
      />
      <VoiceSemanticTurnDetectionField
        t={props.t}
        checked={props.voiceSupportsSemanticTurnDetection}
        disabled={props.disabled}
        onChange={props.setVoiceSupportsSemanticTurnDetection}
      />
      <VoiceSpeechOutputDeploymentField
        t={props.t}
        value={props.voiceSpeechOutputModelId}
        disabled={props.disabled}
        onChange={props.setVoiceSpeechOutputModelId}
        onBlur={props.commitVoiceSpeechOutputModelId}
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
  readonly t: GatewaySetupTranslate;
  readonly preserveExisting: boolean;
  readonly voiceBaseUrl: string;
  readonly setVoiceBaseUrl: Dispatch<SetStateAction<string>>;
  readonly commitVoiceBaseUrl: () => void;
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
        onBlur={props.commitVoiceBaseUrl}
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
  readonly t: GatewaySetupTranslate;
  readonly busy: boolean;
  readonly success: string | undefined;
  readonly preserveExisting: boolean;
  readonly storedModels: readonly ModelCapability[];
  readonly voiceModelId: string;
  readonly setVoiceModelId: Dispatch<SetStateAction<string>>;
  readonly voiceRealtimeModelId: string;
  readonly setVoiceRealtimeModelId: Dispatch<SetStateAction<string>>;
  readonly commitVoiceRealtimeModelId: () => void;
  readonly voiceRealtimeTranscriptionModelId: string;
  readonly setVoiceRealtimeTranscriptionModelId: Dispatch<SetStateAction<string>>;
  readonly voiceSupportsSemanticTurnDetection: boolean;
  readonly setVoiceSupportsSemanticTurnDetection: (enabled: boolean) => void;
  readonly voiceSpeechOutputModelId: string;
  readonly setVoiceSpeechOutputModelId: Dispatch<SetStateAction<string>>;
  readonly commitVoiceSpeechOutputModelId: () => void;
  readonly voiceOutputVoiceId: string;
  readonly setVoiceOutputVoiceId: Dispatch<SetStateAction<string>>;
  readonly voiceProviderLocalityLabelId: string;
  readonly voiceProviderLocality: VoiceProviderLocality;
  readonly setVoiceProviderLocality: Dispatch<SetStateAction<VoiceProviderLocality>>;
  readonly voiceBaseUrl: string;
  readonly setVoiceBaseUrl: Dispatch<SetStateAction<string>>;
  readonly commitVoiceBaseUrl: () => void;
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
        preserveExisting={props.preserveExisting}
        storedModels={props.storedModels}
        voiceModelId={props.voiceModelId}
        setVoiceModelId={props.setVoiceModelId}
        voiceRealtimeModelId={props.voiceRealtimeModelId}
        setVoiceRealtimeModelId={props.setVoiceRealtimeModelId}
        commitVoiceRealtimeModelId={props.commitVoiceRealtimeModelId}
        voiceRealtimeTranscriptionModelId={props.voiceRealtimeTranscriptionModelId}
        setVoiceRealtimeTranscriptionModelId={props.setVoiceRealtimeTranscriptionModelId}
        voiceSupportsSemanticTurnDetection={props.voiceSupportsSemanticTurnDetection}
        setVoiceSupportsSemanticTurnDetection={props.setVoiceSupportsSemanticTurnDetection}
        voiceSpeechOutputModelId={props.voiceSpeechOutputModelId}
        setVoiceSpeechOutputModelId={props.setVoiceSpeechOutputModelId}
        commitVoiceSpeechOutputModelId={props.commitVoiceSpeechOutputModelId}
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
        commitVoiceBaseUrl={props.commitVoiceBaseUrl}
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
  readonly t: GatewaySetupTranslate;
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
  readonly t: GatewaySetupTranslate;
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
  readonly figmaAccessTokenRef: RefObject<HTMLInputElement | null>;
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
        <output className="gw-success" style={NATIVE_BLOCK_STYLE}>
          {success}
        </output>
      ) : null}
      {busy ? (
        <output className="gw-pending" style={NATIVE_BLOCK_STYLE}>
          Testing credentials…
        </output>
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
  const t = useGatewaySetupTranslate();
  const { theme, toggle: toggleTheme } = useTheme();
  const dialogRef = useRef<HTMLDialogElement>(null);
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
  const [workflowEligibleModelIds, setWorkflowEligibleModelIds] = useState(() =>
    preserveExisting ? storedWorkflowEligibleModelIds(storedModels) : "",
  );
  const [imageInputModelIdsConfigured, setImageInputModelIdsConfigured] = useState(false);
  const [importedEmbeddingModelIds, setImportedEmbeddingModelIds] = useState<readonly string[]>([]);
  const [importedVoiceEndpointStyle, setImportedVoiceEndpointStyle] = useState("");
  const [importedVoiceApiVersion, setImportedVoiceApiVersion] = useState("");
  const [importedVoiceRealtimeAuthMode, setImportedVoiceRealtimeAuthMode] = useState("");
  const [importedVoiceEndpointBaseUrl, setImportedVoiceEndpointBaseUrl] = useState("");
  const [importedEndpointStyle, setImportedEndpointStyle] = useState("");
  const [importedApiVersion, setImportedApiVersion] = useState("");
  const [importedEndpointBaseUrl, setImportedEndpointBaseUrl] = useState("");
  const [uploadReadPending, setUploadReadPending] = useState(false);
  const [workflowEligibleModelIdsConfigured, setWorkflowEligibleModelIdsConfigured] =
    useState(false);
  const [voiceBaseUrl, setVoiceBaseUrl] = useState("");
  const [voiceApiKey, setVoiceApiKey] = useState("");
  const [voiceApiKeyHeaderName, setVoiceApiKeyHeaderName] = useState("");
  const [voiceModelId, setVoiceModelId] = useState("");
  const [voiceRealtimeModelId, setVoiceRealtimeModelId] = useState("");
  const [voiceRealtimeTranscriptionModelId, setVoiceRealtimeTranscriptionModelId] = useState("");
  const [voiceSupportsSemanticTurnDetection, setVoiceSupportsSemanticTurnDetection] = useState(
    () => (preserveExisting ? storedSemanticTurnDetection(storedModels) : false),
  );
  const [voiceSemanticTurnDetectionConfigured, setVoiceSemanticTurnDetectionConfigured] =
    useState(false);
  // No form control exists for speech-synthesis instruction support — the pair is file-scoped
  // hidden state set by a config upload, cleared on a speech-output identity change (#3037).
  const [voiceSupportsSpeechSynthesisInstructions, setVoiceSupportsSpeechSynthesisInstructions] =
    useState(false);
  const [
    voiceSpeechSynthesisInstructionsConfigured,
    setVoiceSpeechSynthesisInstructionsConfigured,
  ] = useState(false);
  // The model id the imported flag is BOUND to — a fresh dialog's identity ref never commits,
  // so the binding, not the ref transition, invalidates the flag when the user retypes the
  // speech-output deployment (review finding on #3041).
  const [voiceSpeechSynthesisInstructionsModelId, setVoiceSpeechSynthesisInstructionsModelId] =
    useState("");
  const [voiceSpeechOutputModelId, setVoiceSpeechOutputModelId] = useState("");
  const [voiceOutputVoiceId, setVoiceOutputVoiceId] = useState("");
  const [voiceOutputVoiceIdConfigured, setVoiceOutputVoiceIdConfigured] = useState(false);
  const [voiceProviderLocality, setVoiceProviderLocality] =
    useState<VoiceProviderLocality>("azure-foundry");
  const [voiceProviderLocalityConfigured, setVoiceProviderLocalityConfigured] = useState(false);
  const [voiceTimeoutMs, setVoiceTimeoutMs] = useState("");
  const [figmaAccessToken, setFigmaAccessToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [errorCode, setErrorCode] = useState<string | undefined>();
  const [success, setSuccess] = useState<string | undefined>();
  const storedVoiceProviderExists = storedVoiceModels(storedModels).length > 0;
  const realtimeIdentityRef = useRef<ProviderIdentity | undefined>(
    preserveExisting ? storedRealtimeModelId(storedModels) : undefined,
  );
  const speechOutputIdentityRef = useRef<ProviderIdentity | undefined>(
    preserveExisting ? storedSpeechOutputModelId(storedModels) : undefined,
  );
  const endpointIdentityRef = useRef<ProviderIdentity | undefined>(
    preserveExisting && storedVoiceProviderExists ? STORED_VOICE_ENDPOINT_IDENTITY : undefined,
  );

  const updateVoiceSemanticTurnDetection = (enabled: boolean): void => {
    setVoiceSupportsSemanticTurnDetection(enabled);
    setVoiceSemanticTurnDetectionConfigured(true);
  };

  const resetRealtimeDependencies = (nextModelId: string, nextBaseUrl: string): void => {
    setVoiceRealtimeTranscriptionModelId("");
    setVoiceSupportsSemanticTurnDetection(
      semanticTurnDetectionForIdentity(preserveExisting, storedModels, nextModelId, nextBaseUrl),
    );
    setVoiceSemanticTurnDetectionConfigured(false);
  };

  const resetSpeechOutputDependencies = (): void => {
    setVoiceOutputVoiceId("");
    setVoiceOutputVoiceIdConfigured(false);
    // An EXPLICIT clear, not an omission: the replacement model's template at the same endpoint
    // is the OLD provider's rawCapability, so an omitted field would re-inherit instruction
    // support onto a deployment that never declared it (review finding on #3041).
    setVoiceSupportsSpeechSynthesisInstructions(false);
    setVoiceSpeechSynthesisInstructionsConfigured(true);
    setVoiceSpeechSynthesisInstructionsModelId("");
  };

  const resetEndpointDependencies = (
    nextBaseUrl: string,
    nextIdentity: ProviderIdentity | undefined,
  ): void => {
    const restoresStoredEndpoint = nextIdentity === STORED_VOICE_ENDPOINT_IDENTITY;
    setVoiceModelId("");
    setVoiceRealtimeModelId("");
    setVoiceSpeechOutputModelId("");
    resetRealtimeDependencies("", nextBaseUrl);
    resetSpeechOutputDependencies();
    realtimeIdentityRef.current = restoresStoredEndpoint
      ? storedRealtimeModelId(storedModels)
      : undefined;
    speechOutputIdentityRef.current = restoresStoredEndpoint
      ? storedSpeechOutputModelId(storedModels)
      : undefined;
  };

  const updateVoiceRealtimeModelId: Dispatch<SetStateAction<string>> = (value): void => {
    const next = typeof value === "function" ? value(voiceRealtimeModelId) : value;
    setVoiceRealtimeModelId(next);
    transitionProviderIdentity(
      realtimeIdentityRef,
      modelIdentity(next, preserveExisting ? storedRealtimeModelId(storedModels) : undefined),
      () => resetRealtimeDependencies(next, voiceBaseUrl),
      false,
    );
    if (!voiceSemanticTurnDetectionConfigured) {
      setVoiceSupportsSemanticTurnDetection(
        semanticTurnDetectionForIdentity(preserveExisting, storedModels, next, voiceBaseUrl),
      );
    }
  };

  const commitVoiceRealtimeModelId = (): void => {
    transitionProviderIdentity(
      realtimeIdentityRef,
      modelIdentity(
        voiceRealtimeModelId,
        preserveExisting ? storedRealtimeModelId(storedModels) : undefined,
      ),
      () => resetRealtimeDependencies(voiceRealtimeModelId, voiceBaseUrl),
      true,
    );
  };

  const updateVoiceSpeechOutputModelId: Dispatch<SetStateAction<string>> = (value): void => {
    const next = typeof value === "function" ? value(voiceSpeechOutputModelId) : value;
    setVoiceSpeechOutputModelId(next);
    transitionProviderIdentity(
      speechOutputIdentityRef,
      modelIdentity(next, preserveExisting ? storedSpeechOutputModelId(storedModels) : undefined),
      resetSpeechOutputDependencies,
      false,
    );
    invalidateDivergedSynthesisBinding(next);
  };

  // Instruction support is a property of the exact deployment the file declared it for — a
  // diverging id turns the configured flag into an EXPLICIT clear, or the server template at
  // the same endpoint would re-inherit it onto the replacement model (review finding on #3041).
  const invalidateDivergedSynthesisBinding = (next: string): void => {
    if (
      voiceSpeechSynthesisInstructionsConfigured &&
      voiceSupportsSpeechSynthesisInstructions &&
      next.trim() !== voiceSpeechSynthesisInstructionsModelId
    ) {
      setVoiceSupportsSpeechSynthesisInstructions(false);
    }
  };

  const commitVoiceSpeechOutputModelId = (): void => {
    transitionProviderIdentity(
      speechOutputIdentityRef,
      modelIdentity(
        voiceSpeechOutputModelId,
        preserveExisting ? storedSpeechOutputModelId(storedModels) : undefined,
      ),
      resetSpeechOutputDependencies,
      true,
    );
  };

  const updateVoiceBaseUrl: Dispatch<SetStateAction<string>> = (value): void => {
    const next = typeof value === "function" ? value(voiceBaseUrl) : value;
    setVoiceBaseUrl(next);
    const nextIdentity = endpointIdentity(next, preserveExisting, storedVoiceProviderExists);
    transitionProviderIdentity(
      endpointIdentityRef,
      nextIdentity,
      () => resetEndpointDependencies(next, nextIdentity),
      false,
    );
  };

  const commitVoiceBaseUrl = (): void => {
    const nextIdentity = endpointIdentity(
      voiceBaseUrl,
      preserveExisting,
      storedVoiceProviderExists,
    );
    transitionProviderIdentity(
      endpointIdentityRef,
      nextIdentity,
      () => resetEndpointDependencies(voiceBaseUrl, nextIdentity),
      true,
    );
  };

  const updateVoiceOutputVoiceId: Dispatch<SetStateAction<string>> = (value): void => {
    setVoiceOutputVoiceId(value);
    setVoiceOutputVoiceIdConfigured(true);
  };

  const updateVoiceProviderLocality: Dispatch<SetStateAction<VoiceProviderLocality>> = (
    value,
  ): void => {
    setVoiceProviderLocality(value);
    setVoiceProviderLocalityConfigured(true);
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;
    if (!dialog.open) dialog.showModal();
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
      if (dialog.open) dialog.close();
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
      const last = focusables.at(-1) as HTMLElement;
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

  function applyUploadedConfig(fields: GatewayConfigUploadFields): void {
    if (fields.baseUrl !== undefined) setBaseUrl(fields.baseUrl);
    if (fields.apiKey !== undefined) setApiKey(fields.apiKey);
    if (fields.apiKeyHeaderName !== undefined) setApiKeyHeaderName(fields.apiKeyHeaderName);
    if (fields.timeoutMs !== undefined) setTimeoutMs(fields.timeoutMs);
    if (fields.deploymentNames.length > 0) setDeploymentNames(fields.deploymentNames.join("\n"));
    // A defined-but-empty flag list is the file explicitly declaring "none" and must clear the
    // field exactly like manual emptying would (review finding on #3031); only an undefined list
    // (the file never speaks about the flag) leaves the field untouched.
    // The CONFIGURED flags are invisible state and therefore file-scoped like every other hidden
    // import: each upload states whether THIS file speaks about the flag lists. The visible
    // textarea values persist unless the file replaces them (the user can see and correct
    // those), but a stale invisible flag from an earlier file's explicit empty list would turn
    // the next submit into a stored-flag clear the current file never asked for (#3037).
    setImageInputModelIdsConfigured(fields.imageInputModelIds !== undefined);
    if (fields.imageInputModelIds !== undefined) {
      setImageInputModelIds(fields.imageInputModelIds.join("\n"));
    }
    setWorkflowEligibleModelIdsConfigured(fields.workflowEligibleModelIds !== undefined);
    if (fields.workflowEligibleModelIds !== undefined) {
      setWorkflowEligibleModelIds(fields.workflowEligibleModelIds.join("\n"));
    }
    // Imported embedding kinds ride along invisibly — they assert the kind to the setup route
    // so a fresh save cannot chat-probe an embedding out of the config (review finding on #3037).
    // Unlike the VISIBLE fields (which the user can see and correct), hidden imported state is
    // strictly file-scoped: every successful upload REPLACES it, or a corrected second upload
    // would still submit the previous file's kind declarations (review finding on #3037).
    setImportedEmbeddingModelIds(fields.embeddingModelIds ?? []);
    if (fields.figmaAccessToken !== undefined) setFigmaAccessToken(fields.figmaAccessToken);
    applyUploadedVoiceConfig(fields);
  }

  /**
   * Voice fields apply through the SAME update wrappers typing uses, in typing order: the base
   * URL first (its identity transition resets the dependent role fields), the realtime id before
   * its transcription id (the realtime transition clears the transcription), and the semantic
   * turn detection flag last so the file's explicit declaration wins over inherited defaults.
   */
  function applyUploadedVoiceConnection(fields: GatewayConfigUploadFields): void {
    if (fields.voiceBaseUrl !== undefined) updateVoiceBaseUrl(fields.voiceBaseUrl);
    if (fields.voiceApiKey !== undefined) setVoiceApiKey(fields.voiceApiKey);
    if (fields.voiceApiKeyHeaderName !== undefined) {
      setVoiceApiKeyHeaderName(fields.voiceApiKeyHeaderName);
    }
    if (fields.voiceTimeoutMs !== undefined) setVoiceTimeoutMs(fields.voiceTimeoutMs);
  }

  // When the file carries a voice section, its role set REPLACES the form's roles — a corrected
  // upload that removed a role must not leave the previous deployment visible, or Test & Save
  // would silently re-add it (review finding on #3037). A file with no voice section leaves the
  // fields untouched, like every other absent statement. The parser guarantees the gate is
  // whole: a voice section always carries voiceBaseUrl (a section without one is refused as
  // invalid), so role ids can never arrive while the section counts as absent (KfQ finding on
  // #3037).
  function applyUploadedVoiceRoles(fields: GatewayConfigUploadFields): void {
    const speaksAboutVoice = fields.voiceBaseUrl !== undefined;
    const applyRole = (value: string | undefined, set: (next: string) => void): void => {
      if (speaksAboutVoice) set(value ?? "");
    };
    applyRole(fields.voiceModelId, setVoiceModelId);
    applyRole(fields.voiceRealtimeModelId, updateVoiceRealtimeModelId);
    applyRole(fields.voiceRealtimeTranscriptionModelId, setVoiceRealtimeTranscriptionModelId);
    applyRole(fields.voiceSpeechOutputModelId, updateVoiceSpeechOutputModelId);
  }

  // AFTER the speech-output role update — file-scoped like the roles: a voice section that says
  // nothing about synthesis support resets the hidden pair, or a fresh dialog whose identity ref
  // never committed would submit a stale configured true without a speech-output role and make
  // the corrected file unsavable (review finding on #3041).
  function applyUploadedSynthesisSupport(fields: GatewayConfigUploadFields): void {
    if (
      fields.voiceBaseUrl === undefined &&
      fields.voiceSupportsSpeechSynthesisInstructions === undefined
    ) {
      return;
    }
    setVoiceSupportsSpeechSynthesisInstructions(
      fields.voiceSupportsSpeechSynthesisInstructions ?? false,
    );
    setVoiceSpeechSynthesisInstructionsConfigured(
      fields.voiceSupportsSpeechSynthesisInstructions !== undefined,
    );
    setVoiceSpeechSynthesisInstructionsModelId(
      fields.voiceSupportsSpeechSynthesisInstructions !== undefined
        ? (fields.voiceSpeechOutputModelId ?? "")
        : "",
    );
  }

  function applyUploadedVoiceConfig(fields: GatewayConfigUploadFields): void {
    applyUploadedVoiceConnection(fields);
    applyUploadedVoiceRoles(fields);
    // After the speech-output update above — its identity transition clears the output voice.
    // File-scoped like the roles: a voice section that dropped the profile clears the field and
    // its configured flag, or Test & Save would silently persist the removed profile (#3037).
    if (fields.voiceBaseUrl !== undefined || fields.voiceOutputVoiceId !== undefined) {
      setVoiceOutputVoiceId(fields.voiceOutputVoiceId ?? "");
      setVoiceOutputVoiceIdConfigured(fields.voiceOutputVoiceId !== undefined);
    }
    applyUploadedSynthesisSupport(fields);
    if (fields.voiceProviderLocality !== undefined) {
      setVoiceProviderLocality(fields.voiceProviderLocality);
      setVoiceProviderLocalityConfigured(true);
    }
    if (fields.voiceSemanticTurnDetection !== undefined) {
      updateVoiceSemanticTurnDetection(fields.voiceSemanticTurnDetection);
    }
    applyUploadedVoiceEndpoint(fields);
    applyUploadedGenericEndpoint(fields);
  }

  // The endpoint protocol rides along invisibly and is persisted verbatim by the setup route —
  // without it a fresh save of an Azure speech endpoint loses its deployment URL shape (#3037).
  // Hidden imported state is file-scoped: when the file speaks about the voice connection at
  // all, its protocol declaration REPLACES the previous upload's (a corrected re-upload without
  // a style must clear the stale one); a file with no voice section leaves the visible voice
  // fields — and therefore the protocol that belongs to them — untouched.
  // Twin of the voice binding below: the generic protocol is BOUND to the uploaded gateway
  // URL and cleared when the file carries none, so a stale binding cannot outlive a corrected
  // re-upload (#3042).
  function applyUploadedGenericEndpoint(fields: GatewayConfigUploadFields): void {
    if (fields.baseUrl === undefined) return;
    setImportedEndpointStyle(fields.endpointStyle ?? "");
    setImportedApiVersion(fields.apiVersion ?? "");
    setImportedEndpointBaseUrl(fields.baseUrl.trim());
  }

  function applyUploadedVoiceEndpoint(fields: GatewayConfigUploadFields): void {
    if (fields.voiceBaseUrl === undefined) return;
    setImportedVoiceEndpointStyle(fields.voiceEndpointStyle ?? "");
    setImportedVoiceApiVersion(fields.voiceApiVersion ?? "");
    setImportedVoiceRealtimeAuthMode(fields.voiceRealtimeAuthMode ?? "");
    // The protocol is BOUND to the uploaded endpoint URL: the payload submits it only while the
    // form still points at exactly that endpoint, so a manually retyped URL can never inherit
    // the file's deployment-path shape (#3037). Trimmed with the same trim the submit-time
    // comparison applies — an untrimmed stored URL would silently drop the protocol.
    setImportedVoiceEndpointBaseUrl(fields.voiceBaseUrl.trim());
  }

  async function submit(event: FormSubmitEvent): Promise<void> {
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
          imageInputModelIdsConfigured,
          importedEmbeddingModelIds,
          workflowEligibleModelIds,
          workflowEligibleModelIdsConfigured,
          voiceBaseUrl,
          voiceApiKey,
          voiceApiKeyHeaderName,
          voiceModelId,
          voiceRealtimeModelId,
          voiceRealtimeTranscriptionModelId,
          voiceSupportsSemanticTurnDetection,
          voiceSemanticTurnDetectionConfigured,
          voiceSupportsSpeechSynthesisInstructions,
          voiceSpeechSynthesisInstructionsConfigured,
          importedVoiceEndpointStyle,
          importedVoiceApiVersion,
          importedVoiceRealtimeAuthMode,
          importedVoiceEndpointBaseUrl,
          importedEndpointStyle,
          importedApiVersion,
          importedEndpointBaseUrl,
          voiceSpeechOutputModelId,
          voiceOutputVoiceId,
          voiceOutputVoiceIdConfigured,
          voiceProviderLocality,
          voiceProviderLocalityConfigured,
          voiceTimeoutMs,
          figmaAccessToken,
          preserveExisting,
          hasStoredVoiceProvider: storedVoiceModels(storedModels).length > 0,
          storedRealtimeModelId: storedRealtimeModelId(storedModels),
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
      // The stored configuration is now a different one. Announce it before the reload window opens:
      // for the ~1s the success message is on screen the Settings panel is still mounted, and every
      // readiness verdict it remembers describes the gateway that was just replaced.
      notifyGatewayConfigUpdated();
      reloadTimerRef.current = window.setTimeout(
        () => window.location.reload(),
        outcome.skippedModelCount === 0 ? 800 : 1800,
      );
    } catch (error_) {
      const details = errorDetails(error_);
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
  const parsedWorkflowEligibleModelIds = deploymentNamesFromInput(workflowEligibleModelIds);
  const voiceCredentialInput = hasVoiceCredentialInput({
    voiceBaseUrl,
    voiceApiKey,
    voiceApiKeyHeaderName,
    voiceModelId,
    voiceRealtimeModelId,
    voiceRealtimeTranscriptionModelId,
    voiceSpeechOutputModelId,
    voiceTimeoutMs,
    voiceSemanticTurnDetectionConfigured,
    voiceSpeechSynthesisInstructionsConfigured,
    voiceOutputVoiceIdConfigured,
    voiceProviderLocalityConfigured,
  });
  const requiresGatewayCredentials = !preserveExisting;
  const hasGatewayCredentialInput = hasAnyGatewayCredentialInput({
    baseUrl,
    apiKey,
    apiKeyHeaderName,
    timeoutMs,
    parsedDeploymentNames,
    parsedImageInputModelIds,
    parsedWorkflowEligibleModelIds,
    workflowEligibleModelIdsConfigured,
    voiceCredentialInput,
  });
  const hasFigmaCredentialInput = figmaAccessToken.trim() !== "";
  const canSubmit = computeCanSubmit({
    busy: busy || uploadReadPending,
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
      t={t}
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
      setImageInputModelIds={(value): void => {
        setImageInputModelIdsConfigured(true);
        setImageInputModelIds(value);
      }}
      workflowEligibleModelIds={workflowEligibleModelIds}
      setWorkflowEligibleModelIds={(value): void => {
        setWorkflowEligibleModelIdsConfigured(true);
        setWorkflowEligibleModelIds(value);
      }}
    />
  );

  const voiceFields = (
    <VoiceFieldsSection
      t={t}
      busy={busy}
      success={success}
      preserveExisting={preserveExisting}
      storedModels={storedModels}
      voiceModelId={voiceModelId}
      setVoiceModelId={setVoiceModelId}
      voiceRealtimeModelId={voiceRealtimeModelId}
      setVoiceRealtimeModelId={updateVoiceRealtimeModelId}
      commitVoiceRealtimeModelId={commitVoiceRealtimeModelId}
      voiceRealtimeTranscriptionModelId={voiceRealtimeTranscriptionModelId}
      setVoiceRealtimeTranscriptionModelId={setVoiceRealtimeTranscriptionModelId}
      voiceSupportsSemanticTurnDetection={voiceSupportsSemanticTurnDetection}
      setVoiceSupportsSemanticTurnDetection={updateVoiceSemanticTurnDetection}
      voiceSpeechOutputModelId={voiceSpeechOutputModelId}
      setVoiceSpeechOutputModelId={updateVoiceSpeechOutputModelId}
      commitVoiceSpeechOutputModelId={commitVoiceSpeechOutputModelId}
      voiceOutputVoiceId={voiceOutputVoiceId}
      setVoiceOutputVoiceId={updateVoiceOutputVoiceId}
      voiceProviderLocalityLabelId={voiceProviderLocalityLabelId}
      voiceProviderLocality={voiceProviderLocality}
      setVoiceProviderLocality={updateVoiceProviderLocality}
      voiceBaseUrl={voiceBaseUrl}
      setVoiceBaseUrl={updateVoiceBaseUrl}
      commitVoiceBaseUrl={commitVoiceBaseUrl}
      voiceApiKey={voiceApiKey}
      setVoiceApiKey={setVoiceApiKey}
      voiceApiKeyHeaderName={voiceApiKeyHeaderName}
      setVoiceApiKeyHeaderName={setVoiceApiKeyHeaderName}
      voiceTimeoutMs={voiceTimeoutMs}
      setVoiceTimeoutMs={setVoiceTimeoutMs}
    />
  );

  const dialogTree = (
    <div className="gw-setup-backdrop">
      <dialog
        ref={dialogRef}
        className="gw-setup"
        aria-modal="true"
        aria-labelledby="gw-setup-title"
        aria-describedby="gw-setup-desc"
        onCancel={(event) => {
          event.preventDefault();
          if (!busy && success === undefined) onCancel?.();
        }}
        // tabIndex -1: keeps focus (and thus the Escape/Tab-trap keydown
        // listener on this element) inside the dialog when a non-focusable
        // area is clicked or all controls are disabled (audit C007/C186).
        tabIndex={-1}
      >
        <form className="gw-form" onSubmit={(event) => void submit(event)}>
          <div className="gw-head">
            <div className={styles["cmp-head-controls"]}>
              <div className="gw-setup-badge">
                <CubeIcon size={18} />
                {preserveExisting ? t("gatewaySetup.badge.update") : t("gatewaySetup.badge.setup")}
              </div>
              <button
                type="button"
                className={styles["cmp-theme-toggle"]}
                aria-label={theme === "light" ? t("rail.darkMode") : t("rail.lightMode")}
                onClick={toggleTheme}
              >
                {theme === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
                <span>{theme === "light" ? t("rail.darkMode") : t("rail.lightMode")}</span>
              </button>
            </div>
            <h1 id="gw-setup-title">{dialogCopy.title}</h1>
            <p id="gw-setup-desc">{dialogCopy.description}</p>
          </div>

          <GatewayConfigUpload
            disabled={busy || success !== undefined}
            onApply={applyUploadedConfig}
            onReadPendingChange={setUploadReadPending}
          />

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
      </dialog>
    </div>
  );

  if (typeof document === "undefined") return dialogTree;
  return createPortal(dialogTree, document.body);
}
