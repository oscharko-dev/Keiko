export interface PgQueryResult<Row extends object = Record<string, never>> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

export interface PgClientLike {
  query<Row extends object = Record<string, never>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<Row>>;
  release(): void;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}
