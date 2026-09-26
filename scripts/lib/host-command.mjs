// How the release chain runs a trusted host executable. Which executable runs stays the business of
// host-executable.mjs; this module only decides how much of its output a caller may hold.

import { spawnSync } from "node:child_process";

import { resolveHostExecutable } from "./host-executable.mjs";

// spawnSync holds a child's whole output in memory and kills the child past `maxBuffer`, 1 MiB by
// default. No GitHub API answer respects that: the release-dispatch history crossed it at its 61st
// run (1.1.9, 2026-09-26), and from then on every release request and every advance run failed to
// read it. An API page is bounded by its per_page; this ceiling only stops a runaway child.
export const HOST_COMMAND_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Runs a trusted host executable to completion, with room for a full GitHub API page. */
export function spawnHostExecutable(command, args, options = {}) {
  return spawnSync(resolveHostExecutable(command), args, {
    encoding: "utf8",
    maxBuffer: HOST_COMMAND_MAX_BUFFER_BYTES,
    ...options,
  });
}
