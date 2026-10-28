import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isDenied } from "@oscharko-dev/keiko-workspace";
import { afterEach, expect, it, vi } from "vitest";
import { withUiLifecycleGuard } from "./ui-lifecycle-guard.js";
import { runLifecycleCli } from "./lifecycle.js";
import { resolveCliControlStateDir } from "./cli-control-state.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("keeps lifecycle exclusion in control state without a sibling project artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiko-ui-control-guard-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const state = join(workspace, ".keiko");
  mkdirSync(state, { recursive: true });
  const result = await runLifecycleCli(
    "status",
    ["--state-dir", state],
    { out: vi.fn(), err: vi.fn() },
    {},
    {
      cwd: workspace,
      homedir: (): string => root,
      securityLogSink: { write: vi.fn() },
    },
  );
  expect(result).toBe(0);
  expect(readdirSync(workspace)).toEqual([".keiko"]);
  const control = resolveCliControlStateDir(process.platform, root);
  expect(existsSync(control)).toBe(true);
  const guards = readdirSync(control, { recursive: true, encoding: "utf8" }).filter(
    (path) => basename(path) === "ui.pid",
  );
  expect(guards).toHaveLength(1);
  const guard = guards[0];
  if (guard === undefined) throw new Error("Missing actual control guard");
  expect(isDenied(guard)).toBe(true);
});

it("keeps the lifecycle guard behind the existing workspace denial", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiko-ui-guard-policy-"));
  roots.push(root);
  await withUiLifecycleGuard(
    join(root, "state"),
    true,
    (): Promise<void> => {
      const paths = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
        (path) => basename(path) === "ui.pid",
      );
      expect(paths).toHaveLength(1);
      const path = paths[0];
      if (path === undefined) throw new Error("Missing actual guard path");
      expect(isDenied(path)).toBe(true);
      return Promise.resolve();
    },
    root,
  );
});

it("keeps the same exclusion across complete selected-state removal", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiko-ui-guard-"));
  roots.push(root);
  const state = join(root, "state");
  mkdirSync(state);
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: (() => void) | undefined;
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = withUiLifecycleGuard(
    state,
    true,
    async (): Promise<number> => {
      rmSync(state, { recursive: true });
      entered?.();
      await held;
      return 1;
    },
    root,
  );
  await active;
  expect(existsSync(state)).toBe(false);
  for (const alias of [
    state,
    `${root}/./state`,
    `${root}//state`,
    `${state}/`,
    join(realpathSync(root), "state"),
  ])
    expect(
      await withUiLifecycleGuard(alias, true, (): Promise<number> => Promise.resolve(2), root),
    ).toEqual({ kind: "busy" });
  release?.();
  expect(await first).toEqual({ kind: "complete", value: 1 });
  expect(
    await withUiLifecycleGuard(state, true, (): Promise<number> => Promise.resolve(3), root),
  ).toEqual({
    kind: "complete",
    value: 3,
  });
  expect(existsSync(state)).toBe(false);
});
