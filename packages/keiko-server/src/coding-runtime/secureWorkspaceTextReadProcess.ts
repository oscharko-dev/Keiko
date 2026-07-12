import { isAbsolute, win32 } from "node:path";

export interface SecureWorkspaceReadPlatform {
  readonly os: string;
  readonly arch: string;
}

export interface SecureWorkspaceTextReadProcess {
  /** A one-shot supervised invocation. Implementations must await child reaping before settling. */
  run(request: { readonly stdin: Uint8Array; readonly signal: AbortSignal }): Promise<Uint8Array>;
}

/**
 * Server-owned process factory seam. The request deliberately has no executable, argv,
 * cwd, environment, root or path field; production wiring owns those outside consumers.
 */
export interface SecureWorkspaceTextReadProcessFactory {
  create(
    artifact: import("./secureWorkspaceTextReadArtifact.js").SecureWorkspaceTextReadArtifact,
  ): SecureWorkspaceTextReadProcess;
}

export interface SecureWorkspaceReadChild {
  readonly stdout: {
    on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
    on(event: "error", listener: () => void): unknown;
  };
  readonly stderr: { on(event: "data", listener: (chunk: Uint8Array) => void): unknown };
  readonly stdin: { end(data: Uint8Array): void };
  on(event: "error" | "close", listener: (code?: number | null) => void): unknown;
  kill(): void;
  /** Must resolve only after the process and its pipes are reaped/closed. */
  reap(): Promise<void>;
}

export interface SecureWorkspaceReadProcessSpawn {
  spawn(request: {
    readonly command: string;
    readonly args: readonly [];
    readonly shell: false;
    readonly cwd: string;
    readonly env: Readonly<Record<string, never>>;
  }): SecureWorkspaceReadChild;
}

export interface SecureWorkspaceReadProcessPortDeps {
  /** Absolute path obtained by trusted server install-state resolution, never consumer input. */
  readonly executable: string;
  /** Fixed safe server-owned directory, never the workspace root. */
  readonly cwd: string;
  readonly spawn: SecureWorkspaceReadProcessSpawn;
}

/** Constructs the private one-shot launch seam with no shell, PATH, argv, or inherited environment. */
export function createSecureWorkspaceReadProcessPort(
  input: SecureWorkspaceReadProcessPortDeps | SecureWorkspaceTextReadProcess["run"],
): SecureWorkspaceTextReadProcess {
  if (typeof input === "function") return Object.freeze({ run: input });
  if (!isAbsoluteFixedPath(input.executable) || !isAbsoluteFixedPath(input.cwd))
    throw new Error("secure-workspace-read-launch-not-fixed");
  return Object.freeze({
    run: (request: { readonly stdin: Uint8Array; readonly signal: AbortSignal }) =>
      runOneShot(input, request),
  });
}

function isAbsoluteFixedPath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

export const SECURE_WORKSPACE_TEXT_READ_TIMEOUT_MS = 2_000;
export const SECURE_WORKSPACE_TEXT_READ_MAX_LIVE = 8;

export class SecureWorkspaceReadProcessError extends Error {
  public constructor(
    readonly reason: "protocol-invalid" | "process-failed" | "cancelled",
    message = `secure-workspace-read-${reason}`,
  ) {
    super(message);
  }
}

const MAX_STDOUT_BYTES = 65_548;

// eslint-disable-next-line max-lines-per-function
function runOneShot(
  deps: SecureWorkspaceReadProcessPortDeps,
  request: { readonly stdin: Uint8Array; readonly signal: AbortSignal },
): Promise<Uint8Array> {
  // eslint-disable-next-line max-lines-per-function
  return new Promise((resolve, reject) => {
    let child: SecureWorkspaceReadChild;
    const stdout: Uint8Array[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = async (error?: Error): Promise<void> => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener("abort", abort);
      try {
        await child.reap();
      } catch {
        /* closed error only */
      }
      if (error !== undefined) {
        stdout.forEach((chunk) => chunk.fill(0));
        reject(error);
        return;
      }
      const result = Buffer.concat(stdout);
      stdout.forEach((chunk) => chunk.fill(0));
      resolve(result);
    };
    const abort = (): void => {
      child.kill();
      void finish(
        new SecureWorkspaceReadProcessError("cancelled", "secure-workspace-read-aborted"),
      );
    };
    try {
      child = deps.spawn.spawn({
        command: deps.executable,
        args: [],
        shell: false,
        cwd: deps.cwd,
        env: {},
      });
    } catch {
      reject(new Error("secure-workspace-read-spawn-failed"));
      return;
    }
    child.stdout.on("data", (chunk) => {
      if (settled) {
        chunk.fill(0);
        return;
      }
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        chunk.fill(0);
        child.kill();
        void finish(
          new SecureWorkspaceReadProcessError("protocol-invalid", "secure-workspace-read-aborted"),
        );
      } else {
        try {
          stdout.push(Buffer.from(chunk));
        } finally {
          chunk.fill(0);
        }
      }
    });
    child.stdout.on("error", () => {
      abort();
    });
    child.stderr.on("data", (chunk) => {
      chunk.fill(0);
      if (settled) return;
      child.kill();
      void finish(
        new SecureWorkspaceReadProcessError("protocol-invalid", "secure-workspace-read-stderr"),
      );
    });
    child.on("error", () => {
      void finish(new SecureWorkspaceReadProcessError("process-failed"));
    });
    child.on("close", (code) => {
      void finish(code === 0 ? undefined : new SecureWorkspaceReadProcessError("process-failed"));
    });
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    else child.stdin.end(request.stdin);
  });
}
