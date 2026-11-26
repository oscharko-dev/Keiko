// #4492 (ADR-0043 D21): how a confined Windows step uses the patched Node.js. Official Node.js
// 26.13.1 hangs inside an AppContainer on any child with piped stdio, a fork or `node --test`
// (libuv#5181, fixed in libuv 1.53, which no official Node.js carries yet), so keiko-server verifies
// a patched build and offers it as `WindowsStepSupervisor.stepNode`. This module decides, from
// closed inputs and without touching the file system itself, what that build replaces:
//
// - a command named `node` is the step Node.js;
// - an install's `npm` or `npx` starts as `<step node.exe> <install>\node_modules\npm\bin\*-cli.js`,
//   because the install's `.cmd` prefers the stock `node.exe` beside it;
// - every other step finds the step Node.js first on its `PATH`, which is what the shims under
//   `node_modules\.bin` fall back to.

import { win32 } from "node:path";
import type { WindowsStepNode, WindowsStepNodeDecision } from "@oscharko-dev/keiko-contracts";
import { windowsPathContains } from "./windows-step-paths.js";

/** The two questions the plan asks the file system; keiko-tools' `exec.ts` answers them. */
export interface WindowsStepNodeProbe {
  readonly isFile: (path: string) => boolean;
  /** The real path through links and junctions, or undefined when it cannot be resolved. */
  readonly realPath: (path: string) => string | undefined;
}

export interface WindowsStepNodeInput {
  /** The allowlisted command as requested. */
  readonly command: string;
  /** The resolved executable of that command. */
  readonly executable: string;
  readonly args: readonly string[];
  readonly executionRoot: string;
  readonly stepNode: WindowsStepNode | undefined;
  readonly probe: WindowsStepNodeProbe;
}

/** A launch that replaces the shell invocation; its arguments are not yet quoted. */
export interface WindowsStepNodeInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

export type WindowsStepNodePlan =
  /** No verified step Node.js: the step runs as it always did. */
  | { readonly kind: "none" }
  /** A step Node.js that is not trusted for this step, recorded and not used. */
  | { readonly kind: "unused"; readonly decision: WindowsStepNodeDecision }
  | {
      readonly kind: "applied";
      readonly decision: WindowsStepNodeDecision;
      readonly stepNode: WindowsStepNode;
      /** The executable whose folder the step is granted; the step Node.js for `node`. */
      readonly grantExecutable: string;
      /** Replaces the shell invocation for `node`, `npm` and `npx`; undefined for any other step. */
      readonly invocation: WindowsStepNodeInvocation | undefined;
    };

const NPM_CLI_NAMES: ReadonlyMap<string, string> = new Map([
  ["npm.cmd", "npm-cli.js"],
  ["npx.cmd", "npx-cli.js"],
]);

const UNUSED: WindowsStepNodeDecision = Object.freeze({
  image: "resolved",
  npmLaunch: "not-npm",
  npmFallback: "none",
  pathPrefixed: false,
  placement: "inside-execution-root",
});

function decision(
  image: WindowsStepNodeDecision["image"],
  npm: Pick<WindowsStepNodeDecision, "npmLaunch" | "npmFallback">,
): WindowsStepNodeDecision {
  return { image, ...npm, pathPrefixed: true, placement: "applied" };
}

const NOT_NPM = { npmLaunch: "not-npm", npmFallback: "none" } as const;

function isNodeCommand(command: string): boolean {
  const name = command.toLowerCase();
  return name === "node" || name === "node.exe";
}

type NpmPlan =
  | { readonly kind: "not-npm" }
  | { readonly kind: "cli"; readonly cli: string }
  | { readonly kind: "fallback"; readonly reason: "cli-missing" | "cli-outside-grant" };

// The install's own CLI script, which must exist and stay inside the folder the step is granted for
// its `.cmd` (a junction or link inside it must not lead the step Node.js out of that folder).
function npmCli(input: WindowsStepNodeInput): NpmPlan {
  const cliName = NPM_CLI_NAMES.get(win32.basename(input.executable).toLowerCase());
  // A launcher inside the execution root is the workspace's own file, not a Node.js install's.
  if (cliName === undefined || windowsPathContains(input.executionRoot, input.executable)) {
    return { kind: "not-npm" };
  }
  const folder = win32.dirname(input.executable);
  const cli = win32.join(folder, "node_modules", "npm", "bin", cliName);
  if (!input.probe.isFile(cli)) return { kind: "fallback", reason: "cli-missing" };
  const realFolder = input.probe.realPath(folder);
  const realCli = input.probe.realPath(cli);
  if (realFolder === undefined || realCli === undefined) {
    return { kind: "fallback", reason: "cli-outside-grant" };
  }
  return windowsPathContains(realFolder, realCli)
    ? { kind: "cli", cli }
    : { kind: "fallback", reason: "cli-outside-grant" };
}

function applied(
  stepNode: WindowsStepNode,
  node: Pick<Extract<WindowsStepNodePlan, { kind: "applied" }>, "decision" | "invocation">,
  grantExecutable: string,
): WindowsStepNodePlan {
  return { kind: "applied", stepNode, grantExecutable, ...node };
}

/**
 * What the verified step Node.js changes for one step. Without one nothing changes; a folder inside
 * the execution root (which the step may modify) is never trusted.
 */
export function planWindowsStepNode(input: WindowsStepNodeInput): WindowsStepNodePlan {
  const { stepNode } = input;
  if (stepNode === undefined) return { kind: "none" };
  if (windowsPathContains(input.executionRoot, stepNode.directory)) {
    return { kind: "unused", decision: UNUSED };
  }
  if (isNodeCommand(input.command)) {
    return applied(
      stepNode,
      {
        decision: decision("step-node", NOT_NPM),
        invocation: { command: stepNode.executable, args: input.args },
      },
      stepNode.executable,
    );
  }
  const npm = npmCli(input);
  if (npm.kind === "cli") {
    return applied(
      stepNode,
      {
        decision: decision("step-node", { npmLaunch: "step-node", npmFallback: "none" }),
        invocation: { command: stepNode.executable, args: [npm.cli, ...input.args] },
      },
      input.executable,
    );
  }
  const npmDecision =
    npm.kind === "fallback"
      ? ({ npmLaunch: "install-cmd", npmFallback: npm.reason } as const)
      : NOT_NPM;
  return applied(
    stepNode,
    { decision: decision("resolved", npmDecision), invocation: undefined },
    input.executable,
  );
}
