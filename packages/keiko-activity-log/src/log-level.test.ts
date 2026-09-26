import { describe, expect, it } from "vitest";

import {
  DEFAULT_SERVER_LOG_LEVEL,
  SERVER_LOG_LEVELS,
  SERVER_LOG_LEVEL_ENV,
  isServerLogLevel,
  isServerLogThreshold,
  parseServerLogThreshold,
  resolveServerLogThreshold,
  serverLogLevelEnabled,
  serverLogLevelRank,
} from "./log-level.js";

describe("server log levels", () => {
  it("ranks the four levels in ascending severity and puts silent above all of them", () => {
    const ranks = SERVER_LOG_LEVELS.map((level) => serverLogLevelRank(level));
    expect(ranks).toStrictEqual([...ranks].sort((left, right) => left - right));
    expect(serverLogLevelRank("silent")).toBeGreaterThan(serverLogLevelRank("error"));
  });

  it("enables a level only at or above the configured threshold", () => {
    expect(serverLogLevelEnabled("debug", "info")).toBe(false);
    expect(serverLogLevelEnabled("info", "info")).toBe(true);
    expect(serverLogLevelEnabled("warn", "info")).toBe(true);
    expect(serverLogLevelEnabled("error", "warn")).toBe(true);
    expect(serverLogLevelEnabled("warn", "error")).toBe(false);
  });

  it("emits nothing at all under the silent threshold", () => {
    for (const level of SERVER_LOG_LEVELS) {
      expect(serverLogLevelEnabled(level, "silent")).toBe(false);
    }
  });

  it("recognises only the four level names, and silent only as a threshold", () => {
    expect(isServerLogLevel("warn")).toBe(true);
    expect(isServerLogLevel("silent")).toBe(false);
    expect(isServerLogLevel("WARN")).toBe(false);
    expect(isServerLogLevel(30)).toBe(false);
    expect(isServerLogThreshold("silent")).toBe(true);
  });

  it("parses case-insensitively, trims, and accepts the common aliases", () => {
    expect(parseServerLogThreshold("  DEBUG ")).toBe("debug");
    expect(parseServerLogThreshold("trace")).toBe("debug");
    expect(parseServerLogThreshold("verbose")).toBe("debug");
    expect(parseServerLogThreshold("warning")).toBe("warn");
    expect(parseServerLogThreshold("fatal")).toBe("error");
    expect(parseServerLogThreshold("critical")).toBe("error");
    expect(parseServerLogThreshold("off")).toBe("silent");
    expect(parseServerLogThreshold("none")).toBe("silent");
  });

  it("falls back to info for an unset, empty or unrecognised value rather than going silent", () => {
    // A typo in the environment variable must never silence the log an operator is trying to
    // read — the failure mode of a strict parser here is exactly the incident this log exists for.
    expect(parseServerLogThreshold(undefined)).toBe(DEFAULT_SERVER_LOG_LEVEL);
    expect(parseServerLogThreshold("")).toBe(DEFAULT_SERVER_LOG_LEVEL);
    expect(parseServerLogThreshold("   ")).toBe(DEFAULT_SERVER_LOG_LEVEL);
    expect(parseServerLogThreshold("loud")).toBe(DEFAULT_SERVER_LOG_LEVEL);
    expect(parseServerLogThreshold("10")).toBe(DEFAULT_SERVER_LOG_LEVEL);
  });

  it("honours an explicit fallback when one is supplied", () => {
    expect(parseServerLogThreshold("nonsense", "warn")).toBe("warn");
  });

  it("reads the threshold from KEIKO_LOG_LEVEL in a caller-supplied environment", () => {
    expect(resolveServerLogThreshold({ [SERVER_LOG_LEVEL_ENV]: "debug" })).toBe("debug");
    expect(resolveServerLogThreshold({})).toBe(DEFAULT_SERVER_LOG_LEVEL);
  });
});
