import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DynamicChunkLoadFailure } from "./DynamicChunkLoadFailure";

afterEach(cleanup);

describe("DynamicChunkLoadFailure", () => {
  it("stays invisible while the chunk is merely loading", () => {
    const { container } = render(<DynamicChunkLoadFailure />);
    expect(container).toBeEmptyDOMElement();
  });

  it("surfaces a failed chunk load as an alert with a retry that re-attempts the import", async () => {
    const retry = vi.fn();
    render(<DynamicChunkLoadFailure error={new Error("chunk load failed")} retry={retry} />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("falls back to a full reload when next/dynamic provides no retry", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    try {
      render(<DynamicChunkLoadFailure error={new Error("chunk load failed")} />);
      await userEvent.click(screen.getByRole("button"));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
