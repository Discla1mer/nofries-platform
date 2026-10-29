# Inactive repository handover contract

This draft adds offline provenance checks for a future move to
`Discla1mer/nofries-platform`. It does not add a deployment workflow or give this
repository production authority. The current release owner continues their work
independently; activation requires a separate, reviewed handover.

The public baseline is
[`a6bba1f0a8fca813ff9a5a2aa7410222ea8ec234`](https://github.com/Discla1mer/nofries-platform/commit/a6bba1f0a8fca813ff9a5a2aa7410222ea8ec234).
The existing public CI and application source remain unchanged by this draft.

## Offline checks

`scripts/release/public-repository-handover.js` exposes `inspectHandover` and
`checkRecovery`. These are pure functions: they obtain no credentials, make no
network calls, write no files, dispatch no workflows and run no candidate code.
`inspectHandover` always returns `deploymentAuthorized: false`, including when
all provenance checks pass. It is not imported by any application or workflow.

Each role is bound to one exact repository, source SHA, workflow path and ID,
run ID, run number and attempt. The public repository name and numeric ID are
pinned. Only the previous successful package producer in `first-public` mode
may use the independently protected `expected.legacyRepository` tuple. After
transition, `public` mode requires the public repository for that role too.
All other roles always require the public repository. There is no global list
of interchangeable repositories or repository override from candidate evidence.

The checks cover:

- Exact protected source before and after observation, its tree and a reviewed
  inventory digest.
- The existing public CI workflow and command graph, exact main push run and
  attempt, complete application/PostgreSQL/dependency job coverage, successful
  required steps, before/after observations and bounded freshness.
- Candidate and evaluation roles bound to the selected source and independently
  reviewed workflow bytes.
- Previous successful package provenance, original candidate components,
  artifact ID/name, expiry, byte length, outer and inner digests, manifest
  producer, and component identities. Missing, expired or reconstructed packages
  do not satisfy the first-release contract.
- Independent recovery roles, exact source and workflow bytes, sequential run
  identities, before/after snapshots, ordering, witness target and absence of
  repeat attempts. An access error cannot establish attempt absence.

The test fixtures contain synthetic runs, historical repository identities,
workflow paths and package bytes. No historical operational evidence or
credentials are included.

## Trusted inputs and limits

These functions do not authenticate their own input. A separately reviewed,
pinned controller must acquire evidence and supply `expected` independently.
It must never construct trusted bindings from a PR artifact, candidate code,
unreviewed workflow input or the evidence being checked. The historical
repository tuple, role-specific workflow paths, workflow digests, artifact
name/digests and witness title belong to that protected configuration. This
draft intentionally ships no operational configuration for them.

The future collector must fetch complete responses from exact repository and
attempt endpoints, assign role labels itself, read exact commit blobs, re-read
source and run state after collection, and protect evidence digests. It must
bind the inventory to all selected commit paths, modes and bytes, refusing
unreviewed overlays, symlinks, replacement refs and historical ancestry imports.
A caller-supplied inventory digest alone does not prove source equivalence.

For archives, the collector must prove extraction relationships, enforce bounded
member inventories and reject traversal and links. Hashing supplied buffers does
not prove that an inner buffer came from an outer archive. Full manifest,
archive, identity, release, recovery and authorization checks remain required;
this helper cannot replace them. Its synthetic tests prove only the offline
contract, not artifact access, deployment or recovery capability.

## Integration and activation remain separate

Public CI supplies application evidence. A controller migration must preserve
every existing source, CI, security, privacy, tenant, dependency, live-evaluation,
release and recovery gate. Reconcile changing source heads and live release
outcomes through the release owner before freezing a candidate. Do not replace
trust constants globally, weaken checks or infer deployment authority from a
passing run. Do not copy historical commits into public history.

Establish and test protected rollback custody before the first release. A
workflow's `GITHUB_TOKEN` is repository-scoped; it must not be assumed to read
another private repository's artifacts.
[GitHub token scope](https://docs.github.com/en/actions/concepts/security/github_token).
Downloads also require repository read access and artifacts expire.
[GitHub artifact access](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts).

Historical packages, receipts, operational identifiers, approvals and raw logs
must stay in their protected store. Preserve their original provenance; do not
relabel an earlier producer or publish its package to solve access. A new
credential, trust relationship, permissions change, retention arrangement or
activation requires its exact review and authorization. This draft provisions
none of them. A final handover must establish exclusive deployment ownership,
retain a tested rollback route and verify its live result.

Before promotion, complete authenticated evidence acquisition, controller and
receipt integration, independent review, exact approvals, protected rollback
access and recovery rehearsal. No current production state or private
implementation is asserted by this public document.

## Verification

Run `npm test -- --runInBand test/publicRepositoryHandover.test.js` for the
repository/role/SHA/run/attempt/digest rejection matrix and first-release rollback
cases. Run the existing complete application, native PostgreSQL, provider-free
evaluation and package checks on the final candidate. The helper is outside the
existing explicit application package inventories. No dependencies, workflows,
credentials, permissions, required checks or application behavior change here.
