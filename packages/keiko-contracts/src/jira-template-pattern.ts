/**
 * The closed pattern language of Jira issue templates (#4177, ADR-0128 D4).
 *
 * A pattern is run on text a Jira user wrote, so it is never handed to `RegExp`: the validated
 * syntax tree is compiled to a Thompson automaton program and simulated in O(input x program)
 * time, which no pattern can make exponential. Validation and matching share the one parser, so a
 * pattern that is accepted is a pattern that can be matched. The language is the JavaScript
 * subset the lead already knows: literals, classes, `. ^ $ \b \B`, `\d \D \w \W \s \S`, escapes,
 * alternation, non-capturing and plain groups, and greedy or lazy `* + ? {n} {n,} {n,m}`.
 * Lookarounds, back-references, named groups, quantified assertions, and a quantified group that
 * holds a quantifier or an alternation are refused. Matching is unanchored, like `RegExp#test`.
 */
export const JIRA_TEMPLATE_PATTERN_CHARS_MAX = 200;

const PROGRAM_MAX = 4096;
const DEPTH_MAX = 16;

type UnitTest = (unit: number) => boolean;
type Assertion = "start" | "end" | "boundary" | "not-boundary";

type PatternNode =
  | { readonly kind: "empty" }
  | { readonly kind: "unit"; readonly test: UnitTest }
  | { readonly kind: "assert"; readonly assertion: Assertion }
  | { readonly kind: "seq"; readonly items: readonly PatternNode[] }
  | { readonly kind: "alt"; readonly items: readonly PatternNode[] }
  | {
      readonly kind: "repeat";
      readonly body: PatternNode;
      readonly min: number;
      readonly max: number;
    };

const isDigit: UnitTest = (unit) => unit >= 48 && unit <= 57;
const isWord: UnitTest = (unit) =>
  isDigit(unit) || (unit >= 65 && unit <= 90) || (unit >= 97 && unit <= 122) || unit === 95;
const SPACE_UNITS: ReadonlySet<number> = new Set([
  9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279,
]);
const isSpace: UnitTest = (unit) => SPACE_UNITS.has(unit) || (unit >= 8192 && unit <= 8202);
const isLineTerminator: UnitTest = (unit) =>
  unit === 10 || unit === 13 || unit === 8232 || unit === 8233;
const not =
  (test: UnitTest): UnitTest =>
  (unit) =>
    !test(unit);
const literal =
  (code: number): UnitTest =>
  (unit) =>
    unit === code;

const CLASS_ESCAPES: Readonly<Record<string, UnitTest>> = {
  d: isDigit,
  D: not(isDigit),
  w: isWord,
  W: not(isWord),
  s: isSpace,
  S: not(isSpace),
};
const CONTROL_ESCAPES: Readonly<Record<string, number>> = { t: 9, n: 10, v: 11, f: 12, r: 13 };

interface Quantifier {
  readonly width: number;
  readonly min: number;
  readonly max: number;
}
// A brace that reads as a quantifier is one, however large its count: `{1,1000}` must never
// degrade to literal text, which would invert the rule the lead wrote. A count beyond the program
// bound could not be compiled anyway, so it is refused (an inverted range, see `term`).
const BRACE = /^\{(\d+)(?:(,)(\d*))?\}/u;
const REFUSED_COUNT = { min: 1, max: 0 } as const;

/** The code point at `index`, or -1 past the end. */
function codeAt(chars: readonly string[], index: number): number {
  return chars[index]?.codePointAt(0) ?? -1;
}

function braceMax(brace: RegExpExecArray, min: number): number {
  if (brace[2] === undefined) return min;
  return brace[3] === "" ? Infinity : Number(brace[3]);
}

function braceQuantifier(brace: RegExpExecArray): Quantifier {
  const min = Number(brace[1]);
  const max = braceMax(brace, min);
  const counts = max === Infinity ? [min] : [min, max];
  return {
    width: brace[0].length,
    ...(counts.some((count) => count > PROGRAM_MAX) ? REFUSED_COUNT : { min, max }),
  };
}

function quantifierAt(chars: readonly string[], index: number): Quantifier | undefined {
  const character = chars[index];
  if (character === "*") return { width: 1, min: 0, max: Infinity };
  if (character === "+") return { width: 1, min: 1, max: Infinity };
  if (character === "?") return { width: 1, min: 0, max: 1 };
  const brace =
    character === "{"
      ? BRACE.exec(chars.slice(index, index + JIRA_TEMPLATE_PATTERN_CHARS_MAX).join(""))
      : null;
  return brace === null ? undefined : braceQuantifier(brace);
}

