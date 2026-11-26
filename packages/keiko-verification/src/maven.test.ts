import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCommandAllowed } from "@oscharko-dev/keiko-tools";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  MAVEN_RUN_REPOSITORY,
  isMavenProject,
  isPlannedMavenStep,
  mavenTestArguments,
  planMavenSteps,
} from "./maven.js";
import { VERIFICATION_COMMAND_RULES } from "./orchestrator.js";
import { DEFAULT_VERIFICATION_LIMITS } from "./types.js";
import { makeWorkspace } from "./_support.js";

const CACHE = String.raw`C:\Users\dev\.m2\repository`;

function mavenWorkspace(): ReturnType<typeof makeWorkspace> {
  const ws = makeWorkspace();
  rmSync(join(ws.root, "package.json"));
  ws.writeFile("pom.xml", "<project/>\n");
  return ws;
}

describe("isMavenProject", () => {
  it("is a root pom.xml without a root package.json", () => {
    expect(isMavenProject(mavenWorkspace().info, nodeWorkspaceFs)).toBe(true);
  });

  it("leaves a project with a package.json to the npm planner, pom.xml or not", () => {
    const ws = makeWorkspace();
    ws.writeFile("pom.xml", "<project/>\n");
    expect(isMavenProject(ws.info, nodeWorkspaceFs)).toBe(false);
  });

  it("is no Maven project without a pom.xml", () => {
    const ws = makeWorkspace();
    rmSync(join(ws.root, "package.json"));
    expect(isMavenProject(ws.info, nodeWorkspaceFs)).toBe(false);
  });

  it("does not take a folder named pom.xml for the build file", () => {
    const ws = makeWorkspace();
    rmSync(join(ws.root, "package.json"));
    mkdirSync(join(ws.root, "pom.xml"));
    expect(isMavenProject(ws.info, nodeWorkspaceFs)).toBe(false);
  });
});

describe("mavenTestArguments", () => {
  it("runs offline and in batch mode, into the run's own repository, over the person's cache", () => {
    expect(mavenTestArguments({ cacheRepository: CACHE })).toEqual([
      "-B",
      "-o",
      `-Dmaven.repo.local=${MAVEN_RUN_REPOSITORY}`,
      `-Dmaven.repo.local.tail=${CACHE}`,
      "-Dmaven.repo.local.tail.ignoreAvailability=true",
      "test",
    ]);
  });

  it("chains no cache when there is none", () => {
    expect(mavenTestArguments({})).toEqual([
      "-B",
      "-o",
      `-Dmaven.repo.local=${MAVEN_RUN_REPOSITORY}`,
      "test",
    ]);
  });

  it("chains no cache that is not an absolute Windows folder", () => {
    for (const cache of ["/home/dev/.m2/repository", "relative\\repository", "C:relative"]) {
      expect(mavenTestArguments({ cacheRepository: cache })).toHaveLength(4);
    }
  });

  it("chains no cache whose path Maven would split into two repositories", () => {
    expect(mavenTestArguments({ cacheRepository: String.raw`C:\a,b\repository` })).not.toContain(
      String.raw`-Dmaven.repo.local.tail=C:\a,b\repository`,
    );
  });
});

describe("planMavenSteps", () => {
  it("plans mvn test for the test kind and skips the kinds Maven cannot tell apart", () => {
    const steps = planMavenSteps(
      ["typecheck", "lint", "test", "build", "targeted-test"],
      DEFAULT_VERIFICATION_LIMITS,
      { cacheRepository: CACHE },
    );
    expect(steps.map((step) => [step.kind, step.skipReason])).toEqual([
      ["typecheck", "no typecheck step is planned for a Maven project"],
      ["lint", "no lint step is planned for a Maven project"],
      ["test", undefined],
      ["build", "no build step is planned for a Maven project"],
    ]);
    const test = steps.find((step) => step.kind === "test");
    expect(test).toMatchObject({ command: "mvn", scriptName: "test" });
    expect(test?.limits).toBe(DEFAULT_VERIFICATION_LIMITS);
  });

  it("plans only what the verifier's command rules admit", () => {
    const [test] = planMavenSteps(["test"], DEFAULT_VERIFICATION_LIMITS, {
      cacheRepository: CACHE,
    });
    expect(test).toBeDefined();
    if (test === undefined) return;
    expect(isCommandAllowed(VERIFICATION_COMMAND_RULES, test.command, test.args)).toEqual({
      allowed: true,
    });
  });
});

