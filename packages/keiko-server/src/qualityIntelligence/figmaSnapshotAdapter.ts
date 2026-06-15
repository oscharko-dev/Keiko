// figmaSnapshotAdapter.ts — Figma-snapshot source seam for QI ingestion (Epic #750, Issue #754).
//
// Two server-tier seams the pure-domain ingestion cannot own:
//
//   1. The snapshot LOADER — reads the immutable Figma Snapshot evidence record for a runId through
//      the existing keiko-evidence store (`createNodeFigmaSnapshotStore(evidenceDir).load`). It
//      reads ONLY the stored snapshot and never contacts Figma. Returns `undefined` when no
//      evidence dir is configured, so the ingestion layer rejects the source with a coded error.
//
//   2. The capability-routed VISION hint provider — consults `resolveQiMultimodalSelection` (#810)
//      to decide whether a multimodal model is available; when one is, it MAY call an injected
//      server-owned vision call to recover image-derived semantics from the STORED render side-file,
//      returning them as additive hints. There is
//      NO hard-coded model id. On "unavailable", a thrown call, or a non-array/garbage result the
//      provider returns `[]`, so the source degrades silently to the deterministic IR-only baseline.
//      The call goes through deps.modelPortFactory / Model Gateway only — no provider SDK and no
//      Figma egress after snapshot build.

import { Buffer } from "node:buffer";
import {
  createNodeFigmaSnapshotStore,
  type FigmaSnapshotImageRef,
  type FigmaSnapshotRecord,
} from "@oscharko-dev/keiko-evidence";
import type { GatewayRequest } from "@oscharko-dev/keiko-model-gateway";
import type { UiHandlerDeps } from "../deps.js";
import { resolveQiMultimodalSelection } from "./modelSelection.js";

/** Loads an immutable Figma Snapshot evidence record by runId. Returns `undefined` when not found. */
export type FigmaSnapshotLoader = (snapshotRunId: string) => FigmaSnapshotRecord | undefined;

export interface FigmaSnapshotLoaderOptions {
  /**
   * Drift seam (#735): a figma-snapshot source pins a write-once, content-addressed runId, so its
   * content can never change under its identity — re-checking the pinned record would always
   * report "fresh" even after the board changed and was re-snapshotted. When this flag is set the
   * loader resolves the LATEST snapshot recorded for the same board scope (fileKey + nodeId) and
   * returns it instead of the pinned record whenever its integrity hash differs. Screen atom ids
   * are board-stable (screenId-derived), so compareStaleness sees changed atoms, not orphans.
   * Used by re-check and regenerate-stale ONLY — the generate path keeps exact pinning.
   */
  readonly resolveLatestByScope?: boolean;
}

/**
 * Build the snapshot loader. Returns `undefined` when `deps.evidenceDir` is not configured so the
 * ingestion layer maps an attempted figma-snapshot source to QI_FIGMA_SNAPSHOT_UNAVAILABLE.
 */
export function makeFigmaSnapshotLoader(
  deps: UiHandlerDeps,
  options?: FigmaSnapshotLoaderOptions,
): FigmaSnapshotLoader | undefined {
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined || evidenceDir.length === 0) return undefined;
  const store = createNodeFigmaSnapshotStore(evidenceDir);
  const resolveLatest = options?.resolveLatestByScope === true;
  return (snapshotRunId: string): FigmaSnapshotRecord | undefined => {
    try {
      const pinned = store.load(snapshotRunId);
      if (pinned === undefined || !resolveLatest) return pinned;
      const entries = store.listByScope(pinned.provenance.fileKey, pinned.provenance.nodeId);
      const newest = entries[0];
      if (
        newest === undefined ||
        newest.runId === pinned.runId ||
        newest.integrityHash === pinned.integrityHash
      ) {
        return pinned;
      }
      // Fall back to the pinned record when the newest record fails to load — drift detection
      // must degrade to "fresh", never crash the re-check.
      return store.load(newest.runId) ?? pinned;
    } catch {
      // A malformed / unreadable record is treated as "not found"; the caller emits a coded error.
      return undefined;
    }
  };
}

/** The image-derived semantics a multimodal model recovered for one screen, as additive hints. */
export interface FigmaVisionScreenRequest {
  readonly snapshotRunId: string;
  readonly screenId: string;
  /** The image side-file reference recorded in the snapshot (relative path + sha256). */
  readonly image: FigmaSnapshotImageRef;
  readonly imageRelativePath: string;
  /** The deterministic baseline text, supplied so the model cross-checks rather than re-derives. */
  readonly baselineText: string;
}

/**
 * Produces additive vision hints for a screen, OR an empty list when vision is unavailable / failed.
 * The contract is total: it NEVER throws and NEVER returns a value that could override the IR — the
 * caller appends the hints below the baseline.
 */
export type FigmaVisionHintProvider = (
  request: FigmaVisionScreenRequest,
) => readonly string[] | Promise<readonly string[]>;

/**
 * A raw vision call: given a screen request and the selected model id, return image-derived hint
 * strings. Injectable so tests can keep the provider deterministic; production defaults to the
 * server-owned evidence-store + Model Gateway port below. Absence is exactly the IR-only path.
 */
export type FigmaVisionCall = (
  request: FigmaVisionScreenRequest,
  modelId: string,
) => readonly string[] | Promise<readonly string[]>;

export interface FigmaVisionHintProviderOptions {
  readonly onGatewayCallAttempt?: (() => void) | undefined;
}

const MAX_VISION_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_VISION_BASELINE_BYTES = 12_000;
const MAX_VISION_HINTS = 24;
const FIGMA_VISION_TIMEOUT_MS = 30_000;

const encoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return encoder.encode(value).length;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  let out = "";
  let bytes = 0;
  for (const cp of value) {
    const cpBytes = utf8ByteLength(cp);
    if (bytes + cpBytes > maxBytes) break;
    out += cp;
    bytes += cpBytes;
  }
  return out;
}

function redactedString(deps: UiHandlerDeps, value: string): string {
  const redacted = deps.redactor(value);
  return typeof redacted === "string" ? redacted : "";
}

function sanitiseCallResult(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function parseHintResponse(raw: string): readonly string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return sanitiseCallResult(parsed).slice(0, MAX_VISION_HINTS);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { readonly hints?: unknown }).hints)
    ) {
      return sanitiseCallResult((parsed as { readonly hints: unknown }).hints).slice(
        0,
        MAX_VISION_HINTS,
      );
    }
  } catch {
    return [];
  }
  return [];
}

function visionUserText(request: FigmaVisionScreenRequest, baselineText: string): string {
  return (
    `Screen id: ${request.screenId}\n` +
    "Structural baseline, already authoritative:\n" +
    `${baselineText}\n\n` +
    "Return only visual/semantic hints that are absent from the baseline."
  );
}

function buildVisionRequest(
  request: FigmaVisionScreenRequest,
  modelId: string,
  dataUrl: string,
  baselineText: string,
  structuredOutput: boolean,
): GatewayRequest {
  const userText = visionUserText(request, baselineText);
  return {
    modelId,
    messages: [
      {
        role: "system",
        content:
          "You are an additive UI test-generation vision pass. Use the image only to recover " +
          "semantics missing from the structural baseline. Do not contradict, replace, or restate " +
          "the baseline. Return concise JSON: an array of strings.",
      },
      {
        role: "user",
        content: userText,
        contentParts: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    ...(structuredOutput
      ? {
          responseFormat: {
            type: "json_schema" as const,
            schema: {
              type: "array",
              items: { type: "string" },
              maxItems: MAX_VISION_HINTS,
            },
          },
        }
      : {}),
  };
}

function createVisionAbortSignal(): { readonly signal: AbortSignal; readonly cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, FIGMA_VISION_TIMEOUT_MS);
  return {
    signal: controller.signal,
    cleanup: (): void => {
      clearTimeout(timeout);
    },
  };
}

function makeGatewayFigmaVisionCall(
  deps: UiHandlerDeps,
  options: FigmaVisionHintProviderOptions,
): FigmaVisionCall | undefined {
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined || evidenceDir.length === 0) return undefined;
  const store = createNodeFigmaSnapshotStore(evidenceDir);
  // Capture the structured-output flag once at closure-creation, not per screen. The multimodal
  // selection is stable for the lifetime of the provider (deps is immutable after server init),
  // so re-calling resolveQiMultimodalSelection on every vision call is redundant work.
  const closureSelection = resolveQiMultimodalSelection(deps);
  const closureModelSelection = closureSelection.kind === "model" ? closureSelection : undefined;
  return async (request: FigmaVisionScreenRequest, modelId: string): Promise<readonly string[]> => {
    if (request.image.byteLength > MAX_VISION_IMAGE_BYTES) return [];
    const model = deps.modelPortFactory(modelId);
    if (model === undefined) return [];
    const image = store.loadImage(request.snapshotRunId, request.image);
    if (image.byteLength > MAX_VISION_IMAGE_BYTES) return [];
    const dataUrl = `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`;
    const baselineText = truncateUtf8(
      redactedString(deps, request.baselineText),
      MAX_VISION_BASELINE_BYTES,
    );
    const structuredOutput =
      closureModelSelection?.modelId === modelId &&
      closureModelSelection.capability.supportsResponseFormat === true;
    const gatewayRequest = buildVisionRequest(
      request,
      modelId,
      dataUrl,
      baselineText,
      structuredOutput,
    );
    const abort = createVisionAbortSignal();
    try {
      options.onGatewayCallAttempt?.();
      const response = await model.call(gatewayRequest, abort.signal);
      return parseHintResponse(redactedString(deps, response.content));
    } finally {
      abort.cleanup();
    }
  };
}

/**
 * Build a capability-routed vision hint provider. When no multimodal capability is configured (or no
 * `visionCall` is injected), every request returns `[]` — the deterministic IR-only baseline path.
 * When a multimodal model IS available, the provider routes the call through it; any thrown error or
 * garbage result is swallowed to `[]` so a misbehaving model can never break the run or override the
 * structural baseline. No model id is hard-coded — selection is via `resolveQiMultimodalSelection`.
 */
export function makeFigmaVisionHintProvider(
  deps: UiHandlerDeps,
  visionCall?: FigmaVisionCall,
  options: FigmaVisionHintProviderOptions = {},
): FigmaVisionHintProvider {
  const resolvedVisionCall = visionCall ?? makeGatewayFigmaVisionCall(deps, options);
  const selection = resolveQiMultimodalSelection(deps);
  if (selection.kind === "unavailable" || resolvedVisionCall === undefined) {
    return () => [];
  }
  const { modelId } = selection;
  return (request: FigmaVisionScreenRequest): readonly string[] | Promise<readonly string[]> => {
    try {
      const result = resolvedVisionCall(request, modelId);
      return typeof (result as Promise<readonly string[]>).then === "function"
        ? Promise.resolve(result).then(sanitiseCallResult, () => [])
        : sanitiseCallResult(result);
    } catch {
      return [];
    }
  };
}
