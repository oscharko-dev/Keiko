import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";
import {
  createAtlassianCredentialCustody,
  type AtlassianCredentialCustody,
  type AtlassianCredentialMetadata,
  type AtlassianCredentialMetadataStore,
  type AtlassianHttpBodyPort,
  type AtlassianHttpBodyRequest,
  type AtlassianHttpBodyResult,
} from "@oscharko-dev/keiko-connectors";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import type { AtlassianConnectorCredentialDeps } from "./credentialRoutes.js";
import { createGatewayAtlassianHttpBodyPort } from "./httpPort.js";
import { publicAtlassianCredential } from "./jiraPodAccess.js";
import { verifyStoredCredential } from "./credentialVerification.js";
import {
  AtlassianCredentialMetadataStoreError,
  atlassianCredentialMetadataPath,
  createAtlassianCredentialMetadataStore,
} from "./credentialMetadataStore.js";

const BASE_URL = "https://jira.example.invalid/context";
const CORRELATION_ID = "jira-compatibility-fixture";
const IDENTITY = { name: "synthetic-user", key: "synthetic-key", active: true };
type Version = readonly [number, number, number];

function inMemoryCustody(
  metadataStore?: AtlassianCredentialMetadataStore,
): AtlassianCredentialCustody {
  const secrets = new Map<string, string>();
  const records = new Map<string, AtlassianCredentialMetadata>();
  return createAtlassianCredentialCustody({
    vault: {
      get: (key): string | undefined => secrets.get(key),
      set: (key, value): void => {
        secrets.set(key, value);
      },
      delete: (key): void => {
        secrets.delete(key);
      },
    },
    metadataStore: metadataStore ?? {
      insert: (record): void => {
        records.set(record.authRef, record);
      },
      get: (key): AtlassianCredentialMetadata | undefined => records.get(key),
      list: (): readonly AtlassianCredentialMetadata[] => [...records.values()],
      delete: (key): boolean => records.delete(key),
    },
  }).custody;
}

function probeResponse(
  request: AtlassianHttpBodyRequest,
  version: Version,
  status = 200,
): AtlassianHttpBodyResult {
  const bodyText = JSON.stringify(
    request.url.endsWith("/serverInfo")
      ? { version: version.join("."), versionNumbers: version, deploymentType: "Data Center" }
      : IDENTITY,
  );
  return {
    kind: "response",
    status,
    // A 401 that Jira itself authored: the only kind that rejects a token.
    ...(status === 401 ? { authenticationFailure: "jira" as const } : {}),
    bodyText,
    bodyBytes: Buffer.byteLength(bodyText),
    truncated: false,
  };
}

interface Fixture {
  readonly deps: AtlassianConnectorCredentialDeps;
  readonly metadata: AtlassianCredentialMetadata;
  readonly requests: AtlassianHttpBodyRequest[];
  readonly events: ServerLogEvent[];
}

function fixture(
  version: Version = [10, 3, 26],
  metadataStore?: AtlassianCredentialMetadataStore,
): Fixture {
  const custody = inMemoryCustody(metadataStore);
  const metadata = custody.create(
    {
      provider: "jira",
      displayName: "Synthetic Jira",
      baseUrl: BASE_URL,
      deployment: "data-center",
      authScheme: "bearer-pat",
      apiToken: ["synthetic", "compatibility", "credential"].join("-"),
      livePodCreationRequestId: "7765d9e4-fc9a-46d5-aea4-24880fec5e1e",
    },
    "a".repeat(64),
  );
  const requests: AtlassianHttpBodyRequest[] = [];
  const events: ServerLogEvent[] = [];
  const deps: AtlassianConnectorCredentialDeps = {
    custody,
    httpPortFactory: () => (): never => {
      throw new Error("The compatibility probe requires the bounded-body port.");
    },
    httpBodyPortFactory:
      () =>
      (request): Promise<AtlassianHttpBodyResult> => {
        requests.push(request);
        return Promise.resolve(probeResponse(request, version));
      },
    activityLog: {
      write: (event): void => {
        events.push(event);
      },
    },
  };
  return { deps, metadata, requests, events };
}

