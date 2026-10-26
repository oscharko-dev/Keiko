// #3899 AC2 / #3901 AC3 (PR #4064 review): the host's processes as the kernel identifies them,
// read outside every sandbox. `proc_info` lists every PID (LISTPIDS, all) and then reads each one's
// PIDINFO (PROC_PIDT_BSDINFOWITHUNIQID, zombies included): its status, its `p_uniqueid` (the
// kernel's per-boot identity, assigned at fork from a counter that only grows, kept across exec and
// never handed out again) and its `p_puniqueid` (the identity of the process that forked it, which
// reparenting never changes). A PID that ended between the listing and its read is counted as gone.
// The kernel refuses that read (EPERM) for a process whose effective uid is another user's; its
// short BSD info, which the kernel gives for every process, names that uid. Only a process proven
// to be another user's counts as foreign: it cannot be a member of a run, because Seatbelt refuses
// to execute a setuid program inside a sandbox, so every process of a run keeps the user's uid. Any
// other refusal leaves the process unidentified. Perl (`/usr/bin/perl`, part of macOS) makes the
// calls, as it does for the run's sandbox member; the process layer (devLaneRuntimeProcessBackend.ts)
// runs it.

/** One process the kernel listed and identified. */
export interface ProcessRecord {
  readonly pid: number;
  /** The process has exited and waits to be reaped. */
  readonly zombie: boolean;
  /** `p_uniqueid`: the kernel's per-boot identity of the process. */
  readonly uniqueId: string;
  /** `p_puniqueid`: the identity of the process that forked it. */
  readonly parentUniqueId: string;
}

export interface ProcessTable {
  readonly records: readonly ProcessRecord[];
  /** PIDs the listing named that had ended, and been reaped, before their identity was read. */
  readonly goneCount: number;
  /** Processes of other users, which no run of this user can own. */
  readonly foreignUserCount: number;
  /** Processes the kernel refused to identify for another reason. */
  readonly unidentifiedCount: number;
}

export type ProcessTableReader = () => Promise<ProcessTable>;

/** `execFile`, promisified: runs a program without a shell and returns its standard output. */
export type ProcessTableExec = (
  file: string,
  args: readonly string[],
  options: {
    readonly encoding: "utf8";
    readonly env: Readonly<Record<string, string>>;
    readonly maxBuffer: number;
  },
) => Promise<{ readonly stdout: string }>;

const PERL_PATH = "/usr/bin/perl";
const TABLE_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const SZOMB = 5;
const TABLE_SCRIPT = [
  String.raw`my $size = 4 * 65536; my $buf = "\0" x $size;`,
  // proc_info(LISTPIDS = 1, PROC_ALL_PIDS = 1): the size of the PID array in bytes.
  "my $n = syscall(336, 1, 1, 0, 0, $buf, $size);",
  String.raw`die "listpids\n" if $n < 0;`,
  'for my $pid (grep { $_ > 0 } unpack("l*", substr($buf, 0, $n))) {',
  String.raw`  my $info = "\0" x 192;`,
  // proc_info(PIDINFO = 2, pid, PROC_PIDT_BSDINFOWITHUNIQID = 18, arg 1 = zombies too).
  "  my $read = syscall(336, 2, $pid, 18, 1, $info, 192); my $errno = $! + 0;",
  "  if ($read == 192) {",
  '    my ($status) = unpack("x4 L", $info);',
  '    my ($uniq, $puniq) = unpack("Q Q", substr($info, 152, 16));',
  String.raw`    print "$pid $status $uniq $puniq\n";`,
  String.raw`  } elsif ($errno == 3) { print "$pid gone\n"; }`,
  // EPERM: PROC_PIDT_SHORTBSDINFO (13, 64 bytes) names the effective uid at offset 36.
  "  elsif ($errno == 1) {",
  String.raw`    my $short = "\0" x 64;`,
  '    my $other = syscall(336, 2, $pid, 13, 1, $short, 64) == 64 && unpack("L", substr($short, 36, 4)) != $>;',
  String.raw`    print "$pid ", ($other ? "foreign" : "unidentified"), "\n";`,
  String.raw`  } else { print "$pid unidentified\n"; }`,
  "}",
].join("\n");
const RECORD = /^(\d+) (\d+) (\d+) (\d+)$/u;
const UNREAD = /^\d+ (foreign|gone|unidentified)$/u;

type UnreadReason = "foreign" | "gone" | "unidentified";

function unreadReason(line: string): UnreadReason | undefined {
  const reason = UNREAD.exec(line)?.[1];
  return reason === "foreign" || reason === "gone" || reason === "unidentified"
    ? reason
    : undefined;
}

function parsedRecord(match: RegExpExecArray): ProcessRecord | undefined {
  const [, pid, status, uniqueId, parentUniqueId] = match;
  if (uniqueId === undefined || parentUniqueId === undefined) return undefined;
  return { pid: Number(pid), zombie: Number(status) === SZOMB, uniqueId, parentUniqueId };
}

/** The table the lister printed; a line out of its grammar makes the whole table unusable. */
export function parseProcessTable(output: string): ProcessTable {
  const records: ProcessRecord[] = [];
  const unread: Record<UnreadReason, number> = { foreign: 0, gone: 0, unidentified: 0 };
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const record = RECORD.exec(line);
    const parsed = record === null ? undefined : parsedRecord(record);
    const reason = unreadReason(line);
    if (parsed !== undefined) records.push(parsed);
    else if (reason !== undefined) unread[reason] += 1;
    else throw new TypeError("darwin-process-table-malformed");
  }
  return {
    records,
    goneCount: unread.gone,
    foreignUserCount: unread.foreign,
    unidentifiedCount: unread.unidentified,
  };
}

/** Reads this host's process table outside every sandbox, through the given `execFile`. */
export function darwinProcessTableReader(exec: ProcessTableExec): ProcessTableReader {
  return async () => {
    const { stdout } = await exec(PERL_PATH, ["-e", TABLE_SCRIPT], {
      encoding: "utf8",
      env: {},
      maxBuffer: TABLE_MAX_BUFFER_BYTES,
    });
    return parseProcessTable(stdout);
  };
}
