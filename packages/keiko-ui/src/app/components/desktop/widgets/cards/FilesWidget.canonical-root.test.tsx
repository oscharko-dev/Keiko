import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Suspense, startTransition, type ComponentProps, type ReactNode } from "react";
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { fetchFilesTree } from "@/lib/api";
import { reportFilesScopeDecision } from "@/lib/client-diagnostics";
import { FilesWidget } from "./FilesWidget";
import { notifyWorkspaceFileMutated } from "./workspace-file-events";
import { nativeFilesChatFixture } from "../../../../../../../../tests/support/files-chat-native-support";

const previewSuspension = vi.hoisted((): { current?: () => void } => ({}));
vi.mock("./FilePreview", async (original) => {
  const actual = await original<typeof import("./FilePreview")>();
  return {
    ...actual,
    FilePreview(props: ComponentProps<typeof actual.FilePreview>): ReactNode {
      previewSuspension.current?.();
      return <actual.FilePreview {...props} />;
    },
  };
});

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
  reportFilesScopeDecision: vi.fn(),
}));

afterEach(() => {
  delete previewSuspension.current;
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

function retargetAliasWithChild(native: NativeFixture): string {
  const replacement = `${native.root}/Beta`;
  mkdirSync(`${replacement}/Alpha/nested`, { recursive: true });
  writeFileSync(`${replacement}/Alpha/nested/replacement.ts`, "export const replacement = true;\n");
  unlinkSync(native.alias);
  symlinkSync(replacement, native.alias, "dir");
  return replacement;
}

describe("Files canonical root while a child is loading", () => {
  it("keeps the first canonical child observation when the initial root arrives late", async () => {
    const native = await nativeFilesChatFixture(true);
    const entered = deferred<void>();
    const released = deferred<void>();
    const retargeted = deferred<void>();
    const childRead = deferred<void>();
    let holdRoot = true;
    try {
      vi.mocked(fetchFilesTree).mockImplementation(async (root, path = "") => {
        if (path === "" && holdRoot) {
          holdRoot = false;
          const response = await native.tree(root, path);
          entered.resolve();
          await released.promise;
          return response;
        }
        await retargeted.promise;
        const response = await native.tree(root, path);
        if (path === "Alpha") childRead.resolve();
        return response;
      });
      const active = vi.fn();
      render(
        <FilesWidget
          root={native.alias}
          initialDirectoryPath="Alpha"
          onActiveFileChange={active}
          watchActive={false}
        />,
      );
      await act(async () => entered.promise);
      const replacement = retargetAliasWithChild(native);
      expect((await native.tree(native.alias, "Alpha")).root).toBe(replacement);
      await act(async () => {
        retargeted.resolve();
        await childRead.promise;
      });
      await screen.findByRole("treeitem", { name: /^nested$/u });
      expect(active).toHaveBeenLastCalledWith(null, replacement, "Alpha");
      active.mockClear();
      await act(async () => released.resolve());
      expect(screen.getByRole("treeitem", { name: /^nested$/u })).toBeInTheDocument();
      expect(active.mock.calls.some(([, root]) => root === native.root)).toBe(false);
    } finally {
      released.resolve();
      retargeted.resolve();
      cleanup();
      await native.close();
    }
  });

  it("adopts a child read's changed canonical root before publishing its entries", async () => {
    const native = await nativeFilesChatFixture(true);
    try {
      vi.mocked(fetchFilesTree).mockImplementation((root, path = "") => native.tree(root, path));
      const active = vi.fn();
      render(
        <FilesWidget
          root={native.alias}
          initialDirectoryPath="Alpha"
          onActiveFileChange={active}
          watchActive={false}
        />,
      );
      const nested = await screen.findByRole("treeitem", { name: /^nested$/u });
      const replacement = `${native.root}/Beta`;
      mkdirSync(`${replacement}/Alpha/nested`, { recursive: true });
      writeFileSync(
        `${replacement}/Alpha/nested/replacement.ts`,
        "export const replacement = true;\n",
      );
      unlinkSync(native.alias);
      symlinkSync(replacement, native.alias, "dir");
      expect((await native.tree(native.alias, "Alpha/nested")).root).toBe(replacement);
      active.mockClear();
      fireEvent.click(nested);
      await screen.findByRole("treeitem", { name: /two\.ts/u });
      expect(active).toHaveBeenLastCalledWith(null, replacement, null);
      expect(screen.queryByRole("treeitem", { name: /replacement\.ts/u })).toBeNull();
      expect(reportFilesScopeDecision).toHaveBeenCalledWith(expect.any(String), {
        decision: "root-replaced",
      });
    } finally {
      cleanup();
      await native.close();
    }
  });

  it("rejects a held child after the same alias resolves to another actual root", async () => {
    const native = await nativeFilesChatFixture(true);
    const pending = delayedChild(native);
    try {
      const active = vi.fn();
      render(
        <FilesWidget
          root={native.alias}
          initialDirectoryPath="Alpha"
          onActiveFileChange={active}
          watchActive={false}
        />,
      );
      fireEvent.click(await screen.findByRole("treeitem", { name: /^nested$/u }));
      await act(async () => pending.entered);
      const replacement = `${native.root}/Beta`;
      unlinkSync(native.alias);
      symlinkSync(replacement, native.alias, "dir");
      expect((await native.tree(native.alias)).root).toBe(replacement);
      act(() => notifyWorkspaceFileMutated(native.root, { relativePath: "README.md" }));
      await screen.findByRole("treeitem", { name: /two\.ts/u });
      expect(active).toHaveBeenLastCalledWith(null, replacement, null);
      expect(reportFilesScopeDecision).toHaveBeenCalledWith(expect.any(String), {
        decision: "root-replaced",
      });
      active.mockClear();
      await pending.release();
      expect(screen.queryByRole("treeitem", { name: /nested\.ts/u })).toBeNull();
      expect(screen.getByRole("treeitem", { name: /two\.ts/u })).toBeInTheDocument();
      expect(active).not.toHaveBeenCalled();
      expect(reportFilesScopeDecision).toHaveBeenCalledWith(expect.any(String), {
        decision: "request-superseded",
        mutationSurface: "files",
      });
      fireEvent.click(screen.getByRole("treeitem", { name: /two\.ts/u }));
      expect(active).toHaveBeenLastCalledWith("two.ts", replacement);
    } finally {
      await pending.release();
      cleanup();
      await native.close();
    }
  });

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
      await act(async () => {
        await pending.entered;
      });
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
      await act(async () => {
        await pending.entered;
      });
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

describe("Files preview authority during background refresh", () => {
  it.each(["canonical", "symlink"] as const)(
    "retains the displayed file when the %s root refreshes",
    async (kind) => {
      const native = await nativeFilesChatFixture(true);
      try {
        vi.mocked(fetchFilesTree).mockImplementation(native.tree);
        const active = vi.fn();
        const props = {
          initialDirectoryPath: "Alpha",
          onActiveFileChange: active,
          watchActive: false,
        };
        const mounted = render(
          <FilesWidget root={kind === "symlink" ? native.alias : native.root} {...props} />,
        );
        await screen.findByRole("treeitem", { name: /one\.ts/u });
        if (kind === "symlink") {
          const canonical = await canonicalRoot(native);
          mounted.rerender(<FilesWidget root={canonical} resolvedRoot={canonical} {...props} />);
        }
        fireEvent.click(await screen.findByRole("treeitem", { name: /one\.ts/u }));
        await screen.findByRole("button", { name: "Back to files" });
        active.mockClear();
        act(() => notifyWorkspaceFileMutated(native.root, { relativePath: "README.md" }));
        await waitFor(() => expect(active).toHaveBeenCalled());
        expect(active).toHaveBeenLastCalledWith("Alpha/one.ts", native.root, "Alpha");
        expect(screen.getByRole("button", { name: "Back to files" })).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
        expect(active).toHaveBeenLastCalledWith(null, native.root);
        active.mockClear();
        act(() => notifyWorkspaceFileMutated(native.root, { relativePath: "README.md" }));
        await waitFor(() => expect(active).toHaveBeenLastCalledWith(null, native.root, "Alpha"));
      } finally {
        cleanup();
        await native.close();
      }
    },
  );
});

function delayedRootRefresh(
  native: NativeFixture,
  requestedRoot = native.root,
): {
  readonly hold: () => void;
  readonly entered: Promise<void>;
  readonly release: () => void;
} {
  const entered = deferred<void>();
  const released = deferred<void>();
  let holding = false;
  vi.mocked(fetchFilesTree).mockImplementation(async (root, path = "") => {
    const response = await native.tree(root, path);
    if (holding && root === requestedRoot && path === "") {
      holding = false;
      entered.resolve();
      await released.promise;
    }
    return response;
  });
  return {
    hold: (): void => {
      holding = true;
    },
    entered: entered.promise,
    release: (): void => released.resolve(),
  };
}

it("does not reuse a held old-root read after a child discovers an alias replacement", async () => {
  const native = await nativeFilesChatFixture(true);
  const pending = delayedRootRefresh(native, native.alias);
  try {
    const active = vi.fn();
    render(
      <FilesWidget
        root={native.alias}
        presentation="project"
        onActiveFileChange={active}
        watchActive={false}
      />,
    );
    fireEvent.click(await screen.findByRole("treeitem", { name: /^Alpha$/u }));
    const nested = await screen.findByRole("treeitem", { name: /^nested$/u });
    pending.hold();
    await act(async () => {
      notifyWorkspaceFileMutated(native.root, { relativePath: "README.md" });
      await pending.entered;
    });
    const replacement = `${native.root}/Beta`;
    mkdirSync(`${replacement}/Alpha/nested`, { recursive: true });
    writeFileSync(
      `${replacement}/Alpha/nested/replacement.ts`,
      "export const replacement = true;\n",
    );
    unlinkSync(native.alias);
    symlinkSync(replacement, native.alias, "dir");
    fireEvent.click(nested);
    await screen.findByRole("treeitem", { name: /two\.ts/u });
    expect(active).toHaveBeenLastCalledWith(null, replacement, null);
    active.mockClear();
    await act(async () => pending.release());
    expect(screen.getByRole("treeitem", { name: /two\.ts/u })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /README\.md/u })).toBeNull();
    expect(active).not.toHaveBeenCalled();
  } finally {
    pending.release();
    cleanup();
    await native.close();
  }
});

it("rejects an older same-root listing after a newer navigation read completes", async () => {
  const native = await nativeFilesChatFixture();
  const pending = delayedRootRefresh(native);
  try {
    writeFileSync(`${native.root}/README.md`, "# Original listing\n");
    render(<FilesWidget root={native.root} watchActive={false} />);
    await screen.findByRole("treeitem", { name: /README\.md/u });
    pending.hold();
    await act(async () => {
      notifyWorkspaceFileMutated(native.root, { relativePath: "README.md" });
      await pending.entered;
    });
    unlinkSync(`${native.root}/README.md`);
    writeFileSync(`${native.root}/fresh.md`, "# Current listing\n");
    fireEvent.click(screen.getByRole("treeitem", { name: /^Alpha$/u }));
    await screen.findByRole("treeitem", { name: /one\.ts/u });
    fireEvent.click(screen.getByRole("button", { name: "Open parent folder" }));
    await screen.findByRole("treeitem", { name: /fresh\.md/u });
    await act(async () => pending.release());
    expect(screen.getByRole("treeitem", { name: /fresh\.md/u })).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /README\.md/u })).toBeNull();
  } finally {
    pending.release();
    cleanup();
    await native.close();
  }
});

