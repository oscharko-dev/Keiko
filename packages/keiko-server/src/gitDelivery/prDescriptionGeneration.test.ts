// Proves the production composition of `PrDescriptionServiceOptions.generation` (#3399 mounts
// #3398's `generatePrDescription`, epic #3384 Frozen Product Decision 8):
//   * No configured model profile composes to `undefined` — the ONE closed reason
//     `prDescriptionRoutes.ts`'s "unavailable" fallback exists for.
//   * A configured profile reuses the SAME cached Gateway instance every other server caller
//     reuses (`gateway-instance-cache.ts`), never a second Gateway.
//   * Branding is derived from the SAME `resolvePrDescriptionBrandingFromConfig` producer #3398
//     built, never restated here.
//   * `errorEvidence` is body-free: dist-anchored frames/cause chain, never the error's own message.
//   * The `pr-description.generation.*` ops fire through the composed path end to end.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultChatCapability,
  parseGatewayConfig,
  PrDescription,
  type GatewayConfig,
} from "@oscharko-dev/keiko-model-gateway";
import {
  gatewayForRuntimeConfig,
  resetGatewayInstanceCacheForTests,
  type RuntimeGatewayConfigSource,
} from "../gateway-instance-cache.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
} from "../observability/index.js";
import { DescriptionFixture } from "./prDescriptionTestSupport.js";
import { createProductionPrDescriptionGeneration } from "./prDescriptionGeneration.js";

function config(): GatewayConfig {
  return parseGatewayConfig({
    providers: [
      {
        modelId: "test-chat",
        baseUrl: "https://gateway.example.com/v1",
        apiKey: "test-token",
      },
    ],
    branding: { logoUrl: `https://cdn.example.org/${"a".repeat(40)}/keiko-logo.svg` },
  });
}

function source(current: GatewayConfig | undefined): RuntimeGatewayConfigSource {
  return { current: () => current, generation: () => 1 };
}

let logs: BufferedServerLogSink;

beforeEach(() => {
  resetGatewayInstanceCacheForTests();
  logs = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink: logs, level: "debug" }));
});
afterEach(() => {
  resetServerLogger();
});

