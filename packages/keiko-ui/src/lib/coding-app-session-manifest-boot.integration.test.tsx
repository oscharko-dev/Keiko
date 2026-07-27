import { render, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeCodingAppSessionPairingFragment,
  type CodingAppSessionPairingAttestation,
} from "@oscharko-dev/keiko-contracts";
import { redeemCodingAppSessionPairingOnBoot } from "./coding-app-session-client";
import { fetchWorkspaceManifests } from "./workspace-manifest-api";

const PAIR_PATH = "/api/coding-workbench/app-session/pair";
const MANIFEST_PATH = "/api/workspaces";

function ManifestReader(): ReactNode {
  useEffect(() => {
    void fetchWorkspaceManifests();
  }, []);
  return null;
}

function DesktopBoot(): ReactNode {
  useEffect(() => {
    void redeemCodingAppSessionPairingOnBoot();
  }, []);
  return <ManifestReader />;
}

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

    render(<DesktopBoot />);
    await waitFor(() => expect(events).toContain("pair-request"));
    await Promise.resolve();
    expect(events).toEqual(["pair-request"]);

    releasePairing();
    await waitFor(() =>
      expect(events).toEqual(["pair-request", "pair-response", "manifest-request"]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