it("does not publish a held root observation after the Files window unmounts", async () => {
  const native = await nativeFilesChatFixture();
  const pending = delayedRootRefresh(native);
  try {
    const active = vi.fn();
    const mounted = render(
      <FilesWidget root={native.root} onActiveFileChange={active} watchActive={false} />,
    );
    await screen.findByRole("treeitem", { name: /^Alpha$/u });
    pending.hold();
    await act(async () => {
      notifyWorkspaceFileMutated(native.root, { relativePath: "README.md" });
      await pending.entered;
    });
    active.mockClear();
    mounted.unmount();
    await act(async () => pending.release());
    expect(active).not.toHaveBeenCalled();
  } finally {
    pending.release();
    cleanup();
    await native.close();
  }
});

it.each(["close-preview", "change-root"] as const)(
  "does not restore an old selection after %s during a root refresh",
  async (action) => {
    const native = await nativeFilesChatFixture();
    const pending = delayedRootRefresh(native);
    try {
      const active = vi.fn();
      const mounted = render(
        <FilesWidget
          root={native.root}
          initialDirectoryPath="Alpha"
          onActiveFileChange={active}
          watchActive={false}
        />,
      );
      fireEvent.click(await screen.findByRole("treeitem", { name: /one\.ts/u }));
      await screen.findByRole("button", { name: "Back to files" });
      pending.hold();
      await act(async () => {
        notifyWorkspaceFileMutated(native.root, { relativePath: "README.md" });
        await pending.entered;
      });
      if (action === "close-preview")
        fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
      else {
        mounted.rerender(
          <FilesWidget
            root={`${native.root}/Beta`}
            onActiveFileChange={active}
            watchActive={false}
          />,
        );
        await screen.findByRole("treeitem", { name: /two\.ts/u });
      }
      active.mockClear();
      await act(async () => pending.release());
      expect(screen.queryByRole("button", { name: "Back to files" })).toBeNull();
      expect(active.mock.calls.some(([path]) => path === "Alpha/one.ts")).toBe(false);
      if (action === "close-preview")
        expect(active).toHaveBeenLastCalledWith(null, native.root, "Alpha");
      else expect(active).not.toHaveBeenCalled();
    } finally {
      pending.release();
      cleanup();
      await native.close();
    }
  },
);

