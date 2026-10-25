import { spawn } from "node:child_process";
import { Duplex } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  createSandboxMembership,
  SANDBOX_MEMBER_SHELL,
  SandboxMembershipUnavailableError,
  sandboxMemberLaunch,
} from "./darwinSandboxMembership.js";

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

  it("waits for the member to announce itself, then asks whether any process of the run remains", async () => {
    const { duplex, written, answer } = channel();
    const membership = createSandboxMembership(duplex);
    const asked = membership.occupied();
    answer("ready 99\n");
    await expect.poll(() => written).toEqual(["check\n"]);
    // An answer may arrive in pieces.
    answer("occu");
    answer("pied\n");
    await expect(asked).resolves.toBe(true);
    const again = membership.occupied();
    answer("empty\n");
    await expect(again).resolves.toBe(false);
  });

  it("ends the run's processes through the member and ends the member", async () => {
    const { duplex, written, answer } = channel();
    const membership = createSandboxMembership(duplex);
    answer("ready 99\nsignalled\n");
    await membership.killAll();
    expect(written).toEqual(["kill\n"]);
    membership.close();
    expect(written.at(-1)).toBe("exit\n");
    await expect(membership.occupied()).rejects.toBeInstanceOf(SandboxMembershipUnavailableError);
  });

  // A broadcast the kernel refused for another reason than ESRCH is no answer.
  it("refuses an answer out of protocol, a failed check and a member that has gone", async () => {
    for (const reply of ["something else", "failed"]) {
      const first = channel();
      first.answer(`ready 99\n${reply}\n`);
      const membership = createSandboxMembership(first.duplex);
      await expect(membership.occupied(), reply).rejects.toThrow("sandbox-membership-protocol");
      await expect(membership.occupied()).rejects.toThrow("sandbox-membership-ended");
    }
    const gone = channel();
    const membership = createSandboxMembership(gone.duplex);
    gone.answer("ready 99\n");
    gone.end();
    await expect(membership.occupied()).rejects.toThrow("sandbox-membership-ended");
  });

  it("asks one question at a time", async () => {
    const { duplex, answer } = channel();
    const membership = createSandboxMembership(duplex);
    const first = membership.occupied();
    await expect(membership.killAll()).rejects.toThrow("sandbox-membership-protocol");
    answer("ready 99\nempty\n");
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
        await expect(membership.occupied()).resolves.toBe(true);
        await membership.killAll();
        await expect.poll(() => membership.occupied(), { interval: 20 }).toBe(false);
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
});
