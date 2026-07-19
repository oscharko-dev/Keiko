# MemoriaViva M1 learning-metric baseline

Recorded by `npm run test:e2e:memoriaviva-m1` from the deterministic, labeled M1 certification corpus. The corpus identity is content-free: `sha256:cf4d894c55306d8bca0c86d6e19b1fd9867057569560f29222bae82d83743195`.

| Metric                   | Numerator | Denominator | Baseline |
| ------------------------ | --------: | ----------: | -------: |
| Repeated-correction rate |         1 |           2 |   0.5000 |
| Proposal-acceptance rate |         1 |           1 |   1.0000 |
| Capture precision        |         6 |           6 |   1.0000 |

## Measurement contract for M8

- Repeated-correction rate = corrective turns that repeat a correction to an already captured fact divided by all labeled corrective turns.
- Proposal-acceptance rate = accepted proposals divided by all proposals emitted by the labeled corpus.
- Capture precision = captures labeled correct divided by all captures emitted by the labeled corpus.
- M8 must rerun the same labels and denominator rules, report counts plus four-decimal rates, and compare against this corpus hash or document an intentional corpus revision.

## Content-safety contract

This evidence contains only metric names, counts, rates, and a hash of content-free labels. It contains no memory body, rejected utterance, secret, endpoint, customer identifier, or personal data.