describe("the verifier's Maven command rule", () => {
  const allowed = (args: readonly string[]): boolean =>
    isCommandAllowed(VERIFICATION_COMMAND_RULES, "mvn", args).allowed;

  it("admits the planned test run only", () => {
    expect(allowed(["-B", "-o", "test"])).toBe(true);
    expect(allowed(["-B", "-o", "deploy"])).toBe(false);
    expect(allowed(["-B", "-o", "exec:exec"])).toBe(false);
    expect(allowed(["test"])).toBe(false);
    expect(allowed(["-o", "-B", "test"])).toBe(false);
  });

  it("refuses a run that would read other settings or another build file", () => {
    for (const flag of ["-s", "--settings", "-gs", "--global-settings", "-t", "--toolchains"]) {
      expect(allowed(["-B", "-o", flag, "x.xml", "test"])).toBe(false);
    }
    expect(allowed(["-B", "-o", "-f", "other/pom.xml", "test"])).toBe(false);
    expect(allowed(["-B", "-o", "--file=other/pom.xml", "test"])).toBe(false);
  });
});

describe("isPlannedMavenStep", () => {
  const [test] = planMavenSteps(["test"], DEFAULT_VERIFICATION_LIMITS, { cacheRepository: CACHE });
  const [skipped] = planMavenSteps(["lint"], DEFAULT_VERIFICATION_LIMITS, {});
  const [bare] = planMavenSteps(["test"], DEFAULT_VERIFICATION_LIMITS, {});

  it("admits exactly what the planner produces", () => {
    for (const step of [test, skipped, bare]) {
      expect(step === undefined ? false : isPlannedMavenStep(step)).toBe(true);
    }
  });

  it("refuses a forged argument, phase, settings file or script", () => {
    if (test === undefined || skipped === undefined) throw new Error("no planned step");
    const forged: readonly (readonly string[])[] = [
      ["-B", "-o", "-sC:\\x\\settings.xml", "test"],
      ["-B", "-o", `-Dmaven.repo.local=${MAVEN_RUN_REPOSITORY}`, "deploy"],
      ["-B", "-o", "-Dmaven.repo.local=C:\\Users\\dev\\.m2\\repository", "test"],
      [...test.args.slice(0, 5), "-Dmaven.ext.class.path=C:\\x.jar", "test"],
      [...test.args.slice(0, 3), "-Dmaven.repo.local.tail=C:\\a,C:\\b", ...test.args.slice(4)],
      [...test.args.slice(0, 3), "-Dmaven.repo.local.tail=relative", ...test.args.slice(4)],
      [...test.args, "test"],
    ];
    for (const args of forged) expect(isPlannedMavenStep({ ...test, args })).toBe(false);
    expect(isPlannedMavenStep({ ...test, scriptName: "verify" })).toBe(false);
    expect(isPlannedMavenStep({ ...test, kind: "build" })).toBe(false);
    expect(isPlannedMavenStep({ ...test, kind: "targeted-test" })).toBe(false);
    expect(isPlannedMavenStep({ ...test, command: "npm" })).toBe(false);
    expect(isPlannedMavenStep({ ...skipped, args: ["test"] })).toBe(false);
    expect(isPlannedMavenStep({ ...skipped, scriptName: "lint" })).toBe(false);
  });
});
