export interface ParserTypeFacts<F extends (...args: never[]) => unknown> {
  readonly input: Parameters<F>[0];
  readonly output: ReturnType<F>;
}

export interface UnknownInputParserFacts<Result> {
  readonly input: unknown;
  readonly output: Result;
}
