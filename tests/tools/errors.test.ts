import { describe, expect, it } from "vitest";
import {
  CommandCancelledError,
  CommandDeniedError,
  CommandTimeoutError,
  OutputLimitError,
  PatchApplyDisabledError,
  PatchApplyError,
  PatchValidationError,
  TOOL_CODES,
  ToolArgumentError,
  ToolError,
  UnknownToolError,
} from "../../src/tools/errors.js";

describe("tool errors", () => {
  it("redacts the message at construction", () => {
    const token = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"; // split so the literal is not contiguous
    const error = new CommandDeniedError(`leak ${token} here`, "git");
    expect(error.message).not.toContain(token);
    expect(error.message).toContain("[REDACTED]");
  });

  it("redacts caller-supplied additional secrets", () => {
    const error = new CommandDeniedError("contains topsecret value", "git", ["topsecret"]);
    expect(error.message).not.toContain("topsecret");
  });

  it("sets name to the concrete subclass name", () => {
    expect(new ToolArgumentError("m", "t").name).toBe("ToolArgumentError");
    expect(new UnknownToolError("m", "t").name).toBe("UnknownToolError");
    expect(new CommandDeniedError("m", "git").name).toBe("CommandDeniedError");
    expect(new CommandTimeoutError("m", 1).name).toBe("CommandTimeoutError");
    expect(new CommandCancelledError("m").name).toBe("CommandCancelledError");
    expect(new OutputLimitError("m", 1).name).toBe("OutputLimitError");
    expect(new PatchValidationError("m", []).name).toBe("PatchValidationError");
    expect(new PatchApplyDisabledError("m").name).toBe("PatchApplyDisabledError");
    expect(new PatchApplyError("m", "p").name).toBe("PatchApplyError");
  });

  it("carries stable codes", () => {
    expect(new ToolArgumentError("m", "t").code).toBe(TOOL_CODES.ARGUMENT);
    expect(new UnknownToolError("m", "t").code).toBe(TOOL_CODES.UNKNOWN);
    expect(new CommandDeniedError("m", "git").code).toBe(TOOL_CODES.COMMAND_DENIED);
    expect(new CommandTimeoutError("m", 1).code).toBe(TOOL_CODES.COMMAND_TIMEOUT);
    expect(new CommandCancelledError("m").code).toBe(TOOL_CODES.COMMAND_CANCELLED);
    expect(new OutputLimitError("m", 1).code).toBe(TOOL_CODES.OUTPUT_LIMIT);
    expect(new PatchValidationError("m", []).code).toBe(TOOL_CODES.PATCH_INVALID);
    expect(new PatchApplyDisabledError("m").code).toBe(TOOL_CODES.PATCH_APPLY_DISABLED);
    expect(new PatchApplyError("m", "p").code).toBe(TOOL_CODES.PATCH_APPLY_FAILED);
  });

  it("carries useful readonly fields", () => {
    expect(new ToolArgumentError("m", "read_file").toolName).toBe("read_file");
    expect(new UnknownToolError("m", "nope").toolName).toBe("nope");
    expect(new CommandDeniedError("m", "git").executable).toBe("git");
    expect(new CommandTimeoutError("m", 5000).timeoutMs).toBe(5000);
    expect(new OutputLimitError("m", 1024).limitBytes).toBe(1024);
    expect(new PatchApplyError("m", "src/x.ts").path).toBe("src/x.ts");
    const reasons = [{ code: "size-limit" as const, message: "too big" }];
    expect(new PatchValidationError("m", reasons).reasons).toEqual(reasons);
  });

  it("instances are ToolError subclasses and real Errors", () => {
    const error = new CommandDeniedError("m", "git");
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toBeInstanceOf(Error);
  });
});
