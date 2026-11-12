# MemoriaViva M1 learning-metric baseline

Recorded by `npm run test:e2e:memoriaviva-m1` from the deterministic, labeled M1 certification corpus. The corpus identity is content-free: `sha256:9797eb51441e40e75effe051b3ec25a7aac4b93f21b3184b78ebc011cdd2c267`.

| Metric                   | Numerator | Denominator | Baseline |
| ------------------------ | --------: | ----------: | -------: |
| Repeated-correction rate |         1 |           2 |   0.5000 |
| Approval-free acceptance |         6 |           6 |   1.0000 |
| Capture precision        |         6 |           6 |   1.0000 |

## Measurement contract for M8

- Repeated-correction rate = corrective turns that repeat a correction to an already captured fact divided by all labeled corrective turns.
- Approval-free acceptance = captures accepted without a review step divided by all captures emitted by the labeled corpus, in every mode (#4206).
- Capture precision = captures labeled correct divided by all captures emitted by the labeled corpus.
- M8 must rerun the same labels and denominator rules, report counts plus four-decimal rates, and compare against this corpus hash or document an intentional corpus revision.

## Content-safety contract

This evidence contains only metric names, counts, rates, and a hash of content-free labels. It contains no memory body, rejected utterance, secret, endpoint, customer identifier, or personal data.
