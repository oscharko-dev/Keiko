import { MAX_ATTACHMENT_BYTES } from "@oscharko-dev/keiko-contracts/runtime/bff-wire";
import { describe, expect, it } from "vitest";
import {
  CODING_SIDECAR_IMAGE_REJECTION_MESSAGES,
  CODING_SIDECAR_IMAGE_REJECTIONS,
  countImageContentParts,
  isImageUrlContentPartCandidate,
  parseImageUrlContentPart,
} from "./coding-sidecar-image-parts.js";

function part(url: unknown, extra: Record<string, unknown> = {}): unknown {
  return { type: "image_url", image_url: { url, ...extra } };
}

function dataUrl(mediaType: string, bytes: number): string {
  return `data:${mediaType};base64,${Buffer.alloc(bytes, 5).toString("base64")}`;
}

describe("native image content part admission", () => {
  it.each(["image/png", "image/jpeg", "image/gif", "image/webp"])(
    "admits an inline %s image unchanged",
    (mediaType) => {
      const url = dataUrl(mediaType, 48);
      expect(parseImageUrlContentPart(part(url))).toEqual({
        kind: "ok",
        part: { type: "image_url", image_url: { url } },
      });
    },
  );

  it("normalizes the declared media type and forwards nothing but the rebuilt data URL", () => {
    const payload = Buffer.alloc(30, 9).toString("base64");
    expect(parseImageUrlContentPart(part(`data:IMAGE/PNG;base64,${payload}`))).toEqual({
      kind: "ok",
      part: { type: "image_url", image_url: { url: `data:image/png;base64,${payload}` } },
    });
  });

  it("drops the provider-side detail hint and refuses any other attached field", () => {
    const url = dataUrl("image/png", 12);
    for (const detail of ["auto", "low", "high"]) {
      expect(parseImageUrlContentPart(part(url, { detail }))).toEqual({
        kind: "ok",
        part: { type: "image_url", image_url: { url } },
      });
    }
    for (const hostile of [
      part(url, { detail: "ultra" }),
      part(url, { detail: 3 }),
      part(url, { headers: {} }),
      { ...(part(url) as object), cache: true },
      { type: "image_url", image_url: url },
      { type: "image_url" },
      { type: "image_url", image_url: { url: 42 } },
    ]) {
      expect(parseImageUrlContentPart(hostile)).toEqual({ kind: "unsupported" });
    }
  });

  it("never admits a URL reference: only inline data is forwarded", () => {
    for (const url of [
      "https://example.invalid/x.png",
      "http://127.0.0.1/x.png",
      "file:///etc/passwd",
      "ftp://example.invalid/x.png",
      "//example.invalid/x.png",
      "blob:https://example.invalid/1",
      " data:image/png;base64,AAAA",
      "",
    ]) {
      expect(parseImageUrlContentPart(part(url))).toEqual({ kind: "unsupported" });
    }
  });

  it.each([
    "data:image/png;base64",
    "data:image/png;base64,",
    "data:image/png;base64,AAA",
    "data:image/png;base64,AAAAA",
    "data:image/png;base64,AA==AA==",
    "data:image/png;base64,A===",
    "data:image/png;base64,AA A",
    "data:image/png;base64,AAA\n",
    "data:image/png;base64,AA-_",
    "data:image/png,AAAA",
    "data:image/png;charset=utf-8;base64,AAAA",
    "data:image/png;base64;base64,AAAA",
    "data:image/png;BASE64,AAAA",
  ])("refuses the malformed inline image %j as invalid", (url) => {
    expect(parseImageUrlContentPart(part(url))).toEqual({
      kind: "rejected",
      reason: "image-part-invalid",
    });
  });

  it.each([
    "data:image/svg+xml;base64,AAAA",
    "data:image/svg;base64,AAAA",
    "data:application/pdf;base64,AAAA",
    "data:application/octet-stream;base64,AAAA",
    "data:text/html;base64,AAAA",
    "data:png;base64,AAAA",
    "data:image/png/extra;base64,AAAA",
    "data:image/pn g;base64,AAAA",
    "data:;base64,AAAA",
  ])("refuses the unsupported media type in %j", (url) => {
    expect(parseImageUrlContentPart(part(url))).toEqual({
      kind: "rejected",
      reason: "image-mime-unsupported",
    });
  });

  it("holds the per-image limit at exactly the Chat attachment ceiling", () => {
    const atLimit = dataUrl("image/png", MAX_ATTACHMENT_BYTES);
    expect(parseImageUrlContentPart(part(atLimit)).kind).toBe("ok");
    expect(parseImageUrlContentPart(part(dataUrl("image/png", MAX_ATTACHMENT_BYTES + 1)))).toEqual({
      kind: "rejected",
      reason: "image-part-too-large",
    });
    // Far past the ceiling the part is refused without scanning its payload.
    expect(
      parseImageUrlContentPart(
        part(`data:image/png;base64,${"@".repeat(MAX_ATTACHMENT_BYTES * 2)}`),
      ),
    ).toEqual({ kind: "rejected", reason: "image-part-too-large" });
  });

  it("recognizes an image candidate whether or not it is well formed", () => {
    expect(isImageUrlContentPartCandidate({ type: "image_url" })).toBe(true);
    expect(isImageUrlContentPartCandidate(part("https://example.invalid/x.png"))).toBe(true);
    expect(isImageUrlContentPartCandidate({ type: "text", text: "x" })).toBe(false);
    expect(isImageUrlContentPartCandidate({ type: "input_audio" })).toBe(false);
    expect(isImageUrlContentPartCandidate("image_url")).toBe(false);
    expect(isImageUrlContentPartCandidate(null)).toBe(false);
  });

  it("counts image parts across all messages and ignores text parts", () => {
    const image = { type: "image_url" as const, image_url: { url: "data:image/png;base64,AAAA" } };
    const text = { type: "text" as const, text: "x" };
    expect(countImageContentParts([])).toBe(0);
    expect(
      countImageContentParts([
        { contentParts: [text, image, image] },
        {},
        { contentParts: [image] },
        { contentParts: [text] },
      ]),
    ).toBe(3);
  });

  it("owns one distinct, body-free message per closed refusal reason", () => {
    const messages = CODING_SIDECAR_IMAGE_REJECTIONS.map(
      (reason) => CODING_SIDECAR_IMAGE_REJECTION_MESSAGES[reason],
    );
    expect(new Set(messages).size).toBe(CODING_SIDECAR_IMAGE_REJECTIONS.length);
    for (const message of messages) expect(message).not.toMatch(/data:|base64,/u);
  });
});
