// Issue #149 (Epic #142) — server-side modality guardrails for the Conversation Center send path.
// These tests pin the four enforcement rules (kind, modality, mime, size) and the privacy rule
// that error messages MUST be static English strings — never echoing model ids, file names, or
// byte counts back into a response the browser will render.

import { describe, expect, it } from "vitest";
import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import {
  MAX_AGGREGATE_DOCUMENT_BYTES,
  validateConversationPayload,
} from "./conversation-validation.js";

const SECRET_MODEL_ID = "secret-internal-model-xyz" as const;
const SECRET_FILE_NAME = "secret-confidential-filename-xyz.txt" as const;

function baseCapability(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id: "test-chat",
    kind: "chat",
    contextWindow: 64_000,
    maxOutputTokens: 4_096,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "low",
    latencyClass: "fast",
    throughputHint: "test",
    preferredUseCases: [],
    knownLimitations: [],
    ...overrides,
  };
}

function registry(...caps: readonly ModelCapability[]): ReadonlyMap<string, ModelCapability> {
  return new Map(caps.map((c) => [c.id, c]));
}

describe("validateConversationPayload", () => {
  it("accepts a chat model with no attachments and no document context", () => {
    const result = validateConversationPayload({
      modelId: "test-chat",
      modelCapabilities: registry(baseCapability()),
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects an embedding model with CONVERSATION_UNAVAILABLE_MODEL", () => {
    const result = validateConversationPayload({
      modelId: "embed-1",
      modelCapabilities: registry(
        baseCapability({ id: "embed-1", kind: "embedding", workflowEligible: false }),
      ),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CONVERSATION_UNAVAILABLE_MODEL");
    }
  });

  it("rejects an OCR/vision-only model with CONVERSATION_UNAVAILABLE_MODEL", () => {
    const result = validateConversationPayload({
      modelId: "ocr-1",
      modelCapabilities: registry(
        baseCapability({ id: "ocr-1", kind: "ocr-vision", workflowEligible: false }),
      ),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CONVERSATION_UNAVAILABLE_MODEL");
    }
  });

  it("rejects a model id absent from the registry with CONVERSATION_UNAVAILABLE_MODEL", () => {
    const result = validateConversationPayload({
      modelId: SECRET_MODEL_ID,
      modelCapabilities: registry(baseCapability()),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CONVERSATION_UNAVAILABLE_MODEL");
      // The error message must NEVER echo the caller-supplied model id.
      expect(result.message).not.toContain(SECRET_MODEL_ID);
    }
  });

  it("rejects a text-only model that receives an image attachment", () => {
    const result = validateConversationPayload({
      modelId: "test-chat",
      modelCapabilities: registry(baseCapability({ supportsImageInput: false })),
      attachments: [{ kind: "image", mimeType: "image/png", sizeBytes: 1024 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CONVERSATION_UNSUPPORTED_MODALITY");
    }
  });

  it("rejects a text-only model that receives a document attachment", () => {
    const result = validateConversationPayload({
      modelId: "test-chat",
      modelCapabilities: registry(baseCapability({ supportsDocumentInput: false })),
      attachments: [{ kind: "document", mimeType: "text/plain", sizeBytes: 1024 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CONVERSATION_UNSUPPORTED_MODALITY");
    }
  });

  it("rejects image/svg+xml with CONVERSATION_UNSUPPORTED_FILE_TYPE even when the model is image-capable", () => {
    const result = validateConversationPayload({
      modelId: "test-chat",
      modelCapabilities: registry(baseCapability({ supportsImageInput: true })),
      attachments: [{ kind: "image", mimeType: "image/svg+xml", sizeBytes: 1024 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CONVERSATION_UNSUPPORTED_FILE_TYPE");
    }
  });

  it("rejects image/svg with CONVERSATION_UNSUPPORTED_FILE_TYPE even when the model is image-capable", () => {
    const result = validateConversationPayload({
      modelId: "test-chat",
      modelCapabilities: registry(baseCapability({ supportsImageInput: true })),
      attachments: [{ kind: "image", mimeType: "image/svg", sizeBytes: 1024 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CONVERSATION_UNSUPPORTED_FILE_TYPE");
    }
  });

  it("rejects an image attachment whose mime is not image/* even when the model is image-capable", () => {
    const result = validateConversationPayload({
      modelId: "test-chat",
      modelCapabilities: registry(baseCapability({ supportsImageInput: true })),
      attachments: [{ kind: "image", mimeType: "application/pdf", sizeBytes: 1024 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CONVERSATION_UNSUPPORTED_FILE_TYPE");
    }
  });

  it("rejects a document attachment whose mime is application/octet-stream", () => {
    const result = validateConversationPayload({
      modelId: "test-chat",
      modelCapabilities: registry(baseCapability({ supportsDocumentInput: true })),
      attachments: [{ kind: "document", mimeType: "application/octet-stream", sizeBytes: 1024 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CONVERSATION_UNSUPPORTED_FILE_TYPE");
    }
  });

  it("rejects an attachment larger than 8 MiB with CONVERSATION_OVERSIZED_CONTEXT", () => {
    const result = validateConversationPayload({
      modelId: "test-chat",
      modelCapabilities: registry(baseCapability({ supportsDocumentInput: true })),
      attachments: [{ kind: "document", mimeType: "text/plain", sizeBytes: 9 * 1024 * 1024 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CONVERSATION_OVERSIZED_CONTEXT");
    }
  });

  it("rejects an aggregate documentContext payload larger than 256 KiB", () => {
    // Two entries whose extractedBytes sum exceeds the budget.
    const oversize = MAX_AGGREGATE_DOCUMENT_BYTES;
    const result = validateConversationPayload({
      modelId: "test-chat",
      modelCapabilities: registry(baseCapability()),
      documentContext: [
        {
          id: "a",
          displayName: "a.txt",
          mimeType: "text/plain",
          sizeBytes: oversize,
          extractedBytes: Math.floor(oversize / 2) + 10,
          truncated: false,
          text: "",
        },
        {
          id: "b",
          displayName: "b.txt",
          mimeType: "text/plain",
          sizeBytes: oversize,
          extractedBytes: Math.floor(oversize / 2) + 10,
          truncated: false,
          text: "",
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CONVERSATION_OVERSIZED_CONTEXT");
    }
  });

  it("rejects under-reported extractedBytes that hide an oversize text payload", () => {
    // Caller claims a tiny extractedBytes (100) but ships a 300 KiB text blob — server must
    // measure the actual UTF-8 length and reject. Without the MAX(declared, measured) guard
    // the aggregate (100) sails under the 256 KiB budget while 300 KiB of text reaches the
    // model prompt.
    const oversizeText = "a".repeat(300 * 1024);
    const result = validateConversationPayload({
      modelId: "test-chat",
      modelCapabilities: registry(baseCapability()),
      documentContext: [
        {
          id: "a",
          displayName: "a.txt",
          mimeType: "text/plain",
          sizeBytes: 100,
          extractedBytes: 100,
          truncated: false,
          text: oversizeText,
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("CONVERSATION_OVERSIZED_CONTEXT");
    }
  });

  it("accepts an honest document context whose declared and actual byte counts agree", () => {
    const text = "okay";
    const result = validateConversationPayload({
      modelId: "test-chat",
      modelCapabilities: registry(baseCapability()),
      documentContext: [
        {
          id: "a",
          displayName: "a.txt",
          mimeType: "text/plain",
          sizeBytes: text.length,
          extractedBytes: Buffer.byteLength(text, "utf8"),
          truncated: false,
          text,
        },
      ],
    });
    expect(result).toEqual({ ok: true });
  });

  it("never echoes a caller-supplied model id, file name, or byte count in any error message", () => {
    // Exercise every failure path with deliberately distinctive caller-supplied values and
    // assert none of them leak into any returned message. This is the privacy contract:
    // the BFF renders these messages verbatim into the browser, so a leak would surface a
    // model id or filename a different tenant should never see.
    const oversize = 9 * 1024 * 1024;
    const probes = [
      // Unknown model id
      {
        input: {
          modelId: SECRET_MODEL_ID,
          modelCapabilities: registry(baseCapability()),
        },
      },
      // Unsupported modality (image)
      {
        input: {
          modelId: "test-chat",
          modelCapabilities: registry(baseCapability()),
          attachments: [{ kind: "image" as const, mimeType: "image/png", sizeBytes: 10 }],
        },
      },
      // Unsupported file type
      {
        input: {
          modelId: "test-chat",
          modelCapabilities: registry(baseCapability({ supportsDocumentInput: true })),
          attachments: [
            { kind: "document" as const, mimeType: "application/octet-stream", sizeBytes: 10 },
          ],
        },
      },
      // Oversize single attachment
      {
        input: {
          modelId: "test-chat",
          modelCapabilities: registry(baseCapability({ supportsDocumentInput: true })),
          attachments: [{ kind: "document" as const, mimeType: "text/plain", sizeBytes: oversize }],
        },
      },
      // Oversize aggregate document context
      {
        input: {
          modelId: "test-chat",
          modelCapabilities: registry(baseCapability()),
          documentContext: [
            {
              id: "x",
              displayName: SECRET_FILE_NAME,
              mimeType: "text/plain",
              sizeBytes: MAX_AGGREGATE_DOCUMENT_BYTES + 1,
              extractedBytes: MAX_AGGREGATE_DOCUMENT_BYTES + 1,
              truncated: false,
              text: "",
            },
          ],
        },
      },
    ];
    for (const probe of probes) {
      const result = validateConversationPayload(probe.input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).not.toContain(SECRET_MODEL_ID);
        expect(result.message).not.toContain(SECRET_FILE_NAME);
        expect(result.message).not.toContain(String(oversize));
        expect(result.message).not.toContain(String(MAX_AGGREGATE_DOCUMENT_BYTES + 1));
        // Bytes-count digits like "9437184" should not appear; assert no long digit runs.
        expect(/\d{4,}/.test(result.message)).toBe(false);
      }
    }
  });

  it("is a pure function — repeated calls with the same input yield the same result and never mutate inputs", () => {
    const caps = registry(baseCapability({ supportsImageInput: true }));
    const attachments = Object.freeze([
      Object.freeze({ kind: "image" as const, mimeType: "image/png", sizeBytes: 1024 }),
    ]);
    const docs = Object.freeze([
      Object.freeze({
        id: "x",
        displayName: "x.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        extractedBytes: 4,
        truncated: false,
        text: "okay",
      }),
    ]);
    const input = {
      modelId: "test-chat",
      modelCapabilities: caps,
      attachments,
      documentContext: docs,
    } as const;
    const first = validateConversationPayload(input);
    const second = validateConversationPayload(input);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
  });
});
