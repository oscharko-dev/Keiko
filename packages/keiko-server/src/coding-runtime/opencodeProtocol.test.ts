import { describe, expect, it } from "vitest";

import {
  OPENCODE_APPROVED_ENDPOINTS,
  createOpenCodeSseDecoder,
  parseOpenCodeHistory,
  parseOpenCodeSse,
  validateOpenCodeHealth,
} from "./opencodeProtocol.js";

describe("OpenCode v1.17.17 protocol boundary", () => {
  it("accepts only the settled HTTP endpoint allowlist", () => {
    expect(OPENCODE_APPROVED_ENDPOINTS).toContain("POST /sync/history");
    expect(OPENCODE_APPROVED_ENDPOINTS).not.toContain("POST /sync/replay");
  });

  it("fails closed on health schema drift", () => {
    expect(validateOpenCodeHealth({ healthy: true, version: "1.17.17" })).toEqual({
      ok: true,
      value: { healthy: true, version: "1.17.17" },
    });
    expect(validateOpenCodeHealth({ healthy: true, version: "1.17.17", extra: true })).toEqual({
      ok: false,
      reason: "schema-invalid",
    });
  });

  it("frames bounded SSE messages and rejects unknown fields", () => {
    expect(
      parseOpenCodeSse(
        'id: evt_1\nevent: message\ndata: {"type":"session.idle","properties":{"sessionID":"ses_1"}}\n\n',
      ),
    ).toEqual({
      ok: true,
      value: [
        {
          id: "evt_1",
          event: "message",
          data: { type: "session.idle", properties: { sessionID: "ses_1" } },
        },
      ],
    });
    expect(parseOpenCodeSse("retry: 100\n\n")).toEqual({ ok: false, reason: "frame-invalid" });
  });

  it("accepts multiline data across partial chunks and bounds an incomplete frame", () => {
    const decoder = createOpenCodeSseDecoder();
    expect(decoder.push('data: {"type":"session.idle",\n')).toEqual({ ok: true, value: [] });
    expect(decoder.push('data: "properties":{"sessionID":"ses_1"}}\n\n')).toMatchObject({
      ok: true,
      value: [{ data: { type: "session.idle" } }],
    });
    expect(createOpenCodeSseDecoder(4).push("data:")).toEqual({
      ok: false,
      reason: "frame-oversized",
    });
  });

  it("maps only exact-key safe and critical event projections", () => {
    expect(
      parseOpenCodeHistory([
        {
          id: "evt_1",
          aggregate_id: "ses_1",
          seq: 0,
          type: "session.idle",
          data: { sessionID: "ses_1" },
        },
      ]),
    ).toMatchObject({ ok: true, value: [{ kind: "terminal", aggregateId: "ses_1", sequence: 0 }] });
    expect(
      parseOpenCodeHistory([
        { id: "evt_2", aggregate_id: "ses_1", seq: 1, type: "unknown.critical", data: {} },
      ]),
    ).toEqual({ ok: false, reason: "event-unknown" });
  });
});
