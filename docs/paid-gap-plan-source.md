# Held proposal for Improvement Plan actions from paid gaps

Migration 0032 depends on #502 (0030). It is a sibling of the 0031 issued-report and 0033 scope proposals. Keep the current NCSC plan read and write paths in service. The held schema supplies storage for a later, separately reviewed paid plan writer.

## What an action refers to

One selected gap starts one plan with one action. It uses the existing plan head, revision chain, operation receipt and assignment command with an owner and a due date. A generated plan revision binds the tenant, organisation, profile and version, assessment ID, submitted revision, record SHA-256 and question ID. Module identity comes from 0030’s fixed cyber security constraint. The JSON generation command also carries the source identifiers so they participate in its existing payload digest. Later revisions must keep the same source.

The foreign key requires the same record digest in that exact scope. An insert also checks the recorded submission revision and the single matching answer. For the two proposed publication versions the allowed options are the gaps in #503, including NIST answers awaiting confirmation. A recorded ISO exclusion is ineligible. Legacy revisions retain the original NCSC foreign key semantics, revision range, JSON payloads and replay chain.

## Access and recovery

The runtime role cannot read or create paid plan revisions or their heads. Existing staff reset and delete remove plan heads and revisions before the referenced paid histories. The migration adds no role or privilege. The native fixtures seed the exact product grant and a paid assignment in a disposable database. Staff reset and delete are exercised against real rows with a second account retained.

A future writer must verify the exact-true paid flag, selected session, current organisation and matching active entitlement, the publication and its sealed submission, the selected gap, Improvement Plan write authority and the existing owner and due-date rules. Derive one stable plan identity for the source gap and reuse the existing command idempotency and transaction lock. Review paid access, list isolation, replay and disclosure before admitting paid rows to any runtime policy. No paid endpoint or action creation is activated by this draft.

## Apply and rollback decision

The generated legacy key rewrites the plan revision table. Foreign key validation and the new digest index can take locks. Size both tables and rehearse lock duration on a restored copy before deciding whether to apply. Preserve a tested backup and the current migration ledger. A logical restore inserts the framework source before its plan and lets PostgreSQL regenerate the derived NCSC key. Compare the full restored rows, including that key. Compose the three sibling proposals’ catalogue assertions and child-before-parent wipe ordering on the final base.

Before any paid row exists, rehearse the held inverse in one transaction as the migration owner. It locks the plan and paid history tables, checks for retained paid rows, restores the original NCSC constraints and leaves the data intact. If any paid row exists, the inverse aborts. Keep access closed and obtain a retention and recovery decision. Use a separately reviewed forward repair for a recorded migration or restore the pre-change backup, including its ledger. Do not edit an applied migration or delete retained links to make rollback pass. [Held inverse](../database/proposals/0032-paid-gap-sources-rollback.sql)
