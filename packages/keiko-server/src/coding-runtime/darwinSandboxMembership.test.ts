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

describe("the run's sandbox member (#3899 AC2, #3901 AC3)", () => {
  it("starts the service in place with the member beside it on descriptor 3", () => {
    const launch = sandboxMemberLaunch("/runtime/bin/opencode", ["serve", "--port", "0"]);
    expect(launch.executable).toBe(SANDBOX_MEMBER_SHELL);
    expect(launch.args.slice(0, 2)).toEqual(["-c", expect.stringContaining('exec 3<&- "$@"')]);
    expect(launch.args.slice(2, 3)).toEqual(["keiko-runtime"]);
    expect(launch.args.slice(4)).toEqual(["/runtime/bin/opencode", "serve", "--port", "0"]);
    // The member uses builtins only: it starts no process of its own while it answers.
    expect(launch.args[3]).not.toMatch(/\$\(|`|\|/u);
  });

  it("waits for the member to announce itself, then asks which PIDs belong to the run", async () => {
    const { duplex, written, answer } = channel();
    const membership = createSandboxMembership(duplex);
    const asked = membership.members([10, 20, 30]);
    answer("ready 99\n");
    await expect.poll(() => written).toEqual(["members 10 20 30\n"]);
    // An answer may arrive in pieces.
    answer("members 1");
    answer("0 30\n");
    await expect(asked).resolves.toEqual([10, 30]);
    await expect(membership.members([])).resolves.toEqual([]);
  });

  it("signals through the member and ends it", async () => {
    const { duplex, written, answer } = channel();
    const membership = createSandboxMembership(duplex);
    answer("ready 99\nsignalled\n");
    await membership.signal([10, 30], "kill");
    expect(written).toEqual(["kill 10 30\n"]);
    membership.close();
    expect(written.at(-1)).toBe("exit\n");
    await expect(membership.members([10])).rejects.toBeInstanceOf(
      SandboxMembershipUnavailableError,
    );
  });

  it("refuses an answer that names a PID it was not asked about, and every later question", async () => {
    const { duplex, answer } = channel();
    const membership = createSandboxMembership(duplex);
    answer("ready 99\nmembers 10 77\n");
    await expect(membership.members([10, 20])).rejects.toThrow("sandbox-membership-protocol");
    await expect(membership.members([10])).rejects.toThrow("sandbox-membership-ended");
  });

  it("refuses an answer out of protocol and a member that has gone", async () => {
    const first = channel();
    first.answer("ready 99\nsomething else\n");
    await expect(createSandboxMembership(first.duplex).members([10])).rejects.toThrow(
      "sandbox-membership-protocol",
    );
    const gone = channel();
    const membership = createSandboxMembership(gone.duplex);
    gone.answer("ready 99\n");
    gone.end();
    await expect(membership.members([10])).rejects.toThrow("sandbox-membership-ended");
  });

  it("asks one question at a time", async () => {
    const { duplex, answer } = channel();
    const membership = createSandboxMembership(duplex);
    const first = membership.members([10]);
    await expect(membership.members([20])).rejects.toThrow("sandbox-membership-protocol");
    answer("ready 99\nmembers 10\n");
    await expect(first).resolves.toEqual([10]);
  });
});
