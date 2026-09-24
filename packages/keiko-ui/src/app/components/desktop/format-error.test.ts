import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import {
  I18N_STORAGE_KEY,
  loadLocaleMessages,
  resetLoadedMessageCatalogs,
  translate,
} from "@/lib/i18n";
import { formatUserError, toUserErrorNotice } from "./format-error";

describe("formatUserError", () => {
  it("keeps user-facing API messages first while preserving the support code", () => {
    expect(
      formatUserError(new ApiError("GATEWAY_UPSTREAM_FAILURE", "Model timed out", 502), "Retry"),
    ).toBe("Model timed out (GATEWAY_UPSTREAM_FAILURE)");
  });

  it("uses the caller fallback when an API error has no human message", () => {
    expect(formatUserError(new ApiError("INTERNAL", "  ", 500), "Could not send message")).toBe(
      "Could not send message (INTERNAL)",
    );
  });

  // #3591: the wording applies to EVERY GATEWAY_TIMEOUT, not only a bare/empty raw message — a
  // slow gateway is not a broken gateway, and the customer-facing text must say so consistently
  // instead of surfacing whatever the provider's own timeout message happened to be.
  it("turns gateway timeout codes into an actionable chat error that never blames prompt size", () => {
    const formatted = formatUserError(
      new ApiError("GATEWAY_TIMEOUT", "request for 'x' timed out while reading stream", 503),
      "Retry",
    );
    expect(formatted).toBe(
      "The model gateway did not complete the request within Keiko's wait limit. Keiko keeps waiting for minutes on a slow gateway, so this usually means the gateway or the model stalled — not that the request was too large. (GATEWAY_TIMEOUT)",
    );
    expect(formatted.toLowerCase()).not.toContain("prompt");
  });

  it("maps a provider output-budget exhaustion to its own actionable chat error", () => {
    expect(
      formatUserError(
        new ApiError(
          "GATEWAY_OUTPUT_EXHAUSTED",
          "provider exhausted the output budget for 'x' before producing any content",
          200,
        ),
        "Retry",
      ),
    ).toBe(
      "The model used its whole output budget before producing an answer, usually on reasoning. Have the gateway declare a larger max_output_tokens for this model, or choose a model with a smaller reasoning share, then retry. (GATEWAY_OUTPUT_EXHAUSTED)",
    );
  });

  it("does not expose raw unknown values to alert regions", () => {
    expect(formatUserError({ code: "INTERNAL" }, "Something went wrong")).toBe(
      "Something went wrong",
    );
  });

  it("normalizes broad connected-source errors into actionable notice fields", () => {
    const notice = toUserErrorNotice(
      new ApiError(
        "BAD_REQUEST",
        "Your question is too broad to search the connected sources.",
        400,
      ),
      "Could not send message.",
    );

    expect(notice).toEqual({
      title: "Narrow the connected-source question",
      message: "Your question is too broad to search the connected sources.",
      code: "BAD_REQUEST",
      remediation:
        "Ask about a specific file, folder, symbol, identifier, or exact phrase. For broad questions over large project folders, narrow the Files scope first.",
    });
  });

  it("renders clarification responses as conversation guidance instead of broad request failures", () => {
    const notice = toUserErrorNotice(
      new ApiError(
        "CLARIFICATION_NEEDED",
        "Keiko braucht mehr Kontext, um die verbundenen Quellen gezielt zu durchsuchen.",
        400,
      ),
      "Could not send message.",
    );

    expect(notice).toEqual({
      title: "Keiko braucht mehr Kontext",
      message: "Keiko braucht mehr Kontext, um die verbundenen Quellen gezielt zu durchsuchen.",
      code: "CLARIFICATION_NEEDED",
      remediation:
        "Nenne eine konkrete Datei, einen Identifier, eine Fehlermeldung oder eine exakte Phrase.",
    });
  });

  // PR #3602 review: title, message AND remediation of a gateway notice follow the selected locale
  // together; a German notice must not carry an English recovery instruction.
  it("localizes the whole gateway notice for the selected locale", async () => {
    await loadLocaleMessages("de");
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    try {
      for (const code of ["GATEWAY_TIMEOUT", "GATEWAY_OUTPUT_EXHAUSTED"] as const) {
        const notice = toUserErrorNotice(new ApiError(code, code, 503), "Could not send message.");
        const key = code === "GATEWAY_TIMEOUT" ? "gatewayTimeout" : "gatewayOutputExhausted";
        expect(notice.title).toBe(translate("de", `chat.error.${key}.title`));
        expect(notice.message).toBe(translate("de", `chat.error.${key}.message`));
        expect(notice.remediation).toBe(translate("de", `chat.error.${key}.remediation`));
        expect(notice.remediation).not.toBe(translate("en", `chat.error.${key}.remediation`));
      }
    } finally {
      window.localStorage.removeItem(I18N_STORAGE_KEY);
      resetLoadedMessageCatalogs();
    }
  });

  it("adds gateway timeout title and remediation for structured notices", () => {
    const notice = toUserErrorNotice(
      new ApiError("GATEWAY_TIMEOUT", "GATEWAY_TIMEOUT", 503),
      "Could not send message.",
    );

    expect(notice).toEqual({
      title: "Model gateway did not answer in time",
      message:
        "The model gateway did not complete the request within Keiko's wait limit. Keiko keeps waiting for minutes on a slow gateway, so this usually means the gateway or the model stalled — not that the request was too large.",
      code: "GATEWAY_TIMEOUT",
      remediation:
        "Retry, or check gateway URL, proxy, and deployment in Settings if it keeps happening.",
    });
  });

  it("adds output-exhausted title and remediation for structured notices", () => {
    const notice = toUserErrorNotice(
      new ApiError(
        "GATEWAY_OUTPUT_EXHAUSTED",
        "provider exhausted the output budget for 'x' before producing any content",
        200,
      ),
      "Could not send message.",
    );

    expect(notice).toEqual({
      title: "Model ran out of output budget",
      message:
        "The model used its whole output budget before producing an answer, usually on reasoning. Have the gateway declare a larger max_output_tokens for this model, or choose a model with a smaller reasoning share, then retry.",
      code: "GATEWAY_OUTPUT_EXHAUSTED",
      remediation:
        "Raise the model's max output tokens in Settings, or switch to a model with a smaller reasoning share, then retry.",
    });
  });

  it("parses the trailing support code from formatted error strings", () => {
    expect(toUserErrorNotice("Gateway returned 502. (GATEWAY_UPSTREAM_FAILURE)", "Retry")).toEqual({
      title: "Request failed",
      message: "Gateway returned 502.",
      code: "GATEWAY_UPSTREAM_FAILURE",
      remediation: undefined,
    });
  });

  it("redacts common credential-shaped strings before formatting", () => {
    const raw = new Error("Gateway failed with Bearer sk-test-1234567890ABCDEFGH");
    expect(formatUserError(raw, "Retry")).toBe("Gateway failed with [REDACTED]");
  });

  it("redacts the full ASCII credential alphabet used by bearer and GitHub tokens", () => {
    const raw = new Error("Bearer Az09._~+/=-Az09; gho_Az09_Az09_Az09; ghp_09Za_09Za_09Za");
    expect(formatUserError(raw, "Retry")).toBe("[REDACTED]; [REDACTED]; [REDACTED]");
  });

  it.each(["=", "/", ".", "+", "-", "~"])("redacts bearer tokens ending with %s", (suffix) => {
    const raw = new Error(`Bearer Az09Az09Az09${suffix}`);
    expect(formatUserError(raw, "Retry")).toBe("[REDACTED]");
  });

  it("captures a plain Error's message when it is not wrapped in ApiError", () => {
    expect(toUserErrorNotice(new Error("boom"), "Retry")).toEqual({
      title: "Something went wrong",
      message: "boom",
      code: undefined,
      remediation: undefined,
    });
  });

  it("falls back to the caller's default when the thrown value is neither a string nor an Error", () => {
    expect(toUserErrorNotice({ unexpected: true }, "Could not send message.")).toEqual({
      title: "Something went wrong",
      message: "Could not send message.",
      code: undefined,
      remediation: undefined,
    });
  });

  // RB-6 / ADR-0173 D5 — the correlation id gains its own structured field and a matching trailing
  // segment in the formatted string, so the round trip every desktop chat error surface already
  // uses (formatUserError -> setError(string) -> toUserErrorNotice) does not silently drop it.
  it("appends a support id segment to the formatted string when the ApiError carries one", () => {
    const error = new ApiError("GATEWAY_UPSTREAM_FAILURE", "Model timed out", 502);
    error.correlationId = "req-a1b2c3d4";
    expect(formatUserError(error, "Retry")).toBe(
      "Model timed out (GATEWAY_UPSTREAM_FAILURE) [correlationId:req-a1b2c3d4]",
    );
  });

  it("omits the support id segment when the ApiError carries none", () => {
    expect(
      formatUserError(new ApiError("GATEWAY_UPSTREAM_FAILURE", "Model timed out", 502), "Retry"),
    ).toBe("Model timed out (GATEWAY_UPSTREAM_FAILURE)");
  });

  it("puts the ApiError's correlationId directly on the structured notice", () => {
    const error = new ApiError("GATEWAY_TIMEOUT", "GATEWAY_TIMEOUT", 503);
    error.correlationId = "req-timeout-9999";
    expect(toUserErrorNotice(error, "Could not send message.").correlationId).toBe(
      "req-timeout-9999",
    );
  });

  it("leaves correlationId undefined on the structured notice when the ApiError carries none", () => {
    const notice = toUserErrorNotice(
      new ApiError("GATEWAY_TIMEOUT", "GATEWAY_TIMEOUT", 503),
      "Could not send message.",
    );
    expect(notice.correlationId).toBeUndefined();
  });

  it("recovers the correlationId and the trailing code from a formatUserError round trip", () => {
    const error = new ApiError("GATEWAY_UPSTREAM_FAILURE", "Model timed out", 502);
    error.correlationId = "req-roundtrip-0007";
    const formatted = formatUserError(error, "Retry");

    const notice = toUserErrorNotice(formatted, "Retry");
    expect(notice.message).toBe("Model timed out");
    expect(notice.code).toBe("GATEWAY_UPSTREAM_FAILURE");
    expect(notice.correlationId).toBe("req-roundtrip-0007");
  });

  it("does not mistake an unrelated trailing bracket for a support id segment", () => {
    const notice = toUserErrorNotice("Path not found [some/other/note]", "Retry");
    expect(notice.correlationId).toBeUndefined();
    expect(notice.message).toBe("Path not found [some/other/note]");
  });

  it("stays fast against an adversarial message with no trailing support code (S8786)", () => {
    // The former `/\s+\(([A-Z][A-Z0-9_/-]{2,})\)\s*$/` has an unanchored leading `\s+`, so a long
    // internal whitespace run that never reaches a "(CODE)" suffix drove O(n²) backtracking
    // (empirically ~530ms at 32,000 chars pre-fix on this machine). Non-space start/end characters
    // keep `toUserErrorNotice`'s own `.trim()` from shrinking the string before it is parsed. The
    // manual character scan is O(n).
    const adversarial = `Error: ${" ".repeat(20_000)}!`;
    const start = Date.now();
    const notice = toUserErrorNotice(adversarial, "Retry");
    expect(Date.now() - start).toBeLessThan(1500);
    expect(notice.code).toBeUndefined();
  });

  // #3241 review — the trailing "[correlationId:...]" segment is peeled off with plain string
  // search (extractTrailingSupportId), not a validating parser: it accepts whatever sits between
  // the prefix and the final "]". These cases pin that malformed/hostile input is never silently
  // dropped — either the value is extracted verbatim, or (when extraction can't apply cleanly) the
  // raw text stays fully visible in notice.message instead of vanishing.
  it("keeps an empty support id suffix fully visible instead of silently dropping it", () => {
    const notice = toUserErrorNotice(
      "Model timed out (GATEWAY_UPSTREAM_FAILURE) [correlationId:]",
      "Retry",
    );
    expect(notice.correlationId).toBeUndefined();
    expect(notice.message).toBe("Model timed out (GATEWAY_UPSTREAM_FAILURE) [correlationId:]");
  });

  it("accepts an oversized (>128 char) correlation id without truncating it", () => {
    const longId = "a".repeat(200);
    const notice = toUserErrorNotice(
      `Model timed out (CODE_XYZ) [correlationId:${longId}]`,
      "Retry",
    );
    expect(notice.correlationId).toBe(longId);
    expect(notice.correlationId).toHaveLength(200);
    expect(notice.message).toBe("Model timed out");
    expect(notice.code).toBe("CODE_XYZ");
  });

  it("uses the last of two repeated support id suffixes and keeps the first one visible in the message", () => {
    const notice = toUserErrorNotice(
      "Model timed out (GATEWAY_UPSTREAM_FAILURE) [correlationId:req-first] [correlationId:req-second]",
      "Retry",
    );
    expect(notice.correlationId).toBe("req-second");
    expect(notice.message).toBe(
      "Model timed out (GATEWAY_UPSTREAM_FAILURE) [correlationId:req-first]",
    );
  });

  it("carries a CRLF-hostile correlation id through verbatim without corrupting the message", () => {
    const hostileId = "req-1\r\nX-Injected: evil";
    const notice = toUserErrorNotice(
      `Model timed out (CODE_XYZ) [correlationId:${hostileId}]`,
      "Retry",
    );
    expect(notice.correlationId).toBe(hostileId);
    expect(notice.message).toBe("Model timed out");
    expect(notice.code).toBe("CODE_XYZ");
  });

  it("carries an HTML-hostile correlation id through verbatim without corrupting the message", () => {
    const hostileId = "<script>alert(1)</script>";
    const notice = toUserErrorNotice(
      `Model timed out (CODE_XYZ) [correlationId:${hostileId}]`,
      "Retry",
    );
    expect(notice.correlationId).toBe(hostileId);
    expect(notice.message).toBe("Model timed out");
    expect(notice.code).toBe("CODE_XYZ");
  });

  it("does not crash on a correlation id value that itself embeds a second support id prefix, and keeps the leftover text visible", () => {
    const notice = toUserErrorNotice(
      "Model timed out (CODE) [correlationId:evil[correlationId:nested]]",
      "Retry",
    );
    expect(notice.correlationId).toBe("nested]");
    expect(notice.message).toBe("Model timed out (CODE) [correlationId:evil");
  });

  it("does not treat a literal 'Support ID:' label in the message text as the internal correlation id marker", () => {
    const notice = toUserErrorNotice(
      "Model timed out (GATEWAY_UPSTREAM_FAILURE) Support ID: req-visible-999",
      "Retry",
    );
    expect(notice.correlationId).toBeUndefined();
    expect(notice.message).toBe(
      "Model timed out (GATEWAY_UPSTREAM_FAILURE) Support ID: req-visible-999",
    );
  });
});
