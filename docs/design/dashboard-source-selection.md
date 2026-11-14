# Explicit dashboard source selection

Related: #151 and the living-dashboard direction in #184. This small module is
unwired. It does not change the dashboard, routes, storage, scoring or permissions.

`selectDashboardSources` accepts an authorised tenant/organisation's retained
version envelopes and two explicit immutable references: a submitted baseline
and an optional saved draft. Each reference binds assessment ID, revision,
revision hash and scope hash. Passing null means no selection; array order,
newest timestamps and draft progress never choose or replace a baseline.

The existing retained-record validator checks ownership, scope, responses and
submitted evaluator evidence. The version hash is rechecked. Invalid or mixed-owner
batches fail without returning partial results. Conflicting duplicates fail;
identical duplicates are harmless. The result is detached and frozen. It projects
source provenance and saved progress, never a combined or recalculated score.

Missing exact references are `not_loaded` for an incomplete batch and `not_found`
only when the caller explicitly supplies a complete candidate set. Completeness
is a caller assertion, not something inferred from row count. An integration must
finish authorised pagination/history reads before making that assertion. The
100-version bound is a resource limit, not an instruction to silently truncate.

Public summaries are unsuitable inputs: their scope text is truncated and they
do not carry organisation ownership. Scope hashes also bind each assessment, so
equal text does not establish that two different assessments cover the same
population. Cross-assessment scope equivalence remains `not_established`; no
trend or combined current score is implied. Same-assessment historical draft and
submitted versions retain their immutable scope binding.

`savedAt` and `submittedAt` are retained record times, not observation freshness.
No new observation time or live monitoring claim is invented. Callers may retain
the exact references and resolve earlier states again without reopening a
submission. This module is not a substitute for the existing authorised reader,
full revision-chain validation, request epoch fencing or final access recheck.

Before runtime wiring, decide how people explicitly pair assessments covering the
same real-world scope, how a selected source is persisted, and how missing or
revoked selections are displayed. Those decisions are not made by this contract.
