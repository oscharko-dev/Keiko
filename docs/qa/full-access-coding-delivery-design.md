# Full access coding delivery authorization

The accepted Code-task delivery path must distinguish two sources of authority without fabricating
one from the other:

- Ask for approval and Supervised workspace execute commit, push, and draft-PR proposals only after
  the existing exact, one-use local-operator approval is matched and consumed.
- Full access may execute the same previously proposed object with the kernel's existing
  `GitDeliveryApprovalRequirement` value `{ required: false }`, but only while the current,
  server-resolved Authority Envelope admits that exact delivery action.

The Full access decision is the conjunction of a live policy-mode decision and the existing coding
tool mutation guard. The guard revalidates the capability, deployment ceiling, workspace binding,
authority expiry, required action classes, connector scopes, and action-specific delivery policy at
admission and again at the service effect edge. Reading `effectiveMode` by itself is never delivery
authority. A downgrade, expiry, scope loss, head drift, verification drift, proposal expiry, or
failed guard therefore stops before the effect.

Proposal and execution stay separate in every mode. A Full access proposal can return the existing
model-only `approvalDisposition: "ready"` without opening an operator approval request, while its
immutable recorded proposal receipt remains unchanged. The model must still call the execute tool.
Ask and Supervised proposals continue to suspend until their exact operator decision settles.

The production services receive a live `policyAllowsWithoutApproval` callback from the authority
owner and evaluate it only together with the mutation guard. When both remain valid, the service
passes `{ required: false }` to the existing Git mutation kernel and emits a body-free
`policy-authorized` approval lifecycle event. It never calls `issueApproval`, never writes the
local-operator identity, and never creates a reusable approval token or lease.

This changes the Code-task commit, push, and draft-PR path only. Merge remains a separate explicit
approval-gated product action. Existing candidate, branch, remote, issue, verification, recovery,
and evidence checks remain authoritative.
