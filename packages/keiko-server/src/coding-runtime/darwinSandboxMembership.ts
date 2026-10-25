import type { Duplex } from "node:stream";

// #3899 AC2 / #3901 AC3 (PR #4064 review): which processes belong to a macOS run is answered by the
// kernel, never inferred from a parent link, a working directory or a start time. Every process a
// run starts inherits the run's Seatbelt instance through fork and exec, however it later detaches,
// changes its session, directory or environment, and the native profile lets a process signal only
// members of its own instance (`(target same-sandbox)`, keiko-sandbox seatbelt-execution-root.ts):
// another instance of the identical profile is refused. One member is therefore started beside the
// service and kept apart from its work: a shell of builtins only, in a process group of its own, on
// descriptor 3. It tests the PIDs Keiko lists (`kill -0`) and signals the ones it may. A PID it may
// signal belongs to the run; one it may not does not, whoever its parent is. The member forks
// nothing and stops or kills only what the kernel lets it signal; how a sweep turns its answers into
// a proof is darwinRuntimeDescendants.ts's.

const MEMBER_SCRIPT = [
  "trap '' HUP INT TERM",
  'echo "ready $$"',
  "while read -r command pids; do",
  '  case "$command" in',
  '    members) out=""; for p in $pids; do [ "$p" != "$$" ] && kill -0 "$p" 2>/dev/null && out="$out $p"; done; echo "members$out" ;;',
  '    stop) for p in $pids; do [ "$p" != "$$" ] && kill -STOP "$p" 2>/dev/null; done; echo signalled ;;',
  '    kill) for p in $pids; do [ "$p" != "$$" ] && kill -KILL "$p" 2>/dev/null; done; echo signalled ;;',
  "    *) exit 0 ;;",
  "  esac",
  "done",
].join("\n");

// The service keeps its PID, standard streams and process group; descriptor 3 is closed before it
// starts. Job control gives the member its own process group, so a group signal to the service
// never reaches it.
const LAUNCH_SCRIPT =
  'member="$1"; shift; set -m; /bin/sh -c "$member" keiko-sandbox-member 0<&3 1>&3 2>/dev/null & set +m; exec 3<&- "$@"';

export const SANDBOX_MEMBER_SHELL = "/bin/sh";
export const SANDBOX_MEMBER_FD = 3;
const ANSWER_TIMEOUT_MS = 5_000;
const READY = /^ready \d+$/u;
const MEMBERS = /^members((?: \d+)*)$/u;

/** The command that starts `executable` as the run's service with its sandbox member beside it. */
export function sandboxMemberLaunch(
  executable: string,
  args: readonly string[],
): { readonly executable: string; readonly args: readonly string[] } {
  return {
    executable: SANDBOX_MEMBER_SHELL,
    args: ["-c", LAUNCH_SCRIPT, "keiko-runtime", MEMBER_SCRIPT, executable, ...args],
  };
}

export interface SandboxMembership {
  /** The given PIDs that belong to the run's sandbox instance, as the kernel answers its member. */
  members(pids: readonly number[]): Promise<readonly number[]>;
  /** Signals the given PIDs from inside the instance; the kernel refuses every other process. */
  signal(pids: readonly number[], signal: "stop" | "kill"): Promise<void>;
  /** Ends the member; it is not part of the run's work. */
  close(): void;
}

/** The member did not answer: it ended, its descriptor closed, or it answered out of protocol. */
export class SandboxMembershipUnavailableError extends Error {
  public constructor(reason: "ended" | "timeout" | "protocol") {
    super(`sandbox-membership-${reason}`);
    this.name = "SandboxMembershipUnavailableError";
  }
}

class ChannelSandboxMembership implements SandboxMembership {
  private buffer = "";
  private readonly lines: string[] = [];
  private waiting: ((line: string | undefined) => void) | undefined;
  private ended = false;
  private announced = false;
  private busy = false;

  public constructor(private readonly channel: Duplex) {
    channel.setEncoding("utf8");
    channel.on("data", (chunk: string) => {
      this.receive(chunk);
    });
    for (const event of ["end", "close", "error"] as const)
      channel.on(event, () => {
        this.finish();
      });
  }

  public async members(pids: readonly number[]): Promise<readonly number[]> {
    if (pids.length === 0) return [];
    const requested = new Set(pids);
    const line = await this.ask(`members ${pids.join(" ")}`, MEMBERS);
    const found = (MEMBERS.exec(line)?.[1] ?? "").split(" ").filter((entry) => entry !== "");
    // Only an asked PID can be an answer; anything else is out of protocol.
    const members = found.map(Number);
    if (members.some((pid) => !requested.has(pid))) {
      this.ended = true;
      throw new SandboxMembershipUnavailableError("protocol");
    }
    return members;
  }

  public async signal(pids: readonly number[], signal: "stop" | "kill"): Promise<void> {
    if (pids.length === 0) return;
    await this.ask(`${signal} ${pids.join(" ")}`, /^signalled$/u);
  }

  public close(): void {
    if (!this.ended && this.channel.writable) this.channel.end("exit\n");
    this.finish();
  }

  // One question at a time: the member announces itself once, then answers each in one line.
  private async ask(request: string, expected: RegExp): Promise<string> {
    if (this.busy) throw new SandboxMembershipUnavailableError("protocol");
    this.busy = true;
    try {
      if (!this.announced) {
        await this.answer(READY);
        this.announced = true;
      }
      if (this.ended) throw new SandboxMembershipUnavailableError("ended");
      this.channel.write(`${request}\n`);
      return await this.answer(expected);
    } finally {
      this.busy = false;
    }
  }

  private answer(expected: RegExp): Promise<string> {
    return new Promise((resolve, reject) => {
      // A late answer would pair with the next question, so a member that missed one is done.
      const timeout = setTimeout(() => {
        this.waiting = undefined;
        this.ended = true;
        reject(new SandboxMembershipUnavailableError("timeout"));
      }, ANSWER_TIMEOUT_MS);
      timeout.unref();
      this.waiting = (line): void => {
        clearTimeout(timeout);
        this.waiting = undefined;
        if (line === undefined) reject(new SandboxMembershipUnavailableError("ended"));
        else if (expected.test(line)) resolve(line);
        else {
          this.ended = true;
          reject(new SandboxMembershipUnavailableError("protocol"));
        }
      };
      this.deliver();
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    for (let end = this.buffer.indexOf("\n"); end !== -1; end = this.buffer.indexOf("\n")) {
      this.lines.push(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end + 1);
    }
    this.deliver();
  }

  private deliver(): void {
    if (this.waiting === undefined) return;
    const line = this.lines.shift();
    if (line !== undefined) this.waiting(line);
    else if (this.ended) this.waiting(undefined);
  }

  private finish(): void {
    this.ended = true;
    this.deliver();
  }
}

/** The membership of one run, answered by its member over the given descriptor. */
export function createSandboxMembership(channel: Duplex): SandboxMembership {
  return new ChannelSandboxMembership(channel);
}
