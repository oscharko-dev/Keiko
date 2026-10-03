import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFilesSearch, fetchWorkspaceSearch, fetchWorkspaceSymbols } from "@/lib/api";
import { DesktopCommandPalette, CommandPalette } from "./CommandPalette";
import type { PaletteCommand } from "../workspaceCommands";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";

vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));

vi.mock("@/lib/api", async () => ({
  ...(await vi.importActual<typeof import("@/lib/api")>("@/lib/api")),
  fetchFilesSearch: vi.fn(),
  fetchWorkspaceSearch: vi.fn(),
  fetchWorkspaceSymbols: vi.fn(),
}));

function command(id: string, label: string): PaletteCommand {
  return { id, label, group: "Test", run: vi.fn() };
}

afterEach(() => vi.clearAllMocks());

describe("CommandPalette", () => {
  it("records command-only palette lifecycle without query or command contents", async () => {
    const { unmount } = render(
      <CommandPalette commands={[command("private-command", "Private label")]} onClose={vi.fn()} />,
    );
    await userEvent.type(screen.getByRole("combobox", { name: "Command query" }), "private query");
    unmount();
    const reports = vi.mocked(reportClientDiagnostic).mock.calls;
    expect(reports).toHaveLength(2);
    expect(reports[0]?.[1]?.stageReport).toMatchObject({
      stage: "command palette",
      phase: "started",
    });
    expect(reports[1]?.[1]?.stageReport).toMatchObject({
      stage: "command palette",
      phase: "settled",
    });
    expect(reports[1]?.[1]?.correlationId).toBe(reports[0]?.[1]?.correlationId);
    expect(JSON.stringify(reports)).not.toMatch(/private query|private-command|Private label/u);
  });
  it("never queries workspace files, text or symbols when filtering commands", async () => {
    render(<CommandPalette commands={[]} onClose={vi.fn()} />);
    await userEvent.type(screen.getByRole("combobox", { name: "Command query" }), "src/probe.ts");
    expect(fetchFilesSearch).not.toHaveBeenCalled();
    expect(fetchWorkspaceSearch).not.toHaveBeenCalled();
    expect(fetchWorkspaceSymbols).not.toHaveBeenCalled();
  });
  it("has no axe violations", async () => {
    const { container } = render(
      <CommandPalette commands={[command("theme", "Change theme")]} onClose={vi.fn()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("builds desktop commands with current shortcut labels and executes the selected action", async () => {
    const run = vi.fn();
    const onClose = vi.fn();
    const props = {
      appCommands: [{ id: "theme", label: "Change theme", icon: "spark" as const, run }],
      editorHost: null,
      onClose,
    };
    const { rerender } = render(
      <DesktopCommandPalette {...props} shortcutLabels={new Map([["theme", "Alt+T"]])} />,
    );
    expect(await screen.findByRole("option", { name: /Change theme/ })).toHaveTextContent("Alt+T");
    rerender(<DesktopCommandPalette {...props} shortcutLabels={new Map([["theme", "Alt+Y"]])} />);
    const option = screen.getByRole("option", { name: /Change theme/ });
    expect(option).toHaveTextContent("Alt+Y");
    expect(option).not.toHaveTextContent("Alt+T");
    await userEvent.click(option);
    expect(run).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("restores the opener captured before the lazy palette mounts", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const capturedOpener = document.activeElement as HTMLElement;
    capturedOpener.blur();

    const { unmount } = render(
      <CommandPalette commands={[]} opener={capturedOpener} onClose={vi.fn()} />,
    );
    unmount();

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("uses the top window fallback when no opener was captured", () => {
    const topWindow = document.createElement("button");
    topWindow.className = "window";
    topWindow.dataset.top = "true";
    document.body.appendChild(topWindow);

    const { unmount } = render(<CommandPalette commands={[]} opener={null} onClose={vi.fn()} />);
    unmount();

    expect(document.activeElement).toBe(topWindow);
    topWindow.remove();
  });

  it("uses the FAB fallback instead of document.body", () => {
    const fab = document.createElement("button");
    fab.className = "ws-fab";
    document.body.appendChild(fab);

    const { unmount } = render(
      <CommandPalette commands={[]} opener={document.body} onClose={vi.fn()} />,
    );
    unmount();

    expect(document.activeElement).toBe(fab);
    fab.remove();
  });

  it("uses the body fallback when the captured opener was disconnected", () => {
    const opener = document.createElement("button");

    const { unmount } = render(<CommandPalette commands={[]} opener={opener} onClose={vi.fn()} />);
    unmount();

    expect(document.activeElement).toBe(document.body);
  });

  it("filters and runs commands without initiating file or symbol searches", async () => {
    const run = vi.fn();
    render(
      <CommandPalette
        commands={[{ ...command("theme", "Toggle light / dark theme"), run }]}
        onClose={vi.fn()}
      />,
    );

    await userEvent.type(screen.getByRole("combobox"), ">theme");
    await userEvent.click(
      await screen.findByRole("option", { name: /Toggle light \/ dark theme/ }),
    );

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps the newly focused top window active after a command closes the palette", async () => {
    const opener = document.createElement("button");
    const activatedWindow = document.createElement("button");
    activatedWindow.className = "window";
    activatedWindow.dataset.top = "true";
    document.body.append(opener, activatedWindow);
    const { unmount } = render(
      <CommandPalette
        commands={[command("open-problems", "Open Problems")]}
        opener={opener}
        onClose={vi.fn()}
      />,
    );

    await userEvent.click(await screen.findByRole("option", { name: /Open Problems/ }));
    unmount();

    expect(document.activeElement).toBe(activatedWindow);
    opener.remove();
    activatedWindow.remove();
  });

  it("keeps the combobox active-descendant contract available to screen readers", async () => {
    render(
      <CommandPalette
        commands={[command("theme", "Toggle light / dark theme")]}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByRole("combobox");
    const listbox = screen.getByRole("listbox");
    const option = await screen.findByRole("option", { name: /Toggle light \/ dark theme/ });

    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(input).toHaveAttribute("aria-activedescendant", option.id);
    expect(option).toHaveAttribute("aria-selected", "true");
  });

  it("keeps active-descendant navigation inside currently rendered command options", async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette
        commands={[command("first", "First command"), command("second", "Second command")]}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByRole("combobox");
    const first = await screen.findByRole("option", { name: /First command/ });
    const second = screen.getByRole("option", { name: /Second command/ });
    input.focus();

    await user.keyboard("{ArrowUp}");
    expect(input).toHaveAttribute("aria-activedescendant", second.id);
    await user.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant", first.id);
    await user.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant", second.id);

    await user.clear(input);
    await user.type(input, ">first");
    await waitFor(() => {
      const activeId = input.getAttribute("aria-activedescendant");
      expect(activeId).toBe(screen.getByRole("option", { name: /First command/ }).id);
      expect(document.getElementById(activeId ?? "")).not.toBeNull();
    });
  });

  it("omits active-descendant for empty and hostile command queries", async () => {
    render(<CommandPalette commands={[command("first", "First command")]} onClose={vi.fn()} />);

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: ">missing" } });
    await waitFor(() => expect(input).not.toHaveAttribute("aria-activedescendant"));

    fireEvent.change(input, { target: { value: "><img src=x>\u0007" } });
    await waitFor(() => {
      expect(input).not.toHaveAttribute("aria-activedescendant");
      expect(screen.getByRole("option")).toBeDisabled();
    });
  });

  it("renders a command's keyboard shortcut chip when the command defines one", async () => {
    render(
      <CommandPalette
        commands={[{ ...command("theme", "Toggle light / dark theme"), shortcut: "⌘K" }]}
        onClose={vi.fn()}
      />,
    );

    const option = await screen.findByRole("option", { name: /Toggle light \/ dark theme/ });
    expect(option).toHaveTextContent("⌘K");
  });
});

it("dismisses Escape when the dialog itself owns focus", () => {
  const onClose = vi.fn();
  render(<CommandPalette commands={[]} onClose={onClose} />);
  const dialog = screen.getByRole("dialog");
  dialog.focus();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
});
