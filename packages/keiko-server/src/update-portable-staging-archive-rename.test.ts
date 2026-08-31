import { describe, expect, it, vi } from "vitest";
import type { SecurityLogEvent, SecurityLogSink } from "@oscharko-dev/keiko-security";
import { publishStagedArchiveTree } from "./update-portable-staging-archive.js";

function recordingSink(): { readonly sink: SecurityLogSink; readonly events: SecurityLogEvent[] } {
  const events: SecurityLogEvent[] = [];
  return {
    events,
    sink: {
      write: (event): void => {
        events.push(event);
      },
    },
  };
}

function eperm(): NodeJS.ErrnoException {
  return Object.assign(new Error("operation not permitted"), { code: "EPERM" });
}

describe("publishStagedArchiveTree", () => {
  it("logs a retry-success under the stage id", () => {
    const { sink, events } = recordingSink();
    const rename = vi
      .fn<() => void>()
      .mockImplementationOnce((): void => {
        throw eperm();
      })
      .mockImplementation((): void => undefined);
    publishStagedArchiveTree("/from", "/to", {
      stageId: "b".repeat(32),
      platform: "win32",
      sleep: (): void => undefined,
      securityLogSink: sink,
      rename,
    });
    expect(events).toEqual([
      expect.objectContaining({
        op: "security.fs.atomic-rename-retried",
        correlationId: "b".repeat(32),
        extra: { attempts: 2 },
      }),
    ]);
  });

  it("logs a terminal rename failure under the stage id", () => {
    const { sink, events } = recordingSink();
    const error = eperm();
    expect(() => {
      publishStagedArchiveTree("/from", "/to", {
        stageId: "c".repeat(32),
        platform: "win32",
        sleep: (): void => undefined,
        securityLogSink: sink,
        rename: (): void => {
          throw error;
        },
      });
    }).toThrow(error);
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "security.fs.atomic-rename-failed",
        correlationId: "c".repeat(32),
      }),
    );
  });
});
