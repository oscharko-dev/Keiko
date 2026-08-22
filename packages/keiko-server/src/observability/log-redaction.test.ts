import { describe, expect, it } from "vitest";

import { DECLARED_ERROR_CLASS_SHAPE } from "./error-classification.js";
import {
  DROPPED_DEPTH,
  DROPPED_LENGTH,
  MAX_LOG_ARRAY_LENGTH,
  MAX_LOG_FIELD_COUNT,
  MAX_LOG_STRING_LENGTH,
  REDACTED_KEY,
  REDACTED_LENGTH,
  REDACTED_PATH,
  REDACTED_PERSONAL,
  REDACTED_SECRET,
  REDACTED_SHAPE,
  closeReasonVocabulary,
  isDeniedLogFieldName,
  normalizeLogFieldName,
  OPAQUE_TOKEN_RUN_LENGTH,
  redactLogFields,
  redactLogString,
} from "./log-redaction.js";

// Credential-shaped fixtures are ASSEMBLED at runtime, never written as literals. A literal here
// is a genuine finding for the repository secret scanner, and silencing that scanner to keep a
// test fixture would trade a security gate for convenience. Concatenation leaves the value under
// test byte-identical while the source file contains no scannable credential.
const OPENAI_PROJECT_KEY = ["sk", "proj", "abcdef0123456789"].join("-");
const GITHUB_PAT = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
const SLACK_BOT_TOKEN = ["xoxb", "1234", "5678", "abcdef"].join("-");
const JSON_WEB_TOKEN = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "abcdef"].join(".");
const AWS_ACCESS_KEY_ID = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

