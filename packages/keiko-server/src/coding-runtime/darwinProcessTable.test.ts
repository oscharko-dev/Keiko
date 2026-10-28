import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { darwinProcessTableReader, parseProcessTable } from "./darwinProcessTable.js";

const readDarwinProcessTable = darwinProcessTableReader(promisify(execFile));

describe("the host's process table with kernel identities (#3899 AC2, #3901 AC3)", () => {
  it("parses identified processes, zombies, gone PIDs and processes of other users", () => {
    expect(
      parseProcessTable(
        "mark 120\n10 3 100 1\n11 5 110 100\n12 gone\n13 foreign\n14 foreign\n15 unidentified\n\n",
      ),
    ).toEqual({
      records: [
        { pid: 10, zombie: false, uniqueId: "100", parentUniqueId: "1" },
        { pid: 11, zombie: true, uniqueId: "110", parentUniqueId: "100" },
      ],
      goneCount: 1,
      foreignUserCount: 2,
      unidentifiedCount: 1,
      lateCount: 0,
    });
  });

  // PR #4064 review: a row whose identity is newer than the mark was forked after the listing
  // began, so it may hold the PID of a listed process that ended before its read.
  it("counts every process forked after the listing's mark as late", () => {
    const parsed = parseProcessTable(
      "mark 105\n10 3 100 1\n11 3 105 100\n12 3 106 1\n13 5 9000 1\n",
    );
    expect(parsed.records).toHaveLength(4);
    expect(parsed.lateCount).toBe(2);
  });

  it("refuses a table with a line out of its grammar, or without exactly one leading mark", () => {
    expect(() => parseProcessTable("mark 1\n10 3 100 1\ngarbage\n")).toThrow(
      "darwin-process-table-malformed",
    );
    expect(() => parseProcessTable("mark 1\n10 3 100 x\n")).toThrow(
      "darwin-process-table-malformed",
    );
    expect(() => parseProcessTable("mark 1\n10 denied\n")).toThrow(
      "darwin-process-table-malformed",
    );
    for (const output of [
      "10 3 100 1\n",
      "10 3 100 1\nmark 1\n",
      "mark 1\nmark 2\n",
      "mark x\n",
      "",
    ])
      expect(() => parseProcessTable(output)).toThrow("darwin-process-table-malformed");
  });

  // On the real kernel: this process with a stable identity, and a zombie with its parent's.
  // Every process the kernel refuses to identify is another user's (the host's root processes).
  it.skipIf(process.platform !== "darwin")(
    "identifies this process and a zombie with the identity of the parent holding it",
    async () => {
      const holder = spawn(
        "/usr/bin/perl",
        ["-e", '$| = 1; my $c = fork(); if ($c == 0) { exit 0 } print "$c\\n"; sleep 30'],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      try {
        const zombie = await new Promise<number>((resolve) => {
          holder.stdout.once("data", (chunk: Buffer) => {
            resolve(Number(chunk.toString().trim()));
          });
        });
        const first = await readDarwinProcessTable();
        const second = await readDarwinProcessTable();
        const self = first.records.find((row) => row.pid === process.pid);
        expect(self).toMatchObject({ zombie: false });
        expect(second.records.find((row) => row.pid === process.pid)?.uniqueId).toBe(
          self?.uniqueId,
        );
        const parent = second.records.find((row) => row.pid === holder.pid);
        await expect
          .poll(async () =>
            (await readDarwinProcessTable()).records.find((row) => row.pid === zombie),
          )
          .toMatchObject({ zombie: true, parentUniqueId: parent?.uniqueId });
        expect(parent?.parentUniqueId).toBe(self?.uniqueId);
        expect(first.foreignUserCount).toBeGreaterThan(0);
        expect(first.unidentifiedCount).toBe(0);
        // This process and the holder were forked before the mark: neither is ever late.
        expect(first.lateCount).toBeLessThan(first.records.length);
      } finally {
        holder.kill("SIGKILL");
      }
    },
    20_000,
  );
});