it("keeps the committed selection while a concurrent preview render is suspended", async () => {
  const native = await nativeFilesChatFixture();
  const pending = delayedRootRefresh(native);
  const preview = deferred<void>();
  let attempted = false;
  try {
    const active = vi.fn();
    render(
      <Suspense fallback={<span>Loading preview</span>}>
        <FilesWidget
          root={native.root}
          initialDirectoryPath="Alpha"
          onActiveFileChange={active}
          watchActive={false}
        />
      </Suspense>,
    );
    const row = await screen.findByRole("treeitem", { name: /one\.ts/u });
    pending.hold();
    await act(async () => {
      notifyWorkspaceFileMutated(native.root, { relativePath: "README.md" });
      await pending.entered;
    });
    previewSuspension.current = (): void => {
      attempted = true;
      throw preview.promise;
    };
    act(() =>
      startTransition(() => {
        fireEvent.click(row);
      }),
    );
    expect(attempted).toBe(true);
    expect(screen.queryByRole("button", { name: "Back to files" })).toBeNull();
    active.mockClear();
    await act(async () => pending.release());
    expect(active).toHaveBeenLastCalledWith(null, native.root, "Alpha");
    expect(active.mock.calls.some(([path]) => path === "Alpha/one.ts")).toBe(false);
  } finally {
    cleanup();
    delete previewSuspension.current;
    pending.release();
    preview.resolve();
    await native.close();
  }
});

it("clears a preview and its directory when an unchanged root resolves elsewhere", async () => {
  const native = await nativeFilesChatFixture();
  try {
    let replaced = false;
    const resolved = `${native.root}/Beta`;
    vi.mocked(fetchFilesTree).mockImplementation((root, path = "") =>
      native.tree(replaced ? resolved : root, path),
    );
    const active = vi.fn();
    render(
      <FilesWidget
        root={native.root}
        initialDirectoryPath="Alpha"
        onActiveFileChange={active}
        watchActive={false}
      />,
    );
    fireEvent.click(await screen.findByRole("treeitem", { name: /one\.ts/u }));
    await screen.findByRole("button", { name: "Back to files" });
    active.mockClear();
    replaced = true;
    act(() => notifyWorkspaceFileMutated(native.root, { relativePath: "README.md" }));
    await waitFor(() => expect(active).toHaveBeenCalled());
    expect(active).toHaveBeenLastCalledWith(null, resolved, null);
    expect(screen.queryByRole("button", { name: "Back to files" })).toBeNull();
    expect(await screen.findByRole("treeitem", { name: /two\.ts/u })).toBeInTheDocument();
  } finally {
    cleanup();
    await native.close();
  }
});
