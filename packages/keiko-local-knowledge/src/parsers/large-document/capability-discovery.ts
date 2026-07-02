// Capability discovery for optional extraction capabilities (Epic #1160, Issue #1286).
//
// OCR and multimodal extraction are optional. They are discovered by probing an injected adapter
// and classified as available | unavailable | degraded | failing. Missing or failing capabilities
// degrade retrieval coverage but never compromise pipeline stability: the indexing job still
// completes deterministically with partial-coverage quality warnings. No third-party OCR/vision
// service is bundled or required by default; the null adapters report "unavailable".

import type {
  ExtractionCapabilityAvailability,
  ExtractionCapabilityStatus,
} from "@oscharko-dev/keiko-contracts";

import type { OcrAdapter } from "../ocr/types.js";

// Minimal multimodal port, mirroring the OCR adapter shape. A real implementation (vision model
// behind the Model Gateway) would describe an image/diagram region; the null adapter reports it is
// not configured.
export type MultimodalResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "not-configured" | "timeout" | "unsupported-input" };

export interface MultimodalAdapter {
  readonly kind: "multimodal";
  readonly describeImage: (input: {
    readonly bytes: Uint8Array;
    readonly pageNumber: number;
  }) => Promise<MultimodalResult>;
}

export const nullMultimodalAdapter: MultimodalAdapter = Object.freeze({
  kind: "multimodal" as const,
  describeImage: (): Promise<MultimodalResult> =>
    Promise.resolve({ ok: false, reason: "not-configured" }),
});

export interface CapabilityProbeDeps {
  readonly ocr?: OcrAdapter;
  readonly multimodal?: MultimodalAdapter;
  readonly now?: () => number;
  readonly probeTimeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const OCR_PROBE_BYTES = new Uint8Array([0]);

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      resolve(onTimeout());
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function probeOcrCapability(
  adapter: OcrAdapter | undefined,
  timeoutMs: number,
): Promise<ExtractionCapabilityStatus> {
  if (adapter === undefined) return "unavailable";
  try {
    const result = await withTimeout(
      adapter.ocrPage({ bytes: OCR_PROBE_BYTES, pageNumber: 1 }),
      timeoutMs,
      () => ({ ok: false as const, reason: "timeout" as const }),
    );
    if (result.ok) return "available";
    switch (result.reason) {
      case "ocr-not-configured":
        return "unavailable";
      case "timeout":
        return "degraded";
      case "unsupported-input":
        // The engine is installed but rejected the intentionally invalid probe input.
        return "available";
      case "engine-error":
        return "failing";
    }
  } catch {
    return "failing";
  }
}

export async function probeMultimodalCapability(
  adapter: MultimodalAdapter | undefined,
  timeoutMs: number,
): Promise<ExtractionCapabilityStatus> {
  if (adapter === undefined) return "unavailable";
  try {
    const result = await withTimeout(
      adapter.describeImage({ bytes: new Uint8Array(0), pageNumber: 1 }),
      timeoutMs,
      () => ({ ok: false as const, reason: "timeout" as const }),
    );
    if (result.ok) return "available";
    switch (result.reason) {
      case "not-configured":
        return "unavailable";
      case "timeout":
        return "degraded";
      case "unsupported-input":
        return "available";
    }
  } catch {
    return "failing";
  }
}

export async function discoverExtractionCapabilities(
  deps: CapabilityProbeDeps = {},
): Promise<ExtractionCapabilityAvailability> {
  const timeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const [ocr, multimodal] = await Promise.all([
    probeOcrCapability(deps.ocr, timeoutMs),
    probeMultimodalCapability(deps.multimodal, timeoutMs),
  ]);
  return { ocr, multimodal };
}
