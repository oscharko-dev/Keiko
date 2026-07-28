import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
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

  it("turns bare gateway timeout codes into an actionable chat error", () => {
    expect(formatUserError(new ApiError("GATEWAY_TIMEOUT", "GATEWAY_TIMEOUT", 503), "Retry")).toBe(
      "The model gateway timed out before the model returned a response. (GATEWAY_TIMEOUT)",
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

  it("adds gateway timeout title and remediation for structured notices", () => {
    const notice = toUserErrorNotice(
      new ApiError("GATEWAY_TIMEOUT", "GATEWAY_TIMEOUT", 503),
      "Could not send message.",
    );

    expect(notice).toEqual({
      title: "Model gateway timed out",
      message: "The model gateway timed out before the model returned a response.",
      code: "GATEWAY_TIMEOUT",
      remediation:
        "Retry. If it repeats, use a smaller prompt or another model, then check gateway URL, proxy, and deployment in Settings.",
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
});
