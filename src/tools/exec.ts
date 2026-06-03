// Re-export shim: command execution boundary lives in @oscharko-dev/keiko-tools
// (issue #162, ADR-0019). All existing import sites (`from "../tools/exec.js"`) keep resolving
// unchanged via this barrel.

export {
  nodeHomeProvider,
  nodeSpawnFn,
  runCommand,
  type ExecutableResolver,
  type ExecutableResolverDeps,
  type HomeProvider,
  type RunCommandDeps,
  type RunCommandInput,
  type SpawnFn,
  type SpawnOptions,
} from "@oscharko-dev/keiko-tools";
