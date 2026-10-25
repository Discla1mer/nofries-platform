# Dormant evidence metadata persistence

IMP-002 adds `createPostgresEvidenceStore({ database })` in
`api/shared/evidenceLifecycle/postgresEvidenceStore.js`, using the explicitly
injected `withTenantTransaction` database contract. The standalone store has no
environment-based factory or HTTP endpoint. The read-only opt-in HTTP composition
is described below; no default runtime registration, credentials or live cutover
are introduced.

The store accepts **trusted internal commands**, not authenticated requests.
It authenticates no actor and grants no membership, entitlement or object access.
The request-authorised reader below establishes and rechecks those policies
within its transaction; this store alone is not a safe user-facing service. All states remain
quarantined/content-unverified. Declared hashes, content types, sizes, provenance
and governance references are metadata assertions, not proof of byte safety or
policy authorization. No byte quota is charged for a size declaration.

## Calls and results

`read({ tenantId, organisationId, artefactId })` returns the current frozen domain
state or null when the active canonical organisation has no such artefact.
`execute(command)` accepts exactly the existing domain create/append-version
command, with expectedRevision and idempotencyKey. It returns the immutable state
produced by the original operation. `reconcile(command)` only reads existing
transaction evidence and returns that same original state; absence is ambiguous.
All inputs are detached and normalized before the first asynchronous boundary.
Actor and recording time are trusted service facts supplied in the domain
command. The store does not silently substitute a clock or generate identity.

Reusing an operation ID with changed intent conflicts. Reusing it with identical
intent returns its original result, even if the artefact has since advanced.
A different operation with a stale expected revision fails. The existing domain
fingerprint excludes execution time and operation ID; receipt integrity still
binds the original recording time, actor, payload and operation ID to its exact
committed revision. A transport retry cannot rewrite those original facts.

## Storage and isolation

Migration `0007_evidence_metadata.sql` adds three tables under `nofries`:

| Table | Key | Purpose |
| --- | --- | --- |
| dashboard_evidence_revisions | tenant, organisation, artefact, revision | Immutable full domain snapshots with parent revision/hash. |
| dashboard_evidence_heads | tenant, organisation, artefact | Current revision/hash, referencing an existing snapshot. |
| dashboard_evidence_receipts | tenant, organisation, artefact, operation | Original command and append-only audit declaration, bound to one revision/hash. |

Every table has forced tenant RLS. Composite foreign keys bind artefacts to
canonical dashboard organisations and receipts/heads to exact versions. Runtime
gets SELECT/INSERT on immutable tables and SELECT/INSERT/UPDATE on heads; no
DELETE or TRUNCATE. Runtime role and schema/table ownership are checked against
PostgreSQL before each operation. SUPERUSER, BYPASSRLS, inherited owner authority,
missing FORCE RLS, missing runtime membership, wrong tenant context or mutable
history privileges fail closed. Role checks do not claim protection from a
malicious database owner or trusted host.

Every operation locks the canonical tenant then selected organisation in that
order, before loading evidence. The parent lock serializes absent-head creates
and prevents authority mutations using the dashboard lock protocol from racing
owner reads. This deliberately serializes an organisation's evidence operations
at tenant level. The store rehydrates strict canonical records from SQL; caller
snapshots cannot substitute ownership. Suspended/closed owners deny reads,
mutations and receipt replay. Member/entitlement authorisation for reads belongs
to the request-bound composition below; authenticated mutation access is deferred.

Every read validates complete history and receipts, with at most 128 revisions
(the existing domain cap). It reconstructs each finite domain transition from
the original command, verifies canonical decoded-JSON hashes, every parent link,
head inclusion and exact audit fields. Orphan snapshots, absent receipts,
extra/truncated history, mixed restore points or tampered events fail closed.
Canonical domain state remains bounded at 262144 UTF-8 bytes. SQL permits a
separate finite 2097152-byte JSONB text representation because JSONB whitespace
and escaping must not silently shrink that public bound. Canonical opaque Unicode
identifiers retain the existing 180 UTF-16-unit domain limit.

## Transaction evidence and recovery

The version, head and receipt/audit declaration commit together. Audit includes
actor, time, exact owner, artefact, operation, revision and state digest.
`correlationId` is SHA-256 of canonical JSON
`["nofries:evidence-correlation:v1", tenantId, organisationId, artefactId]`;
`causationId` hashes
`["nofries:evidence-causation:v1", tenantId, organisationId, artefactId, idempotencyKey]`.
These deterministic internal bindings correlate an artefact's metadata lineage
and identify the causing operation without adding an untrusted trace field or
exposing metadata content. They are not external distributed-trace credentials.
No external effect exists, so this slice needs no outbox or provider call.

