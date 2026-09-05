import { Script } from "node:vm";
import { webcrypto } from "node:crypto";
import { createGeneratedOpenCodeBundle } from "../opencodeRuntimeAdapter.js";
import { projectOpenCodePermissionEvent } from "../opencodeProtocol.js";

interface GeneratedToolContext {
  readonly sessionID: string;
  readonly callID: string;
  readonly abort: AbortSignal;
  readonly ask: (request: Record<string, unknown>) => Promise<void>;
}
interface GeneratedTool {
  readonly execute: (
    args: Record<string, unknown>,
    context: GeneratedToolContext,
  ) => Promise<unknown>;
}
interface PendingPermission {
  readonly row: Record<string, unknown>;
  readonly settle: (allowed: boolean) => void;
}
export interface ScriptedGovernedToolsInput {
  readonly env: Readonly<Record<string, string>>;
  readonly sessionId: string;
  readonly broadcast: (type: string, properties: Record<string, unknown>) => void;
  readonly fetch?: typeof globalThis.fetch;
  readonly observePhase?: (event: ScriptedToolPhase) => void;
}
export interface ScriptedToolPhase {
  readonly runId: string;
  readonly tool: string;
  readonly phase: "entered" | "ipc-requested" | "ipc-returned" | "completed" | "failed";
}

/** Executes repository-owned generated shims, never source supplied by the model or workspace. */
function generatedTool(name: string, input: ScriptedGovernedToolsInput): GeneratedTool {
  const source = createGeneratedOpenCodeBundle().toolSources[name];
  if (source === undefined) throw new Error("functional-generated-tool-unavailable");
  const script = new Script(`${source.replace("export default", "const generated =")}\ngenerated;`);
  const value: unknown = script.runInNewContext(
    {
      process: { env: input.env },
      crypto: webcrypto,
      fetch: input.fetch ?? globalThis.fetch,
      AbortController,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      setTimeout,
      clearTimeout,
    },
    { timeout: 1000 },
  );
  if (
    typeof value !== "object" ||
    value === null ||
    !("execute" in value) ||
    typeof value.execute !== "function"
  ) {
    throw new Error("functional-generated-tool-invalid");
  }
  return value as GeneratedTool;
}

/** Only the fake upstream permission queue lives here; the real manager issues every approval. */
export class ScriptedGovernedTools {
  private readonly pending = new Map<string, PendingPermission>();
  private sequence = 0;
  public constructor(private readonly input: ScriptedGovernedToolsInput) {}

  public rows(): readonly Record<string, unknown>[] {
    return [...this.pending.values()].map((permission) => permission.row);
  }

  public reply(requestId: string, body: string): boolean {
    const value: unknown = JSON.parse(body);
    if (
      typeof value !== "object" ||
      value === null ||
      Object.keys(value).length !== 1 ||
      !("reply" in value)
    )
      return false;
    if (value.reply !== "once" && value.reply !== "reject") return false;
    const permission = this.pending.get(requestId);
    if (permission === undefined) return false;
    permission.settle(value.reply === "once");
    return true;
  }

  public close(): void {
    for (const permission of this.pending.values()) permission.settle(false);
  }

  public async execute(
    call: { readonly id: string; readonly name: string; readonly args: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) throw new Error("functional-generated-tool-aborted");
    this.phase(call.name, "entered");
    try {
      const output = await this.executeObserved(call, signal);
      this.phase(call.name, "completed");
      return output;
    } catch (error) {
      this.phase(call.name, "failed");
      throw error;
    }
  }

  private async executeObserved(
    call: { readonly id: string; readonly name: string; readonly args: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<string> {
    const fetch: typeof globalThis.fetch = async (...args) => {
      this.phase(call.name, "ipc-requested");
      const response = await (this.input.fetch ?? globalThis.fetch)(...args);
      this.phase(call.name, "ipc-returned");
      return response;
    };
    const result = await generatedTool(call.name, { ...this.input, fetch }).execute(call.args, {
      sessionID: this.input.sessionId,
      callID: call.id,
      abort: signal,
      ask: (request) => this.ask(request, signal),
    });
    if (
      typeof result !== "object" ||
      result === null ||
      !("output" in result) ||
      typeof result.output !== "string"
    ) {
      throw new Error("functional-generated-tool-output-invalid");
    }
    return result.output;
  }

  private phase(name: string, phase: ScriptedToolPhase["phase"]): void {
    const runId = this.input.env.KEIKO_CODING_RUN_ID;
    if (runId === undefined || !/^run-[A-Za-z0-9-]{1,120}$/u.test(runId)) return;
    const known = Object.hasOwn(createGeneratedOpenCodeBundle().toolSources, name);
    this.input.observePhase?.({ runId, tool: known ? name : "unknown", phase });
  }

  private ask(request: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.pending.size >= 8)
      return Promise.reject(new Error("functional-permission-unavailable"));
    const id = `per_functional${String(++this.sequence)}`;
    const row = { ...request, id, sessionID: this.input.sessionId };
    const event = {
      id: `evt_permission${String(this.sequence)}`,
      type: "permission.asked",
      properties: row,
    };
    if (projectOpenCodePermissionEvent(event, this.input.sessionId) === undefined) {
      return Promise.reject(new Error("functional-permission-invalid"));
    }
    return new Promise<void>((resolve, reject) => {
      const settle = (allowed: boolean): void => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        this.input.broadcast("permission.replied", {
          sessionID: this.input.sessionId,
          requestID: id,
          reply: allowed ? "once" : "reject",
        });
        if (allowed) resolve();
        else reject(new Error("functional-permission-rejected"));
      };
      const abort = (): void => {
        settle(false);
      };
      const timeout = setTimeout(abort, 90_000);
      timeout.unref();
      this.pending.set(id, { row, settle });
      signal.addEventListener("abort", abort, { once: true });
      this.input.broadcast("permission.asked", row);
    });
  }
}