function holdsRepeatOrAlternation(node: PatternNode): boolean {
  if (node.kind === "repeat" || node.kind === "alt") return true;
  return node.kind === "seq" && node.items.some(holdsRepeatOrAlternation);
}

function hex(chars: readonly string[], start: number, width: number): number | undefined {
  const digits = chars.slice(start, start + width);
  return digits.length === width && /^[0-9a-fA-F]+$/u.test(digits.join(""))
    ? Number.parseInt(digits.join(""), 16)
    : undefined;
}

interface Escape {
  readonly test: UnitTest;
  /** The code unit when the escape names one character (usable as a range end). */
  readonly code: number | undefined;
  readonly width: number;
}

function numericEscape(chars: readonly string[], index: number): Escape | undefined {
  const letter = chars[index + 1];
  if (letter === "0") {
    return isDigit(codeAt(chars, index + 2)) ? undefined : { test: literal(0), code: 0, width: 2 };
  }
  const width = letter === "x" ? 2 : 4;
  const code = hex(chars, index + 2, width);
  return code === undefined ? undefined : { test: literal(code), code, width: 2 + width };
}

function characterEscape(chars: readonly string[], index: number): Escape | undefined {
  const letter = chars[index + 1] ?? "";
  const controlled = CONTROL_ESCAPES[letter];
  if (controlled !== undefined) return { test: literal(controlled), code: controlled, width: 2 };
  if (letter === "0" || letter === "x" || letter === "u") return numericEscape(chars, index);
  // Any other letter or digit is a back-reference, a property or a legacy escape: refused.
  if (letter === "" || /[A-Za-z0-9]/u.test(letter)) return undefined;
  const unit = codeAt(chars, index + 1);
  return { test: literal(unit), code: unit, width: 2 };
}

function classEscape(chars: readonly string[], index: number): Escape | undefined {
  const test = CLASS_ESCAPES[chars[index + 1] ?? ""];
  return test === undefined ? characterEscape(chars, index) : { test, code: undefined, width: 2 };
}

interface ClassMember {
  readonly test: UnitTest;
  readonly code: number | undefined;
  readonly width: number;
}

function classMember(chars: readonly string[], index: number): ClassMember | undefined {
  if (chars[index] === "\\") return classEscape(chars, index);
  const code = codeAt(chars, index);
  return { test: literal(code), code, width: 1 };
}

class PatternParser {
  private index = 0;
  private depth = 0;

  public constructor(private readonly chars: readonly string[]) {}

  public parse(): PatternNode | undefined {
    const node = this.alternation();
    return node !== undefined && this.index === this.chars.length ? node : undefined;
  }

  private alternation(): PatternNode | undefined {
    const items: PatternNode[] = [];
    for (;;) {
      const item = this.sequence();
      if (item === undefined) return undefined;
      items.push(item);
      if (this.chars[this.index] !== "|") break;
      this.index += 1;
    }
    return items.length === 1 ? (items[0] ?? { kind: "empty" }) : { kind: "alt", items };
  }

  private sequence(): PatternNode | undefined {
    const items: PatternNode[] = [];
    while (this.index < this.chars.length) {
      const character = this.chars[this.index];
      if (character === "|" || character === ")") break;
      const term = this.term();
      if (term === undefined) return undefined;
      items.push(term);
    }
    return items.length === 1 ? (items[0] ?? { kind: "empty" }) : { kind: "seq", items };
  }

  private term(): PatternNode | undefined {
    if (quantifierAt(this.chars, this.index) !== undefined) return undefined;
    const atom = this.atom();
    const quantifier = atom === undefined ? undefined : quantifierAt(this.chars, this.index);
    if (atom === undefined || quantifier === undefined) return atom;
    if (atom.kind === "assert" || quantifier.min > quantifier.max) return undefined;
    this.index += quantifier.width;
    // Lazy and greedy quantifiers accept the same texts; the suffix only has to be well formed.
    if (this.chars[this.index] === "?") this.index += 1;
    if (quantifierAt(this.chars, this.index) !== undefined || holdsRepeatOrAlternation(atom))
      return undefined;
    return { kind: "repeat", body: atom, min: quantifier.min, max: quantifier.max };
  }

