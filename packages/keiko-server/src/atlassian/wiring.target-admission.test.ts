import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type {
  AtlassianCredentialMetadata,
  AtlassianHttpBodyRequest,
  JiraHumanInputBinding,
} from "@oscharko-dev/keiko-connectors";
import type { OutboundHttpEgressConfig } from "@oscharko-dev/keiko-model-gateway/internal/http";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { NO_LOCAL_VAULT_KEYCHAIN } from "@oscharko-dev/keiko-security/secret-vault";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../../tests/support/activity-log-proof.js";
import { createFileServerLogSink } from "../observability/index.js";
import { createAtlassianCredentialMetadataStore } from "./credentialMetadataStore.js";
import type { AtlassianConnectorCredentialDeps } from "./credentialRoutes.js";
import { verifyStoredCredential } from "./credentialVerification.js";
import { buildAtlassianConnectorCredentialDeps } from "./wiring.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";

const SYNTHETIC_TOKEN = ["synthetic", "wiring", "admission", "fixture"].join("-");
const PRIVATE_BASE = "https://10.23.45.67:8443/context";
const directories = new Set<string>();
const sinks = new Set<ServerLogSink>();

interface WiringFixture {
  readonly directory: string;
  readonly fetchImpl: Mock<typeof fetch>;
  readonly sink: ServerLogSink;
  readonly store: ReturnType<typeof createAtlassianCredentialMetadataStore>;
  readonly build: () => AtlassianConnectorCredentialDeps;
}

function fixture(egress?: OutboundHttpEgressConfig): WiringFixture {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "keiko-atlassian-wiring-admission-"));
  directories.add(directory);
  const configPath = join(directory, "keiko.config.json");
  const env = { KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY: randomBytes(32).toString("base64") };
  const sink = createFileServerLogSink(directory, { level: "debug" });
  sinks.add(sink);
  const fetchImpl = vi.fn<typeof fetch>((input) => {
    const address =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(address);
    const body = url.pathname.endsWith("/serverInfo")
      ? { version: "10.3.26", versionNumbers: [10, 3, 26], deploymentType: "Data Center" }
      : {
          accountId: "synthetic-account",
          name: "synthetic-user",
          key: "synthetic-key",
          active: true,
        };
    return Promise.resolve(Response.json(body));
  });
  return {
    directory,
    fetchImpl,
    sink,
    store: createAtlassianCredentialMetadataStore({ configPath }),
    build: () =>
      buildAtlassianConnectorCredentialDeps({
        configPath,
        env,
        egress: () => egress,
        keychainAccess: NO_LOCAL_VAULT_KEYCHAIN,
        fetchImpl,
        activityLog: sink,
      }),
  };
}

function createDataCenter(
  deps: AtlassianConnectorCredentialDeps,
  baseUrl: string,
): Extract<AtlassianCredentialMetadata, { deployment: "data-center" }> {
  const created = deps.custody.create(
    {
      provider: "jira",
      deployment: "data-center",
      authScheme: "bearer-pat",
      displayName: "Synthetic Jira",
      baseUrl,
      apiToken: SYNTHETIC_TOKEN,
      livePodCreationRequestId: randomUUID(),
    },
    "a".repeat(64),
  );
  if (created.deployment !== "data-center")
    throw new TypeError("Missing Data Center fixture metadata");
  return created;
}

function selected(
  deps: AtlassianConnectorCredentialDeps,
  authRef: string,
): AtlassianCredentialMetadata {
  const metadata = deps.custody.getMetadata(authRef);
  if (metadata === undefined) throw new TypeError("Expected stored synthetic Jira metadata.");
  return metadata;
}

function request(baseUrl: string): AtlassianHttpBodyRequest & { readonly method: "GET" } {
  return {
    method: "GET" as const,
    url: `${baseUrl}/rest/api/2/project`,
    timeoutMs: 1000,
    maxBodyBytes: 4096,
  };
}