describe("createProductionPrDescriptionGeneration (#3399)", () => {
  it("composes to undefined when no runtime config source is wired at all", () => {
    expect(createProductionPrDescriptionGeneration(undefined)).toBeUndefined();
  });

  it("composes to undefined — a closed reason, not a throw — when no model profile is configured", () => {
    expect(createProductionPrDescriptionGeneration(source(undefined))).toBeUndefined();
  });

  it("reuses the SAME cached Gateway instance every other server caller reuses", () => {
    const cfg = config();
    const runtimeConfig = source(cfg);
    const expectedGateway = gatewayForRuntimeConfig(runtimeConfig);
    const generation = createProductionPrDescriptionGeneration(runtimeConfig);
    expect(generation?.gateway).toBe(expectedGateway);
  });

  it("carries the exact resolved config through, unmodified", () => {
    const cfg = config();
    const generation = createProductionPrDescriptionGeneration(source(cfg));
    expect(generation?.config).toBe(cfg);
  });

  it("derives branding from the SAME producer #3398 built, never a restated formula", () => {
    const cfg = config();
    const generation = createProductionPrDescriptionGeneration(source(cfg));
    expect(generation?.branding).toEqual({
      immutableLogoUrl: cfg.branding?.logoUrl,
      availability: "public",
    });
  });

  it("falls back to no branding fact when the operator configured no logo", () => {
    const raw = config();
    const cfg = parseGatewayConfig({
      providers: raw.providers.map((provider) => ({
        modelId: provider.modelId,
        baseUrl: "https://gateway.example.com/v1",
        apiKey: "test-token",
      })),
    });
    const generation = createProductionPrDescriptionGeneration(source(cfg));
    expect(generation?.branding).toEqual({});
  });

  it("reports body-free, dist-anchored error evidence — never the error's own message", () => {
    const generation = createProductionPrDescriptionGeneration(source(config()));
    const secretMessage = "leaked api key sk-should-never-appear";
    const evidence = generation?.errorEvidence?.(new Error(secretMessage));
    expect(evidence).toBeDefined();
    expect(JSON.stringify(evidence)).not.toContain(secretMessage);
    expect(Array.isArray(evidence?.frames)).toBe(true);
    expect(Array.isArray(evidence?.causeChain)).toBe(true);
  });

  it("emits the pr-description.generation.* ops through the composed log port end to end", () => {
    const generation = createProductionPrDescriptionGeneration(source(config()));
    generation?.log.write({
      category: "gateway",
      op: "pr-description.generation.started",
      extra: {},
    });
    const ops = logs.events.map((event) => event.op);
    expect(ops).toContain("pr-description.generation.started");
  });

  // description-composition-closeout (task 5): drives the COMPOSED production value through the
  // real `generatePrDescription` core (#3398) and a fake Model Gateway HTTP transport, rather than
  // only inspecting the composed object's own fields as the tests above do. Reuses
  // `DescriptionFixture`'s real git-repo-backed snapshot capture for `resolveSnapshot` instead of
  // hand-building a `GitChangeSnapshot` — that digest formula is owned by
  // `gitChangeSnapshotDigestFields`/`GitChangeSnapshotService`, never restated here (AGENTS.md §7).
  it("generates a real description through the production composition and a fake Model Gateway HTTP transport", async () => {
    const cfgWithCapability = parseGatewayConfig({
      providers: [
        {
          modelId: "test-chat",
          baseUrl: "https://gateway.example.com/v1",
          apiKey: "test-token",
        },
      ],
      capabilities: [
        {
          ...createDefaultChatCapability("test-chat"),
          contextWindow: 32_768,
          maxOutputTokens: 2048,
        },
      ],
      branding: { logoUrl: `https://cdn.example.org/${"a".repeat(40)}/keiko-logo.svg` },
    });
    const generation = createProductionPrDescriptionGeneration(source(cfgWithCapability));
    if (generation === undefined) throw new Error("expected a composed generation");
    const fixture = new DescriptionFixture();
    try {
      const captured = await fixture.snapshots.capture({
        workspace: fixture.context.workspace,
        baseRef: fixture.remote.identity.baseSha,
        headRef: fixture.remote.identity.headSha,
        accessScope: fixture.context.accessScope,
        correlationId: fixture.context.correlationId,
      });
      if (captured.reference === undefined) throw new Error("expected a captured snapshot");
      const reference = captured.reference;
      const fetchSpy = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        const rawBody = typeof init?.body === "string" ? init.body : "{}";
        const raw: unknown = JSON.parse(rawBody);
        const serialized = JSON.stringify(raw);
        // The evidence payload is nested one JSON-string level inside the chat request's own
        // "content" field, so a literal `"evidenceId":"..."` key match would need to account for
        // that extra escaping layer -- matching the bare 64-hex-character id anywhere is simpler
        // and just as unambiguous (it is the only such token in this fixture's request).
        const evidenceId = /([a-f0-9]{64})/u.exec(serialized)?.[1] ?? "";
        const statement = { text: "Change the exported value.", evidenceIds: [evidenceId] };
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    summary: [statement],
                    keyChanges: [statement],
                    risks: [],
                    reviewerFocus: [],
                  }),
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetchSpy);
      const result = await PrDescription.generatePrDescription(
        {
          snapshotReference: reference,
          language: "en",
          authority: {
            authorityDigest: fixture.context.authorityDigest,
            correlationId: fixture.context.correlationId,
          },
        },
        {
          ...generation,
          // The fixture's own snapshot capture is stamped with its fixed clock (`fixture.now`);
          // matching it here avoids a spurious `invalid-snapshot` from comparing a captured/expiry
          // timestamp against the real wall clock instead of the clock that produced it.
          now: () => fixture.now,
          resolveSnapshot: (supplied) => {
            if (supplied !== reference) return Promise.resolve(undefined);
            const content = fixture.snapshots.read(
              reference,
              fixture.context.accessScope,
              fixture.context.correlationId,
            );
            return Promise.resolve(
              content === undefined
                ? undefined
                : {
                    snapshot: content.snapshot,
                    evidence: content.files.map((file) => ({
                      evidenceId: file.evidenceId,
                      text: JSON.stringify(file),
                    })),
                  },
            );
          },
        },
      );
      expect(fetchSpy).toHaveBeenCalled();
      expect(result.status).toBe("generated");
      if (result.status !== "generated") throw new Error("expected a generated artifact");
      expect(result.artifact.markdown).toContain("Change the exported value.");
      const ops = logs.events.map((event) => event.op);
      expect(ops.some((op) => op.startsWith("pr-description.generation."))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      fixture.close();
    }
  });
});
