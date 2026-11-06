import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { AtlassianConnectorMetadata } from "@/lib/atlassian-connectors-api";
import { LivePodHeader } from "./LivePodCard";

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
