import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DATA_VOLUME,
  FootprintRefusal,
  accountAreas,
  classifyEntry,
  findArguments,
  findChanged,
  onDataVolume,
  parseFootprintArgs,
  summarize,
  writableBy,
} from "../testing/standard-account-footprint.mjs";

// #4520: what a standard account created or changed outside its own folders. The pins keep the
// attribution honest: whatever the account owns counts, a regular file it may write counts, and a
// change it could not have made is counted apart, never against the promise.
const ACCOUNT = { uid: 501, gids: [20, 12] };

function stats({ uid = 0, gid = 0, mode = 0o644, kind = "file" }) {
  return { uid, gid, mode, isFile: () => kind === "file", isDirectory: () => kind === "directory" };
}

describe("parseFootprintArgs", () => {
  it("takes the account, the marker and an optional evidence file", () => {
    expect(parseFootprintArgs(["--account", "keikoqa", "--marker", "m"])).toEqual({
      account: "keikoqa",
      marker: "m",
    });
    expect(
      parseFootprintArgs(["--account", "keikoqa", "--marker", "m", "--evidence", "e"]).evidence,
    ).toBe("e");
  });

  it("refuses a missing marker, a malformed account and unknown flags", () => {
    for (const argv of [
      ["--account", "keikoqa"],
      ["--account", "Kei Ko", "--marker", "m"],
      ["--marker", "m"],
      ["--account", "keikoqa", "--marker", "m", "--x", "y"],
    ]) {
      expect(() => parseFootprintArgs(argv)).toThrow(FootprintRefusal);
    }
  });
});

describe("writableBy", () => {
  it("reads the owner, group and other write bits", () => {
    expect(writableBy(stats({ uid: 501, mode: 0o644 }), ACCOUNT)).toBe(true);
    expect(writableBy(stats({ uid: 501, mode: 0o444 }), ACCOUNT)).toBe(false);
    expect(writableBy(stats({ gid: 20, mode: 0o664 }), ACCOUNT)).toBe(true);
    expect(writableBy(stats({ gid: 20, mode: 0o644 }), ACCOUNT)).toBe(false);
    expect(writableBy(stats({ gid: 80, mode: 0o664 }), ACCOUNT)).toBe(false);
    expect(writableBy(stats({ gid: 80, mode: 0o666 }), ACCOUNT)).toBe(true);
  });
});

describe("classifyEntry", () => {
  const classify = (entry) => classifyEntry("/x", ACCOUNT, () => entry);

  it("attributes what the account owns, file or folder", () => {
    expect(classify(stats({ uid: 501 }))).toBe("owned");
    expect(classify(stats({ uid: 501, kind: "directory", mode: 0o755 }))).toBe("owned");
  });

  it("attributes a regular file of another account that the account may write", () => {
    expect(classify(stats({ mode: 0o666 }))).toBe("writable");
  });

  it("counts a folder, a socket or a protected file of another account apart", () => {
    expect(classify(stats({ kind: "directory", mode: 0o1777 }))).toBe("others");
    expect(classify(stats({ kind: "socket", mode: 0o777 }))).toBe("others");
    expect(classify(stats({ mode: 0o644 }))).toBe("others");
  });

  it("names an entry removed since the walk as gone", () => {
    const missing = () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    expect(classifyEntry("/x", ACCOUNT, missing)).toBe("gone");
  });
});

describe("summarize", () => {
  it("counts every class and lists only attributed entries, at most twenty", () => {
    const kinds = { "/o": "owned", "/w": "writable", "/r": "others", "/g": "gone" };
    const paths = ["/o", "/w", "/r", "/g", ...Array.from({ length: 30 }, () => "/o")];
    const summary = summarize(paths, (path) => kinds[path]);
    expect(summary.counts).toEqual({ owned: 31, writable: 1, others: 1, gone: 1 });
    expect(summary.violationCount).toBe(32);
    expect(summary.attributed).toHaveLength(20);
    expect(summary.attributed.slice(0, 2)).toEqual(["owned: /o", "writable: /w"]);
  });

  it("passes a volume where only other accounts changed something", () => {
    expect(summarize(["/a", "/b"], () => "others").violationCount).toBe(0);
  });
});

