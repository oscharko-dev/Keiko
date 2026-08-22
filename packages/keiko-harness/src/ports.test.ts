// Compile-time pin for the ModelPort request widening (ADR-0173 D5). `ModelPort.call` and
// `callStream` were widened from the wire-only `GatewayRequest` to `GatewayCallRequest`, which
// adds exactly one OPTIONAL field (`logContext`, the caller's correlation context). Because the
// added field is optional, `GatewayRequest` and `GatewayCallRequest` are mutually assignable —
// that mutual assignability is precisely what makes the widening backward-compatible, and the
// first two cases below are where a future change that turns `logContext` (or any new field)
// required would be caught: the `toExtend` assertions would stop compiling.
//
// These are type-level assertions only (`expectTypeOf` performs no runtime check); the observable
// proof is `tsc`, not `vitest run`. The THIRD case is the one that actually moves with the
// widening: `request` there is deliberately left UNANNOTATED so its type is inferred from the
// `ModelPort` contextual type, exactly as a real port implementation is written. Before the
// widening, `ModelPort.call`'s inferred `request` type was `GatewayRequest`, which has no
// `logContext` field, so `request.logContext` was a `TS2339` compile error — verified by reverting
// `ports.ts` locally and rerunning this file through `tsc`.
//
// The FOURTH case pins the reverse and more important property for this task: an implementation
// written before the widening, whose `call` is explicitly typed against the narrower
// `GatewayRequest`, must keep satisfying `ModelPort` with zero edits — this is what lets every
// OTHER `ModelPort` implementation in the repository stay untouched.

import { describe, expectTypeOf, it } from "vitest";
import type {
  GatewayCallRequest,
  GatewayRequest,
  GatewayStreamChunk,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "./ports.js";

function response(): NormalizedResponse {
  return {
    modelId: "m",
    content: "ok",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: { requestId: "r", promptTokens: 1, completionTokens: 1, latencyMs: 1, costClass: "low" },
  };
}

describe("ModelPort request type (ADR-0173 D5)", () => {
  it("a plain GatewayRequest is assignable where a GatewayCallRequest is expected", () => {
    // Every existing caller building a plain GatewayRequest (no logContext) keeps compiling
    // against the widened ModelPort/ChatModel parameter type unchanged.
    expectTypeOf<GatewayRequest>().toExtend<GatewayCallRequest>();
  });

  it("a GatewayCallRequest is assignable back to the narrower GatewayRequest shape", () => {
    // The reverse direction: code still typed against GatewayRequest (e.g. Gateway.chat's own
    // wire-contract parameter) accepts a GatewayCallRequest value without a cast.
    expectTypeOf<GatewayCallRequest>().toExtend<GatewayRequest>();
  });

  it("a ModelPort implementation's request parameter is inferred wide enough to carry logContext", () => {
    const port: ModelPort = {
      // `request` is intentionally unannotated: its type comes from ModelPort's own declared
      // parameter type via contextual typing, so this line only compiles when that declared type
      // is (or includes) GatewayCallRequest.
      call: (request, _signal) => {
        const correlationId: string | undefined = request.logContext?.correlationId;
        void correlationId;
        return Promise.resolve(response());
      },
      // Never actually invoked: this generator exists only so the type checker infers
      // `request`'s type from ModelPort.callStream's contextual type, same as `call` above.
      // eslint-disable-next-line @typescript-eslint/require-await
      callStream: async function* (request, _signal): AsyncGenerator<GatewayStreamChunk> {
        void request.logContext?.correlationId;
        yield { type: "delta", token: "" };
      },
    };
    expectTypeOf(port).toExtend<ModelPort>();
  });

  it("a ModelPort implementation typed against the narrower GatewayRequest still satisfies ModelPort", () => {
    // Pins backward compatibility: an implementation written before the widening, whose `call`
    // signature only names `GatewayRequest`, remains a valid ModelPort without edits — this is
    // the property the spec relies on to leave every OTHER ModelPort implementation untouched.
    const narrowPort: {
      call: (request: GatewayRequest, signal: AbortSignal) => Promise<NormalizedResponse>;
    } = {
      call: (request: GatewayRequest): Promise<NormalizedResponse> =>
        Promise.resolve({ ...response(), modelId: request.modelId }),
    };
    const port: ModelPort = narrowPort;
    expectTypeOf(port).toExtend<ModelPort>();
  });
});
