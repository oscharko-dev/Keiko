import { execFile, spawn } from "node:child_process";
import { Duplex } from "node:stream";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  createSandboxMembership,
  SANDBOX_MEMBER_SHELL,
  SandboxMembershipUnavailableError,
  sandboxMemberLaunch,
} from "./darwinSandboxMembership.js";
import { darwinProcessTableReader } from "./darwinProcessTable.js";

const readDarwinProcessTable = darwinProcessTableReader(promisify(execFile));

interface Channel {
  readonly duplex: Duplex;
  readonly written: string[];
  readonly answer: (text: string) => void;
  readonly end: () => void;
}

// The member's descriptor as Keiko holds it: what Keiko writes, and what the member answers.
function channel(): Channel {
  const written: string[] = [];
  const duplex = new Duplex({
    read(): void {
      // Answers are pushed by the test.
    },
    write(chunk: Buffer | string, _encoding, callback): void {
      written.push(String(chunk));
      callback();
    },
  });
  return {
    duplex,
    written,
    answer: (text): void => {
      duplex.push(text);
    },
    end: (): void => {
      duplex.push(null);
    },
  };
}

// The signal rules of the native profile (keiko-sandbox seatbelt-execution-root.ts).
const SIGNAL_PROFILE =
  "(version 1)(allow default)(deny signal process-info*)" +
  "(allow signal process-info* (target self) (target same-sandbox))";

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("the run's sandbox member (#3899 AC2, #3901 AC3)", () => {
  it("starts the service in place with the member beside it on descriptor 3", () => {
    const launch = sandboxMemberLaunch("/runtime/bin/opencode", ["serve", "--port", "0"]);
    expect(launch.executable).toBe(SANDBOX_MEMBER_SHELL);
    expect(launch.args.slice(0, 2)).toEqual(["-c", expect.stringContaining('exec 3<&- "$@"')]);
    expect(launch.args.slice(2, 3)).toEqual(["keiko-runtime"]);
    expect(launch.args.slice(4)).toEqual(["/runtime/bin/opencode", "serve", "--port", "0"]);
    // The member starts no process of its own while it answers, and uses the non-POSIX broadcast
    // (third argument 0), which leaves the member itself out.
    expect(launch.args[3]).not.toMatch(/\bfork\b|\bsystem\b|\bexec\b|`|\bopen\b/u);
    expect(launch.args[3]).toContain("syscall(37, -1, 0, 0)");
    expect(launch.args[3]).toContain("syscall(37, -1, 9, 0)");
  });

  it("waits for the member to announce its identity, then asks whether any process remains", async () => {
    const { duplex, written, answer } = channel();
    const membership = createSandboxMembership(duplex);
    const asked = membership.occupied();
    answer("ready 99 990 40 400\n");
    await expect.poll(() => written).toEqual(["check\n"]);
    // An answer may arrive in pieces.
    answer("occu");
    answer("pied\n");
    await expect(asked).resolves.toBe(true);
    await expect(membership.self()).resolves.toEqual({
      pid: 99,
      uniqueId: "990",
      parentPid: 40,
      parentUniqueId: "400",
    });
    const again = membership.occupied();
    answer("empty\n");
    await expect(again).resolves.toBe(false);
  });

  it("names the asked processes that belong to the run, by PID and kernel identity", async () => {
    const { duplex, written, answer } = channel();
    const membership = createSandboxMembership(duplex);
    answer("ready 99 990 40 400\n");
    const asked = membership.members([10, 20, 30]);
    await expect.poll(() => written).toEqual(["members 10 20 30\n"]);
    answer("members 10:100 30:300\n");
    await expect(asked).resolves.toEqual([
      { pid: 10, uniqueId: "100" },
      { pid: 30, uniqueId: "300" },
    ]);
    await expect(membership.members([])).resolves.toEqual([]);
    expect(written).toHaveLength(1);
  });

  it("asks about a long list in parts", async () => {
    const { duplex, written, answer } = channel();
    const membership = createSandboxMembership(duplex);
    answer("ready 99 990 40 400\n");
    const pids = Array.from({ length: 600 }, (_, index) => index + 1);
    const asked = membership.members(pids);
    await expect.poll(() => written.length).toBe(1);
    answer("members 1:11\n");
    await expect.poll(() => written.length).toBe(2);
    answer("members 600:6000\n");
    await expect(asked).resolves.toEqual([
      { pid: 1, uniqueId: "11" },
      { pid: 600, uniqueId: "6000" },
    ]);
    expect(written[0]?.split(" ")).toHaveLength(513);
  });

  it("ends the run's processes through the member and ends the member", async () => {
    const { duplex, written, answer } = channel();
    const membership = createSandboxMembership(duplex);
    answer("ready 99 990 40 400\nsignalled\n");
    await membership.killAll();
    expect(written).toEqual(["kill\n"]);
    membership.close();
    expect(written.at(-1)).toBe("exit\n");
    await expect(membership.occupied()).rejects.toBeInstanceOf(SandboxMembershipUnavailableError);
  });

  // A broadcast the kernel refused for another reason than ESRCH is no answer, nor is a member that
  // could not read its own identity, or one naming a process it was not asked about.
  it("refuses an answer out of protocol, a failed check and a member that has gone", async () => {
    for (const [ready, reply] of [
      ["ready 99 990 40 400", "something else"],
      ["ready 99 990 40 400", "failed"],
      ["unidentified", "empty"],
      ["ready 99 990", "empty"],
    ] as const) {
      const first = channel();
      first.answer(`${ready}\n${reply}\n`);
      const membership = createSandboxMembership(first.duplex);
      await expect(membership.occupied(), reply).rejects.toThrow("sandbox-membership-protocol");
      await expect(membership.occupied()).rejects.toThrow("sandbox-membership-ended");
    }
    const foreign = channel();
    foreign.answer("ready 99 990 40 400\nmembers 10:100 77:770\n");
    const naming = createSandboxMembership(foreign.duplex);
    await expect(naming.members([10, 20])).rejects.toThrow("sandbox-membership-protocol");
    await expect(naming.members([10])).rejects.toThrow("sandbox-membership-ended");
    const gone = channel();
    const membership = createSandboxMembership(gone.duplex);
    gone.answer("ready 99 990 40 400\n");
    gone.end();
    await expect(membership.occupied()).rejects.toThrow("sandbox-membership-ended");
  });

  it("asks one question at a time", async () => {
    const { duplex, answer } = channel();
    const membership = createSandboxMembership(duplex);
    const first = membership.occupied();
    await expect(membership.killAll()).rejects.toThrow("sandbox-membership-protocol");
    answer("ready 99 990 40 400\nempty\n");
    await expect(first).resolves.toBe(false);
  });

  // On the real kernel: the member answers for its own sandbox instance only. A process of another
  // instance of the identical profile and a process outside every sandbox are neither counted nor
  // signalled, and once the member has ended its instance's processes, the kernel reports none.
  it.skipIf(process.platform !== "darwin")(
    "answers and signals for its own sandbox instance only, on the real kernel",
    async () => {
      const outside = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
      const other = spawn("/usr/bin/sandbox-exec", ["-p", SIGNAL_PROFILE, "/bin/sleep", "30"], {
        stdio: "ignore",
      });
      // The run: a detached grandchild, a background child and the service, with the member beside it.
      const launch = sandboxMemberLaunch("/bin/sh", [
        "-c",
        '/bin/sh -c "/bin/sleep 30 & exit 0"; /bin/sleep 30 & exec /bin/sleep 30',
      ]);
      const run = spawn(
        "/usr/bin/sandbox-exec",
        ["-p", SIGNAL_PROFILE, launch.executable, ...launch.args],
        {
          stdio: ["ignore", "ignore", "ignore", "pipe"],
        },
      );
      const descriptor = run.stdio[3];
      if (!(descriptor instanceof Duplex)) throw new TypeError("member-descriptor-missing");
      const membership = createSandboxMembership(descriptor);
      try {
        const self = await membership.self();
        const ownTable = await readDarwinProcessTable();
        expect(ownTable.records).toContainEqual(
          expect.objectContaining({ pid: self.pid, uniqueId: self.uniqueId, zombie: false }),
        );
        const service = ownTable.records.find((row) => row.pid === run.pid);
        expect(service).toBeDefined();
        // The run's root forked the member, before any other process of the run.
        expect(self).toMatchObject({ parentPid: run.pid, parentUniqueId: service?.uniqueId });
        expect(BigInt(self.uniqueId)).toBeGreaterThan(BigInt(service?.uniqueId ?? "0"));
        // Of the service, a process outside every sandbox and one of another instance of the same
        // profile, the member names the service alone, with the identity the table shows.
        await expect(
          membership.members([run.pid ?? 0, outside.pid ?? 0, other.pid ?? 0]),
        ).resolves.toEqual([{ pid: run.pid, uniqueId: service?.uniqueId }]);
        await expect(membership.occupied()).resolves.toBe(true);
        await membership.killAll();
        // Every process of the run has ended; the member names nothing but itself.
        await expect
          .poll(
            async () =>
              membership.members(
                (await readDarwinProcessTable()).records
                  .map((row) => row.pid)
                  .filter((pid) => pid !== self.pid),
              ),
            { interval: 20 },
          )
          .toEqual([]);
        expect(alive(outside.pid)).toBe(true);
        expect(alive(other.pid)).toBe(true);
      } finally {
        membership.close();
        outside.kill("SIGKILL");
        other.kill("SIGKILL");
        run.kill("SIGKILL");
      }
    },
    20_000,
  );

  // PR #4064 review (4372402175), on the real kernel: XNU counts a zombie of the same user in the
  // broadcast check without the sandbox's test, so "occupied" may be a zombie outside the run. The
  // member's identity answer is the sandbox's: it never names that zombie, nor its parent.
  it.skipIf(process.platform !== "darwin")(
    "never names a zombie outside the run, which the broadcast check counts",
    async () => {
      const launch = sandboxMemberLaunch("/bin/sh", ["-c", "exit 0"]);
      const run = spawn(
        "/usr/bin/sandbox-exec",
        ["-p", SIGNAL_PROFILE, launch.executable, ...launch.args],
        { stdio: ["ignore", "ignore", "ignore", "pipe"] },
      );
      const descriptor = run.stdio[3];
      if (!(descriptor instanceof Duplex)) throw new TypeError("member-descriptor-missing");
      const membership = createSandboxMembership(descriptor);
      // A parent outside every sandbox holds its exited child unreaped.
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
        await membership.self();
        await expect
          .poll(
            async () =>
              (await readDarwinProcessTable()).records.find((row) => row.pid === zombie)?.zombie,
          )
          .toBe(true);
        await expect.poll(() => membership.occupied(), { interval: 20 }).toBe(true);
        await expect(membership.members([zombie, holder.pid ?? 0])).resolves.toEqual([]);
      } finally {
        membership.close();
        holder.kill("SIGKILL");
        run.kill("SIGKILL");
      }
    },
    20_000,
  );
});
