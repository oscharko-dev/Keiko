import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationsPanel } from "./AutomationsPanel";

describe("AutomationsPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  // A test that replaces a prototype method owns putting it back. The persistence-failure case
  // below stubs `Storage.prototype.setItem` to throw, and neither the vitest configs (no
  // `restoreMocks`) nor the shared teardown in vitest.setup.ts undoes that — so without this hook
  // storage stays write-dead for every later test in the file. The panel swallows write failures by
  // design, so the leak surfaces as silently stale `keiko.automations.v1` reads rather than an
  // error, and only under a shuffled order (`--sequence.shuffle.tests`) where the stubbing test runs
  // first. Restoring here rather than in a `finally` inside that one test makes the whole class
  // impossible for any future spy in this file.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders default automation states and persists toggles", async () => {
    const user = userEvent.setup();
    render(<AutomationsPanel />);

    expect(screen.getByText("Nightly review")).toBeInTheDocument();
    expect(screen.getByText("02:00 daily")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Nightly review" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("switch", { name: "Weekly digest" })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    await user.click(screen.getByRole("switch", { name: "Weekly digest" }));

    expect(screen.getByRole("switch", { name: "Weekly digest" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(JSON.parse(window.localStorage.getItem("keiko.automations.v1") ?? "{}")).toMatchObject({
      "weekly-digest": true,
    });
  });

  it("loads only known boolean values from storage and falls back on malformed state", () => {
    window.localStorage.setItem(
      "keiko.automations.v1",
      JSON.stringify({
        "nightly-review": false,
        "weekly-digest": true,
        "unknown-job": true,
        "on-push-lint": "yes",
      }),
    );

    const { unmount } = render(<AutomationsPanel />);

    expect(screen.getByRole("switch", { name: "Nightly review" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("switch", { name: "On push → lint" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("switch", { name: "Weekly digest" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    unmount();
    window.localStorage.setItem("keiko.automations.v1", "{bad json");
    render(<AutomationsPanel />);
    expect(screen.getByRole("switch", { name: "Nightly review" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("keeps the UI responsive when localStorage persistence throws", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const user = userEvent.setup();

    render(<AutomationsPanel />);

    await user.click(screen.getByRole("switch", { name: "Weekly digest" }));

    expect(screen.getByRole("switch", { name: "Weekly digest" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});
