import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import type { AtlassianConnectorMetadata } from "@/lib/atlassian-connectors-api";
import type { ReactNode } from "react";
import { LivePodHeader, type LivePodState } from "./LivePodCard";

const connector: AtlassianConnectorMetadata = {
  schemaVersion: "1",
  authRef: "atlassian-cred:AAAAAAAAAAAAAAAAAAAAAA",
  provider: "jira",
  displayName: "Jira workspace",
  baseUrl: "https://private-jira.example",
  authScheme: "basic-api-token",
  createdAt: 1_700_000_000_000,
};

const embeddedConnectors: readonly AtlassianConnectorMetadata[] = [
  { ...connector, deployment: "cloud" },
  {
    ...connector,
    provider: "jira",
    deployment: "data-center",
    authScheme: "bearer-pat",
    generation: 1,
  },
];

it.each(embeddedConnectors)(
  "keeps an embedded $deployment fallback to icon and name without inventing a drag capability",
  (fixture) => {
    const { container } = render(
      <LivePodHeader connector={fixture} state={{ kind: "ready" }} actions={null} embedded />,
    );
    expect(screen.getByText(connector.displayName)).toBeVisible();
    expect(screen.getByRole("img", { name: "Jira" })).toBeVisible();
    expect(container.innerHTML).not.toContain(connector.baseUrl);
    expect(container.querySelector("[draggable]")).toBeNull();
  },
);

it("retains the address and readiness chip in standalone connector settings", () => {
  render(
    <LivePodHeader
      connector={connector}
      state={{ kind: "ready" }}
      actions={null}
      embedded={false}
    />,
  );
  expect(screen.getByText(connector.baseUrl)).toHaveAttribute("title", connector.baseUrl);
  expect(screen.getByTestId("acx-pod-state")).toBeVisible();
});

// #4371 F01: a person who just connected a Pod must SEE that it is connected and ready, in the
// words of the connection page; a card loaded at rest stays silent.
function embeddedHeader(state: LivePodState): ReactNode {
  return <LivePodHeader connector={connector} state={state} actions={null} embedded />;
}

it("shows the verified outcome of a check run in this view, in the connection page's words", () => {
  const { rerender } = render(embeddedHeader({ kind: "verifying" }));
  rerender(embeddedHeader({ kind: "ready" }));
  const status = screen.getByTestId("acx-verify-status");
  expect(status).toBeVisible();
  expect(status).not.toHaveClass("sr-only");
  expect(status).toHaveAttribute("data-status", "ok");
  expect(within(status).getByText("Connection verified")).toBeVisible();
});

it("keeps a card that was loaded ready silent", () => {
  render(embeddedHeader({ kind: "ready" }));
  expect(screen.getByTestId("acx-verify-status")).toBeEmptyDOMElement();
});

it("keeps the reason of a failed check visible beside the chip", () => {
  const { rerender } = render(embeddedHeader({ kind: "verifying" }));
  rerender(embeddedHeader({ kind: "failed", status: "auth-failed" }));
  expect(screen.getByTestId("acx-pod-state")).toHaveTextContent("Authentication failed");
  expect(document.querySelector(".acx-hint")).toHaveTextContent(/The token was rejected/u);
});
