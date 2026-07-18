import { describe, expect, it } from "vitest";

import {
  CODING_APP_SESSION_CHANNEL_BODY_MAX_CHARS,
  CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION,
  CODING_APP_SESSION_CHANNEL_KIND_MAX_CHARS,
  CODING_APP_SESSION_CHANNEL_MAX_UTF8_BYTES,
  codingAppSessionAcknowledgement,
  contentFreeCodingAppSessionChannelSnapshot,
  validateCodingAppSessionChannelContent,
  validateCodingAppSessionChannelSnapshot,
} from "./channelContract.js";

describe("contentFreeCodingAppSessionChannelSnapshot", () => {
  it("is the fail-closed content-free shape and validates", () => {
    const snapshot = contentFreeCodingAppSessionChannelSnapshot();
    expect(snapshot).toEqual({
      schemaVersion: CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION,
      content: null,
    });
    expect(validateCodingAppSessionChannelSnapshot(snapshot).ok).toBe(true);
  });

  it("is byte-identical for repeated calls so unpaired and empty-paired reads cannot be told apart", () => {
    expect(JSON.stringify(contentFreeCodingAppSessionChannelSnapshot())).toBe(
      JSON.stringify(contentFreeCodingAppSessionChannelSnapshot()),
    );
  });
});

describe("codingAppSessionAcknowledgement", () => {
  it("carries only the schema version, never bearer material", () => {
    expect(codingAppSessionAcknowledgement()).toEqual({
      schemaVersion: CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION,
    });
  });
});

describe("validateCodingAppSessionChannelSnapshot", () => {
  const content = { kind: "probe", body: "bounded" } as const;

  it("accepts a bounded content snapshot", () => {
    const result = validateCodingAppSessionChannelSnapshot({
      schemaVersion: CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION,
      content,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a non-object", () => {
    for (const value of [null, undefined, "x", 7, []]) {
      expect(validateCodingAppSessionChannelSnapshot(value).ok).toBe(false);
    }
  });

  it("rejects an unknown schema version", () => {
    expect(validateCodingAppSessionChannelSnapshot({ schemaVersion: "2", content: null }).ok).toBe(
      false,
    );
  });

  it("rejects unexpected top-level keys", () => {
    expect(
      validateCodingAppSessionChannelSnapshot({
        schemaVersion: CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION,
        content: null,
        extra: 1,
      }).ok,
    ).toBe(false);
  });

  it("rejects a non-null, non-object content value", () => {
    for (const bad of ["string", 7, []]) {
      expect(
        validateCodingAppSessionChannelSnapshot({
          schemaVersion: CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION,
          content: bad,
        }).ok,
      ).toBe(false);
    }
  });

  it("rejects unexpected content keys", () => {
    expect(
      validateCodingAppSessionChannelSnapshot({
        schemaVersion: CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION,
        content: { ...content, extra: 1 },
      }).ok,
    ).toBe(false);
  });

  it("rejects an empty body", () => {
    expect(
      validateCodingAppSessionChannelSnapshot({
        schemaVersion: CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION,
        content: { kind: "probe", body: "" },
      }).ok,
    ).toBe(false);
  });

  it("rejects a body over the character budget", () => {
    expect(
      validateCodingAppSessionChannelSnapshot({
        schemaVersion: CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION,
        content: { kind: "probe", body: "a".repeat(CODING_APP_SESSION_CHANNEL_BODY_MAX_CHARS + 1) },
      }).ok,
    ).toBe(false);
  });

  it("rejects a kind over the character budget", () => {
    expect(
      validateCodingAppSessionChannelSnapshot({
        schemaVersion: CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION,
        content: { kind: "k".repeat(CODING_APP_SESSION_CHANNEL_KIND_MAX_CHARS + 1), body: "b" },
      }).ok,
    ).toBe(false);
  });

  it("stays valid for legal multi-byte content and does not spuriously trip the aggregate guard", () => {
    const body = "ä".repeat(CODING_APP_SESSION_CHANNEL_BODY_MAX_CHARS); // 2 UTF-8 bytes per char
    const result = validateCodingAppSessionChannelSnapshot({
      schemaVersion: CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION,
      content: { kind: "probe", body },
    });
    expect(result.ok).toBe(true);
    expect(new TextEncoder().encode(body).length).toBeLessThan(
      CODING_APP_SESSION_CHANNEL_MAX_UTF8_BYTES,
    );
  });
});

describe("validateCodingAppSessionChannelContent", () => {
  it("accepts a bounded item and rejects malformed ones", () => {
    expect(validateCodingAppSessionChannelContent({ kind: "probe", body: "ok" }).ok).toBe(true);
    expect(validateCodingAppSessionChannelContent({ kind: "probe", body: "" }).ok).toBe(false);
    expect(validateCodingAppSessionChannelContent({ kind: "", body: "ok" }).ok).toBe(false);
    expect(validateCodingAppSessionChannelContent("nope").ok).toBe(false);
    expect(validateCodingAppSessionChannelContent({ kind: "probe" }).ok).toBe(false);
  });
});