afterEach(() => {
  for (const sink of sinks) sink.close?.();
  sinks.clear();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

describe("stored Data Center admission through real custody, wiring and verification", () => {
  it.each([
    { versionNumbers: [10, 3, 26], expected: "10.3" },
    { versionNumbers: [10, 4, 0], expected: "10.4" },
    { versionNumbers: [11, 2, 1], expected: undefined },
    { versionNumbers: [11, 3, 13], expected: undefined },
  ] as const)(
    "binds legacy avatar ports only to the current persisted release $versionNumbers",
    ({ versionNumbers, expected }) => {
      const f = fixture();
      const deps = f.build();
      const created = createDataCenter(deps, PRIVATE_BASE);
      const verification = deps.custody.beginVerification(created.authRef);
      if (verification === undefined || created.livePod === undefined)
        throw new TypeError("Missing verified Pod");
      deps.custody.finishVerification(
        created.authRef,
        created.generation,
        verification.revision,
        "ok",
        undefined,
        {
          schemaVersion: 1,
          deploymentType: "Data Center",
          versionNumbers,
          restApi: "v2",
          agileApi: "unverified",
        },
      );
      const current = selected(deps, created.authRef);
      const factory = deps.jiraPrivatePortFactory;
      if (factory === undefined) throw new TypeError("Missing private port factory");
      const context = {
        invocationId: "legacy-avatar",
        correlationId: "legacy-avatar",
        signal: new AbortController().signal,
        beforeEffect: () => true,
      };
      const options = {
        legacyTemporaryRelease: "10.3" as const,
        sessionScope: {
          context: {
            kind: "chat" as const,
            chatId: "synthetic-chat",
            podId: created.livePod.podId,
            bindingGeneration: 1,
          },
          authority: { runId: "synthetic-run", envelopeDigest: "a".repeat(64) },
          principalDigest: "a".repeat(64),
          authRef: created.authRef,
          authenticationGeneration: created.generation,
          verificationRevision: verification.revision,
          expiresAt: Date.now() + 60_000,
        },
      };
      expect(factory(current, context, options).legacyTemporaryRelease).toBe(expected);
      // A supplied hint never substitutes for the current native verification.
      deps.custody.beginVerification(created.authRef, created.generation);
      expect(factory(current, context, options).legacyTemporaryRelease).toBeUndefined();
      expect(f.fetchImpl).not.toHaveBeenCalled();
    },
  );
  it("sweeps expired ready input once on the first legitimate vault use after restart, never during construction", () => {
    const f = fixture();
    const deps = f.build();
    const created = createDataCenter(deps, PRIVATE_BASE);
    const verification = deps.custody.beginVerification(created.authRef);
    if (verification === undefined || created.livePod === undefined)
      throw new TypeError("Missing verified Pod");
    deps.custody.finishVerification(
      created.authRef,
      created.generation,
      verification.revision,
      "ok",
    );
    const binding: JiraHumanInputBinding = {
      context: {
        kind: "chat",
        chatId: "synthetic-chat",
        messageId: "synthetic-message",
        callId: "synthetic-call",
        podId: created.livePod.podId,
        bindingGeneration: 1,
      },
      authority: { runId: "synthetic-input-run", envelopeDigest: "a".repeat(64) },
      principalDigest: "a".repeat(64),
      authRef: created.authRef,
      authenticationGeneration: created.generation,
      verificationRevision: verification.revision,
      operation: "jira.login",
      argumentsDigest: "b".repeat(64),
      actorUserKey: "synthetic-key",
      actorUsername: "synthetic-user",
      expiresAt: Date.now() + 1000,
    };
    const inputs = deps.custody.humanInputs;
    if (inputs === undefined) throw new TypeError("Missing input custody");
    const pending = inputs.prepare(binding);
    inputs.submit(pending.requestId, binding, pending.revision, {
      password: "synthetic-expired-private-input",
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(binding.expiresAt);
    try {
      const restarted = f.build();
      const restoredInputs = restarted.custody.humanInputs;
      if (restoredInputs === undefined) throw new TypeError("Missing restored input custody");
      const sweep = vi.spyOn(restoredInputs, "sweepExpired");
      expect(restarted.custody.list()).toHaveLength(1);
      expect(sweep).not.toHaveBeenCalled();
      expect(restoredInputs.inspect(pending.requestId, binding)).toBeUndefined();
      expect(restoredInputs.inspect(pending.requestId, binding)).toBeUndefined();
      expect(sweep).toHaveBeenCalledTimes(1);
      const phases = persistedActivityLogLines(
        readPersistedActivityLog(f.directory),
        "atlassian.jira.human-input",
      ).map((line) => expectActivityLogProof("atlassian.jira.human-input.line", line));
      const expired = phases.filter((line) => line.phase === "expired");
      expect(expired).toHaveLength(1);
      expect(expired[0]).toMatchObject({ correlationId: UNKNOWN_CORRELATION_ID });
      expect(expired[0]).not.toHaveProperty("parentCorrelationId");
    } finally {
      clock.mockRestore();
    }
  });
  it.each([
    [PRIVATE_BASE, "private"],
    ["https://127.0.0.1:18443/context", "loopback"],
  ] as const)(
    "verifies %s once and preserves its %s binding across restart",
    async (baseUrl, addressClass) => {
      const f = fixture();
      const deps = f.build();
      const created = createDataCenter(deps, baseUrl);
      expect(await deps.httpPortFactory(created)(request(baseUrl))).toEqual({
        kind: "network-error",
      });
      expect(await deps.httpBodyPortFactory(created)(request(baseUrl))).toEqual({
        kind: "network-error",
      });
      expect(f.fetchImpl).not.toHaveBeenCalled();
      expect(f.store.getTargetAdmission(created)).toBeUndefined();

      expect(await verifyStoredCredential(deps, created, "synthetic-target-verification")).toBe(
        "ok",
      );
      expect(f.fetchImpl).toHaveBeenCalledTimes(2);
      const current = selected(deps, created.authRef);
      expect(f.store.getTargetAdmission(current)).toEqual({ baseUrl, addressClass });

      const restarted = f.build();
      const restored = selected(restarted, created.authRef);
      expect(await restarted.httpPortFactory(restored)(request(baseUrl))).toMatchObject({
        kind: "response",
        status: 200,
      });
      expect(await restarted.httpBodyPortFactory(restored)(request(baseUrl))).toMatchObject({
        kind: "response",
        status: 200,
      });
      expect(f.fetchImpl).toHaveBeenCalledTimes(4);

      f.sink.flush?.();
      const lines = persistedActivityLogLines(
        readPersistedActivityLog(f.directory),
        "atlassian.target.admission",
      );
      const records = lines.map((line) =>
        expectActivityLogProof("atlassian.target.admission.line", line),
      );
      expect(records.filter((record) => record.outcome === "admitted")).toHaveLength(4);
      for (const record of records) {
        expect(record).toMatchObject({ source: "saved-data-center" });
        if (record.outcome === "admitted") expect(record).toMatchObject({ addressClass });
      }
      for (const line of lines) {
        expect(line).not.toContain(baseUrl);
        expect(line).not.toContain(new URL(baseUrl).hostname);
        expect(line).not.toContain(created.authRef);
        expect(line).not.toContain(SYNTHETIC_TOKEN);
        expect(line).not.toContain("Bearer ");
      }
    },
  );

  it("revokes existing and reconstructed ports after the stored Pod is removed", async () => {
    const f = fixture();
    const deps = f.build();
    const created = createDataCenter(deps, PRIVATE_BASE);
    expect(await verifyStoredCredential(deps, created, "synthetic-before-removal")).toBe("ok");
    const metadata = selected(deps, created.authRef);
    const statusPort = deps.httpPortFactory(metadata);
    const bodyPort = deps.httpBodyPortFactory(metadata);
    expect(deps.custody.delete(created.authRef)).toBe(true);
    expect(f.store.getTargetAdmission(metadata)).toBeUndefined();
    expect(await statusPort(request(PRIVATE_BASE))).toEqual({ kind: "network-error" });
    expect(await bodyPort(request(PRIVATE_BASE))).toEqual({ kind: "network-error" });
    const restarted = f.build();
    expect(await restarted.httpPortFactory(metadata)(request(PRIVATE_BASE))).toEqual({
      kind: "network-error",
    });
    expect(await restarted.httpBodyPortFactory(metadata)(request(PRIVATE_BASE))).toEqual({
      kind: "network-error",
    });
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("refuses a forged replacement address for saved metadata on both ports", async () => {
    const f = fixture();
    const deps = f.build();
    const created = createDataCenter(deps, PRIVATE_BASE);
    expect(await verifyStoredCredential(deps, created, "synthetic-before-forgery")).toBe("ok");
    const forged = {
      ...selected(deps, created.authRef),
      baseUrl: "https://10.23.45.68:8443/context",
    };
    expect(await deps.httpPortFactory(forged)(request(forged.baseUrl))).toEqual({
      kind: "network-error",
    });
    expect(await deps.httpBodyPortFactory(forged)(request(forged.baseUrl))).toEqual({
      kind: "network-error",
    });
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("never grants Cloud metadata private access through inherited model egress flags", async () => {
    const f = fixture({ allowPrivateNetwork: true, allowLinkLocalAndMetadata: true });
    const deps = f.build();
    const cloud = deps.custody.create({
      provider: "jira",
      authScheme: "basic-api-token",
      displayName: "Synthetic Cloud",
      baseUrl: PRIVATE_BASE,
      accountEmail: "synthetic@example.invalid",
      apiToken: SYNTHETIC_TOKEN,
    });
    expect(await verifyStoredCredential(deps, cloud, "synthetic-cloud-private-refusal")).toBe(
      "unreachable",
    );
    expect(await deps.httpPortFactory(cloud)(request(PRIVATE_BASE))).toEqual({
      kind: "network-error",
    });
    expect(await deps.httpBodyPortFactory(cloud)(request(PRIVATE_BASE))).toEqual({
      kind: "network-error",
    });
    expect(f.store.getTargetAdmission(cloud)).toBeUndefined();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
});