describe("log field redaction", () => {
  it("keeps the evidence fields the instrumentation surface is built from", () => {
    const fields = redactLogFields({
      endpoint: "https://gateway.internal:8443",
      modelId: "text-embedding-3-large",
      jobId: "job-1f2e3d",
      inputCount: 36,
      inputBytes: 48_120,
      timeoutMs: 30_000,
      durationMs: 19_412.25,
      httpStatus: 500,
      errorKind: "http-error",
      partialCount: 0,
      force: false,
      reasons: ["source-hash-changed", "parser-version-changed"],
    });

    expect(fields).toStrictEqual({
      endpoint: "https://gateway.internal:8443",
      modelId: "text-embedding-3-large",
      jobId: "job-1f2e3d",
      inputCount: 36,
      inputBytes: 48_120,
      timeoutMs: 30_000,
      durationMs: 19_412.25,
      httpStatus: 500,
      errorKind: "http-error",
      partialCount: 0,
      force: false,
      reasons: ["source-hash-changed", "parser-version-changed"],
    });
  });

  it("keeps a hashed identifier, which is the value that replaces the raw one", () => {
    const digest = "a".repeat(64);
    const fields = redactLogFields({ documentIdHash: digest, capsuleIdDigest: "9f2c1b0e" });
    expect(fields).toStrictEqual({ documentIdHash: digest, capsuleIdDigest: "9f2c1b0e" });
  });

  it("matches denied names as whole names, never as substrings", () => {
    expect(isDeniedLogFieldName("prompt")).toBe(true);
    expect(isDeniedLogFieldName("api_key")).toBe(true);
    expect(isDeniedLogFieldName("API-KEY")).toBe(true);
    // Neighbouring evidence fields that merely contain a denied word must keep working.
    expect(isDeniedLogFieldName("promptTokens")).toBe(false);
    expect(isDeniedLogFieldName("promptVersion")).toBe(false);
    expect(isDeniedLogFieldName("strategyKey")).toBe(false);
    expect(isDeniedLogFieldName("keySource")).toBe(false);
    expect(isDeniedLogFieldName("requestBytes")).toBe(false);
    expect(isDeniedLogFieldName("probeName")).toBe(false);
    expect(isDeniedLogFieldName("envVarName")).toBe(false);
    expect(normalizeLogFieldName("Access-Token")).toBe("accesstoken");
  });

  it("drops a field whose name is not an identifier", () => {
    expect(redactLogFields({ "not a name": "x", "9lives": "y", ok: "z" })).toStrictEqual({
      ok: "z",
    });
  });

  it("never lets an extra field spoof the identity of a line", () => {
    // ts/level/category/op are what every operator query keys on and are reserved outright, and
    // envelope v2 (#2902) adds the process/sequence identity to that reserved set: schemaVersion,
    // pid, instanceId and seq are stamped once by the sink itself, so an `extra.pid`/`extra.seq`/
    // `extra.schemaVersion`/`extra.instanceId` planted by a caller (or by a hostile value merged
    // into `extra`) must be dropped before the real identity is ever applied — never merely
    // overridden by it, which would still leave the spoofed key in the record if the real value
    // were absent. status is not reserved — an instrumentation site legitimately carries it as a
    // field, and the formatter applies the envelope after `extra` so an explicit envelope value
    // still wins.
    expect(
      redactLogFields({
        ts: "1970",
        level: "debug",
        category: "http",
        op: "spoof",
        schemaVersion: 999,
        pid: 1,
        instanceId: "deadbeef",
        seq: 999_999,
        status: 200,
        keep: 1,
      }),
    ).toStrictEqual({ status: 200, keep: 1 });
  });

  it("replaces an over-long string instead of truncating it", () => {
    const long = "x".repeat(MAX_LOG_STRING_LENGTH + 1);
    expect(redactLogString(long)).toBe(REDACTED_LENGTH);
    // A truncated prompt is still a leaked prompt: no prefix of the input may survive.
    expect(redactLogString(long)).not.toContain("x");
  });

  it("refuses a string that reads as prose or carries a control character", () => {
    expect(redactLogString("Summarize the following contract clause")).toBe(REDACTED_SHAPE);
    expect(redactLogString("line one\nline two")).toBe(REDACTED_SHAPE);
    expect(redactLogString("has\ttab")).toBe(REDACTED_SHAPE);
    // Up to a few spaces stay legible for the rare two-word code.
    expect(redactLogString("connection refused")).toBe("connection refused");
  });

  it("refuses credential-shaped values whatever they are called", () => {
    expect(redactLogString(OPENAI_PROJECT_KEY)).toBe(REDACTED_SECRET);
    expect(redactLogString(GITHUB_PAT)).toBe(REDACTED_SECRET);
    expect(redactLogString(SLACK_BOT_TOKEN)).toBe(REDACTED_SECRET);
    expect(redactLogString(JSON_WEB_TOKEN)).toBe(REDACTED_SECRET);
    expect(redactLogString("Bearer abcdef")).toBe(REDACTED_SECRET);
    expect(redactLogString(AWS_ACCESS_KEY_ID)).toBe(REDACTED_SECRET);
    expect(redactLogString("https://user:hunter2@gateway.internal/v1")).toBe(REDACTED_SECRET);
    expect(redactLogString("https://host/v1?api_key=abc")).toBe(REDACTED_SECRET);
    expect(redactLogString("password=hunter2")).toBe(REDACTED_SECRET);
  });

  // Requirement 4, the direction that must keep working: a real opaque token is caught anywhere in
  // the value, not only when it is the whole value.
  it("refuses a high-entropy opaque token, anchored or embedded", () => {
    // Generated, never a literal. A high-entropy value written into a `token = "…"` assignment is
    // a genuine `generic-api-key` finding for the repository secret scanner, and the scanner is
    // right to fire on it — the shape is indistinguishable from a real credential, which is exactly
    // why it makes a good fixture. Building the same characters at runtime keeps the guard under
    // test unchanged and leaves nothing scannable in the source.
    const token = ["Kd8Zq2Lm5Rt9", "Wx3Yb6Nc1Vf4", "Hj7Pg0Sa2Dk5", "Qe8Uz"].join("");
    expect(token.length).toBeGreaterThanOrEqual(OPAQUE_TOKEN_RUN_LENGTH);
    expect(redactLogString(token)).toBe(REDACTED_SECRET);
    expect(redactLogString(`session=${token}`)).toBe(REDACTED_SECRET);
  });

  // Requirement 4, the direction that was broken: the guard accepted ANY 40+ character run drawn
  // from `[A-Za-z0-9+/_=-]`, and `/` is in that alphabet because base64 uses it. So an ordinary
  // request path of 40 characters or more was reported as a leaked credential — which is how the
  // most useful field on the HTTP request line disappeared for exactly the deep API routes an
  // operator needs during an incident — while a short customer-named route passed untouched.
  it("keeps an ordinary long string that carries no entropy", () => {
    const deepRoute = "/api/local-knowledge/capsules/finance/sources/handbook/root";
    expect(deepRoute.length).toBeGreaterThan(OPAQUE_TOKEN_RUN_LENGTH);
    expect(redactLogString(deepRoute)).not.toBe(REDACTED_SECRET);
    // A single case of a single alphabet is not a credential, however long it is.
    expect(redactLogString("Y".repeat(48))).toBe("Y".repeat(48));
    expect(redactLogString("a".repeat(50))).toBe("a".repeat(50));
    expect(redactLogString("f".repeat(40))).toBe("f".repeat(40));
    // A sha-256 digest is the evidence that REPLACES a raw value; it must survive.
    expect(redactLogString("9f".repeat(32))).toBe("9f".repeat(32));
    // A long kebab identifier is not a credential either.
    const slug = "regenerate-stale-capsule-index-for-workspace-handbook";
    expect(redactLogString(slug)).toBe(slug);
  });

  it("refuses an absolute filesystem path, which is never inside the workspace root", () => {
    expect(redactLogString("/Users/someone/Documents/report.pdf")).toBe(REDACTED_PATH);
    expect(redactLogString("/home/runner/work/keiko")).toBe(REDACTED_PATH);
    expect(redactLogString("~/secrets.env")).toBe(REDACTED_PATH);
    expect(redactLogString("C:\\Users\\someone\\file.txt")).toBe(REDACTED_PATH);
    expect(redactLogString("file:///etc/passwd")).toBe(REDACTED_PATH);
    // A URL route is not a filesystem path and stays readable — every segment of this one is a
    // literal in the declared route table.
    expect(redactLogString("/api/voice/control")).toBe("/api/voice/control");
  });

  // Requirement 1. The path guard used to hand back ANY absolute value whose first segment named a
  // web route — `api`, `_next`, `health`, … — which made a fail-closed detector fail OPEN across
  // the entire API surface. That surface is where the customer-chosen identifiers live: capsule
  // ids, source ids and project ids are values a customer typed. One GET therefore wrote the
  // customer's own name for their Knowledge Pod to disk in clear, in the file whose whole contract
  // is that it carries counts, hashes and statuses.
  it("elides a customer-chosen identifier out of a request path", () => {
    const reduced = redactLogString("/api/local-knowledge/capsules/Acme-Q3-Financials/index");
    expect(reduced).not.toContain("Acme");
    expect(reduced).not.toContain("Financials");
    // The route itself stays readable: only the parameter position is elided. It is elided, not
    // digested — a per-value token for a customer identifier is reversible by brute force, and the
    // join key an operator greps is the correlation id every line of a run carries.
    expect(reduced).toBe("/api/local-knowledge/capsules/{id}/index");
  });

  it("refuses an absolute value whose first segment is not a declared route", () => {
    expect(redactLogString("/wp-admin/setup.php")).toBe(REDACTED_PATH);
    expect(redactLogString("/api/../../etc/passwd")).toBe(REDACTED_PATH);
  });

  // The guard used to be an allowlist of first segments, so it answered only the roots someone had
  // thought of: a path under any other root, and EVERY relative path, serialised verbatim — and a
  // relative path is what a repository-relative or capsule-relative producer naturally logs.
  it("refuses a path structurally, including roots no allowlist would have listed", () => {
    expect(redactLogString("/Volumes/External/customer-alpha")).toBe(REDACTED_PATH);
    expect(redactLogString("/data/keiko/state")).toBe(REDACTED_PATH);
    expect(redactLogString("/nix/store/keiko")).toBe(REDACTED_PATH);
  });

  it("refuses a relative path, which no first-segment rule can recognise", () => {
    expect(redactLogString("../../etc/passwd")).toBe(REDACTED_PATH);
    expect(redactLogString("./workspace/notes.md")).toBe(REDACTED_PATH);
    expect(redactLogString("packages/keiko-server/src/store.ts")).toBe(REDACTED_PATH);
    expect(redactLogString("logs/server.log")).toBe(REDACTED_PATH);
    expect(redactLogString("workspace\\keiko\\state.db")).toBe(REDACTED_PATH);
  });

  it("keeps the separator-bearing values that are not paths", () => {
    // A media type, a namespaced model id and an endpoint all carry a separator and none of them
    // is a filesystem path. A versioned identifier is not a file extension either.
    expect(redactLogString("text/plain")).toBe("text/plain");
    expect(redactLogString("openai/gpt-4.1")).toBe("openai/gpt-4.1");
    expect(redactLogString("https://api.openai.com")).toBe("https://api.openai.com");
    expect(redactLogString("https://gateway.internal:8443")).toBe("https://gateway.internal:8443");
  });

  // Requirement 2. The prose guard counted ASCII spaces (0x20), which is a rule about ONE script.
  // Japanese, Chinese, Thai and Khmer separate nothing at all, and an HTML extractor emits NBSP
  // where a space belongs — so the normal output of PDF and HTML extraction, the exact content
  // this log exists to keep out, passed every layer verbatim.
  it("refuses document text in a script that does not separate words with spaces", () => {
    const documentSamples = [
      // Japanese, Chinese, Korean: no spaces anywhere.
      "これは抽出された文書のテキストです",
      "患者记录第三次就诊的详细内容",
      "환자의 세 번째 방문 기록입니다",
      // Thai and Khmer: no spaces, and no word boundaries at all.
      "ข้อความที่แยกจากเอกสารของผู้ป่วย",
      "អត្ថបទដកស្រង់ពីឯកសាររបស់អ្នកជំងឺ",
      // Cyrillic, Arabic, Hebrew, Devanagari.
      "Выписка из истории болезни",
      "سجل المريض في الزيارة الثالثة",
      "רשומת המטופל מהביקור השלישי",
      "रोगी का तीसरा दौरा",
      // Latin text separated by NBSP rather than by ASCII space.
      "The\u00a0patient\u00a0was\u00a0seen\u00a0on\u00a0the\u00a0third\u00a0visit",
    ];
    for (const sample of documentSamples) {
      // Every sample is far under the length cap, so the length guard cannot be what stops it.
      expect(sample.length).toBeLessThanOrEqual(MAX_LOG_STRING_LENGTH);
      expect(redactLogString(sample)).toBe(REDACTED_SHAPE);
    }
  });

  it("refuses non-Latin document text under an invented field name, at any nesting", () => {
    const fields = redactLogFields({
      stage: "これは抽出された文書のテキストです",
      context: { inner: ["ข้อความที่แยกจากเอกสาร"] },
    });
    expect(JSON.stringify(fields)).not.toContain("これ");
    expect(JSON.stringify(fields)).not.toContain("ข้อความ");
    expect(fields).toStrictEqual({ stage: REDACTED_SHAPE, context: { inner: [REDACTED_SHAPE] } });
  });

  // Requirement 3. `email` was on the name denylist, and a name denylist is exactly the rule the
  // value layer exists to backstop — the caller picks the name.
  it("refuses a personal identifier whatever the field is called", () => {
    expect(redactLogString("jane.doe@example.com")).toBe(REDACTED_PERSONAL);
    expect(redactLogString("mailto:jane.doe@example.com")).toBe(REDACTED_PERSONAL);
    expect(redactLogString("+1 (415) 555-0142")).toBe(REDACTED_PERSONAL);
    expect(redactLogString("078-05-1120")).toBe(REDACTED_PERSONAL);
    const fields = redactLogFields({ contact: "jane.doe@example.com", owner: "j.doe@keiko.dev" });
    expect(fields).toStrictEqual({ contact: REDACTED_PERSONAL, owner: REDACTED_PERSONAL });
    expect(JSON.stringify(fields)).not.toContain("example.com");
  });

  it("keeps the identifier-shaped values a personal-data rule must not eat", () => {
    expect(redactLogString("node@24")).toBe("node@24");
    expect(redactLogString("a".repeat(64))).toBe("a".repeat(64));
    expect(redactLogString("http-error")).toBe("http-error");
    expect(redactLogString("2026-08-21")).toBe("2026-08-21");
  });

  it("drops every value type that is not a string, finite number, boolean, array or plain object", () => {
    class Custom {
      public readonly note = "internal";
    }
    const fields = redactLogFields({
      error: new Error("upstream said: the patient record is ..."),
      buffer: Buffer.from("document bytes"),
      map: new Map([["k", "v"]]),
      set: new Set(["v"]),
      fn: (): string => "v",
      big: 10n,
      nan: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
      nothing: null,
      missing: undefined,
      instance: new Custom(),
      survivor: 1,
    });

    // `error` is caught by the name denylist before its type is even considered; every other
    // entry is dropped purely because its type is not on the allowlist.
    expect(fields).toStrictEqual({ error: REDACTED_KEY, survivor: 1 });
  });

  it("bounds nesting depth", () => {
    // MAX_LOG_FIELD_DEPTH nested objects below `extra` survive; the next one down does not.
    expect(redactLogFields({ a: { b: { c: 1 } } })).toStrictEqual({ a: { b: { c: 1 } } });
    expect(redactLogFields({ a: { b: { c: { d: { e: 1 } } } } })).toStrictEqual({
      a: { b: { c: { d: DROPPED_DEPTH } } },
    });
  });

  function widthListOf(length: number): Record<string, unknown> {
    return { list: Array.from({ length }, (_unused, index) => index) };
  }

  // The marker CONSUMES A SLOT, so the configured cap holds EXACTLY: MAX_LOG_ARRAY_LENGTH - 1 real
  // elements survive, plus one bounded marker proving the bound actually fired —
  // MAX_LOG_ARRAY_LENGTH total, never MAX_LOG_ARRAY_LENGTH + 1. A reconstructing agent can still
  // tell a truncated list from one that genuinely only had that many entries (the marker), and a
  // consumer that enforces the documented cap on array length no longer sees it exceeded by one
  // every time truncation actually fires.
  it("reserves one array slot for the truncation marker, so the length cap holds exactly", () => {
    const wide = redactLogFields(widthListOf(MAX_LOG_ARRAY_LENGTH + 5));
    expect(wide?.list).toHaveLength(MAX_LOG_ARRAY_LENGTH);
    expect((wide?.list as unknown[]).slice(0, MAX_LOG_ARRAY_LENGTH - 1)).toStrictEqual(
      Array.from({ length: MAX_LOG_ARRAY_LENGTH - 1 }, (_unused, index) => index),
    );
    expect((wide?.list as unknown[]).at(-1)).toBe(DROPPED_LENGTH);
  });

  it("holds the array cap exactly one element over the limit, not one under it", () => {
    // One element over the cap is the boundary the reserved slot exists for: still exactly
    // MAX_LOG_ARRAY_LENGTH total, not MAX_LOG_ARRAY_LENGTH + 1.
    const oneOver = redactLogFields(widthListOf(MAX_LOG_ARRAY_LENGTH + 1));
    expect(oneOver?.list).toHaveLength(MAX_LOG_ARRAY_LENGTH);
    expect((oneOver?.list as unknown[]).at(-1)).toBe(DROPPED_LENGTH);
  });

  it("passes an array exactly at the length cap through whole, with no marker", () => {
    // Exactly MAX_LOG_ARRAY_LENGTH elements is not a truncation: nothing was dropped, so the whole
    // array passes through with no marker and no slot reserved.
    const exact = redactLogFields(widthListOf(MAX_LOG_ARRAY_LENGTH));
    expect(exact?.list).toHaveLength(MAX_LOG_ARRAY_LENGTH);
    expect((exact?.list as unknown[]).at(-1)).not.toBe(DROPPED_LENGTH);
  });

  function fieldsOf(count: number): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    for (let index = 0; index < count; index += 1) {
      fields[`f${String(index)}`] = index;
    }
    return fields;
  }

  it("reserves one field slot for the truncation marker, so the field-count cap holds exactly", () => {
    // The marker CONSUMES A SLOT here too: MAX_LOG_FIELD_COUNT - 1 accepted fields, plus one
    // synthetic key proving the field-count bound fired — MAX_LOG_FIELD_COUNT keys total, never
    // MAX_LOG_FIELD_COUNT + 1.
    const truncated = redactLogFields(fieldsOf(MAX_LOG_FIELD_COUNT + 10)) ?? {};
    expect(Object.keys(truncated)).toHaveLength(MAX_LOG_FIELD_COUNT);
    expect(truncated._truncatedFieldCount).toBe(true);
  });

  it("holds the field-count cap exactly one field over the limit, not one under it", () => {
    // One field over the cap is the boundary the reserved slot exists for: still exactly
    // MAX_LOG_FIELD_COUNT keys total, not MAX_LOG_FIELD_COUNT + 1.
    const oneOverFields = redactLogFields(fieldsOf(MAX_LOG_FIELD_COUNT + 1)) ?? {};
    expect(Object.keys(oneOverFields)).toHaveLength(MAX_LOG_FIELD_COUNT);
    expect(oneOverFields._truncatedFieldCount).toBe(true);
  });

  it("passes an object exactly at the field-count cap through whole, with no marker", () => {
    // Exactly MAX_LOG_FIELD_COUNT fields is not a truncation: every field was accepted, so no
    // synthetic key is added and no slot is reserved.
    const notTruncated = redactLogFields(fieldsOf(MAX_LOG_FIELD_COUNT)) ?? {};
    expect(Object.keys(notTruncated)).toHaveLength(MAX_LOG_FIELD_COUNT);
    expect(notTruncated._truncatedFieldCount).toBeUndefined();
  });

  it("counts only eligible fields toward the cap, never a reserved or invalid name at the boundary", () => {
    // Regression: the cap check used to run BEFORE the reserved-name and pattern filters, so an
    // ineligible key sitting right at the boundary consumed the last counted slot, dropped a real
    // accepted field, and reported a truncation that never actually happened.
    const lastValidKey = `f${String(MAX_LOG_FIELD_COUNT - 1)}`;
    const withReservedTail = { ...fieldsOf(MAX_LOG_FIELD_COUNT), seq: 999 };
    const reservedResult = redactLogFields(withReservedTail) ?? {};
    expect(Object.keys(reservedResult)).toHaveLength(MAX_LOG_FIELD_COUNT);
    expect(reservedResult._truncatedFieldCount).toBeUndefined();
    // The last accepted field must have survived, not been evicted to make room for `seq`.
    expect(reservedResult[lastValidKey]).toBe(MAX_LOG_FIELD_COUNT - 1);
    expect(reservedResult.seq).toBeUndefined();

    const withInvalidTail = { ...fieldsOf(MAX_LOG_FIELD_COUNT), "bad name!": 1 };
    const invalidResult = redactLogFields(withInvalidTail) ?? {};
    expect(Object.keys(invalidResult)).toHaveLength(MAX_LOG_FIELD_COUNT);
    expect(invalidResult._truncatedFieldCount).toBeUndefined();
    expect(invalidResult[lastValidKey]).toBe(MAX_LOG_FIELD_COUNT - 1);
  });

  it("yields no fields for a non-object, an array or an empty object", () => {
    expect(redactLogFields(undefined)).toBeUndefined();
    expect(redactLogFields(null)).toBeUndefined();
    expect(redactLogFields("body text")).toBeUndefined();
    expect(redactLogFields([1, 2, 3])).toBeUndefined();
    expect(redactLogFields({})).toBeUndefined();
  });

  // This module used to also export `redactEndpointUrl`, documented as "the canonical form of the
  // `endpoint` field" — with no production caller anywhere, while two packages that DO log an
  // endpoint each shipped their own reducer (`logEndpointHost` in keiko-model-gateway,
  // `embeddingEndpointHost` in keiko-local-knowledge). Three implementations of one rule, one of
  // them dead, is how the three drift apart: the dead one is the one nobody notices is wrong. The
  // two live reducers are package-local BECAUSE they must be — ADR-0019 forbids a domain package
  // from importing the server — so the dead third was deleted rather than made canonical.
  it("does not ship a third, callerless endpoint reducer", async () => {
    const module: Record<string, unknown> = await import("./log-redaction.js");
    expect(Object.keys(module)).not.toContain("redactEndpointUrl");
  });
});

