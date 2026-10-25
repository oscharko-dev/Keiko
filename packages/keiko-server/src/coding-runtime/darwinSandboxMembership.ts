import type { Duplex } from "node:stream";

// #3899 AC2 / #3901 AC3 (PR #4064 review): which processes belong to a macOS run is answered by the
// kernel, never inferred from a parent link, a working directory, a start time or a PID. Every
// process a run starts inherits the run's Seatbelt instance through fork and exec, however it later
// detaches or changes its session, directory or environment, and the native profile lets a process
// signal only members of its own instance (`(target same-sandbox)`, keiko-sandbox
// seatbelt-execution-root.ts): another instance of the identical profile is refused. One member is
// therefore started beside the service and kept apart from its work, on descriptor 3, in a process
// group of its own. It uses the kernel's broadcast signal, `kill` with PID -1, in its original
// non-POSIX form: the kernel walks every process, delivers only to those the member may signal (the
// processes of its instance), leaves the member itself out, and reports ESRCH when it reached none.
// Signal 0 therefore answers whether any other process of the instance exists, and SIGKILL ends
// them all, with no listing and no process identity to go stale. The shell's `kill` uses the POSIX
// form, which includes the caller, so the member is a short Perl program (`/usr/bin/perl`, part of
// macOS) that forks nothing: once it is the only process of the instance, no other can appear.
// Without Perl the member never announces itself, and the run's end stays unproven. How a sweep
// turns the answers into a proof is darwinRuntimeDescendants.ts's.

const MEMBER_SCRIPT = [
  '$SIG{$_} = "IGNORE" for qw(HUP INT TERM);',
  "$| = 1;",
  'print "ready $$\n";',
  "while (defined(my $line = <STDIN>)) {",
  "  chomp $line;",
  // SYS_kill is 37; the third argument 0 selects the non-POSIX broadcast that leaves the caller out.
  '  if ($line eq "check") { my $r = syscall(37, -1, 0, 0); print $r == 0 ? "occupied\n" : ($! + 0 == 3 ? "empty\n" : "failed\n"); }',
  '  elsif ($line eq "kill") { syscall(37, -1, 9, 0); print "signalled\n"; }',
  "  else { exit 0; }",
  "}",
].join("\n");

// The service keeps its PID, standard streams and process group; descriptor 3 is closed before it
// starts. Job control gives the member its own process group, so a group signal to the service
// never reaches it.
const LAUNCH_SCRIPT =
  'member="$1"; shift; set -m; /usr/bin/perl -e "$member" 0<&3 1>&3 2>/dev/null & set +m; exec 3<&- "$@"';

export const SANDBOX_MEMBER_SHELL = "/bin/sh";
export const SANDBOX_MEMBER_FD = 3;
const ANSWER_TIMEOUT_MS = 5_000;
const READY = /^ready \d+$/u;
const CHECKED = /^(?:occupied|empty)$/u;

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
  /** Whether any process of the run's sandbox instance besides the member exists now. */
  occupied(): Promise<boolean>;
  /** Sends SIGKILL to every other process of the instance; the kernel reaches no other process. */
  killAll(): Promise<void>;
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

  public async occupied(): Promise<boolean> {
    return (await this.ask("check", CHECKED)) === "occupied";
  }

  public async killAll(): Promise<void> {
    await this.ask("kill", /^signalled$/u);
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
