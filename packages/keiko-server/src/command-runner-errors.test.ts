// GEN-DUP-NEAR-008 — CommandRunnerError now derives its HTTP status through the shared
// CodedHttpError mechanism (contracts). This coverage pins that the status per code is UNCHANGED
// by the refactor: the per-domain STATUS_MAP still drives every mapping, and the class remains an
// instanceof Error / CodedHttpError with the concrete subclass name.

import { describe, expect, it } from "vitest";
import { CodedHttpError } from "@oscharko-dev/keiko-contracts";
import {
  COMMAND_RUNNER_ERROR_CODES,
  CommandRunnerError,
  type CommandRunnerErrorCode,
} from "./command-runner-errors.js";

const EXPECTED_STATUS: Readonly<Record<CommandRunnerErrorCode, number>> = {
  PROJECT_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  TASK_REQUIRES_TRUST: 403,
  EVIDENCE_WRITE_FAILED: 500,
  RUN_LIMIT_EXCEEDED: 429,
  RUN_NOT_FOUND: 404,
  BAD_REQUEST: 400,
  PAYLOAD_TOO_LARGE: 413,
  COMMAND_RUNNER_UNAVAILABLE: 503,
  INTERNAL: 500,
};

describe("CommandRunnerError (GEN-DUP-NEAR-008)", () => {
  it("derives the documented HTTP status for every code", () => {
    for (const code of Object.values(COMMAND_RUNNER_ERROR_CODES)) {
      expect(new CommandRunnerError(code, "m").status).toBe(EXPECTED_STATUS[code]);
    }
  });

  it("maps PROJECT_NOT_FOUND to 404 and RUN_LIMIT_EXCEEDED to 429", () => {
    expect(new CommandRunnerError("PROJECT_NOT_FOUND", "gone").status).toBe(404);
    expect(new CommandRunnerError("RUN_LIMIT_EXCEEDED", "too many").status).toBe(429);
  });

  it("exposes the concrete code and message", () => {
    const err = new CommandRunnerError("TASK_REQUIRES_TRUST", "nope");
    expect(err.code).toBe("TASK_REQUIRES_TRUST");
    expect(err.message).toBe("nope");
  });

  it("is an instanceof Error and CodedHttpError with the concrete subclass name", () => {
    const err = new CommandRunnerError("INTERNAL", "boom");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CodedHttpError);
    expect(err.name).toBe("CommandRunnerError");
  });
});