  private atom(): PatternNode | undefined {
    const character = this.chars[this.index] ?? "";
    if (character === "(") return this.group();
    if (character === "[") return this.characterClass();
    if (character === "\\") return this.escape();
    this.index += 1;
    if (character === ".") return { kind: "unit", test: not(isLineTerminator) };
    if (character === "^") return { kind: "assert", assertion: "start" };
    if (character === "$") return { kind: "assert", assertion: "end" };
    return { kind: "unit", test: literal(character.codePointAt(0) ?? 0) };
  }

  private group(): PatternNode | undefined {
    const plain = this.chars[this.index + 1] !== "?";
    if (!plain && this.chars[this.index + 2] !== ":") return undefined;
    this.index += plain ? 1 : 3;
    this.depth += 1;
    const body = this.depth > DEPTH_MAX ? undefined : this.alternation();
    this.depth -= 1;
    if (body === undefined || this.chars[this.index] !== ")") return undefined;
    this.index += 1;
    return body;
  }

  private escape(): PatternNode | undefined {
    const letter = this.chars[this.index + 1];
    if (letter === "b" || letter === "B") {
      this.index += 2;
      return { kind: "assert", assertion: letter === "b" ? "boundary" : "not-boundary" };
    }
    const escape = classEscape(this.chars, this.index);
    if (escape === undefined) return undefined;
    this.index += escape.width;
    return { kind: "unit", test: escape.test };
  }

  private characterClass(): PatternNode | undefined {
    this.index += 1;
    const negate = this.chars[this.index] === "^";
    if (negate) this.index += 1;
    const members: UnitTest[] = [];
    while (this.chars[this.index] !== "]") {
      const member = this.classItem();
      if (member === undefined) return undefined;
      members.push(member);
    }
    this.index += 1;
    return { kind: "unit", test: (unit) => members.some((test) => test(unit)) !== negate };
  }

  private classItem(): UnitTest | undefined {
    const first = this.chars[this.index] === undefined ? undefined : this.member();
    if (first === undefined) return undefined;
    const open = this.chars[this.index] === "-" && this.chars[this.index + 1] !== "]";
    if (!open || first.code === undefined || this.index + 1 >= this.chars.length) return first.test;
    this.index += 1;
    const last = this.member();
    if (last?.code === undefined || first.code > last.code) return undefined;
    const [low, high] = [first.code, last.code];
    return (unit) => unit >= low && unit <= high;
  }

  private member(): ClassMember | undefined {
    const member = classMember(this.chars, this.index);
    if (member === undefined) return undefined;
    this.index += member.width;
    return member;
  }
}

// ─── Program ────────────────────────────────────────────────────────────────────────────────────
interface SplitInstruction {
  readonly op: "split";
  first: number;
  second: number;
}
interface JumpInstruction {
  readonly op: "jump";
  target: number;
}
type Instruction =
  | { readonly op: "unit"; readonly test: UnitTest }
  | { readonly op: "assert"; readonly assertion: Assertion }
  | { readonly op: "match" }
  | SplitInstruction
  | JumpInstruction;

class ProgramBuilder {
  public readonly program: Instruction[] = [];

  public get overflowed(): boolean {
    return this.program.length > PROGRAM_MAX;
  }

  private push<Item extends Instruction>(instruction: Item): Item {
    this.program.push(instruction);
    return instruction;
  }

  public emit(node: PatternNode): void {
    if (this.overflowed) return;
    switch (node.kind) {
      case "empty":
        return;
      case "unit":
        this.push({ op: "unit", test: node.test });
        return;
      case "assert":
        this.push({ op: "assert", assertion: node.assertion });
        return;
      case "seq":
        for (const item of node.items) this.emit(item);
        return;
      case "alt":
        this.alternation(node.items);
        return;
      case "repeat":
        this.repeat(node);
    }
  }

  private alternation(items: readonly PatternNode[]): void {
    const exits: JumpInstruction[] = [];
    for (const item of items.slice(0, -1)) {
      const split = this.push<SplitInstruction>({ op: "split", first: 0, second: 0 });
      split.first = this.program.length;
      this.emit(item);
      exits.push(this.push<JumpInstruction>({ op: "jump", target: 0 }));
      split.second = this.program.length;
    }
    this.emit(items.at(-1) ?? { kind: "empty" });
    for (const exit of exits) exit.target = this.program.length;
  }

