# ledger-lab

A small expense ledger: a TypeScript library plus a CLI that summarizes a CSV export.

```bash
npm run check                           # typecheck, lint and tests
npm test                                # run the test suite (node:test, no runtime dependencies)
node src/cli.ts summary data/sample.csv # print the balance and monthly totals
node src/cli.ts accounts data/sample.csv   # per-account report
node src/cli.ts months data/sample.csv     # per-month report with the largest expense
node src/cli.ts categories data/sample.csv # expense categories
node src/cli.ts import --format bank-b data/bank-b.csv # summary of a Bank B export
```

## CSV format

The file starts with the header `date,account,description,amount`. Dates are ISO
(`YYYY-MM-DD`), amounts are decimal with at most two fractional digits; negative
amounts are expenses.

File formats, including the Bank B export, are described in `docs/FORMAT.md`.
