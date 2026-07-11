// Issue #2245 (AC — token write-only) — the add-connector flow. Asserts base-URL validation, the
// masked token field, and the HARD token contract: after save the token is absent from the DOM,
// from every mocked network call except the single create hop, and from any re-queried state.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddConnectorForm, type AddConnectorClient } from "./AddConnectorForm";
import { ApiError } from "@/lib/api";
import type { AtlassianConnectorMetadata } from "@/lib/atlassian-connectors-api";

const TOKEN = "s3cr3t-token-xyz";

const METADATA: AtlassianConnectorMetadata = {
  schemaVersion: "1",
  authRef: "atlassian-cred:AAAAAAAAAAAAAAAAAAAAAA",
  provider: "confluence",
  displayName: "Docs",
  baseUrl: "https://x.atlassian.net",
  authScheme: "basic-api-token",
  createdAt: 1_700_000_000_000,
};

function makeClient(overrides: Partial<AddConnectorClient> = {}): AddConnectorClient {
  return {
    createConnector: vi.fn(async () => METADATA),
    verifyConnector: vi.fn(async () => ({ authRef: METADATA.authRef, status: "ok" as const })),
    ...overrides,
  };
}

async function fillValid(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText("Label"), "Docs");
  await user.type(screen.getByLabelText("Base URL"), "https://x.atlassian.net");
  await user.type(screen.getByLabelText("Account email"), "me@example.com");
  await user.type(screen.getByLabelText("API token"), TOKEN);
}

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

describe("AddConnectorForm — token field", () => {
  it("masks the token input and disables password-manager coupling", () => {
    render(<AddConnectorForm client={makeClient()} onCreated={vi.fn()} onClose={vi.fn()} />);
    const token = screen.getByLabelText("API token");
    expect(token).toHaveAttribute("type", "password");
    expect(token).toHaveAttribute("autocomplete", "off");
  });

  it("sends the token only in the create hop and never renders/keeps it after save", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    const onCreated = vi.fn();
    const { container } = render(
      <AddConnectorForm client={client} onCreated={onCreated} onClose={vi.fn()} />,
    );
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Save connector" }));

    // The form advanced to the verify phase; the token input is unmounted.
    await screen.findByTestId("acx-add-verify");
    expect(onCreated).toHaveBeenCalledWith(METADATA);
    expect(screen.queryByLabelText("API token")).toBeNull();

    // DOM scan: the token string appears nowhere in the rendered tree.
    expect(screen.queryByDisplayValue(TOKEN)).toBeNull();
    expect(container.innerHTML).not.toContain(TOKEN);
    expect(container.textContent ?? "").not.toContain(TOKEN);

    // Network audit: the token rode exactly one hop — the create request body.
    const createMock = vi.mocked(client.createConnector);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]?.[0].apiToken).toBe(TOKEN);
    // No other mocked call carries the token.
    const verifyMock = vi.mocked(client.verifyConnector);
    for (const call of verifyMock.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(TOKEN);
    }
  });
});

describe("AddConnectorForm — validation", () => {
  it("blocks submit with an invalid base URL and does not call the API", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<AddConnectorForm client={client} onCreated={vi.fn()} onClose={vi.fn()} />);
    await user.type(screen.getByLabelText("Label"), "Docs");
    await user.type(screen.getByLabelText("Base URL"), "http://insecure.example.com");
    await user.type(screen.getByLabelText("Account email"), "me@example.com");
    await user.type(screen.getByLabelText("API token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "Save connector" }));
    expect(screen.getByText(/HTTPS URL with no embedded credentials/i)).toBeInTheDocument();
    expect(vi.mocked(client.createConnector)).not.toHaveBeenCalled();
  });

  it("surfaces a body-safe API error and stays on the entry form", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      createConnector: vi.fn(async () => {
        throw new ApiError("VALIDATION_FAILED", "displayName is required", 400);
      }),
    });
    render(<AddConnectorForm client={client} onCreated={vi.fn()} onClose={vi.fn()} />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Save connector" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("displayName is required");
    });
    expect(screen.getByLabelText("API token")).toBeInTheDocument();
  });
});

describe("AddConnectorForm — inline verify after save", () => {
  it("verifies the created connector and renders the closed status", async () => {
    const user = userEvent.setup();
    const client = makeClient({
      verifyConnector: vi.fn(async () => ({
        authRef: METADATA.authRef,
        status: "forbidden" as const,
      })),
    });
    render(<AddConnectorForm client={client} onCreated={vi.fn()} onClose={vi.fn()} />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Save connector" }));
    await user.click(await screen.findByRole("button", { name: "Verify connection" }));
    const status = await screen.findByTestId("acx-verify-status");
    expect(status).toHaveAttribute("data-status", "forbidden");
    expect(vi.mocked(client.verifyConnector)).toHaveBeenCalledWith(METADATA.authRef);
  });

  it("has no axe violations on the entry form (light and dark)", async () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.setAttribute("data-theme", theme);
      const { container, unmount } = render(
        <AddConnectorForm client={makeClient()} onCreated={vi.fn()} onClose={vi.fn()} />,
      );
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});
