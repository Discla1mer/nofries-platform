# Empty-signup reset preparation

Status: prepared operator library, **not production wired or qualified**. This PR performs no production inspection, dry run, reset or rollback. Nothing in the application imports the command. Fry owns subsequent qualification and execution. The generic signup error is evidence to investigate, never permission to delete an account.

## Scope and implementation decision

`api/shared/customerSignup/guardedEmptySignupReset.js` adds a flag-driven operator command around the unchanged `createEmptySignupReset`. It uses current main's version-bound two-pointer plan, conditional deletes/restores and per-effect reconciliation. It follows #47's shared-writer exclusion and protected adoption design without importing or combining those open PRs. All new behaviour is dormant unless a trusted host supplies the ports below.

The finish line for this PR is a reviewed command, runbook and synthetic failure/recovery tests. Production activation is a separate dependency: the #16 writer-participation work, qualified #20/#47 fence binding and recovery host must exist first. Target blob leases alone cannot stop recreation of deleted keys. #47's `withReset` does not automatically resume its retained infinite lease; this PR does not invent a lease-break path. A qualified recovery host must establish prior workers have stopped and retain ownership throughout recovery.

## Explicit eligibility: every condition must hold

| Condition | Required evidence from the protected read-only inspector |
| --- | --- |
| Correct incident | Exact target correlated privately to a retained `organisation_preparation` / `signup_state_unavailable` event, support-reference ID and diagnostic release SHA. Host verifies diagnostics were live and that this is the selected target's event; a caller cannot supply evidence. |
| External ID only | Provider and subject match the trusted source binding and requested customer; the acting staff subject differs and has current reset authority. |
| One incomplete account | Valid account codec, `activation === null`, exactly one organisation slot, `kind === 'own'`; account/email/subject/tenant/org/binding/account-type match the authority and evidence. |
| Recoverable pointers | Both account and active authority pointers exist, with exact keys, ETags, version IDs and SHA-256s. Preview reads original version bodies, checks bytes/hash/codec equality. Expired authority may be removed/restored but never renewed. |
| No canonical state | Registration, canonical tenant AND organisation, SQL starter account/scopes, acceptance, binding, admission, customer content and accepted invitation are all proven absent. Any positive, unknown, malformed or failed read blocks. |
| No indexed account | Signup index reference is proven absent with complete visibility. Indexed accounts need #47's tombstone/recovery integration and are deliberately ineligible here. |
| Complete visibility | Inspector has authenticated, correctly scoped reads and checks relevant constraints/policies. An RLS-hidden row or a failed query is **unknown**, not absence. Evidence fields are an exact closed schema; `{empty:true}` is insufficient. |

This is a conservative subset of half-created signups. Missing-authority accounts are refused on current main; #47 adds that separate capability. SQL-prepared, activated, multi-organisation, revoked or existing-customer accounts are never reset here. Retained setup, claim context, invitations not accepted, legal archives, admission budgets, subject reservations, directory identities and staff records are preserved. No SQL row or organisation record is deleted.

## Trusted host contract — required before any live use

Ports are operator dependencies, not request JSON, plugins chosen by a customer, or boolean approvals. No credentials, environment loader or production CLI is added by this PR.

| Port | Contract |
| --- | --- |
| `checkAuthority(request)` | Read-only assertion returning undefined or throwing; resolve current staff identity/privilege and exact source SHA, provider, target and approved time window from trusted records. Recheck throughout execution; flags/digests do not grant authority. |
| `inspect(request)` | Read-only bounded, versioned source reads and complete dependency checks; returns `{status,target,evidence}`. `target` follows existing reset inventory. `evidence` has provider, account/tenant/org/subject IDs, incident, visibility and all eleven absence fields exported as `ABSENT`. Derive the evidence rather than accepting operator-supplied assertions. No journal/index repair, audit write or fence acquisition. |
| `inspectRecovery(request,plan)` | Reconstruct original account/authority descriptors from the exact retained versions even if active pointers are absent. Independently recheck all current dependencies and visibility; never use cached “empty” evidence. Detect replacement, source/container drift and new canonical/index state. |
| `checkWriterAdoption(request,manifest)` | Current protected assertion equivalent to #47's `readAdoption`: source, writer implementation digest/contract, instance, restore epoch, source binding, old-writer drainage, version recovery and expiry. Verify all create/replace writers participate. Bind the configured audit store, two source containers and exact coordination-key protocol to this manifest. No self-issued record or permission change. |
| `withExclusiveTarget(binding,callback)` | Exactly one awaited callback, same returned object; combine the shared creator fence and version-bound target leases. `assertCurrent` checks both. `retain` must preserve both even after process loss or partial completion failure; `complete` releases only current ownership. No superseded-holder cleanup. Host must safely resume the same retained operation, never break a lease on timeout. |
| `blobs` | Existing coordinator's bounded `readCurrent`, immutable `readVersion`, conditional `remove`, conditional create-only `restore`; confined to the two planned keys. Host must not add index or other hidden writes. |
| `audit`, `auditStoreSha256` | Separate protected immutable store. `read(key)` returns record or null; `write(key,record,{ifNoneMatch:'*'})` creates only. Match the configured store digest. Command independently reads back every intent/receipt, including a lost acknowledgement. Keep version history/provider timestamps for audit time; receipts bind the operation's original manifest, not an invented completion timestamp. |

