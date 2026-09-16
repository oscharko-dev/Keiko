import { render, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingAppSessionPairingAttestation } from "@oscharko-dev/keiko-contracts";
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";

const PAIR_PATH = "/api/coding-workbench/app-session/pair";
const LOCAL_SESSION_PATH = "/api/coding-workbench/app-session/local-session";
const MANIFEST_PATH = "/api/workspaces";

// `bootRedemption` in coding-app-session-client is module-scoped, so its state must be reset
// between tests — otherwise the second test would reuse the first test's already-resolved boot
// promise and never post to LOCAL_SESSION_PATH.
interface BootModules {
  readonly redeemCodingAppSessionPairingOnBoot: () => Promise<boolean>;
  readonly fetchWorkspaceManifests: () => Promise<unknown>;
}

async function loadBootModules(): Promise<BootModules> {
  const client = await import("./coding-app-session-client");
  const manifests = await import("./workspace-manifest-api");
  return {
    redeemCodingAppSessionPairingOnBoot: client.redeemCodingAppSessionPairingOnBoot,
    fetchWorkspaceManifests: manifests.fetchWorkspaceManifests,
  };
}

function DesktopBoot({ modules }: { readonly modules: BootModules }): ReactNode {
  useEffect(() => {
    void modules.redeemCodingAppSessionPairingOnBoot();
  }, [modules]);
  useEffect(() => {
    void modules.fetchWorkspaceManifests();
  }, [modules]);
  return null;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("app-session manifest boot ordering", () => {
  it("waits for successful pairing when the child read effect runs before the parent", async () => {
    const events: string[] = [];
    let releasePairing = (): void => undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const path = String(input);
      if (path === PAIR_PATH) {
        events.push("pair-request");
        return new Promise<Response>((resolve) => {
          releasePairing = (): void => {
            events.push("pair-response");
            resolve(new Response(JSON.stringify({ schemaVersion: "1" }), { status: 200 }));
          };
        });
      }
      if (path === LOCAL_SESSION_PATH) {
        events.push("local-session-request");
        return Promise.resolve(
          new Response(JSON.stringify({ schemaVersion: "1" }), { status: 200 }),
        );
      }
      if (path === MANIFEST_PATH) {
        events.push("manifest-request");
        return Promise.resolve(
          new Response(JSON.stringify({ manifests: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.reject(new TypeError(`Unexpected request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const attestation: CodingAppSessionPairingAttestation = {
      requestId: "req_manifest-boot",
      issuedAtMs: 1_720_000_000_000,
      claim: "c".repeat(64),
    };
    window.location.hash = encodeCodingAppSessionPairingFragment(attestation);

    const modules = await loadBootModules();
    render(<DesktopBoot modules={modules} />);
    await waitFor(() => expect(events).toContain("pair-request"));
    await Promise.resolve();
    expect(events).toEqual(["pair-request"]);

    releasePairing();
    await waitFor(() =>
      expect(events).toEqual([
        "pair-request",
        "pair-response",
        "local-session-request",
        "manifest-request",
      ]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // `ensureLocalCodingAppSession` converts a rejected request into `false`, and
  // `codingAppSessionPairingSettled()` MUST still settle so `fetchWorkspaceManifests()` can
  // request `/api/workspaces`. Without the settle, the manifest read would stall behind a boot
  // promise that never resolves and the desktop would boot without its workspace list.
  it("still starts the manifest request when the local-session request rejects", async () => {
    const events: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const path = String(input);
      if (path === LOCAL_SESSION_PATH) {
        events.push("local-session-request");
        return Promise.reject(new TypeError("network offline"));
      }
      if (path === MANIFEST_PATH) {
        events.push("manifest-request");
        return Promise.resolve(
          new Response(JSON.stringify({ manifests: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.reject(new TypeError(`Unexpected request: ${path}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const modules = await loadBootModules();
    render(<DesktopBoot modules={modules} />);
    await waitFor(() => expect(events).toContain("manifest-request"));
    expect(events).toContain("local-session-request");
  });
});
