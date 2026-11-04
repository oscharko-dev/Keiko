import {
  CallerAttemptAdmissionError,
  ContextOverflowError,
} from "@oscharko-dev/keiko-model-gateway";
import { describe, expect, it } from "vitest";
import { isGatewayAdmissionRefusal } from "./grounded-gateway-error-status.js";

describe("an optional call's refusal", () => {
  it("is only the caller's own admission refusal", () => {
    expect(isGatewayAdmissionRefusal(new CallerAttemptAdmissionError("refused"))).toBe(true);
    expect(isGatewayAdmissionRefusal(new ContextOverflowError("too long"))).toBe(false);
    expect(isGatewayAdmissionRefusal(new Error("GATEWAY_ATTEMPT_ADMISSION_DENIED"))).toBe(false);
  });
});
