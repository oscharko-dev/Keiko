// F2 — TwinContext read `keiko.twin.policy` / `keiko.twin.bridges` from localStorage through a
// generic `readJson<T>` that blind-casts the parsed JSON (`parsed as T`) with zero shape
// validation. A malformed persisted value throws INSIDE the Keiko Twin panel's render
// (`policy.map` is not a function on a non-array; `DEC_META[r.decision]` is undefined for an
// unrecognized decision string) once the post-mount hydration effect adopts it.
// WindowBodyBoundary (the panel's real host inside a workspace window) only degrades the panel
// to its generic retry fallback — it offers no in-product way to see or fix the twin governance
// policy that got corrupted. These tests fail on the pre-fix TwinContext because the hydration
// effect's re-render throws inside the boundary; after validating the shape at read time (falling
// back to the safe, documented default), the panel renders normally instead, exactly like the
// already-hardened readMode()/readPersona() readers in the same file.

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeikoTwinPanel } from "../widgets/panels/KeikoTwinPanel";
import { WindowBodyBoundary } from "../windows/WindowBodyBoundary";
import { TwinProvider } from "./TwinContext";

const KEY_POLICY = "keiko.twin.policy";
const KEY_BRIDGES = "keiko.twin.bridges";

// Silences React's expected error-boundary console noise for a render that throws.
function withBoundaryNoise<T>(run: () => T): T {
  const onError = (event: ErrorEvent): void => {
    event.preventDefault();
  };
  window.addEventListener("error", onError);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    return run();
  } finally {
    errorSpy.mockRestore();
    window.removeEventListener("error", onError);
  }
}

function renderTwinPanel(): void {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    withBoundaryNoise(() =>
      render(
        <TwinProvider>
          <WindowBodyBoundary windowType="twin">
            <KeikoTwinPanel />
          </WindowBodyBoundary>
        </TwinProvider>,
      ),
    );
  } finally {
    warnSpy.mockRestore();
  }
}

describe("TwinContext persisted policy/bridges validation (F2)", () => {
  afterEach(() => {
    window.localStorage.removeItem(KEY_POLICY);
    window.localStorage.removeItem(KEY_BRIDGES);
  });

  it("does not crash the Twin panel when the persisted policy is not an array at all", async () => {
    window.localStorage.setItem(KEY_POLICY, JSON.stringify("clobbered"));

    renderTwinPanel();

    // The provider reads localStorage in a post-mount effect; wait for that hydration pass to
    // land before asserting the panel is still alive.
    expect(await screen.findByRole("tablist")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not crash the Twin panel when a persisted policy row has an unrecognized decision", async () => {
    window.localStorage.setItem(
      KEY_POLICY,
      JSON.stringify([
        { id: "write", action: "Write files", scope: "src/**", decision: "self-destruct" },
      ]),
    );

    renderTwinPanel();

    expect(await screen.findByRole("tablist")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not crash the Twin panel when the persisted bridges value is not an object", async () => {
    window.localStorage.setItem(KEY_BRIDGES, JSON.stringify(["not", "an", "object"]));

    renderTwinPanel();

    expect(await screen.findByRole("tablist")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not crash the Twin panel when the persisted bridges value is null", async () => {
    window.localStorage.setItem(KEY_BRIDGES, "null");

    renderTwinPanel();

    expect(await screen.findByRole("tablist")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
