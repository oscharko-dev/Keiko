import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GroundedCitationBehaviour } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  createDefaultChatCapability,
  createDefaultEmbeddingCapability,
  findConfiguredCapability,
  loadConfigFromFile,
  parseGatewayConfig,
  type GatewayConfig,
} from "@oscharko-dev/keiko-model-gateway";
import {
  buildUiHandlerDeps,
  CITATION_BEHAVIOUR_WINDOW_MAX,
  currentConversationReady,
  currentConversationReadinessObservation,
  type UiHandlerDeps,
} from "./deps.js";
import { createProviderSecretResolver } from "./credentialVault.js";
import { rawConfigFromCurrent } from "./gateway-setup.js";
import {
  citationBehaviourFor,
  citationBehaviourObserverFor,
} from "./grounded-citation-capability.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";

const MODEL = "citation-observation-model";
const PROBE_TIME = "2026-10-09T10:00:00.000Z";
const roots: string[] = [];
const disposals: UiHandlerDeps[] = [];

afterEach(async () => {
  resetServerLogger();
  for (const deps of disposals.splice(0)) await deps.dispose?.();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(citationBehaviour?: GroundedCitationBehaviour): GatewayConfig {
  return parseGatewayConfig({
    providers: [
      {
        modelId: MODEL,
        baseUrl: "https://citation.example.invalid/v1",
        apiKey: "private-fixture-key",
      },
    ],
    capabilities: [
      {
        ...createDefaultChatCapability(MODEL),
        ...(citationBehaviour === undefined ? {} : { citationBehaviour }),
      },
    ],
  });
}

function fixture(initial = config()): UiHandlerDeps {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-citation-capability-"));
  roots.push(root);
  const deps = buildUiHandlerDeps({
    configPath: join(root, "gateway.json"),
    evidenceDir: join(root, "evidence"),
    uiDbPath: join(root, "ui.db"),
    env: {},
  });
  disposals.push(deps);
  deps.gatewayConfig?.set(initial, true);
  return deps;
}

function observe(deps: UiHandlerDeps, outcome: GroundedCitationBehaviour): void {
  citationBehaviourObserverFor(deps, MODEL, "citation-observation-correlation")(outcome);
}

function stored(deps: UiHandlerDeps): GroundedCitationBehaviour | undefined {
  const current = deps.gatewayConfig?.current();
  return current === undefined
    ? undefined
    : findConfiguredCapability(current, MODEL)?.citationBehaviour;
}

describe("generation-owned citation observation window", () => {
  it.each(["cites", "cites-after-repair", "never"] as const)(
    "refines and seals actual %s metadata without replacing configuration",
    (outcome) => {
      const deps = fixture();
      const generation = deps.gatewayConfig?.generation();
      observe(deps, outcome);
      expect(stored(deps)).toBe(outcome);
      expect(deps.gatewayConfig?.generation()).toBe(generation);
      const path = deps.gatewayConfig?.storagePath;
      if (path === undefined) throw new Error("expected configuration path");
      const text = readFileSync(path, "utf8");
      expect(text).not.toContain("private-fixture-key");
      expect(text).not.toContain("citationBehaviourWindow");
      const loaded = loadConfigFromFile(
        path,
        {},
        { secretResolver: createProviderSecretResolver({ configPath: path, env: {} }) },
      );
      expect(findConfiguredCapability(loaded, MODEL)?.citationBehaviour).toBe(outcome);
      expect(
        parseGatewayConfig(rawConfigFromCurrent(loaded, undefined)).capabilities?.[0]
          ?.citationBehaviour,
      ).toBe(outcome);
    },
  );

  it("requires three current consistent outcomes for repair-skipping reliability and clears it on regression", () => {
    const deps = fixture();
    observe(deps, "cites");
    observe(deps, "cites");
    expect(citationBehaviourFor(deps, MODEL)).toBeUndefined();
    observe(deps, "cites");
    expect(citationBehaviourFor(deps, MODEL)).toBe("cites");
    observe(deps, "never");
    expect(citationBehaviourFor(deps, MODEL)).toBeUndefined();
    expect(stored(deps)).toBeUndefined();
  });

  it("bounds outcomes in the existing record and preserves probe evidence and readiness time", () => {
    const deps = fixture();
    const holder = deps.gatewayConfig;
    holder?.recordVerifiedCapability(
      MODEL,
      { conversationReady: true, toolCalling: false },
      PROBE_TIME,
      holder.generation(),
      PROBE_TIME,
    );
    observe(deps, "never");
    for (let index = 0; index < CITATION_BEHAVIOUR_WINDOW_MAX; index += 1) observe(deps, "cites");
    expect(holder?.verifiedCapability(MODEL)).toMatchObject({
      checkedAt: PROBE_TIME,
      conversationCheckedAt: PROBE_TIME,
      fields: { conversationReady: true, toolCalling: false },
      citationBehaviourWindow: Array.from({ length: CITATION_BEHAVIOUR_WINDOW_MAX }, () => "cites"),
    });
    expect(citationBehaviourFor(deps, MODEL)).toBe("cites");
  });

  it("retains the citation window across an ordinary probe and unchanged catalog replacement", () => {
    const deps = fixture();
    const holder = deps.gatewayConfig;
    if (holder === undefined) throw new Error("expected configured holder");
    observe(deps, "cites");
    observe(deps, "cites");
    holder.recordVerifiedCapability(MODEL, { toolCalling: false }, PROBE_TIME, holder.generation());
    const current = holder.current();
    if (current === undefined) throw new Error("expected current configuration");
    expect(holder.replaceCatalog?.({ ...current }, holder.generation())).toBe(true);
    observe(deps, "cites");
    expect(citationBehaviourFor(deps, MODEL)).toBe("cites");
    expect(holder.verifiedCapability(MODEL)?.checkedAt).toBe(PROBE_TIME);
  });

  it("invalidates carried outcomes when a catalog replaces the actual provider", () => {
    const deps = fixture();
    const holder = deps.gatewayConfig;
    if (holder === undefined) throw new Error("expected configured holder");
    for (let index = 0; index < 3; index += 1) observe(deps, "cites");
    const current = holder.current();
    if (current === undefined) throw new Error("expected current configuration");
    expect(
      holder.replaceCatalog?.(
        {
          ...current,
          providers: current.providers.map((provider) => ({
            ...provider,
            baseUrl: "https://replacement.example.invalid/v1",
          })),
        },
        holder.generation(),
      ),
    ).toBe(true);
    expect(citationBehaviourFor(deps, MODEL)).toBeUndefined();
    observe(deps, "never");
    expect(holder.verifiedCapability(MODEL)?.citationBehaviourWindow).toEqual(["never"]);
  });

  it("never manufactures conversation readiness from citation metadata", () => {
    const deps = fixture();
    const readiness = deps.gatewayConfig?.verification();
    for (let index = 0; index < 3; index += 1) observe(deps, "cites");
    expect(citationBehaviourFor(deps, MODEL)).toBe("cites");
    expect(currentConversationReady(deps, MODEL)).toBe(false);
    expect(currentConversationReadinessObservation(deps, MODEL)).toBeUndefined();
    expect(deps.gatewayConfig?.verification()).toEqual(readiness);
  });

  it("does not count a callback twice for the same turn", () => {
    const deps = fixture();
    const callback = citationBehaviourObserverFor(deps, MODEL);
    callback("cites");
    callback("never");
    expect(deps.gatewayConfig?.verifiedCapability(MODEL)?.citationBehaviourWindow).toEqual([
      "cites",
    ]);
  });

  it("ignores late callbacks after even an equivalent replacement generation", () => {
    const deps = fixture();
    const callback = citationBehaviourObserverFor(deps, MODEL);
    deps.gatewayConfig?.set(config(), true);
    callback("never");
    expect(stored(deps)).toBeUndefined();
    expect(deps.gatewayConfig?.verifiedCapability(MODEL)).toBeUndefined();
  });

  it("checks actual deployment identity even when a metadata-only generation is retained", () => {
    const deps = fixture();
    const callback = citationBehaviourObserverFor(deps, MODEL);
    const current = deps.gatewayConfig?.current();
    if (current === undefined) throw new Error("expected configured gateway");
    deps.gatewayConfig?.refine?.({
      ...current,
      providers: current.providers.map((provider) => ({
        ...provider,
        baseUrl: "https://replacement.example.invalid/v1",
      })),
    });
    callback("never");
    expect(stored(deps)).toBeUndefined();
    expect(deps.gatewayConfig?.verifiedCapability(MODEL)).toBeUndefined();
  });

  it("treats persisted metadata as descriptive rather than current runtime proof", () => {
    const deps = fixture(config("cites"));
    expect(citationBehaviourFor(deps, MODEL)).toBeUndefined();
    expect(stored(deps)).toBe("cites");
  });

  it("does not observe non-chat, missing or unconfigured models", () => {
    const initial = parseGatewayConfig({
      providers: [
        {
          modelId: MODEL,
          baseUrl: "https://citation.example.invalid/v1",
          apiKey: "private-fixture-key",
        },
      ],
      capabilities: [createDefaultEmbeddingCapability(MODEL)],
    });
    const deps = fixture(initial);
    observe(deps, "never");
    citationBehaviourObserverFor(deps, "missing-model")("cites");
    expect(deps.gatewayConfig?.verifiedCapability(MODEL)).toBeUndefined();
    deps.gatewayConfig?.set(undefined, false);
    expect(() => {
      observe(deps, "cites");
    }).not.toThrow();
  });

  it("keeps capability unknown with a body-free diagnostic when durable persistence fails", () => {
    const base = fixture();
    const records: ServerDiagnosticRecord[] = [];
    const deps = {
      ...base,
      diagnostics: {
        record: (record: ServerDiagnosticRecord): void => {
          records.push(record);
        },
      },
    };
    const path = deps.gatewayConfig?.storagePath;
    if (path === undefined) throw new Error("expected configuration path");
    mkdirSync(path);
    expect(() => {
      observe(deps, "never");
    }).not.toThrow();
    expect(stored(deps)).toBeUndefined();
    expect(citationBehaviourFor(deps, MODEL)).toBeUndefined();
    expect(deps.gatewayConfig?.verifiedCapability(MODEL)).toMatchObject({
      citationBehaviourWindow: ["never"],
      citationBehaviourObservationStatus: "unavailable",
    });
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain(path);
    expect(JSON.stringify(records)).not.toContain("private-fixture-key");
    expect(JSON.stringify(records)).not.toContain("citation.example.invalid");
  });
});
