import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectorsMenu,
  activeConnectorCount,
  nextServerSelection,
  type ConnectorsMenuProps,
} from "./ConnectorsMenu";
import type { McpServerChoice } from "./useMcpServerChoices";
import type { PodChoice } from "./useJiraPodChoices";

const SERVERS: readonly McpServerChoice[] = [
  { name: "wiki", state: "connected" },
  { name: "build", state: "attention" },
  { name: "alpha", state: "idle" },
];
const PODS: readonly PodChoice[] = [
  { id: "pod-one", name: "Lab Jira", ready: true },
  { id: "pod-two", name: "Staging Jira", ready: false },
];

function props(overrides: Partial<ConnectorsMenuProps> = {}): ConnectorsMenuProps {
  return {
    servers: SERVERS,
    selectedServers: undefined,
    pods: PODS,
    boundPodId: undefined,
    loading: false,
    busy: false,
    failed: false,
    onServersChange: vi.fn(),
    onPodChange: vi.fn(),
    ...overrides,
  };
}

async function openMenu(
  user: ReturnType<typeof userEvent.setup>,
  name: string | RegExp = /Connectors/,
): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name }));
  return screen.getByRole("region", { name: "Connectors" });
}

describe("nextServerSelection", () => {
  it("returns null once every enabled server is selected", () => {
    expect(nextServerSelection(SERVERS, ["alpha", "build"], "wiki", true)).toBeNull();
    expect(nextServerSelection(SERVERS, undefined, "wiki", true)).toBeNull();
  });

  it("stores a narrower selection sorted when a server is switched off from the default", () => {
    expect(nextServerSelection(SERVERS, undefined, "build", false)).toEqual(["alpha", "wiki"]);
  });

  it("adds a server to a narrower selection and keeps it sorted", () => {
    expect(nextServerSelection(SERVERS, ["wiki"], "alpha", true)).toEqual(["alpha", "wiki"]);
  });

  it("removes the last selected server into an empty selection", () => {
    expect(nextServerSelection(SERVERS, ["wiki"], "wiki", false)).toEqual([]);
  });

  it("drops stored names that are no longer enabled servers", () => {
    expect(nextServerSelection(SERVERS, ["gone", "wiki"], "alpha", true)).toEqual([
      "alpha",
      "wiki",
    ]);
    expect(nextServerSelection(SERVERS, ["gone", "wiki"], "wiki", false)).toEqual([]);
  });

  it("treats a switch that changes nothing as unchanged", () => {
    expect(nextServerSelection(SERVERS, ["wiki"], "wiki", true)).toEqual(["wiki"]);
    expect(nextServerSelection(SERVERS, ["wiki"], "alpha", false)).toEqual(["wiki"]);
  });

  it("returns null for an empty server list because nothing is left unselected", () => {
    expect(nextServerSelection([], undefined, "wiki", true)).toBeNull();
    expect(nextServerSelection([], [], "wiki", false)).toBeNull();
  });
});

describe("activeConnectorCount", () => {
  it("counts every enabled server when nothing is selected explicitly", () => {
    expect(activeConnectorCount(SERVERS, undefined, undefined)).toBe(3);
  });

  it("counts only selected servers that exist", () => {
    expect(activeConnectorCount(SERVERS, ["wiki", "gone"], undefined)).toBe(1);
    expect(activeConnectorCount(SERVERS, [], undefined)).toBe(0);
  });

  it("adds the bound pod", () => {
    expect(activeConnectorCount(SERVERS, [], "pod-one")).toBe(1);
    expect(activeConnectorCount(SERVERS, undefined, "pod-one")).toBe(4);
    expect(activeConnectorCount([], undefined, undefined)).toBe(0);
  });
});