// The dedicated proof for requirement 3: `extra` is a caller-controlled channel, and the guarantee
// is that no arrangement of it can put a body, a prompt, a document or a credential into the log.
// Each entry below is a distinct smuggling route — honest name, invented name, nested, inside an
// array, inside an object type that serialises its payload, and over-long — and the assertion is
// on the SERIALISED output, so a value that survived anywhere fails the test.
//
// Scope, stated honestly: the guarantee is over CONTENT SHAPES (prose, markup/JSON, control
// characters, credential formats, filesystem paths, over-long strings), not over arbitrary short
// opaque tokens. A caller who base64-encodes a body into a 20-character identifier defeats any
// redactor, and no policy that still admits `errorCode: "INVALID_CAPSULE_PLAN"` can distinguish
// the two. Everything a real body, prompt, document or key actually looks like is covered.
describe("redaction cannot be defeated through extra", () => {
  const PROMPT = "You are a helpful assistant. Summarize the attached contract for the reviewer.";
  const BODY = '{"patient":"Jane Doe","diagnosis":"acute","notes":"seen on the third visit"}';
  const API_KEY = ["sk", "proj", "LEAKEDAPIKEY0123456789"].join("-");
  const BEARER = "Bearer LEAKEDBEARERTOKEN";
  const FILE_PATH = "/Users/someone/Documents/confidential.pdf";

  const HOSTILE_EXTRA: Readonly<Record<string, unknown>> = {
    // 1. Honestly named content and credentials.
    prompt: PROMPT,
    body: BODY,
    apiKey: API_KEY,
    authorization: BEARER,
    // 2. The same values under invented, innocent-looking names the denylist cannot know.
    stage: PROMPT,
    detail: API_KEY,
    hint: BEARER,
    sourceFile: FILE_PATH,
    marker: BODY,
    // 3. Buried inside nested objects and arrays.
    context: { inner: { deeper: API_KEY } },
    samples: [BODY, { anything: PROMPT }],
    // 4. Smuggled inside object types that serialise their payload.
    thrown: new Error(BODY),
    bytes: Buffer.from(BODY),
    // 5. A very long document, which must be replaced rather than truncated.
    trace: `Jane Doe ${"was seen on the third visit. ".repeat(20)}`,
  };

  it("emits no fragment of any hostile value", () => {
    const serialized = JSON.stringify(redactLogFields(HOSTILE_EXTRA));
    for (const secret of [PROMPT, BODY, API_KEY, BEARER, FILE_PATH]) {
      expect(serialized).not.toContain(secret);
    }
    // Not even a prefix: these are replacements, never truncations.
    expect(serialized).not.toContain("Jane Doe");
    expect(serialized).not.toContain("diagnosis");
    expect(serialized).not.toContain("helpful assistant");
    expect(serialized).not.toContain("sk-proj-");
    expect(serialized).not.toContain("LEAKED");
    expect(serialized).not.toContain("/Users/");
  });

  it("still records that a field was refused, so the refusal is itself evidence", () => {
    const fields = redactLogFields(HOSTILE_EXTRA) ?? {};
    expect(fields.prompt).toBe(REDACTED_KEY);
    expect(fields.stage).toBe(REDACTED_SHAPE);
    expect(fields.marker).toBe(REDACTED_SHAPE);
    expect(fields.detail).toBe(REDACTED_SECRET);
    expect(fields.sourceFile).toBe(REDACTED_PATH);
    expect(fields.trace).toBe(REDACTED_LENGTH);
    // Unsupported types leave no trace at all rather than a marker.
    expect(fields.bytes).toBeUndefined();
    expect(fields.thrown).toBeUndefined();
  });
});

