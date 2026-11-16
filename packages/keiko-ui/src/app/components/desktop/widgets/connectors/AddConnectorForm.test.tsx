// Issue #2245 (AC — token write-only) — the add-connector flow. Asserts base-URL validation, the
// masked token field, and the HARD token contract: after save the token is absent from the DOM,
// from every mocked network call except the single create hop, and from any re-queried state.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddConnectorForm, type AddConnectorClient } from "./AddConnectorForm";
import { ApiError } from "@/lib/api";
import type { AtlassianConnectorMetadata } from "@/lib/atlassian-connectors-api";
import * as diagnostics from "@/lib/client-diagnostics";

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

const CREATED_JIRA = {
  schemaVersion: "1",
  authRef: METADATA.authRef,
  provider: "jira",
  deployment: "data-center",
  authScheme: "bearer-pat",
  generation: 1,
  displayName: "Team Jira",
  baseUrl: "https://jira.example.invalid/context",
  createdAt: 1000,
  livePod: {
    kind: "jira-live",
    podId: "11111111-1111-4111-8111-111111111111",
    authenticationGeneration: 1,
    verificationRevision: 0,
    verificationStatus: "unverified",
    verificationInProgress: false,
    capabilities: ["live-read", "live-write"],
  },
} as const satisfies AtlassianConnectorMetadata;
const VERIFIED_JIRA = {
  ...CREATED_JIRA,
  livePod: { ...CREATED_JIRA.livePod, verificationRevision: 1, verificationStatus: "ok" },
} as const satisfies AtlassianConnectorMetadata;

function makeClient(overrides: Partial<AddConnectorClient> = {}): AddConnectorClient {
  return {
    createConnector: vi.fn(async () => METADATA),
    verifyConnector: vi.fn(async () => ({ authRef: METADATA.authRef, status: "ok" as const })),
    listConnectors: vi.fn(async () => [METADATA]),
    ...overrides,
  };
}

async function fillValid(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText("Label"), "Docs");
  await user.type(screen.getByLabelText("Base URL"), "https://x.atlassian.net");
  await user.type(screen.getByLabelText("Account email"), "me@example.com");
  await user.type(screen.getByLabelText("API token"), TOKEN);
}

async function fillJira(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText("Label"), "Team Jira");
  await user.type(screen.getByLabelText("Base URL"), CREATED_JIRA.baseUrl);
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
    expect(verifyMock).not.toHaveBeenCalled();
    expect(client.listConnectors).not.toHaveBeenCalled();
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