function currentMetadata(f: Fixture): AtlassianCredentialMetadata {
  const current = f.deps.custody.getMetadata(f.metadata.authRef);
  if (current === undefined) throw new Error("The fixture credential is missing.");
  return current;
}

function withPort(f: Fixture, port: AtlassianHttpBodyPort): AtlassianConnectorCredentialDeps {
  return { ...f.deps, httpBodyPortFactory: () => port };
}

function signal(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function delayedProbe(f: Fixture): {
  readonly entered: Promise<void>;
  readonly release: () => void;
  readonly result: Promise<string>;
} {
  const entered = signal();
  const release = signal();
  const deps = withPort(f, async (request) => {
    if (request.url.endsWith("/serverInfo")) {
      entered.resolve();
      await release.promise;
    }
    return probeResponse(request, [10, 3, 26]);
  });
  return {
    entered: entered.promise,
    release: release.resolve,
    result: verifyStoredCredential(deps, currentMetadata(f), CORRELATION_ID),
  };
}

describe("Jira compatibility through stored credential verification", () => {
  it.each<Version>([
    [10, 3, 27],
    [10, 4, 4],
    [11, 2, 1],
    [11, 3, 13],
  ])("retains measured REST-v2 facts for %i.%i.%i under its context path", async (...version) => {
    const f = fixture(version);
    expect(await verifyStoredCredential(f.deps, f.metadata, CORRELATION_ID)).toBe("ok");
    expect(currentMetadata(f)).toMatchObject({
      generation: 1,
      livePod: {
        verificationStatus: "ok",
        verificationInProgress: false,
        compatibility: {
          schemaVersion: 1,
          deploymentType: "Data Center",
          versionNumbers: version,
          restApi: "v2",
          agileApi: "unverified",
        },
      },
    });
    expect(f.requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: `${BASE_URL}/rest/api/2/serverInfo` },
      { method: "GET", url: `${BASE_URL}/rest/api/2/myself` },
    ]);
    expect(JSON.stringify(currentMetadata(f))).not.toContain(IDENTITY.name);
    expect(JSON.stringify(currentMetadata(f))).not.toContain(IDENTITY.key);
  });

  it.each([401, 403])(
    "clears successful facts when a new probe receives HTTP %i",
    async (status) => {
      const f = fixture();
      expect(await verifyStoredCredential(f.deps, f.metadata, CORRELATION_ID)).toBe("ok");
      expect(currentMetadata(f)).toHaveProperty("livePod.compatibility.restApi", "v2");
      const failing = withPort(f, (request) =>
        Promise.resolve(probeResponse(request, [10, 3, 26], status)),
      );
      const outcome = status === 401 ? "auth-failed" : "forbidden";
      expect(await verifyStoredCredential(failing, currentMetadata(f), CORRELATION_ID)).toBe(
        outcome,
      );
      const current = currentMetadata(f);
      expect(current).toMatchObject({
        generation: 2,
        livePod: { verificationStatus: outcome, verificationInProgress: false },
      });
      assert(current.deployment === "data-center" && current.livePod !== undefined);
      expect(current.livePod).not.toHaveProperty("compatibility");
      expect(f.events.at(-1)?.extra).toMatchObject({
        outcome,
        verificationState: "applied",
        jiraCompatibility: "unverified",
      });
      expect(f.events.at(-1)?.extra).not.toHaveProperty("restApi");
    },
  );

  it("refuses an anonymous identity at verification and retains no compatibility (#4289 AC1)", async () => {
    const f = fixture();
    const anonymous = withPort(
      f,
      createGatewayAtlassianHttpBodyPort({
        baseUrl: BASE_URL,
        authRef: f.metadata.authRef,
        credentials: {
          resolveForExecution: () => ({ scheme: "bearer-pat", apiToken: "synthetic-credential" }),
        },
        fetchImpl: (input) => {
          const url = input instanceof Request ? input.url : input.toString();
          const body = url.endsWith("/serverInfo")
            ? { version: "10.3.26", versionNumbers: [10, 3, 26], deploymentType: "Data Center" }
            : IDENTITY;
          return Promise.resolve(
            new Response(JSON.stringify(body), {
              status: 200,
              headers: url.endsWith("/myself")
                ? { "X-AUSERNAME": "anonymous", "X-AREQUESTID": "synthetic-request" }
                : {},
            }),
          );
        },
      }),
    );
    expect(await verifyStoredCredential(anonymous, currentMetadata(f), CORRELATION_ID)).toBe(
      "auth-failed",
    );
    const current = currentMetadata(f);
    assert(current.deployment === "data-center" && current.livePod !== undefined);
    expect(current.livePod.verificationStatus).toBe("auth-failed");
    expect(current.livePod).not.toHaveProperty("compatibility");
  });

  it("marks a verified Pod without retained facts as missing them, and only that Pod (#4289, #4353)", async () => {
    const f = fixture();
    expect(await verifyStoredCredential(f.deps, f.metadata, CORRELATION_ID)).toBe("ok");
    const verified = currentMetadata(f);
    assert(verified.deployment === "data-center" && verified.livePod !== undefined);
    expect(publicAtlassianCredential(verified)).toMatchObject({
      livePod: { verificationStatus: "ok" },
    });
    expect(JSON.stringify(publicAtlassianCredential(verified))).not.toContain("compatibilityFacts");
    const { compatibility: _facts, ...legacyPod } = verified.livePod;
    const legacy = publicAtlassianCredential({ ...verified, livePod: legacyPod });
    expect(legacy).toMatchObject({ livePod: { compatibilityFacts: "missing" } });
    // Closed state only: no version, REST or Agile fact reaches the public view.
    expect(JSON.stringify(legacy)).not.toMatch(/versionNumbers|restApi|agileApi/u);
    const unverified = publicAtlassianCredential({
      ...verified,
      livePod: { ...legacyPod, verificationStatus: "unverified" as const },
    });
    expect(JSON.stringify(unverified)).not.toContain("compatibilityFacts");
  });

  it.each(["foreign", "denied"] as const)(
    "an explicit verification meeting a %s 401 neither rejects nor invalidates the Pod (#4353)",
    async (origin) => {
      const f = fixture([11, 3, 13]);
      expect(await verifyStoredCredential(f.deps, f.metadata, CORRELATION_ID)).toBe("ok");
      const before = currentMetadata(f);
      assert(before.deployment === "data-center" && before.livePod?.compatibility !== undefined);
      // A single sign-in proxy or a captcha check answers instead of Jira.
      const proxied = withPort(f, () =>
        Promise.resolve({
          kind: "response",
          status: 401,
          authenticationFailure: origin,
          bodyText: "<html>sign in</html>",
          bodyBytes: 20,
          truncated: false,
        }),
      );
      expect(await verifyStoredCredential(proxied, before, CORRELATION_ID)).toBe("auth-unverified");
      const after = currentMetadata(f);
      assert(after.deployment === "data-center" && after.livePod !== undefined);
      // Nothing was invalidated: same generation, still verified, facts retained, not in progress.
      expect(after.generation).toBe(before.generation);
      expect(after.livePod).toMatchObject({
        verificationStatus: "ok",
        verificationInProgress: false,
        compatibility: before.livePod.compatibility,
      });
      expect(f.events.at(-1)?.extra).toMatchObject({
        outcome: "auth-unverified",
        verificationState: "applied",
      });
      // There is always a way out: the token can be replaced at once.
      const rotated = f.deps.custody.updateLivePod(after.authRef, {
        expectedGeneration: after.generation,
        apiToken: ["replacement", "synthetic", "credential"].join("-"),
      });
      expect(rotated.generation).toBe((after.generation ?? 1) + 1);
    },
  );

  it("clears successful facts when a recheck throws", async () => {
    const f = fixture();
    expect(await verifyStoredCredential(f.deps, f.metadata, CORRELATION_ID)).toBe("ok");
    expect(currentMetadata(f)).toHaveProperty("livePod.compatibility.restApi", "v2");
    const failing = withPort(f, () => Promise.reject(new TypeError("Synthetic probe failure")));
    await expect(
      verifyStoredCredential(failing, currentMetadata(f), CORRELATION_ID),
    ).rejects.toThrow("Synthetic probe failure");
    expect(currentMetadata(f)).toMatchObject({
      generation: 2,
      livePod: { verificationStatus: "unverified", verificationInProgress: false },
    });
    const current = currentMetadata(f);
    assert(current.deployment === "data-center" && current.livePod !== undefined);
    expect(current.livePod).not.toHaveProperty("compatibility");
  });

  it("discards late facts after token rotation without restoring readiness", async () => {
    const f = fixture();
    expect(await verifyStoredCredential(f.deps, f.metadata, CORRELATION_ID)).toBe("ok");
    expect(currentMetadata(f)).toHaveProperty("livePod.compatibility.restApi", "v2");
    const pending = delayedProbe(f);
    await pending.entered;
    const rejected = expect(pending.result).rejects.toMatchObject({ code: "credential-changed" });
    try {
      expect(currentMetadata(f)).not.toHaveProperty("livePod.compatibility");
      f.deps.custody.updateLivePod(f.metadata.authRef, {
        expectedGeneration: 1,
        apiToken: ["replacement", "synthetic", "credential"].join("-"),
      });
    } finally {
      pending.release();
    }
    await rejected;
    expect(currentMetadata(f)).toMatchObject({
      generation: 2,
      livePod: { verificationStatus: "unverified", verificationInProgress: false },
    });
    expect(currentMetadata(f)).not.toHaveProperty("livePod.compatibility");
    expect(f.events.at(-1)?.extra).toMatchObject({ verificationState: "stale" });
  });

  it("cannot replace facts from a newer successful verification", async () => {
    const f = fixture();
    const pending = delayedProbe(f);
    await pending.entered;
    const rejected = expect(pending.result).rejects.toMatchObject({ code: "credential-changed" });
    const newer = withPort(f, (request) => Promise.resolve(probeResponse(request, [11, 3, 13])));
    try {
      expect(await verifyStoredCredential(newer, currentMetadata(f), CORRELATION_ID)).toBe("ok");
    } finally {
      pending.release();
    }
    await rejected;
    expect(currentMetadata(f)).toMatchObject({
      generation: 1,
      livePod: {
        verificationRevision: 2,
        verificationInProgress: false,
        verificationStatus: "ok",
        compatibility: { versionNumbers: [11, 3, 13], restApi: "v2", agileApi: "unverified" },
      },
    });
    expect(f.events.map((event) => event.extra?.verificationState)).toEqual(["applied", "stale"]);
  });

  it("records compatibility as closed evidence without version, identity or target data", async () => {
    const f = fixture([11, 3, 13]);
    expect(await verifyStoredCredential(f.deps, f.metadata, CORRELATION_ID)).toBe("ok");
    expect(f.events).toHaveLength(1);
    const event = f.events[0];
    assert(event !== undefined);
    const line = formatActivityLogProofLine(event);
    expect(
      expectActivityLogProof("atlassian.connection.checked.compatibility", line),
    ).toMatchObject({
      correlationId: CORRELATION_ID,
      action: "verify",
      outcome: "ok",
      verificationState: "applied",
      jiraCompatibility: "verified",
      restApi: "v2",
      agileApi: "unverified",
    });
    for (const privateValue of [
      BASE_URL,
      f.metadata.authRef,
      IDENTITY.name,
      IDENTITY.key,
      "11.3.13",
    ])
      expect(line).not.toContain(privateValue);
    expect(event.extra).not.toHaveProperty("versionNumbers");
  });

  it("retains its own copy when the original compatibility tuple changes after commit", async () => {
    const f = fixture([11, 3, 13]);
    expect(await verifyStoredCredential(f.deps, f.metadata, CORRELATION_ID)).toBe("ok");
    const before = currentMetadata(f);
    assert(before.deployment === "data-center" && before.livePod?.compatibility !== undefined);
    const versionNumbers: [number, number, number] = [11, 3, 13];
    const input = { ...before.livePod.compatibility, versionNumbers };
    const ticket = f.deps.custody.beginVerification(f.metadata.authRef, 1);
    assert(ticket !== undefined);
    expect(
      f.deps.custody.finishVerification(
        f.metadata.authRef,
        1,
        ticket.revision,
        "ok",
        CORRELATION_ID,
        input,
      ),
    ).toBe(true);
    versionNumbers[0] = 99;
    expect(currentMetadata(f)).toHaveProperty("livePod.compatibility.versionNumbers", [11, 3, 13]);
  });
});

