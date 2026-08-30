import { captureActivityLog } from "./activityLogCapture.test-support.js";
import { describe, expect, it, vi } from "vitest";
import type { GitProcessResult, GitProcessRunner } from "@oscharko-dev/keiko-git";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import { logGitProcessOutcome, observedGitRunner } from "./gitProcessActivity.js";
import {
  createBufferedServerLogSink,
  type ServerLogEvent,
  type ServerLogSink,
} from "./observability/index.js";

function result(overrides: Partial<GitProcessResult> = {}): GitProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: false,
    timedOut: false,
    aborted: false,
    ...overrides,
  };
}

const STATUS_ARGS = ["--no-pager", "--no-optional-locks", "-C", "/repo", "status"] as const;

function onlyEvent(events: readonly ServerLogEvent[]): ServerLogEvent {
  expect(events).toHaveLength(1);
  const event = events[0];
  if (event === undefined) throw new Error("expected exactly one activity-log event");
  return event;
}

describe("logGitProcessOutcome", () => {
  it("writes nothing for a successful git run", () => {
    const log = captureActivityLog();

    logGitProcessOutcome(log.sink, "corr-success-0001", STATUS_ARGS, result(), 4);

    // The `http`/`request` line server.ts already writes carries the successful outcome. A line
    // per successful spawn would multiply the log volume of a polling UI without adding a fact.
    // "Clean" means exit 0 AND untruncated — see the byte-cap test below for why that matters.
    expect(log.events).toEqual([]);
  });

  it("reports the spawn-boundary refusal on the security category with its refusal class", () => {
    const log = captureActivityLog();

    logGitProcessOutcome(
      log.sink,
      "corr-refusal-0001",
      ["--no-pager", "-c", "diff.external=/bin/sh", "diff"],
      result({
        exitCode: 128,
        stderr: "refused git option: -c diff.external",
        refusal: "config-override",
      }),
      1,
    );

    expect(onlyEvent(log.events)).toMatchObject({
      level: "error",
      category: "security",
      op: "git.process.refused",
      correlationId: "corr-refusal-0001",
      errorKind: "git-option-refused",
      durationMs: 1,
      extra: {
        subcommand: "diff",
        exitCode: 128,
        refusal: "config-override",
        truncated: false,
        timedOut: false,
        aborted: false,
      },
    });
  });

  it("does not classify a refusal through the shared git failure classifier", () => {
    // A refusal exits 128 with a stderr no phrase table matches, so `classifyGitFailure` reports
    // it as the generic `git-error`. If this line inherited that, Keiko's own security refusal
    // would be indistinguishable in the log from a repository that simply failed to read.
    const log = captureActivityLog();

    logGitProcessOutcome(
      log.sink,
      "corr-refusal-0002",
      ["clone", "--upload-pack=/bin/sh"],
      result({
        exitCode: 128,
        stderr: "refused git option: --upload-pack",
        refusal: "remote-command-option",
      }),
      0,
    );

    const event = onlyEvent(log.events);
    expect(event.errorKind).toBe("git-option-refused");
    expect(event.errorKind).not.toBe("git-error");
    expect(event.op).toBe("git.process.refused");
  });

  it.each([
    {
      label: "a missing git executable",
      failure: result({ exitCode: 127 }),
      kind: "git-missing",
      endedBy: "exit",
    },
    {
      label: "a wall-clock timeout",
      failure: result({ exitCode: null, signal: "SIGTERM", truncated: true, timedOut: true }),
      kind: "timeout",
      endedBy: "signal",
    },
    {
      label: "unsafe repository ownership",
      failure: result({ exitCode: 128, stderr: "fatal: detected dubious ownership" }),
      kind: "unsafe-repository",
      endedBy: "exit",
    },
    {
      label: "a folder that is not a repository",
      failure: result({ exitCode: 128, stderr: "fatal: not a git repository" }),
      kind: "not-a-repository",
      endedBy: "exit",
    },
  ])(
    "reports $label as a diagnostic failure with errorKind $kind",
    ({ failure, kind, endedBy }) => {
      const log = captureActivityLog();

      logGitProcessOutcome(log.sink, "corr-failure-0001", STATUS_ARGS, failure, 7);

      expect(onlyEvent(log.events)).toMatchObject({
        level: "warn",
        category: "diagnostic",
        op: "git.process.failed",
        correlationId: "corr-failure-0001",
        errorKind: kind,
        durationMs: 7,
        extra: {
          subcommand: "status",
          endedBy,
          ...(failure.exitCode === null ? {} : { exitCode: failure.exitCode }),
        },
      });
    },
  );

  it("classifies the ORDINARY byte-cap stop, not just the exit-0 race", () => {
    // The cap kills a still-running child, so the common shape is `exitCode: null` plus a signal —
    // the exit-0 close is the rarer race. Testing the exit code caught only the race and let this
    // case fall through to `git-error` while `extra.truncated` said otherwise, so the line
    // contradicted itself.
    const log = captureActivityLog();

    logGitProcessOutcome(
      log.sink,
      "corr-cap-normal-001",
      STATUS_ARGS,
      result({ exitCode: null, signal: "SIGTERM", truncated: true }),
      11,
    );

    expect(onlyEvent(log.events)).toMatchObject({
      errorKind: "output-truncated",
      extra: { endedBy: "signal", signal: "SIGTERM", truncated: true },
    });
  });

  it.each([
    {
      label: "a rejected credential",
      subcommand: "fetch",
      stderr: "fatal: Authentication failed for 'https://example.invalid/r.git'",
      kind: "auth-failed",
    },
    {
      label: "an unreachable host",
      subcommand: "clone",
      stderr: "fatal: unable to access: Could not resolve host: example.invalid",
      kind: "remote-unavailable",
    },
    {
      label: "an untrusted host key",
      subcommand: "pull",
      stderr: "Host key verification failed.",
      kind: "untrusted-host-key",
    },
  ])("keeps the remote taxonomy for $label on a $subcommand", ({ subcommand, stderr, kind }) => {
    // The local classifier has no member for any of these and folds them all into `git-error`.
    // Because the raw output is deliberately absent from the log, that would leave an operator
    // unable to tell a wrong credential from a down network — on the one surface where the
    // difference decides what to do next.
    const log = captureActivityLog();

    logGitProcessOutcome(
      log.sink,
      "corr-remote-00001",
      ["--no-pager", subcommand],
      result({ exitCode: 128, stderr }),
      20,
    );

    expect(onlyEvent(log.events).errorKind).toBe(kind);
  });

  it("stays silent for a non-zero exit the call site declared successful", () => {
    // `git diff --no-index` exits 1 to mean "the files differ" — the outcome that call exists to
    // produce. Only the call site knows this, so it declares it rather than the observer guessing.
    const log = captureActivityLog();
    const differs = result({ exitCode: 1, stdout: "diff --git a/x b/x" });

    logGitProcessOutcome(log.sink, "corr-expected-00001", ["--no-pager", "diff"], differs, 3, [1]);
    expect(log.events).toEqual([]);

    // The declaration is narrow: a different non-zero code is still a failure, and a truncated run
    // is reported even when its code was declared expected.
    logGitProcessOutcome(
      log.sink,
      "corr-expected-00002",
      ["--no-pager", "diff"],
      result({ exitCode: 2 }),
      3,
      [1],
    );
    logGitProcessOutcome(
      log.sink,
      "corr-expected-00003",
      ["--no-pager", "diff"],
      result({ exitCode: 1, truncated: true }),
      3,
      [1],
    );
    expect(log.events.map((event) => event.errorKind)).toEqual(["git-error", "output-truncated"]);
  });

  it("reports a byte-cap truncation even though the run exited 0", () => {
    // Keiko's byte cap sets `truncated` and terminates the child INDEPENDENTLY of the exit status,
    // so a read cut off while git was already finishing closes with 0. A bare `exitCode === 0`
    // guard drops it — the exact ranking mistake keiko-git's classifyGitRemoteFailure was hardened
    // against after it made the sync executor report such a run as "succeeded" (#2869). The route
    // tells the caller `truncated: true`; the log must not say nothing happened.
    const log = captureActivityLog();

    logGitProcessOutcome(
      log.sink,
      "corr-truncated-0001",
      STATUS_ARGS,
      result({ exitCode: 0, stdout: "partial", truncated: true }),
      9,
    );

    expect(onlyEvent(log.events)).toMatchObject({
      level: "warn",
      category: "diagnostic",
      op: "git.process.failed",
      correlationId: "corr-truncated-0001",
      errorKind: "output-truncated",
      extra: { subcommand: "status", endedBy: "exit", exitCode: 0, truncated: true },
    });
  });

  it("keeps the deadline and the caller's cancellation ranked above the byte cap", () => {
    // The runner sets `truncated` on a timeout AND on an abort, so a cap-first ranking would
    // relabel both as `output-truncated` and erase the distinction each kind exists to carry.
    const log = captureActivityLog();

    logGitProcessOutcome(
      log.sink,
      "corr-precedence-0001",
      STATUS_ARGS,
      result({ exitCode: 0, truncated: true, timedOut: true }),
      30_000,
    );
    logGitProcessOutcome(
      log.sink,
      "corr-precedence-0002",
      STATUS_ARGS,
      result({ exitCode: 0, truncated: true, aborted: true }),
      5,
    );

    expect(log.events.map((event) => event.errorKind)).toEqual(["timeout", "git-cancelled"]);
  });

  it("separates an untrusted git executable from a machine with no git at all", () => {
    // Both exit 127 and both classify as `git-missing`, so before keiko-git reported the refusal
    // structurally the planted-binary indicator (KEIKO-0263) was indistinguishable in the log from
    // a mundane environment problem — and its only distinguishing evidence, the stderr text, is
    // not body-free and can never be logged.
    const log = captureActivityLog();

    logGitProcessOutcome(
      log.sink,
      "corr-untrusted-0001",
      STATUS_ARGS,
      result({ exitCode: 127, stderr: "...", refusal: "untrusted-executable" }),
      2,
    );
    logGitProcessOutcome(log.sink, "corr-nogit-000001", STATUS_ARGS, result({ exitCode: 127 }), 2);

    const [untrusted, missing] = log.events;
    expect(untrusted).toMatchObject({
      level: "error",
      category: "security",
      op: "git.process.refused",
      errorKind: "git-executable-untrusted",
      extra: { refusal: "untrusted-executable" },
    });
    expect(missing).toMatchObject({
      level: "warn",
      category: "diagnostic",
      op: "git.process.failed",
      errorKind: "git-missing",
    });
  });

  it("records a caller-cancelled run at info, not as a fault", () => {
    const log = captureActivityLog();

    logGitProcessOutcome(
      log.sink,
      "corr-cancel-0001",
      STATUS_ARGS,
      result({ exitCode: null, signal: "SIGTERM", truncated: true, aborted: true }),
      12,
    );

    // A UI that abandons a diff it no longer needs is routine navigation, and must not read as an
    // incident — but it is still recorded, so an operator can tell it from a git failure.
    expect(onlyEvent(log.events)).toMatchObject({
      level: "info",
      op: "git.process.failed",
      errorKind: "git-cancelled",
      extra: { aborted: true, endedBy: "signal", signal: "SIGTERM" },
    });
  });

  it("reports `unknown` when a result carries neither an exit code nor a signal", () => {
    // The arm that exists so a fake which sets neither is reported honestly instead of being
    // mislabelled as a clean exit. Unreachable through the real runner, which is exactly why it
    // needs a test: nothing else would notice if the fallback were changed to `signal`.
    const log = captureActivityLog();

    logGitProcessOutcome(log.sink, "corr-neither-0001", STATUS_ARGS, result({ exitCode: null }), 1);

    const event = onlyEvent(log.events);
    expect(event.extra).toMatchObject({ endedBy: "unknown" });
    expect(event.extra).not.toHaveProperty("exitCode");
    expect(event.extra).not.toHaveProperty("signal");
  });

  it("survives an empty argv and still names the subcommand honestly", () => {
    // `gitSubcommand([])` has no token to read. The emitter must report `unknown` rather than throw
    // inside the logging path — a log line can never become a new failure mode for the operation
    // being logged.
    const log = captureActivityLog();

    expect(() => {
      logGitProcessOutcome(log.sink, "corr-empty-argv-01", [], result({ exitCode: 1 }), 0);
    }).not.toThrow();
    expect(onlyEvent(log.events).extra).toMatchObject({ subcommand: "unknown" });
  });

  it("falls back to the sanctioned unknown correlation id rather than inventing one", () => {
    const log = captureActivityLog();

    logGitProcessOutcome(log.sink, undefined, STATUS_ARGS, result({ exitCode: 1 }), 0);

    expect(onlyEvent(log.events).correlationId).toBe(UNKNOWN_CORRELATION_ID);
  });

  it("carries no git output, path or config value into the line", () => {
    const log = captureActivityLog();

    logGitProcessOutcome(
      log.sink,
      "corr-redaction-0001",
      ["--no-pager", "-C", "/home/customer/secret-project", "-c", "alias.x=!curl evil", "log"],
      result({
        exitCode: 128,
        stdout: "commit 9f8e7d /home/customer/secret-project/notes.md",
        stderr: "fatal: ambiguous argument '/home/customer/secret-project'",
        refusal: "config-override",
      }),
      3,
    );

    // Body-free is the whole contract (ADR-0173 D4): the line names WHICH preflight fired and how
    // the run ended, and nothing about the repository, the caller-chosen alias name, or git's own
    // output — every one of which appears in the inputs above.
    const serialized = JSON.stringify(onlyEvent(log.events));
    expect(serialized).not.toContain("secret-project");
    expect(serialized).not.toContain("notes.md");
    expect(serialized).not.toContain("curl evil");
    expect(serialized).not.toContain("ambiguous argument");
  });

  it.each([
    { label: "an absolute path at the subcommand position", token: "/etc/passwd" },
    { label: "a config assignment", token: "core.pager=less" },
  ])("names the subcommand `unknown` for $label", ({ token }) => {
    const log = captureActivityLog();

    logGitProcessOutcome(
      log.sink,
      "corr-shape-0001",
      ["--no-pager", token],
      result({ exitCode: 1 }),
      0,
    );

    expect(onlyEvent(log.events).extra).toMatchObject({ subcommand: "unknown" });
  });
});