  private repeat(node: Extract<PatternNode, { kind: "repeat" }>): void {
    for (let count = 0; count < node.min && !this.overflowed; count += 1) this.emit(node.body);
    if (node.max === Infinity) {
      const head = this.program.length;
      const split = this.push<SplitInstruction>({ op: "split", first: 0, second: 0 });
      split.first = this.program.length;
      this.emit(node.body);
      this.push<JumpInstruction>({ op: "jump", target: head });
      split.second = this.program.length;
      return;
    }
    const splits: SplitInstruction[] = [];
    for (let count = node.min; count < node.max && !this.overflowed; count += 1) {
      const split = this.push<SplitInstruction>({ op: "split", first: 0, second: 0 });
      split.first = this.program.length;
      splits.push(split);
      this.emit(node.body);
    }
    for (const split of splits) split.second = this.program.length;
  }
}

function compileProgram(source: string): readonly Instruction[] | undefined {
  if (source.length === 0 || source.length > JIRA_TEMPLATE_PATTERN_CHARS_MAX) return undefined;
  const tree = new PatternParser(Array.from(source)).parse();
  if (tree === undefined) return undefined;
  const builder = new ProgramBuilder();
  builder.emit(tree);
  builder.program.push({ op: "match" });
  return builder.overflowed ? undefined : builder.program;
}

// ─── Simulation ─────────────────────────────────────────────────────────────────────────────────
function wordAt(input: readonly number[], index: number): boolean {
  const unit = input[index];
  return unit !== undefined && isWord(unit);
}

function holds(assertion: Assertion, input: readonly number[], position: number): boolean {
  if (assertion === "start") return position === 0;
  if (assertion === "end") return position === input.length;
  const boundary = wordAt(input, position - 1) !== wordAt(input, position);
  return assertion === "boundary" ? boundary : !boundary;
}

interface Run {
  readonly program: readonly Instruction[];
  readonly input: readonly number[];
  readonly seen: Int32Array;
}

/** Adds the states reachable from `start` at `position`; true as soon as the match is reached. */
function follow(run: Run, start: number, position: number, out: number[]): boolean {
  const stamp = position + 1;
  const stack = [start];
  for (let pc = stack.pop(); pc !== undefined; pc = stack.pop()) {
    if (run.seen[pc] === stamp) continue;
    run.seen[pc] = stamp;
    const instruction = run.program[pc];
    if (instruction === undefined) continue;
    if (instruction.op === "match") return true;
    if (instruction.op === "unit") out.push(pc);
    else if (instruction.op === "jump") stack.push(instruction.target);
    else if (instruction.op === "split") stack.push(instruction.second, instruction.first);
    else if (holds(instruction.assertion, run.input, position)) stack.push(pc + 1);
  }
  return false;
}

function step(run: Run, current: readonly number[], position: number): number[] | true {
  const unit = run.input[position] ?? -1;
  const next: number[] = [];
  for (const pc of current) {
    const instruction = run.program[pc];
    if (
      instruction?.op === "unit" &&
      instruction.test(unit) &&
      follow(run, pc + 1, position + 1, next)
    )
      return true;
  }
  return next;
}

function simulate(program: readonly Instruction[], text: string): boolean {
  // Code points, so an astral character is one character for `.` and for a literal alike.
  const input = Array.from(text, (character) => character.codePointAt(0) ?? 0);
  const run: Run = { program, input, seen: new Int32Array(program.length) };
  let current: number[] = [];
  for (let position = 0; ; position += 1) {
    if (follow(run, 0, position, current)) return true;
    if (position >= input.length) return false;
    const next = step(run, current, position);
    if (next === true) return true;
    current = next;
  }
}

/** Why a pattern is refused, or `undefined` when it can be matched. */
export function jiraTemplatePatternIssue(source: string): string | undefined {
  if (source.length === 0 || source.length > JIRA_TEMPLATE_PATTERN_CHARS_MAX)
    return "pattern length";
  return compileProgram(source) === undefined ? "pattern structure" : undefined;
}

export interface JiraTemplatePatternMatcher {
  readonly test: (value: string) => boolean;
}

/** The matcher of an accepted pattern; callers must have accepted it at parse time. */
export function compileJiraTemplatePattern(source: string): JiraTemplatePatternMatcher {
  const program = compileProgram(source);
  if (program === undefined) throw new TypeError(jiraTemplatePatternIssue(source) ?? "pattern");
  return { test: (value) => simulate(program, value) };
}
