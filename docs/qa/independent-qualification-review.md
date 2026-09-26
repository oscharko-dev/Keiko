# Independent qualification review (#3390)

The five-flow qualification lane stops once, between the delivered draft pull request and the
governed merge, and asks an independent reviewer to check the actual final diff and the required
checks against the frozen rubric. This document is the operator's side of that checkpoint.

The reviewer is deliberately not the run: the request and the answer live in a directory outside
both the Keiko checkout and the controlled repository, so neither the model nor its managed
workspace can write its own approval. `KEIKO_QUALIFICATION_REVIEW_DIR` names that directory and the
harness refuses any location inside either workspace.

## What the harness publishes

One request per flow, named `<flowId>.<taskRunId>.<headSha>.request.json`:

| Field          | Meaning                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `binding`      | The exact flow, run, repository, issue, pull request, head, source commit and frozen-rubric digest this answer may cover. |
| `criterionIds` | The complete criterion inventory, derived from the rubric — the reviewer cannot drop an inconvenient entry.               |
| `outcomes`     | The accepted outcome vocabulary: `passed`, `rejected`, `needs-changes`.                                                   |

## What the reviewer answers

`<same name>.review.json`, carrying the request's `binding` verbatim, a `reviewId`, and exactly one
result per criterion. Every result carries an `outcome` from that vocabulary and a `reason`: a
passed criterion states what was checked, an unmet one states what is wrong.

The verdict is derived, never supplied: all passed is `approved`, any `rejected` is `rejected`,
otherwise `changes-requested`. Only an approved review yields the acceptance row a completed flow
may retain. A review that withholds approval fails the flow with its unmet criterion ids named, so
a reviewer who found a defect can never be mistaken for a reviewer who never answered.

## The answer is signed

The review is signed with a detached SSH signature over its exact bytes, written last:

```bash
/usr/bin/ssh-keygen -Y sign -f ~/.ssh/id_ed25519 -n keiko-qualification-review review.json
```

The harness verifies it against `KEIKO_QUALIFICATION_REVIEW_ALLOWED_SIGNERS` for the identity in
`KEIKO_QUALIFICATION_REVIEW_SIGNER`, under this lane's own namespace — never the `git` namespace an
operator signs commits with. A missing or foreign signature, or an edited review, fails closed. The
signature file is also the completion marker, so the harness never reads a half-written review.

## The flow parks

Reviewing a real diff is human-paced work, so the wait is event-driven and carries no deadline of
its own: the flow parks until the answer appears. An unattended lane may bound it with
`KEIKO_QUALIFICATION_REVIEW_TIMEOUT_MS`, in whole milliseconds; unset means park indefinitely. Each
remaining stage keeps its own bounded wait, so an unbounded park never hides a hung step.
