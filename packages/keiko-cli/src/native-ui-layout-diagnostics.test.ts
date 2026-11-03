import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import { nativeUiRuntimeForLayout } from "./native-ui-runtime.js";
import { layoutFor } from "./portable-shared.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(["missing", "directory"])("classifies native layout verification refusal: %s", (kind) => {
  const root = mkdtempSync(join(tmpdir(), "keiko-native-layout-refusal-"));
  roots.push(root);
  const layout = layoutFor("linux-x64", root);
  if (kind === "directory") mkdirSync(layout.runtimeSupervisorPath, { recursive: true });
  const events: SecurityLogEvent[] = [];
  expect(() =>
    nativeUiRuntimeForLayout(layout, { write: (event): void => void events.push(event) }),
  ).toThrow("installed native runtime could not be verified.");
  expect(events).toEqual([
    expect.objectContaining({
      op: "cli.lifecycle.native-owner",
      errorKind: "unavailable",
      extra: {
        phase: "admission",
        outcome: "refused",
        failureKind: kind === "missing" ? "ENOENT" : "Error",
        completeness: "complete",
        loss: "none",
      },
    }),
  ]);
  expect(JSON.stringify(events)).not.toContain(root);
});
