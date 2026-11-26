import { describe, it, expect } from "vitest";
import { selectEnforcingBackend } from "./select.js";
import type { BackendAvailability } from "./types.js";

const NONE: BackendAvailability = {
  bubblewrap: false,
  unshare: false,
  seatbelt: false,
  docker: false,
  podman: false,
};

describe("selectEnforcingBackend", () => {
  it("prefers bubblewrap on Linux", () => {
    expect(selectEnforcingBackend("linux", { ...NONE, bubblewrap: true, unshare: true })).toBe(
      "bubblewrap",
    );
  });

  it("falls back to unshare on Linux when bubblewrap is absent", () => {
    expect(selectEnforcingBackend("linux", { ...NONE, unshare: true })).toBe("unshare");
  });

  it("uses seatbelt on macOS", () => {
    expect(selectEnforcingBackend("darwin", { ...NONE, seatbelt: true })).toBe("seatbelt");
  });

  it("does not use Linux native primitives on macOS", () => {
    expect(selectEnforcingBackend("darwin", { ...NONE, bubblewrap: true, unshare: true })).toBe(
      "none",
    );
  });

  it("does not use seatbelt on Linux", () => {
    expect(selectEnforcingBackend("linux", { ...NONE, seatbelt: true })).toBe("none");
  });

  it("falls back to docker when no native primitive is available (e.g. Windows)", () => {
    expect(selectEnforcingBackend("win32", { ...NONE, docker: true })).toBe("container-docker");
  });

  it("prefers docker over podman", () => {
    expect(selectEnforcingBackend("win32", { ...NONE, docker: true, podman: true })).toBe(
      "container-docker",
    );
  });

  it("falls back to podman when docker is absent", () => {
    expect(selectEnforcingBackend("win32", { ...NONE, podman: true })).toBe("container-podman");
  });

  it("prefers a Linux native primitive over a container runtime", () => {
    expect(selectEnforcingBackend("linux", { ...NONE, bubblewrap: true, docker: true })).toBe(
      "bubblewrap",
    );
  });

  it("returns 'none' when nothing can enforce egress", () => {
    expect(selectEnforcingBackend("linux", NONE)).toBe("none");
    expect(selectEnforcingBackend("win32", NONE)).toBe("none");
    expect(selectEnforcingBackend("darwin", NONE)).toBe("none");
  });

  it("requires a native filesystem boundary or a container for execution-root isolation", () => {
    expect(selectEnforcingBackend("linux", { ...NONE, unshare: true }, "execution-root")).toBe(
      "none",
    );
    expect(selectEnforcingBackend("darwin", { ...NONE, seatbelt: true }, "execution-root")).toBe(
      "none",
    );
    expect(selectEnforcingBackend("linux", { ...NONE, bubblewrap: true }, "execution-root")).toBe(
      "bubblewrap",
    );
    expect(selectEnforcingBackend("darwin", { ...NONE, docker: true }, "execution-root")).toBe(
      "container-docker",
    );
  });

  it("requires the container lifetime owner for macOS execution-root runs", () => {
    expect(
      selectEnforcingBackend("darwin", { ...NONE, seatbelt: true, docker: true }, "execution-root"),
    ).toBe("container-docker");
    expect(
      selectEnforcingBackend("darwin", { ...NONE, seatbelt: true, podman: true }, "execution-root"),
    ).toBe("container-podman");
  });

  it("runs a Windows execution-root step under the pinned supervisor without a container (#4496)", () => {
    const windows = { ...NONE, windowsAppContainer: true };
    expect(selectEnforcingBackend("win32", windows, "execution-root")).toBe("windows-appcontainer");
    // A present container runtime keeps the step, exactly as before, with or without the supervisor.
    expect(selectEnforcingBackend("win32", { ...windows, docker: true }, "execution-root")).toBe(
      "container-docker",
    );
    expect(selectEnforcingBackend("win32", { ...windows, podman: true }, "execution-root")).toBe(
      "container-podman",
    );
    expect(selectEnforcingBackend("win32", { ...NONE, docker: true }, "execution-root")).toBe(
      "container-docker",
    );
    // The supervisor confines execution-root steps only, and only on Windows.
    expect(selectEnforcingBackend("win32", windows, "inherit")).toBe("none");
    expect(selectEnforcingBackend("linux", windows, "execution-root")).toBe("none");
    expect(selectEnforcingBackend("darwin", windows, "execution-root")).toBe("none");
  });

  it("retains native macOS confinement for ordinary network-only runs", () => {
    expect(
      selectEnforcingBackend("darwin", { ...NONE, seatbelt: true, docker: true }, "inherit"),
    ).toBe("seatbelt");
  });
});
