import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LookupAddress } from "node:dns";
import type { AtlassianCredentialMetadata } from "@oscharko-dev/keiko-connectors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup }));

import { createAtlassianCredentialMetadataStore } from "./credentialMetadataStore.js";
import { resolveAtlassianTargetAdmission } from "./targetAdmission.js";

const AUTH_REF = "atlassian-cred:AAAAAAAAAAAAAAAAAAAAAA";
function metadata(baseUrl = "https://jira.example:8443/context"): AtlassianCredentialMetadata {
  return {
    schemaVersion: "1",
    authRef: AUTH_REF,
    provider: "jira",
    deployment: "data-center",
    authScheme: "bearer-pat",
    generation: 1,
    displayName: "Team Jira",
    baseUrl,
    createdAt: 1000,
  };
}

let directory: string;
let configPath: string;
beforeEach(() => {
  directory = mkdtempSync(join(realpathSync(tmpdir()), "keiko-atlassian-admission-"));
  configPath = join(directory, "keiko.config.json");
  lookup.mockReset();
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("resolveAtlassianTargetAdmission", () => {
  it("does not create an admission or resolve DNS outside explicit verification", async () => {
    const store = createAtlassianCredentialMetadataStore({ configPath });
    const saved = metadata();
    store.insert(saved);
    expect(await resolveAtlassianTargetAdmission(store, saved, undefined, false)).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    expect(store.getTargetAdmission(saved)).toBeUndefined();
  });

  it("rejects deleted or already superseded metadata before attempting DNS", async () => {
    const store = createAtlassianCredentialMetadataStore({ configPath });
    const saved = metadata();
    expect(await resolveAtlassianTargetAdmission(store, saved, undefined, true)).toBeUndefined();
    store.insert({ ...saved, generation: 2 });
    expect(await resolveAtlassianTargetAdmission(store, saved, undefined, true)).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    ["https://10.0.0.5:8443/context", "private"],
    ["https://[fd00::1]/context", "private"],
    ["https://127.0.0.1:18443/context", "loopback"],
    ["https://localhost:18443/context", "loopback"],
    ["https://[::1]:18443/context", "loopback"],
    ["https://203.0.113.8/context", "public"],
  ] as const)(
    "binds the explicitly saved literal %s as %s without DNS",
    async (baseUrl, addressClass) => {
      const store = createAtlassianCredentialMetadataStore({ configPath });
      const saved = metadata(baseUrl);
      store.insert(saved);
      expect(await resolveAtlassianTargetAdmission(store, saved, undefined, true)).toEqual({
        baseUrl,
        addressClass,
      });
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it.each([
    { addresses: ["10.0.0.5", "192.168.0.2"], addressClass: "private" },
    { addresses: ["203.0.113.10", "203.0.113.11"], addressClass: "public" },
  ] as const)(
    "binds a uniform $addressClass DNS set and retains the class across restart",
    async ({ addresses, addressClass }) => {
      const store = createAtlassianCredentialMetadataStore({ configPath });
      const saved = metadata();
      store.insert(saved);
      lookup.mockResolvedValue(addresses.map((address) => ({ address, family: 4 })));
      const expected = { baseUrl: saved.baseUrl, addressClass };
      expect(await resolveAtlassianTargetAdmission(store, saved, undefined, true)).toEqual(
        expected,
      );
      expect(lookup).toHaveBeenCalledExactlyOnceWith("jira.example", { all: true, verbatim: true });
      lookup.mockRejectedValue(new Error("DNS must not redefine an established class"));
      const restarted = createAtlassianCredentialMetadataStore({ configPath });
      expect(await resolveAtlassianTargetAdmission(restarted, saved, undefined, false)).toEqual(
        expected,
      );
      expect(await resolveAtlassianTargetAdmission(restarted, saved, undefined, true)).toEqual(
        expected,
      );
      expect(lookup).toHaveBeenCalledOnce();
    },
  );

  it.each(
    [
      [],
      ["10.0.0.5", "203.0.113.10"],
      ["127.0.0.1"],
      ["::1"],
      ["0.0.0.0"],
      ["::"],
      ["0:0:0:0:0:0:0:0"],
      ["0:0:0:0:0:0:0:1"],
      ["::ffff:0:0"],
      ["::ffff:7f00:1"],
      ["::ffff:a9fe:a9fe"],
      ["::ffff:a9fe:1"],
      ["169.254.169.254"],
      ["169.254.1.2"],
      ["fe80::1"],
      ["224.0.0.1"],
      ["ff02::1"],
      ["unclassified"],
    ].map((addresses) => ({ addresses })),
  )(
    "rejects an unsafe or mixed DNS set (%j) without persisting authority",
    async ({ addresses }) => {
      const store = createAtlassianCredentialMetadataStore({ configPath });
      const saved = metadata();
      store.insert(saved);
      lookup.mockResolvedValue(addresses.map((address) => ({ address, family: 4 })));
      expect(await resolveAtlassianTargetAdmission(store, saved, undefined, true)).toBeUndefined();
      expect(store.getTargetAdmission(saved)).toBeUndefined();
    },
  );

  it.each([
    "https://0.0.0.0/context",
    "https://[::]/context",
    "https://[::ffff:0:0]/context",
    "https://[::ffff:a9fe:a9fe]/context",
    "https://[::ffff:a9fe:1]/context",
    "https://169.254.169.254/context",
    "https://169.254.1.2/context",
    "https://[fe80::1]/context",
    "https://224.0.0.1/context",
    "https://[ff02::1]/context",
    "https://jira.example/context/%2e%2e/other",
    "https://jira.example/context//other",
  ])("refuses unsafe or noncanonical saved base URL %s", async (baseUrl) => {
    const store = createAtlassianCredentialMetadataStore({ configPath });
    const saved = metadata(baseUrl);
    store.insert(saved);
    expect(await resolveAtlassianTargetAdmission(store, saved, undefined, true)).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("does not grant a Cloud connection admission", async () => {
    const store = createAtlassianCredentialMetadataStore({ configPath });
    const cloud: AtlassianCredentialMetadata = {
      schemaVersion: "1",
      authRef: AUTH_REF,
      provider: "jira",
      authScheme: "basic-api-token",
      baseUrl: "https://jira.example",
      displayName: "Cloud",
      createdAt: 1000,
    };
    store.insert(cloud);
    expect(await resolveAtlassianTargetAdmission(store, cloud, undefined, true)).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["delete", "rotate"] as const)(
    "cannot admit a stale identity after %s while DNS is pending",
    async (operation) => {
      const store = createAtlassianCredentialMetadataStore({ configPath });
      const saved = metadata();
      store.insert(saved);
      let finish: ((addresses: LookupAddress[]) => void) | undefined;
      lookup.mockImplementation(
        () =>
          new Promise<LookupAddress[]>((resolve) => {
            finish = resolve;
          }),
      );
      const pending = resolveAtlassianTargetAdmission(store, saved, undefined, true);
      if (operation === "delete") store.delete(saved.authRef);
      else store.insert({ ...saved, generation: 2 });
      finish?.([{ address: "10.0.0.5", family: 4 }]);
      expect(await pending).toBeUndefined();
      expect(store.getTargetAdmission(saved)).toBeUndefined();
    },
  );

  it("cannot switch classes when two explicit verifications race", async () => {
    const store = createAtlassianCredentialMetadataStore({ configPath });
    const saved = metadata();
    store.insert(saved);
    let finish: ((addresses: LookupAddress[]) => void) | undefined;
    lookup.mockImplementation(
      () =>
        new Promise<LookupAddress[]>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = resolveAtlassianTargetAdmission(store, saved, undefined, true);
    const publicAdmission = { baseUrl: saved.baseUrl, addressClass: "public" as const };
    store.bindTargetAdmission(saved, publicAdmission);
    finish?.([{ address: "10.0.0.5", family: 4 }]);
    expect(await pending).toBeUndefined();
    expect(store.getTargetAdmission(saved)).toEqual(publicAdmission);
  });

  it("honors cancellation before DNS and before committing a completed lookup", async () => {
    const store = createAtlassianCredentialMetadataStore({ configPath });
    const saved = metadata();
    store.insert(saved);
    const cancelled = AbortSignal.abort();
    await expect(
      resolveAtlassianTargetAdmission(store, saved, cancelled, true),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(lookup).not.toHaveBeenCalled();
    let finish: ((addresses: LookupAddress[]) => void) | undefined;
    lookup.mockImplementation(
      () =>
        new Promise<LookupAddress[]>((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = resolveAtlassianTargetAdmission(store, saved, controller.signal, true);
    controller.abort();
    finish?.([{ address: "10.0.0.5", family: 4 }]);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(store.getTargetAdmission(saved)).toBeUndefined();
  });
});