Do not reuse #47's admin `inspect()` directly for preview: it writes an inspection audit record. Use its underlying bounded reader patterns. Do not wire only #20's target lease binding: the deleted-key recreation race remains. Existing pending operations may require a separately reviewed recovery adapter; the command cannot make an unresumable storage lease resumable.

## Reviewable preview and explicit execution

These are the **library API** calls for the future qualified operator host, not shell commands or an existing production launcher. Prepare `request` privately using the closed existing reset request schema (operation ID, reviewed source SHA, email, customer/staff subjects, provider key, created/expires times; maximum one hour). Never put email or credential material in argv, output or a PR.

```js
const command = createGuardedEmptySignupReset(qualifiedPorts);
const preview = await command.run([], { request }); // default: read only
// Preserve this exact manifest securely; independently review every effect.
const manifest = preview.manifest;
const result = await command.run(['--execute'], {
    request, manifest, confirmSha256: manifest.manifestSha256
});
```

`manifest.changes` lists the exact two active-pointer deletions, including key, ETag, version ID and content hash. `coordination` separately lists the shared control record, per-account target-fence record and exact immutable audit keys. Rollback's receipt is explicitly marked conditional on `--rollback`. Source/container/dependency/audit-store bindings and actor/target IDs are digest-bound. The private request, customer names/emails, original bodies, raw SQL/provider messages and credentials are not output. The command has no logging sink.

The preview creates no audit record, fence, lease, index update, blob or file. The host may separately preserve the returned manifest in its approved evidence store. Review the exact returned contents and digest; do not hand-edit or widen the target. Execute requires `--execute`, the full manifest, its separately confirmed digest, the same private request and all current host assertions. Recheck occurs under writer exclusion; stale evidence/ETags/versions, denied authority or absent adoption cannot be overridden.

Before the first deletion, intent is durably written and read back. Completion receipt is durably written and read back before either fence is released. Account deletion precedes authority deletion. Immutable audit records contain only operation/actor/source IDs, manifest digest, action and fixed status. No automatic batch enumeration or bulk deletion exists.

## Resume, rollback and stop conditions

Retain the original operation ID, request, manifest and digest after any lost response. Within its original validity window, invoke the same execute call: retained intent selects `inspectRecovery`, original versions and exact-effect reconciliation; already absent pointers are not deleted again. A completed receipt is an idempotent **historical result**, not a new assertion that the account is currently absent. New bytes are never removed on receipt replay.

`pending / reset_recovery_required` means keep the fences and investigate through the protected host. Unknown audit state is also pending. Do not clear ownership, generate a new operation ID, extend the manifest window, repeatedly re-inventory a partially deleted target, or infer success from a timeout. If either exclusion or receipt publication is uncertain, stop further reset work.

After expiry, destructive continuation stays refused. With current operator authority, adoption and qualified retained-fence recovery, explicitly request restoration using the original manifest:

```js
await command.run(['--execute', '--rollback'], {
    request, manifest, confirmSha256: manifest.manifestSha256
});
```

Rollback requires matching durable intent, rechecks live dependencies, and restores exact original bytes only into absent keys, account before authority. Conflicting replacement bytes stop recovery. An existing exact copy is preserved. Successful rollback is receipted before release; repetition returns the same receipt, and reset of that operation is closed. Expired authority stays expired. Source-code revert only removes this dormant tool; it does **not** restore deleted records. Blob version retention and the original manifest are mandatory recovery prerequisites.

## Evidence and integration boundary

Tests use the real reset coordinator and synthetic versioned records, fences and immutable journal. They cover zero-write preview, every absence criterion, drift, flags/digest tampering, adoption/authority denial, intent/receipt failures, lost acknowledgements, partial resume, expired-operation rollback, receipt replay and a host rejecting while its callback still awaits a fence check. These are not production writer-adoption or Azure recovery proof.

No changed file overlaps private #720's workflow, validator or pins. This branch edits only a new operator module, existing reset tests and this runbook. Integration with #20/#47 and the concurrent #16 writer work is a future compatibility/qualification dependency; do not merge their branches into this PR or edit their files here. Keep reset execution disabled until Fry has the diagnostic event, all safety prerequisites and final reviewed/qualified host.