// closeReasonVocabulary generalises the same "structural, not caller discipline" guard
// KNOWN_CATEGORIES/readCategory already give categories to any closed-vocabulary array field
// (#2902 g33) — a producer's own type is a compile-time promise, not a runtime one, so the log
// layer closes the vocabulary again at the point that writes the value.
describe("closeReasonVocabulary", () => {
  const VOCAB = new Set(["chat", "embedding", "not-chat-capable"]);

  it("passes a recognised value through unchanged", () => {
    expect(closeReasonVocabulary(VOCAB, "chat", "unrecognised-mode")).toBe("chat");
    expect(closeReasonVocabulary(VOCAB, "not-chat-capable", "unrecognised-mode")).toBe(
      "not-chat-capable",
    );
  });

  it("collapses anything outside the vocabulary to the caller's fallback", () => {
    expect(closeReasonVocabulary(VOCAB, "vendor-private-mode", "unrecognised-mode")).toBe(
      "unrecognised-mode",
    );
    // A short, space-free, credential-free string is exactly what would otherwise sail through
    // every generic value guard untouched — this closure is the only thing that stops it.
    expect(closeReasonVocabulary(VOCAB, "REALTIME", "unrecognised-mode")).toBe("unrecognised-mode");
    expect(closeReasonVocabulary(VOCAB, "", "unrecognised-mode")).toBe("unrecognised-mode");
  });
});

