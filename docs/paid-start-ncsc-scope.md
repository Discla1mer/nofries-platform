# Held proposal for an explicit NCSC source at paid start

An entitled organisation could choose **Use this submitted assessment’s scope** when starting NIST CSF or an ISO 27001 readiness self-assessment. The choice includes the NCSC assessment ID, submitted revision, revision digest and captured scope digest. Without a choice, the paid assessment starts as it does today. Both paths start with zero answers.

## Storage and erasure

Migration 0033 depends on 0030 in #502. Four nullable columns on the immutable paid creation row store the choice. The paid primary key already binds tenant, organisation, paid profile/version and assessment. A composite foreign key to the existing NCSC revision includes both owner IDs and its digest. The source scope digest binds the NCSC owner, assessment, capture and body. The insert trigger checks the runtime’s selected owner and subject, the submitted source and its recorded scope against the paid scope. Both the digest and complete scope body must match. Reusing identical words across assessments or clients cannot create this link.

Only a created revision zero with empty responses and no submission can carry a selection. Later revisions read it from revision zero. Existing records and a start without a choice keep all four columns null. No historical record is linked retrospectively. 0033 adds no role, table grant, backfill or NCSC write. The staff wipe already locks and deletes paid history before NCSC history. Removing the paid row removes its binding in the same transaction.

## Contract for the later serving change

1. Under the exact server flag and current paid tuple, verify the selected tenant, organisation, session generation and authority for **both** the target write and the NCSC source read. Accept only an explicit source choice from the user. Keep owner, actor and target profile server-selected.
2. In the paid create transaction, use the existing NCSC `readHead` and `readHistory` with the selected organisation’s aggregate. Verify the submitted seal, revision, digest and scope digest against the choice. Derive the paid scope from the verified source. Reject an invalid explicit choice with a data-free refusal so the user can choose again. An ordinary unbound start remains available.
3. Include the explicit choice in the canonical paid start intent. Insert its four values alongside the hashed, empty paid record in the same statement. An identical retry returns the original start. A changed source with the same idempotency key conflicts. A save or resume cannot add or replace a choice.
4. On a suggestion read, reauthorise both resources and verify the binding on paid revision zero, the current paid scope and the retained NCSC history. On missing or failed proof, show nothing. Use only the reviewed publication pairs and partial mappings in #508/#511. Hints say “Needs confirmation”. Only the user’s own answer can enter paid progress or scoring. The database checks structure and relationships. The NCSC history reader verifies the canonical digest and reconstructs the seal.

The migration draft has no serving or picker change. #507, #508, #509 and #511 need a separately reviewed integration before any user can choose a source or see a hint. Review the data, entitlement and session boundaries independently. #500 tracks the separate 0031 and 0032 proposals and the shared 0028–0030 decision.

## Rollback

Withdraw the selecting writer and suggestion reader first. Leaving 0033 in place preserves retained choices, the existing free/paid starts and staff erasure. Once retention and removal of the choices have been approved, remove the trigger and its function, the two named constraints, then the four nullable columns in a transaction. Removing columns destroys the recorded choices. Keep 0030 and its wipe path for as long as any paid history is retained. The proposal runs only on disposable test databases until separately authorised.
