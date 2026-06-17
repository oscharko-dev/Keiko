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
});