describe("findArguments", () => {
  it("walks one volume, prunes every own area and selects changes after the marker", () => {
    expect(findArguments("/V", ["/V/Users/q", "/V/private/var/folders/ab/cd"], "/m")).toEqual([
      "/V",
      "-xdev",
      "(",
      "-path",
      "/V/Users/q",
      "-o",
      "-path",
      "/V/private/var/folders/ab/cd",
      ")",
      "-prune",
      "-o",
      "(",
      "-newer",
      "/m",
      "-o",
      "-cnewer",
      "/m",
      ")",
      "-print0",
    ]);
  });
});

describe("findChanged", () => {
  // The real find: what the pruned area holds is never listed, and only changes after the marker are.
  function tree() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "footprint-walk-")));
    const volume = join(root, "volume");
    mkdirSync(join(volume, "own", "deep"), { recursive: true });
    mkdirSync(join(volume, "other"), { recursive: true });
    writeFileSync(join(volume, "own", "deep", "a.txt"), "a");
    writeFileSync(join(volume, "other", "b.txt"), "b");
    const marker = join(root, "marker");
    writeFileSync(marker, "");
    return { root, volume, marker };
  }

  function at(marker, secondsFromNow) {
    const time = Date.now() / 1000 + secondsFromNow;
    utimesSync(marker, time, time);
  }

  it("lists what changed after the marker outside the pruned area", () => {
    const { root, volume, marker } = tree();
    try {
      at(marker, -3600);
      const { paths, unreadable } = findChanged(volume, [join(volume, "own")], marker);
      expect(paths.sort()).toEqual([volume, join(volume, "other"), join(volume, "other", "b.txt")]);
      expect(unreadable).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists nothing that changed before the marker", () => {
    const { root, volume, marker } = tree();
    try {
      at(marker, 3600);
      expect(findChanged(volume, [join(volume, "own")], marker).paths).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() === 0)("counts a folder it cannot read instead of failing", () => {
    const { root, volume, marker } = tree();
    const closed = join(volume, "other", "closed");
    mkdirSync(closed);
    writeFileSync(join(closed, "c.txt"), "c");
    chmodSync(closed, 0o000);
    try {
      at(marker, -3600);
      const { paths, unreadable } = findChanged(volume, [join(volume, "own")], marker);
      expect(unreadable).toBe(1);
      expect(paths).toContain(closed);
      expect(paths).not.toContain(join(closed, "c.txt"));
    } finally {
      chmodSync(closed, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("onDataVolume", () => {
  it("prefixes the data volume to a resolved path once", () => {
    const folder = mkdtempSync(join(tmpdir(), "footprint-"));
    try {
      const real = realpathSync(folder);
      expect(onDataVolume(folder, "/V")).toBe(join("/V", real));
      expect(onDataVolume(folder, real.split("/").slice(0, 2).join("/"))).toBe(real);
      expect(DATA_VOLUME).toBe("/System/Volumes/Data");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("accountAreas", () => {
  const answers = {
    "id -u keikoqa": "502",
    "id -G keikoqa": "20 12 61",
    "dscl . -read /Users/keikoqa NFSHomeDirectory": "NFSHomeDirectory: /Users/keikoqa",
    "sudo -u keikoqa getconf DARWIN_USER_DIR": "/var/folders/ab/cdef/0/",
  };

  it("names the account's ids, its home and its per-user folder", () => {
    const run = (command, args) => answers[`${command} ${args.join(" ")}`] ?? "";
    expect(accountAreas("keikoqa", run)).toEqual({
      uid: 502,
      gids: [20, 12, 61],
      roots: ["/Users/keikoqa", "/var/folders/ab/cdef"],
    });
  });

  it("refuses an account it cannot resolve", () => {
    const run = (command, args) =>
      command === "dscl" ? "" : (answers[`${command} ${args.join(" ")}`] ?? "");
    expect(() => accountAreas("keikoqa", run)).toThrow(FootprintRefusal);
  });
});
