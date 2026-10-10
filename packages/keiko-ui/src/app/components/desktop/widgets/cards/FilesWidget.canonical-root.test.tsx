import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFilesTree } from "@/lib/api";
import { FilesWidget } from "./FilesWidget";
import { nativeFilesChatFixture } from "../../../../../../../../tests/support/files-chat-native-support";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  fetchFilesTree: vi.fn(),
  fetchFilesPreview: vi.fn(async (root: string, path: string) => ({
    root,
    path,
    name: "nested.ts",
    sizeBytes: 36,
    modifiedAt: 1,
    extension: "ts",
    mime: "text/plain",
    symlink: false,
    kind: "text",
    content: "",
    truncated: false,
    maxBytes: 1000,
  })),
  fetchGitStatus: vi.fn(async (root: string) => ({ root, available: false, changes: [] })),
}));
vi.mock("@/lib/client-diagnostics", async (original) => ({
  ...(await original<typeof import("@/lib/client-diagnostics")>()),
  reportClientDiagnostic: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

type NativeFixture = Awaited<ReturnType<typeof nativeFilesChatFixture>>;

function delayedChild(native: NativeFixture): {
  readonly entered: Promise<void>;
  readonly release: () => Promise<void>;
} {
  const entered = deferred<void>();
  const released = deferred<void>();
  vi.mocked(fetchFilesTree).mockImplementation(async (root, path = "") => {
    const response = await native.tree(root, path);
    if (root === native.alias && path === "Alpha/nested") {
      entered.resolve();
      await released.promise;
    }
    return response;
  });
  return {
    entered: entered.promise,
    release: (): Promise<void> =>
      act(async () => {
        released.resolve();
      }),
  };
}

async function canonicalRoot(native: NativeFixture): Promise<string> {
  const ack = await native.patch([
    { kind: "directory", root: native.alias, relativePaths: ["Alpha/nested"], connectedAtMs: 1 },
  ]);
  const root = ack.chat.connectedScope?.root;
  if (root === undefined) throw new TypeError("Missing canonical native scope ACK");
  return root;
}

describe("Files canonical root while a child is loading", () => {
  it("reloads the pending child after the native canonical ACK without a watcher", async () => {
    const native = await nativeFilesChatFixture(true);
    try {
      const pending = delayedChild(native);
      const active = vi.fn();
      const props = {
        watchActive: false,
        initialDirectoryPath: "Alpha",
        onActiveFileChange: active,
      };
      const mounted = render(
        <FilesWidget root={native.alias} resolvedRoot={native.alias} {...props} />,
      );
      fireEvent.click(await screen.findByRole("treeitem", { name: /^nested$/u }));
      await pending.entered;
      const root = await canonicalRoot(native);
      mounted.rerender(<FilesWidget root={root} resolvedRoot={root} {...props} />);
      await pending.release();
      expect(await screen.findByRole("treeitem", { name: /nested\.ts/u })).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole("treeitem", { name: /nested\.ts/u }));
      });
      expect(active.mock.calls.at(-1)).toEqual(["Alpha/nested/nested.ts", root]);
      expect(
        vi
          .mocked(fetchFilesTree)
          .mock.calls.filter(([requested, path]) => requested === root && path === "Alpha/nested"),
      ).toHaveLength(1);
    } finally {
      cleanup();
      await native.close();
    }
  });

  it("retains completed child entries and selected directory during normalization", async () => {
    const native = await nativeFilesChatFixture(true);
    try {
      vi.mocked(fetchFilesTree).mockImplementation(native.tree);
      const props = { watchActive: false, initialDirectoryPath: "Alpha" };
      const mounted = render(
        <FilesWidget root={native.alias} resolvedRoot={native.alias} {...props} />,
      );
      fireEvent.click(await screen.findByRole("treeitem", { name: /^nested$/u }));
      await screen.findByRole("treeitem", { name: /nested\.ts/u });
      const root = await canonicalRoot(native);
      mounted.rerender(<FilesWidget root={root} resolvedRoot={root} {...props} />);
      expect(await screen.findByRole("treeitem", { name: /nested\.ts/u })).toBeInTheDocument();
      expect(
        vi
          .mocked(fetchFilesTree)
          .mock.calls.filter(([requested, path]) => requested === root && path === "Alpha/nested"),
      ).toHaveLength(0);
    } finally {
      cleanup();
      await native.close();
    }
  });

  it("drops pending alias entries when the human chooses a different actual root", async () => {
    const native = await nativeFilesChatFixture(true);
    try {
      const pending = delayedChild(native);
      const mounted = render(
        <FilesWidget
          root={native.alias}
          resolvedRoot={native.alias}
          initialDirectoryPath="Alpha"
          watchActive={false}
        />,
      );
      fireEvent.click(await screen.findByRole("treeitem", { name: /^nested$/u }));
      await pending.entered;
      const root = `${native.root}/Beta`;
      mounted.rerender(<FilesWidget root={root} watchActive={false} />);
      await screen.findByRole("treeitem", { name: /two\.ts/u });
      await pending.release();
      await waitFor(() =>
        expect(screen.queryByRole("treeitem", { name: /nested\.ts/u })).toBeNull(),
      );
    } finally {
      cleanup();
      await native.close();
    }
  });
});
