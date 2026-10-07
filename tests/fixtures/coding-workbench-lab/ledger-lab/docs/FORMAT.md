# Ledger file formats

## Native ledger CSV (`ledger-csv`)

Comma-separated with a fixed header `date,account,description,amount`.

- `date`: ISO calendar date `YYYY-MM-DD`.
- `account`: free text, required.
- `description`: free text; RFC 4180 quoting applies (a field containing a comma or a double quote
  is wrapped in double quotes, and a double quote inside such a field is doubled).
- `amount`: decimal with a dot and at most two fractional digits, optionally prefixed with `$`;
  negative values are expenses. Thousands separators are not accepted.

Example: `data/sample.csv`.

## Bank B export (`bank-b`)

Semicolon-separated. The file starts with free-form metadata lines, then the header
`Datum;Konto;Verwendungszweck;Betrag`, then one entry per line.

- `Datum`: `DD.MM.YYYY`.
- `Betrag`: German notation, comma as the decimal separator and an optional dot as the thousands
  separator, for example `-1.200,00` or `3.000,00`.
- Quoting is not used by Bank B; a `;` never occurs inside a field.

Example: `data/bank-b.csv`.

## Money

Every amount is stored as integer cents (`Cents`). Parsers convert exactly; nothing in the ledger
stores or sums floating-point currency values.
