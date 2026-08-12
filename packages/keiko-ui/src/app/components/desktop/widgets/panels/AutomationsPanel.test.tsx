// KEIKO-0158 — Automations is an honest placeholder: no scheduler runs behind it, so the
// rows must not impersonate a live switch, and no fake setting may survive a reload.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationsPanel } from "./AutomationsPanel";

describe("AutomationsPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  // A test that replaces a prototype method owns putting it back (see the equivalent note
  // this file carried before KEIKO-0158 — the panel no longer touches Storage.prototype at
  // all, but a future spy in this file should not leak into later tests either).
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders automation rows as honest, non-interactive status text", () => {
    render(<AutomationsPanel />);

    expect(screen.getByText("Nightly review")).toBeInTheDocument();
    expect(screen.getByText("02:00 daily")).toBeInTheDocument();
    expect(screen.getByText("On push → lint")).toBeInTheDocument();
    expect(screen.getByText("Weekly digest")).toBeInTheDocument();

    // GEN-UI-INTERACTION-002 (KEIKO-0158): nothing here controls a real scheduler, so no
    // row may expose switch or button semantics.
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);

    // Status is carried by visible copy instead of aria-checked.
    expect(screen.getAllByText("On")).toHaveLength(2);
    expect(screen.getAllByText("Off")).toHaveLength(1);
  });

  it("does not write to window.localStorage when a row is clicked", async () => {
    const user = userEvent.setup();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const { container } = render(<AutomationsPanel />);

    const row = container.querySelector(".auto-row");
    expect(row).not.toBeNull();
    await user.click(row as Element);
    // Click exactly where the old interactive control used to sit (the row's trailing
    // element) — the row itself never had a click handler even before KEIKO-0158, so
    // clicking only the row would pass trivially either way and prove nothing.
    const trailing = row?.lastElementChild;
    expect(trailing).toBeTruthy();
    await user.click(trailing as Element);

    expect(setItemSpy).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("keiko.automations.v1")).toBeNull();
  });

  it("ignores any pre-existing keiko.automations.v1 entry — no fake setting survives a reload", () => {
    window.localStorage.setItem(
      "keiko.automations.v1",
      JSON.stringify({ "nightly-review": false, "weekly-digest": true }),
    );

    render(<AutomationsPanel />);

    // The rows still reflect the fixed, honest defaults — not whatever a previous session
    // (or a hand-crafted storage entry) left behind.
    expect(screen.getAllByText("On")).toHaveLength(2);
    expect(screen.getAllByText("Off")).toHaveLength(1);
  });
});
