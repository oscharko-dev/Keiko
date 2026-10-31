import type { ExpectTypeOf } from "vitest";

type Callable = (...args: never[]) => unknown;

type LibraryInput<F extends Callable> = Parameters<
  Parameters<ExpectTypeOf<F, { positive: true }>["parameters"]["map"]>[0]
>[0][0];

export type LibraryOutput<F extends Callable> = Parameters<
  Parameters<ExpectTypeOf<F, { positive: true }>["returns"]["map"]>[0]
>[0];

type MatcherPass<M> = [M] extends [never]
  ? false
  : M extends (...args: infer A) => unknown
    ? [] extends A
      ? true
      : false
    : false;

export type LibraryParserTypeFacts<F extends Callable> = readonly [
  MatcherPass<ExpectTypeOf<LibraryInput<F>, { positive: true }>["toBeUnknown"]>,
  MatcherPass<ExpectTypeOf<LibraryInput<F>, { positive: true }>["not"]["toBeAny"]>,
  LibraryOutput<F>,
  MatcherPass<ExpectTypeOf<F, { positive: true }>["returns"]["not"]["toBeAny"]>,
];

export type LibraryParserTripleFacts<
  S extends Callable,
  P extends Callable,
  W extends Callable,
> = readonly [
  ...LibraryParserTypeFacts<S>,
  ...LibraryParserTypeFacts<P>,
  ...LibraryParserTypeFacts<W>,
];

export type LibraryParserTripleExpected<SOutput, POutput, WOutput> = readonly [
  true,
  true,
  SOutput,
  true,
  true,
  true,
  POutput,
  true,
  true,
  true,
  WOutput,
  true,
];

export type LibraryContextDiagnosticFacts<F extends Callable, Reasons, Element> = readonly [
  Parameters<F>,
  MatcherPass<ExpectTypeOf<ReturnType<F>, { positive: true }>["not"]["toBeAny"]>,
  ReturnType<F>,
  Reasons,
  MatcherPass<ExpectTypeOf<Element, { positive: true }>["not"]["toBeAny"]>,
];

/** The public and forwarding stages also return exactly the source stage's result. */
export type LibraryParserTripleIdentityFacts<
  S extends Callable,
  P extends Callable,
  W extends Callable,
> = readonly [LibraryParserTripleFacts<S, P, W>, LibraryOutput<P>, LibraryOutput<W>];

export type LibraryParserTripleIdentityExpected<SOutput, POutput> = readonly [
  LibraryParserTripleExpected<SOutput, POutput, POutput>,
  SOutput,
  SOutput,
];

type AcceptedValue<F extends Callable> =
  LibraryOutput<F> extends infer R
    ? R extends { readonly ok: true; readonly value: infer V }
      ? V
      : never
    : never;

// A union containing `any` is `any` and one containing `unknown` is `unknown`, so one pair of
// matchers covers the accepted value and every listed member type.
type ConcreteFacts<T> = readonly [
  MatcherPass<ExpectTypeOf<T, { positive: true }>["not"]["toBeAny"]>,
  MatcherPass<ExpectTypeOf<T, { positive: true }>["not"]["toBeUnknown"]>,
];

/** The triple facts, the forwarding stage's accepted value, and its listed member types. */
export type LibraryParserAcceptedFacts<
  S extends Callable,
  P extends Callable,
  W extends Callable,
  Members extends readonly unknown[],
> = readonly [
  LibraryParserTripleFacts<S, P, W>,
  AcceptedValue<W>,
  ConcreteFacts<AcceptedValue<W> | Members[number]>,
];

export type LibraryParserAcceptedExpected<SOutput, POutput, Value> = readonly [
  LibraryParserTripleExpected<SOutput, POutput, POutput>,
  Value,
  readonly [true, true],
];

type ResultOk<F extends Callable> =
  LibraryOutput<F> extends infer R ? (R extends { readonly ok: infer O } ? O : never) : never;

type RefusedErrors<F extends Callable> =
  LibraryOutput<F> extends infer R
    ? R extends { readonly ok: false; readonly errors: infer E }
      ? E
      : never
    : never;

/** A checked result: a boolean `ok`, string refusals, and a concrete accepted value. */
export type CheckedResultFacts<F extends Callable> = readonly [
  ResultOk<F>,
  RefusedErrors<F>,
  ConcreteFacts<AcceptedValue<F>>,
];

export type CheckedResultExpected = readonly [boolean, readonly string[], readonly [true, true]];

type DiagnosticReasons<F extends Callable> =
  ReturnType<F> extends infer R
    ? R extends { readonly ok: false; readonly reasons: infer Reasons }
      ? Reasons
      : never
    : never;

type ContextDiagnosticFacts<F extends Callable> = LibraryContextDiagnosticFacts<
  F,
  DiagnosticReasons<F>,
  DiagnosticReasons<F> extends readonly (infer Element)[] ? Element : never
>;

/** Source and public diagnostics share one closed result type; the witness counts reasons. */
export type ContextDiagnosticTripleFacts<
  S extends Callable,
  P extends Callable,
  Count extends Callable,
> = readonly [
  ContextDiagnosticFacts<S>,
  ContextDiagnosticFacts<P>,
  Parameters<Count>,
  ReturnType<Count>,
];

export type ContextDiagnosticTripleExpected<Result> = readonly [
  readonly [[unknown], true, Result, readonly string[], true],
  readonly [[unknown], true, Result, readonly string[], true],
  [unknown],
  number,
];
