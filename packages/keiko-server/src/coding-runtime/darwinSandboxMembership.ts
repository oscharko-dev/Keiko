import type { Duplex } from "node:stream";

// #3899 AC2 / #3901 AC3 (PR #4064 review): which processes belong to a macOS run is answered by the
// kernel, never inferred from a parent link, a working directory, a start time or a PID. Every
// process a run starts inherits the run's Seatbelt instance through fork and exec, however it later
// detaches or changes its session, directory or environment, and the native profile admits
// `signal` and `process-info*` only towards the process itself and its own instance
// (`(target same-sandbox)`, keiko-sandbox seatbelt-execution-root.ts): another instance of the
// identical profile is refused. One member is therefore started beside the service and kept apart
// from its work, on descriptor 3, in a process group of its own. It is a short Perl program
// (`/usr/bin/perl`, part of macOS) that forks nothing, and it answers with three kernel calls:
// - `kill` with PID -1 in its original non-POSIX form (`syscall(37, -1, sig, 0)`): the kernel walks
//   every process, delivers only to those the member may signal, the processes of its instance,
//   and leaves the member itself out. Signal 0 reports ESRCH when it reached nothing; SIGKILL ends
//   them all. XNU also counts an exited process (a zombie) of the same user without the sandbox
//   check (`cansignal_nomac`), so "occupied" may mean a zombie anywhere on the host, never a
//   proof of a member. "Empty" is exact.
// - `proc_info` PIDINFO (`syscall(336, 2, pid, 18, 0, ...)`) for each PID it is asked about: the
//   sandbox answers EPERM for a process of anyone else and ESRCH for a zombie or a PID that is gone;
//   a process of the instance yields its `p_uniqueid`, the kernel's per-boot process identity,
//   which is never handed out again. The answer therefore names members by identity, not by PID.
//   The member announces its own identity, its parent's PID and the identity of the process that
//   forked it (`p_puniqueid`): the run's root, which the launch script forks the member from.
// The shell's `kill` uses the POSIX form, which includes the caller, which is why the member is not
// a shell. Without Perl the member never announces itself, and the run's end stays unproven. How a
// sweep turns the answers into a proof is darwinRuntimeDescendants.ts's.

