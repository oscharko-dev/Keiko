import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  CancelledError,
  CircuitOpenError,
  ConfigInvalidError,
  ContextOverflowError,
  ERROR_CODES,
  GatewayError,
  MalformedToolCallError,
  ModelRefusalError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  TransportError,
  UnknownModelError,
} from "./gateway.js";

describe("error code constants", () => {
  it("maps each name to its stable string code", () => {
    expect(ERROR_CODES.AUTHENTICATION).toBe("GATEWAY_AUTHENTICATION");
    expect(ERROR_CODES.TRANSPORT).toBe("GATEWAY_TRANSPORT");
    expect(ERROR_CODES.MODEL_REFUSAL).toBe("GATEWAY_MODEL_REFUSAL");
    expect(ERROR_CODES.MALFORMED_TOOL_CALL).toBe("GATEWAY_MALFORMED_TOOL_CALL");
    expect(ERROR_CODES.CONTEXT_OVERFLOW).toBe("GATEWAY_CONTEXT_OVERFLOW");
    expect(ERROR_CODES.RATE_LIMIT).toBe("GATEWAY_RATE_LIMIT");
    expect(ERROR_CODES.TIMEOUT).toBe("GATEWAY_TIMEOUT");
    expect(ERROR_CODES.CANCELLED).toBe("GATEWAY_CANCELLED");
    expect(ERROR_CODES.CIRCUIT_OPEN).toBe("GATEWAY_CIRCUIT_OPEN");
    expect(ERROR_CODES.PROVIDER_ERROR).toBe("GATEWAY_PROVIDER_ERROR");
    expect(ERROR_CODES.CONFIG_INVALID).toBe("GATEWAY_CONFIG_INVALID");
    expect(ERROR_CODES.UNKNOWN_MODEL).toBe("GATEWAY_UNKNOWN_MODEL");
  });
});

describe("error subclasses", () => {
  const cases = [
    [new AuthenticationError("a"), ERROR_CODES.AUTHENTICATION, false],
    [new TransportError("a"), ERROR_CODES.TRANSPORT, true],
    [new ModelRefusalError("a"), ERROR_CODES.MODEL_REFUSAL, false],
    [new MalformedToolCallError("a"), ERROR_CODES.MALFORMED_TOOL_CALL, false],
    [new ContextOverflowError("a"), ERROR_CODES.CONTEXT_OVERFLOW, false],
    [new RateLimitError("a"), ERROR_CODES.RATE_LIMIT, true],
    [new TimeoutError("a"), ERROR_CODES.TIMEOUT, true],
    [new CancelledError("a"), ERROR_CODES.CANCELLED, false],
    [new CircuitOpenError("a"), ERROR_CODES.CIRCUIT_OPEN, false],
    [new ProviderError("a", 500), ERROR_CODES.PROVIDER_ERROR, false],
    [new ConfigInvalidError("a"), ERROR_CODES.CONFIG_INVALID, false],
    [new UnknownModelError("a"), ERROR_CODES.UNKNOWN_MODEL, false],
  ] as const;

  it.each(cases)("%s carries the right code and is a GatewayError", (err, code, retryable) => {
    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
    expect(err.name).toBe(err.constructor.name);
  });

  it("RateLimitError.retryAfterMs defaults to null when not provided", () => {
    expect(new RateLimitError("rate").retryAfterMs).toBeNull();
  });

  it("RateLimitError.retryAfterMs carries the supplied value", () => {
    expect(new RateLimitError("rate", 5000).retryAfterMs).toBe(5000);
  });

  it("ProviderError carries the http status", () => {
    expect(new ProviderError("boom", 503).httpStatus).toBe(503);
  });

  it("redacts secrets in the message at construction time", () => {
    const key = ["sk-", "SECRETKEY1234567890abcdef"].join("");
    const err = new AuthenticationError(`auth failed with key ${key}`);
    expect(err.message).not.toContain(key);
    expect(err.message).not.toContain("apiKey");
    expect(err.message).toContain("[REDACTED]");
  });

  it("scrubs caller-supplied secrets from the message", () => {
    const err = new TransportError("connect to https://host?token=opaque-1", ["opaque-1"]);
    expect(err.message).not.toContain("opaque-1");
  });

  it("redacts a provider URL passed as a caller-supplied additional secret (AC #1)", () => {
    // The product treats provider base URLs as private runtime values. When the caller hands the
    // URL to the error as an additional secret, it must NEVER appear in the rendered message — the
    // safe-error contract is what keeps a browser-displayed error from leaking the internal host.
    const providerUrl = "https://internal.corp.example/v1";
    const err = new TransportError(`upstream failure talking to ${providerUrl}`, [providerUrl]);
    expect(err.message).not.toContain(providerUrl);
    expect(err.message).not.toContain("internal.corp.example");
    expect(err.message).toContain("[REDACTED]");
  });
});
