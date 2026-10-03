import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
// vitest hoists the `vi.mock` factories below above this import, so the host loads the stubbed runtime.
import { EditorWidget } from "./EditorWidget";

// Stub the heavy editor runtime so the HOST chrome (panes, split controls, resizers) can be tested in
// isolation — and replace next/dynamic with a synchronous passthrough to that stub, since the host
// loads the runtime via `dynamic(() => import("./EditorRuntimeWidget"))`. The stub renders the
// host-supplied split controls (`toolbarExtras`) so a split can be created from the toolbar.
vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => {
    function RuntimeStub(props: { paneId?: string; toolbarExtras?: ReactNode }): ReactNode {
      return (
        <div data-testid="pane-runtime" data-pane={props.paneId ?? "root"}>
          {props.toolbarExtras}
        </div>
      );
    }
    return RuntimeStub;
  },
}));

// The sidebar FilesWidget calls these on mount; resolve them quietly so the host renders without I/O.
vi.mock("../../../../../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../../lib/api")>("../../../../../lib/api");
  return {
    ...actual,
    fetchProjects: vi.fn(() => Promise.resolve({ projects: [] })),
    fetchFilesTree: vi.fn(() =>
      Promise.resolve({ root: "/repo", path: "", truncated: false, entries: [] }),
    ),
    fetchGitStatus: vi.fn(() => Promise.reject(new Error("no git"))),
  };
});

// jsdom does not implement the Pointer Capture API the resizer uses; the methods are no-ops here.
type PointerCaptureCapable = {
  hasPointerCapture?: (pointerId: number) => boolean;
  setPointerCapture?: (pointerId: number) => void;
  releasePointerCapture?: (pointerId: number) => void;
};
const elementProto = Element.prototype as PointerCaptureCapable;
elementProto.hasPointerCapture ??= () => false;
elementProto.setPointerCapture ??= () => undefined;
elementProto.releasePointerCapture ??= () => undefined;

afterEach(() => {
  vi.clearAllMocks();
});

function splitParent(): HTMLElement {
  const separator = screen.getByRole("separator", { name: "Resize editor split" });
  const parent = separator.parentElement;
  if (parent === null) throw new Error("split separator has no parent");
  return parent;
}

describe("EditorWidget host — split resize gesture", () => {
  it("commits the split ratio ONLY on pointer release — never on a move — and previews live via CSS", async () => {
    const onWorkspaceChange = vi.fn();
    render(
      <EditorWidget
        root="/repo"
        file="src/a.ts"
        openFiles={["src/a.ts", "src/b.ts"]}
        onWorkspaceChange={onWorkspaceChange}
      />,
    );

    // Create a second pane so the resizer separator exists.
    await userEvent.click(await screen.findByRole("button", { name: /Split .* right/ }));
    const separator = await screen.findByRole("separator", { name: "Resize editor split" });
    const parent = splitParent();
    // jsdom reports zero-sized rects; give the split container a real one so the previewed ratio
    // tracks the cursor and we can assert the live value at each move.
    vi.spyOn(parent, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 1000,
      bottom: 500,
      width: 1000,
      height: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    onWorkspaceChange.mockClear();

    // Every drag move previews the ratio live on the DOM but commits/persists NOTHING — asserted after
    // EACH move so a regression that commits mid-drag (per frame) cannot slip through.
    for (const [clientX, expected] of [
      [200, "20%"],
      [450, "45%"],
      [700, "70%"],
    ] as const) {
      fireEvent.pointerMove(separator, { buttons: 1, clientX, clientY: 250 });
      expect(parent.style.getPropertyValue("--ed-split-ratio")).toBe(expected);
      expect(onWorkspaceChange).not.toHaveBeenCalled();
    }

    // Release commits exactly once, persisting the final previewed ratio.
    fireEvent.pointerUp(separator, { clientX: 700, clientY: 250 });
    await waitFor(() => expect(onWorkspaceChange).toHaveBeenCalledTimes(1));
    const patch = onWorkspaceChange.mock.calls.at(-1)?.[0] as { layoutJson?: string } | undefined;
    expect(patch?.layoutJson).toContain('"ratio":70');
  });

  it("renders one editor host per pane after a split", async () => {
    render(<EditorWidget root="/repo" file="src/a.ts" openFiles={["src/a.ts", "src/b.ts"]} />);
    expect(screen.getAllByTestId("pane-runtime")).toHaveLength(1);
    await userEvent.click(await screen.findByRole("button", { name: /Split .* down/ }));
    await waitFor(() => expect(screen.getAllByTestId("pane-runtime")).toHaveLength(2));
  });
});