describe("email guard fail-open regression", () => {
  // A guard that inspects only the first `@` gives up on the first bad candidate and lets the
  // real address behind it through. Every one of these carries a decoy before the address.
  it.each([
    "x@ jane.doe@example.com",
    "@@ contact@corp.internal",
    "not-an-email@ then owner@sub.domain.co",
  ])("redacts an address that is not the first @-candidate: %s", (value) => {
    // Asserting on the SECURITY property, not on which guard fired: whichever layer catches it,
    // the address must not survive into the log.
    const redacted = redactLogString(value);
    expect(redacted).not.toContain("@");
    expect(redacted.startsWith("[redacted:")).toBe(true);
  });

  it("still passes a value whose only @ has no domain", () => {
    expect(redactLogString("queue@")).toBe("queue@");
  });
});

describe("embedded personal identifiers", () => {
  // Anchoring the phone pattern to the whole string let a number inside a larger value through,
  // and its digit run is far below the opaque-token length, so no other guard sees it.
  it.each(["tel:+14155550142", "reach me on +1 415 555 0142 tomorrow", "x+4915112345678"])(
    "redacts an embedded telephone number: %s",
    (value) => {
      expect(redactLogString(value).startsWith("[redacted:")).toBe(true);
    },
  );

  it("leaves an ordinary short identifier alone", () => {
    expect(redactLogString("cap-2f9c7a")).toBe("cap-2f9c7a");
  });
});

