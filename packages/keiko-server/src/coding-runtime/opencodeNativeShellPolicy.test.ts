import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  decideOpenCodeNativePolicy,
  openCodeNativeVerificationKind,
  type OpenCodeNativePolicyRequest,
} from "./opencodeNativePolicy.js";

/**
 * #4271: the native shell classifier reads options, not only the program and its first operand.
 * Every row is decided in all three modes on a real workspace (so path options and `cd` targets are
 * resolved physically): Ask for approval asks for every non-denied command, Supervised allows what
 * is vetted and asks for the rest, Full access allows inside the envelope, and a delivery command
 * is refused in every mode.
 */

const MODES = ["governed-assist", "supervised-coding", "autonomous-delivery"] as const;
type Mode = (typeof MODES)[number];

let root = "";
let workspace = "";

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-shell-")));
  workspace = join(root, "workspace");
  for (const directory of ["svc/api", "web", "packages/app", "docs"])
    mkdirSync(join(workspace, directory), { recursive: true });
  for (const file of ["svc/pom.xml", "pom.xml", "mvnw", "gradlew", "svc/mvnw", "settings.xml"])
    writeFileSync(join(workspace, file), "x\n");
  mkdirSync(join(root, "outside"), { recursive: true });
  symlinkSync(join(root, "outside"), join(workspace, "linked-out"));
  symlinkSync(join(workspace, "web"), join(workspace, "linked-in"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function request(resources: readonly string[]): OpenCodeNativePolicyRequest {
  return {
    runId: "run-shell-1",
    sessionID: "ses_native0000000000001",
    agent: "build",
    permission: "shell",
    resources,
    source: { messageID: "msg_1", id: "call_1" },
  };
}

function effectOf(mode: Mode, resources: readonly string[]): string {
  const decision = decideOpenCodeNativePolicy({
    mode,
    workspaceRoot: workspace,
    request: request(resources),
    nowMs: Date.parse("2026-11-06T12:00:00.000Z"),
  });
  return decision.effect === "deny" ? `deny:${decision.reason}` : decision.effect;
}

/** The three modes' effects of one line, as `[assist, supervised, full]`. */
function effects(resources: readonly string[]): readonly string[] {
  return MODES.map((mode) => effectOf(mode, resources));
}

const VETTED_EFFECTS = ["ask", "allow", "allow"];
const UNVETTED_EFFECTS = ["ask", "ask", "allow"];
const RESERVED_EFFECTS = [
  "deny:delivery-reserved",
  "deny:delivery-reserved",
  "deny:delivery-reserved",
];

describe("legitimate monorepo build and test commands run without a decision in Supervised", () => {
  it.each([
    // Maven: option values are not the subcommand (customer report: nested Java monorepos).
    ["mvn -pl api -am verify"],
    ["mvn -pl :api,:core -amd test"],
    ["mvn --projects api test"],
    ["mvn -f svc/pom.xml test"],
    ["mvn -f ./svc/pom.xml -o test-compile"],
    ["mvn --file=svc/pom.xml compile"],
    ["mvn -f svc/pom.xml -pl api -am clean verify"],
    ["mvn -T 1C -P dev,ci -Dtest=FooTest#bar -DfailIfNoTests=false clean verify"],
    ["mvn -T1C -Pdev -B -ntp -DskipTests package"],
    ["mvn -s settings.xml test"],
    ["mvn -rf :api verify"],
    ["mvn compile"],
    ["mvn validate"],
    ["mvn test-compile"],
    ["mvn dependency:tree"],
    ["mvn -o test"],
    ["mvn --offline -q test"],
    // The repository's own wrapper scripts, directly or through a shell.
    ["./mvnw test"],
    ["./mvnw -pl api test"],
    ["svc/mvnw test"],
    ["bash ./mvnw test"],
    ["sh ./gradlew build"],
    ["bash svc/mvnw -pl api verify"],
    ["./gradlew :app:test"],
    ["./gradlew :svc:api:build --offline"],
    ["./gradlew test --tests com.acme.FooTest"],
    ['./gradlew test --tests "com.acme.FooTest"'],
    ["./gradlew -p svc test"],
    ["./gradlew build -x test"],
    ["gradle --no-daemon clean build -Pfoo=bar -Dorg.gradle.parallel=true"],
    // Package managers: workspace selectors and prefixes, script shorthands.
    ["npm -w pkg run test"],
    ["npm --workspace=pkg test"],
    ["npm --workspace pkg run build --if-present"],
    ["npm -ws run build --if-present"],
    ["npm --workspaces test"],
    ["npm --prefix web test"],
    ["npm --prefix=web run build"],
    ["npm -w @scope/pkg run lint"],
    ["npm run test -- --reporter=dot"],
    ["pnpm --filter web test"],
    ["pnpm -F web build"],
    ["pnpm -C web test"],
    ["pnpm --dir web run lint"],
    ["pnpm -r run build"],
    ["pnpm build"],
    ["pnpm lint"],
    ["pnpm test"],
    ["pnpm run test"],
    ["yarn workspace web test"],
    ["yarn build"],
    ["yarn lint"],
    ["yarn test"],
    ["yarn run build"],
    ["yarn --cwd web test"],
    ["bun run test"],
    ["bun test"],
    // Navigation into the workspace, as one line or as separate resources.
    ["cd svc && mvn test"],
    ["cd packages/app && npm test"],
    ["cd linked-in && npm test"],
    // Other toolchains.
    ["cargo test -p crate"],
    ["cargo +nightly test"],
    ["go test ./..."],
    ["make test"],
    ["make -C svc test"],
    ["make -j 4 test"],
    ["make -j4 check"],
    // Vetted inspection that stays vetted without an executing option.
    ["find . -name '*.java' -newer pom.xml"],
    ["rg --files-with-matches Foo svc"],
    ["sort pom.xml"],
    ["uniq pom.xml"],
    ["git -C svc status"],
    ["git -c color.ui=never log -3"],
    ["git diff --stat"],
    ["git grep -n Foo"],
    // Environment and redirections that cannot run or write anything else.
    ["env CI=1 npm test"],
    ["CI=1 NODE_ENV=test npm test"],
    ["npm test 2>&1"],
    ["npm test > /dev/null"],
    ["npm test >/dev/null 2>&1"],
  ])("allows %s in Supervised, asks in Ask for approval", (command) => {
    expect(effects([command]), command).toEqual(VETTED_EFFECTS);
  });

  it("allows a cd and its command arriving as separate resources", () => {
    expect(effects(["cd svc", "mvn -pl api test"])).toEqual(VETTED_EFFECTS);
  });
});

describe("hostile and unvetted commands stay closed", () => {
  it.each([
    // A path option or a cd target outside the workspace, lexically or through a link.
    ["mvn -f /etc/x test"],
    ["mvn -f ../outside/pom.xml test"],
    ["mvn --file=/etc/x test"],
    ["mvn -f~/pom.xml test"],
    ["mvn -f linked-out/pom.xml test"],
    ["mvn -s /etc/settings.xml test"],
    ["mvn -l /tmp/build.log test"],
    ["cd / && mvn test"],
    ["cd .. && mvn test"],
    ["cd ../outside && npm test"],
    ["cd linked-out && npm test"],
    ["cd ~ && npm test"],
    // Paths are read against the workspace root, never a directory a cd may have moved to.
    ["cd svc/api && mvn -f ../pom.xml test"],
    ["cd && npm test"],
    ["cd - && npm test"],
    ["npm --prefix /tmp test"],
    ["npm --prefix ../x test"],
    ["npm -C /tmp test"],
    ["pnpm -C /tmp test"],
    ["pnpm --dir=../x test"],
    ["yarn --cwd /tmp test"],
    ["make -C /tmp test"],
    ["make -f /tmp/Makefile test"],
    ["cargo test --manifest-path /tmp/Cargo.toml"],
    ["./gradlew -p /tmp test"],
    ["./gradlew -b ../build.gradle test"],
    // Plugin goals, properties and separators that run something else.
    ["mvn -Dexec.executable=sh exec:exec"],
    ["mvn -Dexec.executable=sh test"],
    ["mvn -D exec.executable=sh test"],
    ["mvn exec:exec"],
    ["mvn exec:java"],
    ["mvn deploy"],
    ["mvn -- test"],
    ["mvn --frobnicate test"],
    ["mvn"],
    ["mvn -f"],
    ["./gradlew --init-script /tmp/init.gradle test"],
    ["./gradlew -I /tmp/init.gradle test"],
    ["./gradlew publish"],
    ["./gradlew run"],
    // Package-manager runners and configuration that choose another program or shell.
    ["npm exec vitest"],
    ["npm x vitest"],
    ["npm exec -- vitest run"],
    ["pnpm exec vitest"],
    ["pnpm dlx create-x"],
    ["yarn exec vitest"],
    ["yarn dlx create-x"],
    ["bun x vitest"],
    ["npm test --script-shell=/tmp/sh"],
    ["npm install -g left-pad"],
    ["npm --userconfig /tmp/npmrc test"],
    ["npx -c 'rm -rf x'"],
    ["npx --package evil vitest"],
    ["npx -y vitest"],
    ["npx left-pad"],
    // Programs that are not vetted, or are not the repository's wrapper.
    ["java -jar target/app.jar"],
    ["bash ./script.sh"],
    ["bash -c 'mvn test'"],
    ["bash /tmp/mvnw test"],
    ["/tmp/evil/mvnw test"],
    ["./mvn test"],
    ["../mvnw test"],
    ["node -e 'process.exit(1)'"],
    ["node ../x.js"],
    ["python -c 'print(1)'"],
    ["xargs rm"],
    ["rm -rf build"],
    // Environment that changes what a vetted program loads.
    ["NODE_OPTIONS=--require=/tmp/x.js npm test"],
    ["PATH=/tmp/evil npm test"],
    ["LD_PRELOAD=/tmp/x.so mvn test"],
    ["MAVEN_OPTS=-javaagent:/tmp/a.jar mvn test"],
    ["env -C /tmp mvn test"],
    // Output redirection, expansion and subshells are not interpreted, so they are not vetted.
    ["echo x > out.txt"],
    ["echo x >> out.txt"],
    ["npm test > build.log"],
    ["cat pom.xml > /tmp/leak"],
    ["npm test < input.txt"],
    ["echo $(whoami)"],
    ["cat `ls`"],
    ["echo ${HOME}"],
    ["(cd svc && npm test)"],
    ["mvn -f $PWD/../x/pom.xml test"],
    ["npm 'test"],
    // A newline or a single ampersand ends a command: the next one is judged on its own.
    ["mvn test\nrm -rf build"],
    ["mvn test & rm -rf build"],
  ])("asks for %s in Supervised and allows it in Full access", (command) => {
    expect(effects([command]), command).toEqual(UNVETTED_EFFECTS);
  });
});

describe("options that execute another command or write a file are never vetted (A1)", () => {
  it.each([
    ["find . -exec rm {} \\;"],
    ["find . -name '*.tmp' -delete"],
    ["find . -execdir sh {} \\;"],
    ["find . -ok rm {} \\;"],
    ["find . -okdir rm {} \\;"],
    ["find . -fprint out.txt"],
    ["find . -fprintf out.txt %p"],
    ["find . -fls out.txt"],
    ["rg --pre ./x.sh foo"],
    ["rg --pre=./x.sh foo"],
    ["rg --hostname-bin=./x foo"],
    ["sort -o out.txt in.txt"],
    ["sort -ro out.txt in.txt"],
    ["sort --output=out.txt in.txt"],
    ["sort --compress-program=sh in.txt"],
    ["uniq in.txt out.txt"],
    ["tree -o out.txt"],
    ["date 010112002026"],
    ["file -C -m x"],
    ["git -c core.fsmonitor=./x.sh status"],
    ["git -c core.pager=./x.sh log"],
    ["git -c diff.external=./x.sh diff"],
    ["git -c alias.x=!sh x"],
    ["git --config-env=core.pager=X log"],
    ["git --exec-path=/tmp status"],
    ["git -C /tmp status"],
    ["git --git-dir=/etc status"],
    ["git --work-tree /tmp status"],
    ["git grep -O./x.sh foo"],
    ["git grep --open-files-in-pager=./x.sh foo"],
    ["git diff --output=out.txt"],
    ["git diff --output out.txt"],
    ["git log --output=out.txt"],
    ["git diff --ext-diff"],
    ["git show --textconv HEAD:x"],
  ])("asks for %s in Supervised", (command) => {
    expect(effects([command]), command).toEqual(UNVETTED_EFFECTS);
  });
});

describe("a delivery command inside a runner is still reserved (A1)", () => {
  it.each([
    ["find . -exec git push origin HEAD \\;"],
    ["find . -execdir git commit -m x \\;"],
    ["find . -name x -exec /usr/bin/git -C . push \\;"],
    ["find . -exec sh -c 'git push' \\;"],
    ["xargs git push"],
    ["echo origin | xargs git push"],
    ["xargs -I{} git -C {} commit -m x"],
    ["xargs -n1 gh pr create"],
    ["timeout 30 git push origin HEAD"],
    ["watch git push"],
    ["npx git push"],
    ["npm exec -- git push"],
    ["pnpm dlx gh pr merge 1"],
    ["sudo git push"],
    // Quotes and escapes do not hide the subcommand from the shell's own reading.
    ["git 'push' origin HEAD"],
    ['git "push" origin HEAD'],
    ["g''it push"],
    ["git pu\\sh"],
    ["git -C . 'commit' -m x"],
    ['env -S "git push"'],
    // List operators other than && and ;
    ["git status & git push"],
    ["git status\ngit push"],
  ])("refuses %s in every mode", (command) => {
    expect(effects([command]), command).toEqual(RESERVED_EFFECTS);
  });

  it("keeps ordinary mentions and read-only runners available", () => {
    expect(effects(["find . -name git"])).toEqual(VETTED_EFFECTS);
    expect(effects(["echo git push"])).toEqual(VETTED_EFFECTS);
    expect(effects(["grep -rn 'git push' docs"])).toEqual(VETTED_EFFECTS);
  });
});

describe("the verification credit follows the same operands (#3901)", () => {
  it.each([
    [["mvn -pl api -am verify"], "test"],
    [["mvn -f svc/pom.xml test"], "test"],
    [["mvn -f svc/pom.xml test-compile"], undefined],
    [["npm -w pkg run test"], "test"],
    [["npm --prefix web test"], "test"],
    [["pnpm --filter web test"], "test"],
    [["make -C svc test"], "test"],
    // A project outside the workspace is no evidence for this one.
    [["mvn -f /etc/x test"], undefined],
    [["mvn -f ../outside/pom.xml test"], undefined],
    [["npm --prefix /tmp test"], undefined],
    [["make -C ../other test"], undefined],
  ] as const)("reads %j as %s", (resources, kind) => {
    expect(openCodeNativeVerificationKind(resources)).toBe(kind);
  });
});