const MEMBER_SCRIPT = [
  '$SIG{$_} = "IGNORE" for qw(HUP INT TERM);',
  "$| = 1;",
  // PROC_PIDT_BSDINFOWITHUNIQID (18) is 192 bytes; p_uniqueid and p_puniqueid sit at offset 152.
  String.raw`sub identity { my $info = "\0" x 192; return syscall(336, 2, $_[0] + 0, 18, 0, $info, 192) == 192 ? unpack("Q Q", substr($info, 152, 16)) : (); }`,
  "my ($self, $forker) = identity($$);",
  "my $parent = getppid();",
  'print defined $forker ? "ready $$ $self $parent $forker\n" : "unidentified\n";',
  "while (defined(my $line = <STDIN>)) {",
  "  chomp $line;",
  "  my ($command, @pids) = split / /, $line;",
  // SYS_kill is 37; the third argument 0 selects the non-POSIX broadcast that leaves the caller out.
  '  if ($command eq "check") { my $r = syscall(37, -1, 0, 0); print $r == 0 ? "occupied\n" : ($! + 0 == 3 ? "empty\n" : "failed\n"); }',
  '  elsif ($command eq "kill") { syscall(37, -1, 9, 0); print "signalled\n"; }',
  '  elsif ($command eq "members") { my @found; for my $pid (@pids) { my ($id) = identity($pid); push @found, "$pid:$id" if defined $id; } print join(" ", "members", @found), "\n"; }',
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
const READY = /^ready (\d+) (\d+) (\d+) (\d+)$/u;
const CHECKED = /^(?:occupied|empty)$/u;
const MEMBERS = /^members((?: \d+:\d+)*)$/u;
/** The PIDs one question names at most; a longer list is asked in parts. */
const MEMBERS_PER_QUESTION = 512;

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

/** A process of the run's sandbox instance: its PID and its kernel identity (`p_uniqueid`). */
export interface SandboxMember {
  readonly pid: number;
  readonly uniqueId: string;
}

/** The member itself, with the process that forked it. */
export interface SandboxMemberSelf extends SandboxMember {
  /** Its parent's PID when it announced itself; a reparented member names launchd. */
  readonly parentPid: number;
  /** `p_puniqueid`: the identity of the process that forked it. */
  readonly parentUniqueId: string;
}

export interface SandboxMembership {
  /** The member itself. */
  self(): Promise<SandboxMemberSelf>;
  /**
   * Whether any process of the run's sandbox instance besides the member exists, or a zombie of the
   * same user anywhere: `false` is exact, `true` proves nothing about the run.
   */
  occupied(): Promise<boolean>;
  /** Of the given live processes, those that belong to the run's sandbox instance now. */
  members(pids: readonly number[]): Promise<readonly SandboxMember[]>;
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
  private member: SandboxMemberSelf | undefined;
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

  public self(): Promise<SandboxMemberSelf> {
    return this.exclusive(() => this.announcement());
  }

  public async occupied(): Promise<boolean> {
    return (await this.ask("check", CHECKED)) === "occupied";
  }

  public async members(pids: readonly number[]): Promise<readonly SandboxMember[]> {
    const found: SandboxMember[] = [];
    for (let start = 0; start < pids.length; start += MEMBERS_PER_QUESTION) {
      const asked = pids.slice(start, start + MEMBERS_PER_QUESTION);
      const answer = await this.ask(`members ${asked.join(" ")}`, MEMBERS); // NOSONAR typescript:S9382 -- the member answers one question at a time; a concurrent one is a protocol error
      found.push(...this.parsedMembers(answer, asked));
    }
    return found;
  }

  public async killAll(): Promise<void> {
    await this.ask("kill", /^signalled$/u);
  }

  public close(): void {
    if (!this.ended && this.channel.writable) this.channel.end("exit\n");
    this.finish();
  }

  // Only an asked PID can be an answer; anything else is out of protocol.
  private parsedMembers(line: string, asked: readonly number[]): readonly SandboxMember[] {
    const requested = new Set(asked);
    const members = (MEMBERS.exec(line)?.[1] ?? "")
      .split(" ")
      .filter((entry) => entry !== "")
      .map((entry) => {
        const [pid = "", uniqueId = ""] = entry.split(":");
        return { pid: Number(pid), uniqueId };
      });
    if (members.some((member) => !requested.has(member.pid))) {
      this.ended = true;
      throw new SandboxMembershipUnavailableError("protocol");
    }
    return members;
  }

  // One question at a time: the member announces itself once, then answers each in one line.
  private ask(request: string, expected: RegExp): Promise<string> {
    return this.exclusive(async () => {
      await this.announcement();
      if (this.ended) throw new SandboxMembershipUnavailableError("ended");
      this.channel.write(`${request}\n`);
      return this.answer(expected);
    });
  }

  // A member that left the protocol or ended answers nothing more.
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.ended) throw new SandboxMembershipUnavailableError("ended");
    if (this.busy) throw new SandboxMembershipUnavailableError("protocol");
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }

  // The member names itself and the process that forked it before its first answer.
  private async announcement(): Promise<SandboxMemberSelf> {
    if (this.member === undefined) {
      const [, pid, uniqueId, parentPid, parentUniqueId] =
        READY.exec(await this.answer(READY)) ?? [];
      if (uniqueId === undefined || parentUniqueId === undefined)
        throw new SandboxMembershipUnavailableError("protocol");
      this.member = { pid: Number(pid), uniqueId, parentPid: Number(parentPid), parentUniqueId };
    }
    return this.member;
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
