import {
  classifyAttachmentMime,
  MAX_ATTACHMENT_BYTES,
  normalizeAttachmentMime,
} from "@oscharko-dev/keiko-contracts/runtime/bff-wire";
import type { ChatMessageImageUrlContentPart } from "@oscharko-dev/keiko-contracts";

import { parseInlineDataUrl } from "./coding-sidecar-data-url.js";

/**
 * Image input for a native OpenCode coding run (#3897 S14). The native `read` of a workspace image
 * reaches the model as an OpenAI-compatible `image_url` content part carrying a base64 data URL;
 * this module is the one place that admits such a part to the existing `ChatMessage.contentParts`
 * the Model Gateway already projects, accounts for and logs for Chat. It adds no second image path:
 * the media policy is the Chat attachment policy (`classifyAttachmentMime`, `MAX_ATTACHMENT_BYTES`),
 * and a part is forwarded only as a re-built, normalized data URL, never as received.
 *
 * Only inline base64 data URLs are admitted. A remote URL would make the gateway (or the provider)
 * fetch attacker-chosen content outside the sandbox egress boundary, so it is refused.
 */

/** The most image parts one gateway request may carry; the bound Chat applies to attachments. */
export const CODING_SIDECAR_MAX_IMAGE_PARTS = 16;

/** Closed refusal vocabulary; the route maps each to one fixed, body-free 400 message. */
export const CODING_SIDECAR_IMAGE_REJECTIONS = [
  "image-part-invalid",
  "image-mime-unsupported",
  "image-part-too-large",
  "image-count-exceeded",
  "image-input-unsupported",
] as const;

export type CodingSidecarImageRejection = (typeof CODING_SIDECAR_IMAGE_REJECTIONS)[number];

export const CODING_SIDECAR_IMAGE_REJECTION_MESSAGES: Readonly<
  Record<CodingSidecarImageRejection, string>
> = {
  "image-part-invalid": "Request body message content included an invalid image part.",
  "image-mime-unsupported":
    "Request body message content included an image part with an unsupported media type.",
  "image-part-too-large":
    "Request body message content included an image part that exceeds the image size limit.",
  "image-count-exceeded": "Request body messages exceed the image part limit.",
  "image-input-unsupported":
    "Request body message content included image input that the selected profile does not declare.",
};

export type CodingSidecarImagePartResult =
  | { readonly kind: "ok"; readonly part: ChatMessageImageUrlContentPart }
  /** Not an inline image at all: a malformed part, or a URL reference Keiko never dereferences. */
  | { readonly kind: "unsupported" }
  | { readonly kind: "rejected"; readonly reason: CodingSidecarImageRejection };

// `detail` is a provider-side resolution hint the AI SDK may attach; it carries no content, and the
// gateway projection forwards the URL only.
const IMAGE_DETAIL_HINTS: ReadonlySet<string> = new Set(["auto", "low", "high"]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a content part that declares itself an image, whether or not it is well formed. */
export function isImageUrlContentPartCandidate(part: unknown): boolean {
  return isRecord(part) && part.type === "image_url";
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function imageUrlOf(part: unknown): string | undefined {
  if (!isRecord(part) || !hasOnlyKeys(part, ["type", "image_url"])) return undefined;
  const target = part.image_url;
  if (!isRecord(target) || !hasOnlyKeys(target, ["url", "detail"])) return undefined;
  const { detail, url } = target;
  if (detail !== undefined && (typeof detail !== "string" || !IMAGE_DETAIL_HINTS.has(detail))) {
    return undefined;
  }
  return typeof url === "string" ? url : undefined;
}

function rejected(reason: CodingSidecarImageRejection): CodingSidecarImagePartResult {
  return { kind: "rejected", reason };
}

/**
 * Validates one `image_url` content part: strict shape, an inline base64 data URL, an allowed
 * image media type (SVG and every non-image type are refused) and a canonical, non-empty payload
 * within the per-image size limit. The returned part carries the normalized media type and the
 * original payload, so nothing but validated media reaches the gateway.
 *
 * A part that is not an inline data URL (a malformed shape, or a remote or file reference) is
 * `unsupported`, exactly the closed refusal every non-text part had before image input existed.
 */
export function parseImageUrlContentPart(part: unknown): CodingSidecarImagePartResult {
  const url = imageUrlOf(part);
  if (url === undefined) return { kind: "unsupported" };
  const inline = parseInlineDataUrl(url, MAX_ATTACHMENT_BYTES);
  if (inline.kind === "not-inline") return { kind: "unsupported" };
  if (inline.kind === "too-large") return rejected("image-part-too-large");
  if (inline.kind === "invalid") return rejected("image-part-invalid");
  const mediaType = normalizeAttachmentMime(inline.value.mediaType);
  if (mediaType === undefined || classifyAttachmentMime(mediaType) !== "image") {
    return rejected("image-mime-unsupported");
  }
  const { payload } = inline.value;
  return {
    kind: "ok",
    part: { type: "image_url", image_url: { url: `data:${mediaType};base64,${payload}` } },
  };
}

/** Image parts across the messages of one request. */
export function countImageContentParts(
  messages: readonly {
    readonly contentParts?: readonly { readonly type: string }[] | undefined;
  }[],
): number {
  return messages.reduce(
    (count, message) =>
      count + (message.contentParts?.filter((part) => part.type === "image_url").length ?? 0),
    0,
  );
}
