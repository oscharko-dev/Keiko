// ESLint rules for the three test patterns that produced non-deterministic verdicts (quality-gate
// hardening plan 2026-11-21, P3). Each reports a construct whose outcome depends on the machine,
// the clock or chance instead of on the code under test:
//
// - no-unguarded-wall-clock-assertion: a comparison of a measured wall-clock duration outside the
//   `KEIKO_ENFORCE_WALL_CLOCK_BUDGETS` guard (ADR-0139 D1). A loaded runner fails it, not a change.
// - no-fixed-sleep: a pause of a fixed number of milliseconds (`setTimeout(resolve, n)` inside a
//   promise, `timers/promises` `setTimeout(n)`, Playwright `waitForTimeout(n)`) outside a polling
//   loop. It either waits too long or not long enough; await the condition, or use fake timers.
// - no-short-hex-negative-substring: `expect(text).not.toContain("9999")` with a literal of at most
//   four hexadecimal characters. Text that carries a digest contains it by chance (#4481).
//
// Existing occurrences are held in the shrink-only register eslint-suppressions.json at the
// repository root. A new occurrence that is genuinely required (a fixture that must answer late, a
// controlled measurement) carries an `eslint-disable-next-line ... -- <reason>` comment.

const COMPARATORS = new Set([
  "toBeLessThan",
  "toBeLessThanOrEqual",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
]);
const WALL_CLOCK_GUARD = "WALL_CLOCK_BUDGETS";
const CONDITIONAL_RUNNERS = new Set(["skipIf", "runIf"]);
const TIMER_PROMISE_MODULES = new Set(["node:timers/promises", "timers/promises"]);
// Four hexadecimal characters occur in one 64-character digest with a chance of about 1 in 1000;
// at five the chance is below 1 in 10,000 and a literal is long enough to say what it rules out.
const SHORT_HEX = /^[0-9a-f]{1,4}$/iu;
const ARRAY_PRODUCERS = new Set(["map", "flatMap", "filter", "keys", "values", "entries", "split"]);
const LOOPS = new Set(["WhileStatement", "DoWhileStatement", "ForStatement", "ForOfStatement"]);
const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);

function memberName(node) {
  if (node?.type !== "MemberExpression" || node.computed) return null;
  return node.property.type === "Identifier" ? node.property.name : null;
}

function isClockRead(node) {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (memberName(callee) === "now") {
    return (
      callee.object.type === "Identifier" && ["Date", "performance"].includes(callee.object.name)
    );
  }
  if (memberName(callee) === "hrtime") return callee.object.name === "process";
  return memberName(callee) === "bigint" && memberName(callee.object) === "hrtime";
}

function isNode(value) {
  return value !== null && typeof value === "object" && typeof value.type === "string";
}

/** The syntax nodes directly below `node`, without following the `parent` back-reference. */
function childNodes(node) {
  return Object.entries(node)
    .filter(([key]) => key !== "parent")
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .filter(isNode);
}

/** Whether `predicate` holds for `node` or any node below it. */
function containsNode(node, predicate) {
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (predicate(current)) return true;
    stack.push(...childNodes(current));
  }
  return false;
}

function findVariable(scope, name) {
  for (let current = scope; current !== null; current = current.upper) {
    const variable = current.set.get(name);
    if (variable !== undefined) return variable;
  }
  return null;
}

function initializedBy(scope, identifier, predicate) {
  const variable = findVariable(scope, identifier.name);
  return (variable?.defs ?? []).some(
    (def) =>
      def.node.type === "VariableDeclarator" &&
      def.node.init !== null &&
      containsNode(def.node.init, predicate),
  );
}

/** A clock read in the node, or in the initializer of a variable it names: a timestamp. */
function readsClock(node, scope) {
  return containsNode(
    node,
    (current) =>
      isClockRead(current) ||
      (current.type === "Identifier" && initializedBy(scope, current, isClockRead)),
  );
}

/**
 * A measured duration: a difference with a timestamp on one side, or `process.hrtime(start)`. A
 * bare timestamp ordered against another one does not depend on load.
 */
function isDuration(node, scope) {
  if (node.type === "BinaryExpression" && node.operator === "-") {
    return readsClock(node.left, scope) || readsClock(node.right, scope);
  }
  return (
    node.type === "CallExpression" &&
    memberName(node.callee) === "hrtime" &&
    node.callee.object.name === "process" &&
    node.arguments.length > 0
  );
}

/** A duration in the node itself, or in the initializer of a variable it names. */
function measuresWallClock(node, scope) {
  const duration = (current) => isDuration(current, scope);
  return containsNode(
    node,
    (current) =>
      duration(current) ||
      (current.type === "Identifier" && initializedBy(scope, current, duration)),
  );
}

/** The `expect(...)` call a matcher chain such as `expect(x).not.toBe` starts from. */
function expectCall(matcherCallee) {
  let current = matcherCallee.object;
  while (current?.type === "MemberExpression") current = current.object;
  if (current?.type !== "CallExpression") return null;
  const callee = current.callee;
  const isExpect =
    (callee.type === "Identifier" && callee.name === "expect") ||
    (callee.type === "MemberExpression" && callee.object.name === "expect");
  return isExpect ? current : null;
}