On an uncertain COMMIT/rollback response, execute attempts one fresh read-only
reconciliation. That path never inserts, updates, retries a missing effect or
refreshes expected revisions. Missing or inconsistent evidence remains
`evidence_store_commit_ambiguous`. Valid receipts from older operations return
only when complete retained history proves the current head includes the effect.
This is synthetic logical recovery evidence, not Azure backup/PITR verification.

Source rollback leaves unused additive tables. No fallback to stale Blob is
introduced. Runtime activation, migration application, bytes/scanner/storage
policy, download capabilities, legal-hold release, erasure and restore-time
deletion replay remain separate governed work. Immutable grants here do not
implement the eventual privileged retention worker.

## Evidence limits

Run contract tests with `test/evidencePostgresStore.test.js`. Real PostgreSQL
cases are registered from `test/postgresMigration.test.js`, therefore included
in the unchanged `npm run test:postgres` gate. Local mock tests cannot prove SQL
isolation, locks or rollback. The current author environment has no supported
local engine; hosted CI's existing synthetic PostgreSQL service must execute
those cases before source acceptance. All full IMP-002 acceptance checks remain
open; this dormant slice supplies only part of AC-01.

## Request-authorised metadata reader

`createEvidenceMetadataService({ repository, requestContext }).read(request,
{ artefactId })` accepts only an artefact selector. The genuine branded request
context supplies tenant, organisation and actor. The service exposes no write,
file, URL, upload, download or scanning operation.

`createPostgresEvidenceMetadataRepository({ database, clock, audit })` supplies
`readEvidenceMetadata(context, selector)`. It obtains the canonical authority
snapshot with UPDATE locks before calling the existing evidence store through
an adapter bound to that same transaction. Current membership, evidence.read,
product and evidence-module eligibility, feature flags and scoped fractional
advisory purchase/assignment must pass. The same locked facts are re-evaluated
at the current monotonic time after the read and after its audit write. A missing
artefact returns a bounded not-found error only after authorisation passes.

The returned immutable metadata includes version, declared content, classification
and quarantine status. Actor identifiers and source/policy/governance references
are omitted. Declared content hashes, MIME types and byte counts are unverified
assertions; this reader does not establish byte safety, quotas or legal authority.

The audit dependency must be paired with the transaction by trusted composition.
The standalone repository must not be installed as a user-facing endpoint.
The trusted runtime binding described below supplies request lifetime and final
authority checks. The service alone installs no route; the opt-in HTTP composition
uses that binding without enabling default installation or live PostgreSQL. Full IMP-002 acceptance
remains open for separately governed Blob, scan, retention and release work.

## Trusted request guard integration

`createDashboardResourceRuntime(options).forRequest(request, transport)` now
returns an additional read-only `evidence` facade. Its sole method is
`readEvidenceMetadata(context, { artefactId })`; it requires the exact branded
context belonging to that request. Compose the metadata service with this
facade and its paired `requestContext` resolver. The opt-in HTTP factory below
uses this facade; default application construction exposes no evidence endpoint.

The fixed `evidence.read` operation constructs the evidence repository with the
same guarded database, clock and audit pair. Canonical authority uses UPDATE
locks from the outset. The guard rechecks runtime instance, session, identity
binding, admission, retained membership lineage and current evidence policy
before commit, after transaction settlement and at disclosure. Expiry or
revocation withholds metadata. The audit allowlist accepts only evidence.read /
evidence / succeeded for this operation. An uncertain COMMIT response returns
unavailable with no metadata and no automatic replay; a durable audit may exist
and must not be described as a successfully delivered response.

This runtime facade alone does not install HTTP handlers, turn on PostgreSQL or
admit customers. Existing release, runtime installation and full evidence-file
acceptance remain mandatory.

## Opt-in HTTP metadata composition

The existing explicit `createDashboardRuntimeHandlers` factory supports
`GET /api/dashboard/evidence?artefactId=<encoded ID>`. Encode the opaque artefact
ID once using `encodeURIComponent`; the handler accepts exactly that canonical
encoding and exactly one `artefactId` selector. Tenant, organisation and actor
come from the authenticated request binding. The request requires exactly one
`X-NoFries-Dashboard-Generation` header matching the active selection. Request
bodies, extra selectors, duplicate keys and alternative encodings are rejected.

The handler composes `createEvidenceMetadataService` with the request-bound
runtime facade and returns its bounded quarantined metadata projection. Existing
host deadlines, session/admission and current evidence permission checks,
transaction-bound audit and final disclosure checks remain in force. Errors are
restricted to known status/code pairs; logs use the fixed category `evidence`
without the selector, URL, identity or driver/provider details. Responses retain
the existing private API security headers.

This adds only an opt-in source composition. Default application construction
still installs no dashboard runtime, and no environment factory, live PostgreSQL
selection, deployment or customer admission is activated. It adds no evidence
write, bytes, upload/download, scanning or retention capability. Full IMP-002
acceptance and release-dependent activation remain separate gates.