// The `frames`/`causeChain` field-name-keyed guard (ADR-0173 D4): defense-in-depth for two fields
// whose exact machine-generated shape this module knows well enough to re-validate structurally,
// at the single point named in the header comment ("TWO NAMED ESCAPE HATCHES") — never relying on
// the fact that a well-formed frame string already happens to slip past the generic prose/path
// guards for reasons that have nothing to do with this guard existing.
describe("frames field guard (ADR-0173 D4)", () => {
  const VALID_DIST_FRAME = "packages/keiko-server/dist/observability/server-log.js:128:18";
  const VALID_SRC_FRAME = "packages/keiko-server/src/observability/server-log.ts:42:9";
  const VALID_ROOT_BIN_DIST_FRAME = "dist/cli/index.js:5:1";
  const VALID_ROOT_BIN_SRC_FRAME = "src/cli/index.ts:5:1";

  it("passes well-formed frames through completely untouched", () => {
    const frames = [
      VALID_DIST_FRAME,
      VALID_SRC_FRAME,
      VALID_ROOT_BIN_DIST_FRAME,
      VALID_ROOT_BIN_SRC_FRAME,
    ];

    expect(redactLogFields({ frames })).toStrictEqual({ frames });
  });

  it.each([
    ["an absolute path", `/Users/someone/app/${VALID_DIST_FRAME}`],
    ["a node_modules path", "node_modules/some-lib/index.js:10:4"],
    ["a frame naming a non-existent package", "packages/keiko-nonexistent/dist/foo.js:1:1"],
    ["a traversal segment", "packages/keiko-server/dist/../secrets/foo.js:1:1"],
    ["a space inside the relative part", "packages/keiko-server/dist/server log.js:1:1"],
    ["a 200-character relative part", `packages/keiko-server/dist/${"a".repeat(200)}.js:1:1`],
    ["an embedded email address", "packages/keiko-server/dist/jane.doe@example.com.js:1:1"],
  ])("drops %s entirely, never a marker in its place", (_label, badFrame) => {
    expect(redactLogFields({ frames: [badFrame] })).toBeUndefined();
    // Mixed with a good frame, only the non-conforming one is dropped — the good one is untouched.
    expect(redactLogFields({ frames: [VALID_DIST_FRAME, badFrame] })).toStrictEqual({
      frames: [VALID_DIST_FRAME],
    });
  });

  it("caps at 8 conforming frames, dropping a 9th", () => {
    const nineFrames = Array.from(
      { length: 9 },
      (_, index) => `packages/keiko-server/dist/observability/server-log.js:${String(index + 1)}:1`,
    );

    const fields = redactLogFields({ frames: nineFrames });

    expect(fields?.frames).toStrictEqual(nineFrames.slice(0, 8));
  });

  it("does not extend the guard to a frames field nested under another object", () => {
    const bogus = "packages/keiko-nonexistent/dist/foo.js:1:1";

    // At the top level the named guard drops the whole array — nothing survives the package check.
    expect(redactLogFields({ frames: [bogus] })).toBeUndefined();
    // One level down, `frames` is just another field name: the generic array/string path applies
    // instead, and this particular string is not itself shaped like a body/prompt/secret/path, so
    // it survives unchanged. The point under test is that a DIFFERENT policy applied — not that
    // this exact string happens to pass.
    expect(redactLogFields({ context: { frames: [bogus] } })).toStrictEqual({
      context: { frames: [bogus] },
    });
  });
});