describe("observedGitRunner", () => {
  it("passes args and options through and returns the underlying result unchanged", async () => {
    const log = captureActivityLog();
    const failure = result({ exitCode: 128, stderr: "fatal: not a git repository" });
    const underlying = vi.fn<GitProcessRunner>().mockResolvedValue(failure);
    const options = { cwd: "/repo", maxBytes: 4096, timeoutMs: 5_000 };

    const observed = await observedGitRunner(
      underlying,
      log.sink,
      "corr-passthrough-01",
    )(STATUS_ARGS, options);

    expect(observed).toBe(failure);
    expect(underlying).toHaveBeenCalledWith(STATUS_ARGS, options);
    expect(onlyEvent(log.events).op).toBe("git.process.failed");
  });

  it("re-throws a runner defect untouched and writes no line for it", async () => {
    // The runner's contract is to RESOLVE with a result for every process outcome, spawn failure
    // included. A throw is therefore a defect in the runner, not a git outcome: it must reach the
    // route's existing diagnostic path unchanged rather than be absorbed here.
    const log = captureActivityLog();
    const boom = new Error("runner defect");
    const underlying = vi.fn<GitProcessRunner>().mockRejectedValue(boom);

    await expect(
      observedGitRunner(
        underlying,
        log.sink,
        "corr-throw-0001",
      )(STATUS_ARGS, {
        cwd: "/repo",
        maxBytes: 4096,
        timeoutMs: 5_000,
      }),
    ).rejects.toBe(boom);
    expect(log.events).toEqual([]);
  });

  it("does not add a second, unreportable swallow around a throwing sink", async () => {
    // "A log line can never become a new failure mode for the operation being logged" is upheld
    // ONE layer down: processServerLogSink() -> getServerLogger().log already catches a sink
    // failure and reports it on stderr via reportServerLogFailure, so production cannot reach this
    // shape. Catching again here would swallow a broken injected sink with no channel left to
    // report it on. This pins that decision — a sink that throws surfaces, it is not hidden.
    const failure = result({ exitCode: 1, stderr: "fatal: bad revision" });
    const underlying = vi.fn<GitProcessRunner>().mockResolvedValue(failure);
    const throwingSink: ServerLogSink = {
      write: (): void => {
        throw new Error("sink is broken");
      },
    };

    await expect(
      observedGitRunner(
        underlying,
        throwingSink,
        "corr-sink-0001",
      )(STATUS_ARGS, {
        cwd: "/repo",
        maxBytes: 4096,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("sink is broken");
  });
});

describe("the line that actually reaches disk", () => {
  // Every other test in this file asserts the ServerLogEvent the code HANDS to the sink. That is
  // one redaction pass short of the truth: `redactLogFields` runs between the sink and the file and
  // silently DROPS any field whose value it will not serialise. A field can therefore be present in
  // every assertion above and absent from `server.log`, which is the only artifact an operator ever
  // reads. `createBufferedServerLogSink().lines()` formats through the real pipeline, so these
  // tests see what the file sees.
  //
  // This is not hypothetical: `exitCode`/`signal` were first emitted raw, and because a child
  // either exits with a code or is killed by a signal, one of the pair is ALWAYS null and was
  // always dropped — every line silently lost one of the two facts it existed to carry.

  function persisted(
    event: Parameters<typeof logGitProcessOutcome>[0] extends never
      ? never
      : {
          readonly correlationId: string;
          readonly args: readonly string[];
          readonly result: GitProcessResult;
        },
  ): Record<string, unknown> {
    const sink = createBufferedServerLogSink();
    logGitProcessOutcome(sink, event.correlationId, event.args, event.result, 5);
    const line = sink.lines()[0];
    if (line === undefined) throw new Error("expected one persisted line");
    return JSON.parse(line) as Record<string, unknown>;
  }

  it("keeps every field the emitter produced — none silently dropped by redaction", () => {
    // The general guard, and the one that would have caught the original defect: whatever the
    // emitter decides to put in `extra`, redaction must carry ALL of it through. A new field added
    // later with an unserialisable value fails here instead of vanishing in production.
    const sink = createBufferedServerLogSink();
    const cases: readonly GitProcessResult[] = [
      result({ exitCode: 128, stderr: "fatal: not a git repository" }),
      result({ exitCode: null, signal: "SIGTERM", truncated: true, timedOut: true }),
      result({ exitCode: null, signal: "SIGKILL", truncated: true, aborted: true }),
      result({ exitCode: 128, refusal: "config-override" }),
      result({ exitCode: 127 }),
    ];

    for (const [index, outcome] of cases.entries()) {
      logGitProcessOutcome(sink, `corr-persisted-${String(index)}0001`, STATUS_ARGS, outcome, 5);
    }

    const lines = sink.lines().map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(cases.length);
    for (const [index, event] of sink.events.entries()) {
      const emitted = Object.keys(event.extra ?? {});
      const survived = Object.keys(lines[index] ?? {});
      expect(emitted.filter((key) => !survived.includes(key))).toEqual([]);
    }
  });

  it("names how the child ended, so an omitted exitCode or signal is never ambiguous", () => {
    const exited = persisted({
      correlationId: "corr-persisted-exit-1",
      args: STATUS_ARGS,
      result: result({ exitCode: 128, stderr: "fatal: not a git repository" }),
    });
    const signalled = persisted({
      correlationId: "corr-persisted-sig-1",
      args: STATUS_ARGS,
      result: result({ exitCode: null, signal: "SIGKILL", truncated: true, timedOut: true }),
    });

    // Exactly one value field per line, and `endedBy` says which one to read — so "no exitCode
    // key" means "a signal ended it", never "this producer does not report exit codes".
    expect(exited).toMatchObject({ endedBy: "exit", exitCode: 128 });
    expect(exited).not.toHaveProperty("signal");
    expect(signalled).toMatchObject({ endedBy: "signal", signal: "SIGKILL" });
    expect(signalled).not.toHaveProperty("exitCode");
  });

  it("carries op, correlationId and errorKind onto the persisted refusal line", () => {
    const line = persisted({
      correlationId: "corr-persisted-refuse1",
      args: ["--no-pager", "-c", "diff.external=/bin/sh", "diff"],
      result: result({
        exitCode: 128,
        stderr: "refused git option: -c diff.external",
        refusal: "config-override",
      }),
    });

    expect(line).toMatchObject({
      level: "error",
      category: "security",
      op: "git.process.refused",
      correlationId: "corr-persisted-refuse1",
      errorKind: "git-option-refused",
      refusal: "config-override",
      subcommand: "diff",
      // Not "exit": keiko-git synthesises exit 128 so existing consumers keep the shape they had,
      // but no child ever launched. Reporting it as an exit would state the opposite.
      endedBy: "not-started",
      exitCode: 128,
    });
  });
});
