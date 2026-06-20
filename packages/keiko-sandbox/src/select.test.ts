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

  it("requires strict bubblewrap or a container for execution-root isolation", () => {
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
});
