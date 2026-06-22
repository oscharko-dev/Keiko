import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logActivity } from "../shared/activityBus";
import { TimelinePanel } from "./TimelinePanel";

describe("TimelinePanel", () => {
  beforeEach(() => {
    delete window.__keikoActivity;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T10:11:12Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders an accessible empty log", () => {
    render(<TimelinePanel />);

    expect(screen.getByRole("log", { name: "Activity timeline" })).toHaveTextContent(
      "No activity yet.",
    );
  });

  it("renders activity rows with agent fallback, kind text and formatted time", () => {
    logActivity({ type: "approval", text: "Approve file write?", agent: "Verifier" });
    logActivity({ type: "open", text: "Opened run detail" });

    render(<TimelinePanel />);

    expect(screen.getByText("Opened run detail")).toBeInTheDocument();
    expect(screen.getByText(/workspace ·/)).toBeInTheDocument();
    expect(screen.getByText("Approve file write?")).toBeInTheDocument();
    expect(screen.getByText(/Verifier ·/)).toBeInTheDocument();
    expect(screen.getByText("approval")).toHaveClass("visually-hidden");
    expect(screen.getByText("open")).toHaveClass("visually-hidden");
  });
});
