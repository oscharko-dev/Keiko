// Issue #2245 — the standalone route mount: renders the connector panel with its own I18nProvider
// and the default same-origin client (fetch stubbed to empty lists). Covers the route entry and the
// default-client path the injected-client component tests do not exercise.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AtlassianConnectorsApp from "./AtlassianConnectorsApp";
import AtlassianConnectorsPage from "./page";

function stubEmptyFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string): Promise<Response> =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: (): string | null => null },
        json: (): Promise<unknown> =>
          Promise.resolve(
            url.includes("action-approvals") ? { approvals: [] } : { credentials: [] },
          ),
      } as unknown as Response),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AtlassianConnectorsApp route", () => {
  it("mounts the connector panel with its own i18n provider and default client", async () => {
    stubEmptyFetch();
    render(<AtlassianConnectorsApp />);
    expect(await screen.findByText("Atlassian connectors")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/No connectors yet/i)).toBeInTheDocument());
  });

  it("renders through the route page entry", async () => {
    stubEmptyFetch();
    render(<AtlassianConnectorsPage />);
    expect(await screen.findByTestId("acx-panel")).toBeInTheDocument();
  });
});