describe("Jira Live Pod creation", () => {
  it("accepts an HTTPS target without an email and submits one private PAT request", async () => {
    const user = userEvent.setup();
    let complete: ((value: AtlassianConnectorMetadata) => void) | undefined;
    const client = makeClient({
      createConnector: vi.fn(
        () =>
          new Promise<AtlassianConnectorMetadata>((resolve) => {
            complete = resolve;
          }),
      ),
      listConnectors: vi.fn(async () => [VERIFIED_JIRA]),
    });
    const created = vi.fn();
    const close = vi.fn();
    render(<AddConnectorForm client={client} onCreated={created} onClose={close} jiraLive />);
    expect(screen.queryByLabelText("Account email")).toBeNull();
    expect(screen.queryByLabelText("Provider")).toBeNull();
    // A Jira Pod connects Jira Data Center: no Confluence or Atlassian Cloud example.
    expect(screen.getByLabelText("Label")).toHaveAttribute("placeholder", "e.g. Jira Data Center");
    expect(screen.getByLabelText("Base URL")).toHaveAttribute(
      "placeholder",
      "https://jira.example.com",
    );
    await user.type(screen.getByLabelText("Label"), "Lab Jira");
    await user.type(screen.getByLabelText("Base URL"), "https://127.0.0.1:18443/jira");
    await user.type(screen.getByLabelText("API token"), TOKEN);
    fireEvent.submit(screen.getByTestId("acx-add-form"));
    fireEvent.submit(screen.getByTestId("acx-add-form"));
    expect(client.createConnector).toHaveBeenCalledTimes(1);
    const input = vi.mocked(client.createConnector).mock.calls[0]?.[0];
    expect(input).toMatchObject({
      provider: "jira",
      deployment: "data-center",
      authScheme: "bearer-pat",
      displayName: "Lab Jira",
      apiToken: TOKEN,
    });
    expect(input).not.toHaveProperty("accountEmail");
    expect(input).not.toHaveProperty("privateTargets");
    expect(input).not.toHaveProperty("addressClass");
    expect(input).toHaveProperty("livePodCreationRequestId", expect.any(String));
    if (complete === undefined) throw new Error("Missing create completion");
    complete(CREATED_JIRA);
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("acx-add-verify")).toBeNull();
    expect(screen.queryByDisplayValue(TOKEN)).toBeNull();
    expect(created).toHaveBeenCalledOnce();
    expect(created).toHaveBeenCalledWith(VERIFIED_JIRA);
    expect(client.verifyConnector).toHaveBeenCalledExactlyOnceWith(CREATED_JIRA.authRef);
    expect(client.listConnectors).toHaveBeenCalledOnce();
  });

  it("keeps Enter and all form controls busy until automatic verification finishes", async () => {
    const user = userEvent.setup();
    let finish: ((result: { authRef: string; status: "ok" }) => void) | undefined;
    const client = makeClient({
      createConnector: vi.fn(async () => CREATED_JIRA),
      verifyConnector: vi.fn(
        () =>
          new Promise<{ authRef: string; status: "ok" }>((resolve) => {
            finish = resolve;
          }),
      ),
      listConnectors: vi.fn(async () => [VERIFIED_JIRA]),
    });
    const created = vi.fn();
    const close = vi.fn();
    render(<AddConnectorForm client={client} onCreated={created} onClose={close} jiraLive />);
    await fillJira(user);
    fireEvent.submit(screen.getByTestId("acx-add-form"));
    fireEvent.submit(screen.getByTestId("acx-add-form"));
    const verifying = await screen.findByRole("button", { name: "Verifying…" });
    expect(verifying).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByLabelText("API token")).toHaveValue("");
    expect(screen.getByLabelText("Base URL")).toBeDisabled();
    expect(screen.getByTestId("acx-add-form")).toHaveAttribute("aria-busy", "true");
    fireEvent.submit(screen.getByTestId("acx-add-form"));
    expect(client.createConnector).toHaveBeenCalledOnce();
    expect(client.verifyConnector).toHaveBeenCalledExactlyOnceWith(CREATED_JIRA.authRef);
    expect(close).not.toHaveBeenCalled();
    finish?.({ authRef: CREATED_JIRA.authRef, status: "ok" });
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(created).toHaveBeenCalledExactlyOnceWith(VERIFIED_JIRA);
  });

  it("keeps a created Pod and publishes its authoritative failed verification without retrying creation", async () => {
    const failed = {
      ...CREATED_JIRA,
      generation: 2,
      livePod: {
        ...CREATED_JIRA.livePod,
        authenticationGeneration: 2,
        verificationRevision: 2,
        verificationStatus: "auth-failed" as const,
      },
    };
    const client = makeClient({
      createConnector: vi.fn(async () => CREATED_JIRA),
      verifyConnector: vi.fn(async () => ({
        authRef: CREATED_JIRA.authRef,
        status: "auth-failed" as const,
      })),
      listConnectors: vi.fn(async () => [failed]),
    });
    const created = vi.fn();
    const close = vi.fn();
    render(<AddConnectorForm client={client} onCreated={created} onClose={close} jiraLive />);
    await fillJira(userEvent.setup());
    await userEvent.click(screen.getByRole("button", { name: "Create Jira Pod" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(created).toHaveBeenCalledExactlyOnceWith(failed);
    expect(client.createConnector).toHaveBeenCalledOnce();
    expect(client.verifyConnector).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("acx-add-verify")).toBeNull();
  });

  it("treats a rejected verification response as post-create repair and does not expose upstream text", async () => {
    const diagnostic = vi.spyOn(diagnostics, "reportClientDiagnostic");
    const client = makeClient({
      createConnector: vi.fn(async () => CREATED_JIRA),
      verifyConnector: vi.fn(async () => {
        throw new ApiError("INTERNAL", TOKEN, 500);
      }),
      listConnectors: vi.fn(async () => [CREATED_JIRA]),
    });
    const created = vi.fn();
    const close = vi.fn();
    const { container } = render(
      <AddConnectorForm client={client} onCreated={created} onClose={close} jiraLive />,
    );
    await fillJira(userEvent.setup());
    await userEvent.click(screen.getByRole("button", { name: "Create Jira Pod" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(created).toHaveBeenCalledExactlyOnceWith(CREATED_JIRA);
    expect(client.createConnector).toHaveBeenCalledOnce();
    expect(client.verifyConnector).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(container.innerHTML).not.toContain(TOKEN);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(TOKEN);
  });

  it("keeps the unverified created record if the metadata refresh fails after verification", async () => {
    const client = makeClient({
      createConnector: vi.fn(async () => CREATED_JIRA),
      listConnectors: vi.fn(async () => {
        throw new Error("metadata unavailable");
      }),
    });
    const created = vi.fn();
    const close = vi.fn();
    render(<AddConnectorForm client={client} onCreated={created} onClose={close} jiraLive />);
    await fillJira(userEvent.setup());
    await userEvent.click(screen.getByRole("button", { name: "Create Jira Pod" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(created).toHaveBeenCalledExactlyOnceWith(CREATED_JIRA);
    expect(client.createConnector).toHaveBeenCalledOnce();
    expect(client.verifyConnector).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

it("retains the Jira creation identity when an uncertain response is retried", async () => {
  const user = userEvent.setup();
  const create = vi
    .fn<AddConnectorClient["createConnector"]>()
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce(METADATA);
  const close = vi.fn();
  render(
    <AddConnectorForm
      client={makeClient({ createConnector: create })}
      onCreated={vi.fn()}
      onClose={close}
      jiraLive
    />,
  );
  await user.type(screen.getByLabelText("Label"), "Lab Jira");
  await user.type(screen.getByLabelText("Base URL"), "https://jira.example.invalid");
  await user.type(screen.getByLabelText("API token"), TOKEN);
  await user.click(screen.getByRole("button", { name: "Create Jira Pod" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("API token")).toHaveValue("");
  await user.type(screen.getByLabelText("API token"), TOKEN);
  await user.click(screen.getByRole("button", { name: "Create Jira Pod" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1]?.[0]).toEqual(create.mock.calls[0]?.[0]);
});

it("drops a late create response after unmount and never retains the submitted PAT", async () => {
  const user = userEvent.setup();
  const releases: Array<(metadata: AtlassianConnectorMetadata) => void> = [];
  const created = vi.fn();
  const client = makeClient({
    createConnector: vi.fn(
      () => new Promise<AtlassianConnectorMetadata>((resolve) => releases.push(resolve)),
    ),
  });
  const { unmount } = render(
    <AddConnectorForm client={client} onCreated={created} onClose={vi.fn()} />,
  );
  await fillValid(user);
  await user.click(screen.getByRole("button", { name: "Save connector" }));
  expect(screen.getByLabelText("API token")).toHaveValue("");
  unmount();
  releases[0]?.(METADATA);
  await Promise.resolve();
  expect(created).not.toHaveBeenCalled();
});

it("clears a typed PAT when the form is cancelled", async () => {
  const close = vi.fn();
  render(<AddConnectorForm client={makeClient()} onCreated={vi.fn()} onClose={close} />);
  await userEvent.type(screen.getByLabelText("API token"), TOKEN);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByLabelText("API token")).toHaveValue("");
  expect(close).toHaveBeenCalledOnce();
});