describe("ConnectorsMenu", () => {
  it("labels the trigger with the active count and plain when none is active", () => {
    const { rerender } = render(<ConnectorsMenu {...props()} />);
    expect(screen.getByRole("button", { name: "Connectors: 3 active" })).toHaveTextContent("3");
    rerender(<ConnectorsMenu {...props({ selectedServers: [] })} />);
    const trigger = screen.getByRole("button", { name: "Connectors" });
    expect(trigger).not.toHaveTextContent(/\d/u);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("opens a labelled panel with both sections, reports the open and toggles it shut", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<ConnectorsMenu {...props({ onOpen })} />);
    const panel = await openMenu(user);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: /Connectors/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(within(panel).getByRole("region", { name: "MCP servers" })).toBeVisible();
    expect(within(panel).getByRole("region", { name: "Jira Pods" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Connectors/ }));
    expect(screen.queryByRole("region", { name: "Connectors" })).toBeNull();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("opens without an onOpen callback", async () => {
    const user = userEvent.setup();
    render(<ConnectorsMenu {...props()} />);
    expect(await openMenu(user)).toBeVisible();
  });

  it("shows every server as on by default and flags one that needs attention", async () => {
    const user = userEvent.setup();
    render(<ConnectorsMenu {...props()} />);
    const panel = await openMenu(user);
    for (const name of ["wiki", "build", "alpha"]) {
      expect(within(panel).getByRole("switch", { name: new RegExp(name) })).toBeChecked();
    }
    expect(within(panel).getByRole("switch", { name: /build/ })).toHaveTextContent("Check");
    expect(within(panel).getByRole("switch", { name: /wiki/ })).not.toHaveTextContent("Check");
  });

  it("reflects an explicit server selection", async () => {
    const user = userEvent.setup();
    render(<ConnectorsMenu {...props({ selectedServers: ["wiki"] })} />);
    const panel = await openMenu(user);
    expect(within(panel).getByRole("switch", { name: /wiki/ })).toBeChecked();
    expect(within(panel).getByRole("switch", { name: /build/ })).not.toBeChecked();
  });

  it("switching a server off from the default reports the sorted remaining selection", async () => {
    const user = userEvent.setup();
    const onServersChange = vi.fn();
    render(<ConnectorsMenu {...props({ onServersChange })} />);
    const panel = await openMenu(user);
    await user.click(within(panel).getByRole("switch", { name: /build/ }));
    expect(onServersChange).toHaveBeenCalledExactlyOnceWith(["alpha", "wiki"]);
  });

  it("switching the last missing server on reports no selection", async () => {
    const user = userEvent.setup();
    const onServersChange = vi.fn();
    render(<ConnectorsMenu {...props({ selectedServers: ["alpha", "wiki"], onServersChange })} />);
    const panel = await openMenu(user);
    await user.click(within(panel).getByRole("switch", { name: /build/ }));
    expect(onServersChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("shows the empty hints only when nothing is offered and nothing is loading", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ConnectorsMenu {...props({ servers: [], pods: [] })} />);
    const panel = await openMenu(user);
    expect(within(panel).getByText("No MCP servers set up")).toBeVisible();
    expect(within(panel).getByText("No Jira Pods yet")).toBeVisible();
    rerender(<ConnectorsMenu {...props({ servers: [], pods: [], loading: true })} />);
    expect(screen.queryByText("No MCP servers set up")).toBeNull();
    expect(screen.queryByText("No Jira Pods yet")).toBeNull();
    expect(screen.getByRole("region", { name: "Connectors" })).toHaveAttribute("aria-busy", "true");
  });

  it("binds a ready pod, unbinds the bound one and disables a not-ready unbound pod", async () => {
    const user = userEvent.setup();
    const onPodChange = vi.fn();
    const { rerender } = render(<ConnectorsMenu {...props({ onPodChange })} />);
    let panel = await openMenu(user);
    expect(within(panel).getByRole("switch", { name: /Lab Jira/ })).not.toBeChecked();
    const notReady = within(panel).getByRole("switch", { name: /Staging Jira/ });
    expect(notReady).toBeDisabled();
    expect(notReady).toHaveTextContent("Verification required");
    await user.click(within(panel).getByRole("switch", { name: /Lab Jira/ }));
    expect(onPodChange).toHaveBeenLastCalledWith("pod-one");

    rerender(<ConnectorsMenu {...props({ onPodChange, boundPodId: "pod-one" })} />);
    panel = screen.getByRole("region", { name: "Connectors" });
    await user.click(within(panel).getByRole("switch", { name: /Lab Jira/ }));
    expect(onPodChange).toHaveBeenLastCalledWith(null);
    expect(onPodChange).toHaveBeenCalledTimes(2);
  });

  it("keeps a bound pod that is not ready switchable so it can be unbound", async () => {
    const user = userEvent.setup();
    const onPodChange = vi.fn();
    render(<ConnectorsMenu {...props({ onPodChange, boundPodId: "pod-two" })} />);
    const panel = await openMenu(user);
    const bound = within(panel).getByRole("switch", { name: /Staging Jira/ });
    expect(bound).toBeEnabled();
    expect(bound).toBeChecked();
    await user.click(bound);
    expect(onPodChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("offers an unavailable bound pod as an on row that unbinds, but not while loading", async () => {
    const user = userEvent.setup();
    const onPodChange = vi.fn();
    const { rerender } = render(
      <ConnectorsMenu {...props({ onPodChange, pods: [], boundPodId: "deleted-pod" })} />,
    );
    const panel = await openMenu(user);
    const row = within(panel).getByRole("switch", { name: /Current Pod unavailable/ });
    expect(row).toBeChecked();
    expect(within(panel).queryByText("No Jira Pods yet")).toBeNull();
    await user.click(row);
    expect(onPodChange).toHaveBeenCalledExactlyOnceWith(null);

    rerender(
      <ConnectorsMenu
        {...props({ onPodChange, pods: [], boundPodId: "deleted-pod", loading: true })}
      />,
    );
    expect(screen.queryByRole("switch", { name: /Current Pod unavailable/ })).toBeNull();
  });

  it("disables every switch while busy", async () => {
    const user = userEvent.setup();
    render(<ConnectorsMenu {...props({ busy: true, boundPodId: "pod-two" })} />);
    const panel = await openMenu(user);
    for (const row of within(panel).getAllByRole("switch")) expect(row).toBeDisabled();
  });

  it("shows the failure alert only after a failed save", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ConnectorsMenu {...props()} />);
    await openMenu(user);
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<ConnectorsMenu {...props({ failed: true })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Not saved. Try again.");
  });

  it("renders no access group without a mode", async () => {
    const user = userEvent.setup();
    render(<ConnectorsMenu {...props()} />);
    const panel = await openMenu(user);
    expect(within(panel).queryByRole("radiogroup")).toBeNull();
  });

  it("offers the three modes, marks the current one and reports a change", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ConnectorsMenu
        {...props({
          mode: { value: "governed-assist", ceiling: "autonomous-delivery", onChange },
        })}
      />,
    );
    const panel = await openMenu(user);
    const group = within(panel).getByRole("radiogroup", { name: "Access" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.textContent)).toEqual([
      "Ask for approval",
      "Supervised workspace",
      "Full access",
    ]);
    expect(within(group).getByRole("radio", { name: "Ask for approval" })).toBeChecked();
    expect(within(group).getByRole("radio", { name: "Full access" })).not.toBeChecked();
    await user.click(within(group).getByRole("radio", { name: "Full access" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("autonomous-delivery");
  });

  it("disables modes above the ceiling and every mode while busy", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const mode = { value: "supervised-coding", ceiling: "supervised-coding", onChange } as const;
    const { rerender } = render(<ConnectorsMenu {...props({ mode })} />);
    const panel = await openMenu(user);
    expect(within(panel).getByRole("radio", { name: "Full access" })).toBeDisabled();
    expect(within(panel).getByRole("radio", { name: "Supervised workspace" })).toBeEnabled();
    await user.click(within(panel).getByRole("radio", { name: "Full access" }));
    expect(onChange).not.toHaveBeenCalled();
    rerender(<ConnectorsMenu {...props({ mode, busy: true })} />);
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
  });

  it("renders a Manage button per section only when its handler is given", async () => {
    const user = userEvent.setup();
    const onManageServers = vi.fn();
    const onManagePods = vi.fn();
    const { rerender } = render(<ConnectorsMenu {...props()} />);
    await openMenu(user);
    expect(screen.queryByRole("button", { name: /: Manage/ })).toBeNull();

    rerender(<ConnectorsMenu {...props({ onManageServers, onManagePods })} />);
    const servers = screen.getByRole("region", { name: "MCP servers" });
    const pods = screen.getByRole("region", { name: "Jira Pods" });
    await user.click(within(servers).getByRole("button", { name: "MCP servers: Manage" }));
    expect(onManageServers).toHaveBeenCalledOnce();
    expect(onManagePods).not.toHaveBeenCalled();
    await user.click(within(pods).getByRole("button", { name: "Jira Pods: Manage" }));
    expect(onManagePods).toHaveBeenCalledOnce();
  });

  it("shows a Manage button for one section only", async () => {
    const user = userEvent.setup();
    render(<ConnectorsMenu {...props({ onManagePods: vi.fn() })} />);
    await openMenu(user);
    expect(
      within(screen.getByRole("region", { name: "MCP servers" })).queryByRole("button", {
        name: "MCP servers: Manage",
      }),
    ).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Jira Pods" })).getByRole("button", {
        name: "Jira Pods: Manage",
      }),
    ).toBeVisible();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<ConnectorsMenu {...props()} />);
    const panel = await openMenu(user);
    within(panel).getAllByRole("switch")[0]?.focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Connectors" })).toBeNull();
    expect(screen.getByRole("button", { name: /Connectors/ })).toHaveFocus();
  });

  it("closes on a pointer press outside and stays open for one inside", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">outside</button>
        <ConnectorsMenu {...props()} />
      </div>,
    );
    const panel = await openMenu(user);
    await user.click(within(panel).getAllByRole("switch")[0] as HTMLElement);
    expect(screen.getByRole("region", { name: "Connectors" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("region", { name: "Connectors" })).toBeNull();
  });

  it("has no axe violations closed, open, with an access group and with a failure", async () => {
    const user = userEvent.setup();
    const mode = {
      value: "governed-assist",
      ceiling: "autonomous-delivery",
      onChange: vi.fn(),
    } as const;
    const { container, rerender } = render(<ConnectorsMenu {...props()} />);
    expect(await axe(container)).toHaveNoViolations();
    await openMenu(user);
    rerender(
      <ConnectorsMenu
        {...props({
          mode,
          failed: true,
          boundPodId: "pod-one",
          onManageServers: vi.fn(),
          onManagePods: vi.fn(),
        })}
      />,
    );
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