describe("causeChain field guard (ADR-0173 D4)", () => {
  it("passes well-formed cause-chain classes through untouched", () => {
    const causeChain = ["TransportError", "GatewayError", "AbortError"];
    // Ties the fixture to the production shape rather than a hand-picked guess: every entry this
    // test expects to survive really is one `error-classification.ts`'s own regex accepts.
    for (const entry of causeChain) expect(DECLARED_ERROR_CLASS_SHAPE.test(entry)).toBe(true);
    expect(redactLogFields({ causeChain })).toStrictEqual({ causeChain });
  });

  it.each([
    ["a lowercase-leading entry", "networkError"],
    ["a prose entry", "bad request from client"],
  ])("drops %s, keeping only the conforming entries", (_label, badEntry) => {
    expect(DECLARED_ERROR_CLASS_SHAPE.test(badEntry)).toBe(false);
    expect(redactLogFields({ causeChain: ["TransportError", badEntry] })).toStrictEqual({
      causeChain: ["TransportError"],
    });
  });

  it("omits the field entirely when nothing survives", () => {
    expect(
      redactLogFields({ causeChain: ["networkError", "bad request from client"] }),
    ).toBeUndefined();
  });

  it("caps at 5 conforming classes, dropping a 6th", () => {
    const sixClasses = ["ErrorA", "ErrorB", "ErrorC", "ErrorD", "ErrorE", "ErrorF"];
    const fields = redactLogFields({ causeChain: sixClasses });
    expect(fields?.causeChain).toStrictEqual(sixClasses.slice(0, 5));
  });
});