describe("private Jira compatibility metadata after restart", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-jira-compatibility-"));
    configPath = join(tempDir, "keiko.config.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reopens verified facts and isolates returned objects from durable metadata", async () => {
    const store = createAtlassianCredentialMetadataStore({ configPath });
    const f = fixture([11, 3, 13], store);
    expect(await verifyStoredCredential(f.deps, f.metadata, CORRELATION_ID)).toBe("ok");
    const restarted = createAtlassianCredentialMetadataStore({ configPath });
    const restored = restarted.get(f.metadata.authRef);
    expect(restored).toEqual(currentMetadata(f));
    assert(restored?.deployment === "data-center" && restored.livePod?.compatibility !== undefined);
    expect(restored.livePod.compatibility.versionNumbers).toEqual([11, 3, 13]);
    Reflect.set(restored.livePod.compatibility.versionNumbers, "0", 99);
    expect(restarted.get(f.metadata.authRef)).toHaveProperty(
      "livePod.compatibility.versionNumbers",
      [11, 3, 13],
    );
    expect(JSON.stringify(restarted.list())).not.toContain(IDENTITY.name);
  });

  it("never invents compatibility for legacy metadata and an identity verification claims no Agile capability (#4289 AC3)", async () => {
    const f = fixture([11, 3, 13], createAtlassianCredentialMetadataStore({ configPath }));
    expect(await verifyStoredCredential(f.deps, f.metadata, CORRELATION_ID)).toBe("ok");
    const verified = currentMetadata(f);
    assert(verified.deployment === "data-center" && verified.livePod !== undefined);
    const { compatibility: observed, ...legacyPod } = verified.livePod;
    expect(observed).toMatchObject({ restApi: "v2", agileApi: "unverified" });
    writeFileSync(
      atlassianCredentialMetadataPath(configPath),
      JSON.stringify({
        version: 1,
        credentials: { [verified.authRef]: { ...verified, livePod: legacyPod } },
      }),
    );
    const restarted = createAtlassianCredentialMetadataStore({ configPath }).get(verified.authRef);
    assert(restarted?.deployment === "data-center" && restarted.livePod !== undefined);
    expect(restarted.livePod).not.toHaveProperty("compatibility");
    expect(JSON.stringify(restarted)).not.toMatch(/agileApi|restApi|versionNumbers/u);
  });

  it.each([
    { name: "failed verification", target: "pod", patch: { verificationStatus: "auth-failed" } },
    { name: "pending verification", target: "pod", patch: { verificationInProgress: true } },
    {
      name: "unfinished token rotation",
      target: "pod",
      patch: { credentialOperation: "replace-token" },
    },
    { name: "unfinished deletion", target: "pod", patch: { credentialOperation: "delete" } },
    { name: "unmeasured Agile capability", target: "facts", patch: { agileApi: "verified" } },
    { name: "unsupported REST root", target: "facts", patch: { restApi: "v3" } },
    { name: "malformed release", target: "facts", patch: { versionNumbers: [11, 3] } },
    { name: "extra credential field", target: "facts", patch: { apiToken: "synthetic-data" } },
  ])("refuses $name alongside persisted facts after restart", async ({ target, patch }) => {
    const f = fixture([11, 3, 13], createAtlassianCredentialMetadataStore({ configPath }));
    expect(await verifyStoredCredential(f.deps, f.metadata, CORRELATION_ID)).toBe("ok");
    const verified = currentMetadata(f);
    assert(verified.deployment === "data-center" && verified.livePod?.compatibility !== undefined);
    const livePod =
      target === "pod"
        ? { ...verified.livePod, ...patch }
        : {
            ...verified.livePod,
            compatibility: { ...verified.livePod.compatibility, ...patch },
          };
    writeFileSync(
      atlassianCredentialMetadataPath(configPath),
      JSON.stringify({
        version: 1,
        credentials: {
          [verified.authRef]: { ...verified, livePod },
        },
      }),
    );
    const restarted = createAtlassianCredentialMetadataStore({ configPath });
    expect(() => restarted.get(verified.authRef)).toThrow(AtlassianCredentialMetadataStoreError);
    expect(() => restarted.list()).toThrow(AtlassianCredentialMetadataStoreError);
  });
});