function guardedByWallClockBudget(sourceCode, node) {
  return sourceCode.getAncestors(node).some((ancestor) => {
    if (["IfStatement", "ConditionalExpression", "LogicalExpression"].includes(ancestor.type)) {
      const condition = ancestor.type === "LogicalExpression" ? ancestor.left : ancestor.test;
      return sourceCode.getText(condition).includes(WALL_CLOCK_GUARD);
    }
    const runner = ancestor.type === "CallExpression" ? ancestor.callee : null;
    if (runner?.type !== "CallExpression") return false;
    if (!CONDITIONAL_RUNNERS.has(memberName(runner.callee))) return false;
    return runner.arguments.some((argument) =>
      sourceCode.getText(argument).includes(WALL_CLOCK_GUARD),
    );
  });
}

const noUnguardedWallClockAssertion = {
  meta: {
    type: "problem",
    messages: {
      unguarded:
        "A measured wall-clock duration is compared outside KEIKO_ENFORCE_WALL_CLOCK_BUDGETS (ADR-0139 D1): a loaded runner fails it. Guard it, or assert on an injected clock.",
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      CallExpression(node) {
        if (!COMPARATORS.has(memberName(node.callee))) return;
        const expectation = expectCall(node.callee);
        if (expectation === null) return;
        const scope = sourceCode.getScope(node);
        const operands = [...expectation.arguments, ...node.arguments];
        if (!operands.some((operand) => measuresWallClock(operand, scope))) return;
        if (guardedByWallClockBudget(sourceCode, node)) return;
        context.report({ node, messageId: "unguarded" });
      },
    };
  },
};

function positiveNumber(node) {
  return node?.type === "Literal" && typeof node.value === "number" && node.value > 0;
}

/** Whether `name` is the resolve parameter of the `new Promise((resolve) => ...)` around `node`. */
function isPromiseResolver(sourceCode, node, name) {
  return sourceCode.getAncestors(node).some((ancestor) => {
    if (!["ArrowFunctionExpression", "FunctionExpression"].includes(ancestor.type)) return false;
    const parent = ancestor.parent;
    const isExecutor =
      parent?.type === "NewExpression" &&
      parent.callee.type === "Identifier" &&
      parent.callee.name === "Promise" &&
      parent.arguments[0] === ancestor;
    const [resolve] = ancestor.params;
    return isExecutor && resolve?.type === "Identifier" && resolve.name === name;
  });
}

function resolvedCallee(callback) {
  if (callback?.type === "Identifier") return callback.name;
  const body = callback?.type === "ArrowFunctionExpression" ? callback.body : null;
  if (body?.type === "CallExpression" && body.callee.type === "Identifier") return body.callee.name;
  return null;
}

function isTimerPromiseImport(scope, name) {
  const variable = findVariable(scope, name);
  return (variable?.defs ?? []).some(
    (def) =>
      def.type === "ImportBinding" &&
      TIMER_PROMISE_MODULES.has(def.parent.source.value) &&
      def.node.type === "ImportSpecifier" &&
      def.node.imported.name === "setTimeout",
  );
}

/** Whether the node sits in a loop of its own function: a poll that re-checks a condition. */
function insidePollingLoop(sourceCode, node) {
  for (const ancestor of sourceCode.getAncestors(node).reverse()) {
    if (LOOPS.has(ancestor.type)) return true;
    if (FUNCTIONS.has(ancestor.type) && ancestor.parent?.type !== "NewExpression") return false;
  }
  return false;
}

function isFixedSleep(sourceCode, node) {
  if (insidePollingLoop(sourceCode, node)) return false;
  const callee = node.callee;
  if (memberName(callee) === "waitForTimeout") return positiveNumber(node.arguments[0]);
  if (callee.type !== "Identifier") return false;
  if (isTimerPromiseImport(sourceCode.getScope(node), callee.name)) {
    return positiveNumber(node.arguments[0]);
  }
  if (callee.name !== "setTimeout" || !positiveNumber(node.arguments[1])) return false;
  const resolver = resolvedCallee(node.arguments[0]);
  return resolver !== null && isPromiseResolver(sourceCode, node, resolver);
}

const noFixedSleep = {
  meta: {
    type: "problem",
    messages: {
      fixedSleep:
        "A fixed sleep waits too long or not long enough. Await the condition (vi.waitFor, expect.poll, an event) or use fake timers.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (isFixedSleep(context.sourceCode, node)) {
          context.report({ node, messageId: "fixedSleep" });
        }
      },
    };
  },
};

const noShortHexNegativeSubstring = {
  meta: {
    type: "problem",
    messages: {
      shortHex:
        "A short hexadecimal substring appears in a digest by chance (#4481). Match it at word boundaries, or assert on a longer, non-hex text.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!["toContain", "toMatch"].includes(memberName(node.callee))) return;
        if (memberName(node.callee.object) !== "not") return;
        const expectation = expectCall(node.callee);
        if (expectation === null || producesArray(expectation.arguments[0])) return;
        const [expected] = node.arguments;
        if (expected?.type !== "Literal" || typeof expected.value !== "string") return;
        if (SHORT_HEX.test(expected.value)) context.report({ node, messageId: "shortHex" });
      },
    };
  },
};

/** A subject that is evidently an array, where `toContain` is element equality, not a substring. */
function producesArray(subject) {
  if (subject?.type === "ArrayExpression") return true;
  return subject?.type === "CallExpression" && ARRAY_PRODUCERS.has(memberName(subject.callee));
}

export const testDeterminismPlugin = {
  meta: { name: "keiko-test-determinism" },
  rules: {
    "no-unguarded-wall-clock-assertion": noUnguardedWallClockAssertion,
    "no-fixed-sleep": noFixedSleep,
    "no-short-hex-negative-substring": noShortHexNegativeSubstring,
  },
};