// The `diagnosticSummary` field-name-keyed guard (ADR-0173 D11 g29): the one field in this schema
// whose legitimate values are prose. Without this hatch a full sentence is indistinguishable from a
// leaked body/prompt fragment to the generic guard, and collapses to `[redacted:shape]` — silently
// discarding the very summary this field exists to carry, even though the value is already safe.
describe("diagnosticSummary field guard (ADR-0173 D11 g29)", () => {
  const ALLOWLISTED_SUMMARY =
    "Provider verification failed without exposing upstream response details.";

  it("passes an allowlisted, prose-shaped summary through untouched", () => {
    expect(redactLogFields({ diagnosticSummary: ALLOWLISTED_SUMMARY })).toStrictEqual({
      diagnosticSummary: ALLOWLISTED_SUMMARY,
    });
  });

  it("still refuses a secret-shaped value under this field name", () => {
    expect(redactLogFields({ diagnosticSummary: OPENAI_PROJECT_KEY })).toStrictEqual({
      diagnosticSummary: REDACTED_SECRET,
    });
  });

  it("still refuses a value carrying an embedded email address under this field name", () => {
    expect(
      redactLogFields({ diagnosticSummary: `contact jane.doe@example.com for details` }),
    ).toStrictEqual({ diagnosticSummary: REDACTED_PERSONAL });
  });

  it("still refuses an oversized value under this field name", () => {
    expect(redactLogFields({ diagnosticSummary: "a".repeat(200) })).toStrictEqual({
      diagnosticSummary: REDACTED_LENGTH,
    });
  });

  it("does not extend the guard to a diagnosticSummary field nested under another object", () => {
    // One level down, `diagnosticSummary` is just another field name: the generic prose guard
    // applies instead, and a full sentence there collapses to `[redacted:shape]` exactly as any
    // other prose-shaped value would under an unrelated field name.
    expect(redactLogFields({ context: { diagnosticSummary: ALLOWLISTED_SUMMARY } })).toStrictEqual({
      context: { diagnosticSummary: REDACTED_SHAPE },
    });
  });
});
