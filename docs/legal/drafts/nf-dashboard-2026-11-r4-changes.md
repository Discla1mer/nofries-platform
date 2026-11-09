# nf-dashboard-2026-11-r4: changes from r3

**Approved by the owner on 9 November 2026. Not legal advice.** r2 and r3
stay exactly as approved, so their pinned digests and every accepted
agreement are unchanged. r4 applies only to schedules issued under the plan
`nf-starter-2026-11-r3`, which pins its text by SHA-256
(`737a94879458d795e4a8b3296773e4b995e213d54e9f7d11d93a3c2b290a2703`). That plan
is in source but is not selected by default. See "Turning it on" below.

## Why

New Zealand's unfair contract terms rules (Fair Trading Act 1986, s 26A and
ss 46H–46M) cover standard form small trade contracts as well as consumer
contracts. A term can be declared unfair if it causes a significant
imbalance in the parties' rights, is not reasonably necessary to protect the
supplier's legitimate interests, and would cause detriment if relied on. The
dashboard agreement is a standard form contract accepted online, usually by
small businesses. Its NZ$100 cap for complimentary access also capped
claims for breach of confidentiality, privacy and security obligations. That
is the term most open to challenge, and it alarmed a test participant who
read it.

## Changes

1. **Complimentary cap (cl 12.3(b), and the liability notice):** NZ$100 to
   NZ$1,000 a contract year.
2. **New cl 12.3(c):** claims for breach of clause 4 (confidentiality) or
   clause 5 (privacy and service providers) have a separate limit: the
   greater of NZ$10,000 and the general limit. It is not added on top of the
   general limit for the same event.
3. **cl 12.7:** states that nothing in the agreement limits the unfair contract
   terms provisions, or individuals' rights under the Privacy Act 2020.
4. **Trial clause:** names the plan `nf-starter-2026-11-r3` in place of
   `nf-starter-2026-10-r2`. The trial itself is the same.
5. **Same-year sentence in cl 12.3:** the single complimentary amount reads
   NZ$1,000 to match (b).

Unchanged, and already consistent with NZ law:
- The CGA s 43 and FTA s 5D business-to-business exclusions, with their
  "in trade, in writing, fair and reasonable" conditions (cl 12.6).
- The carve-outs for fraud, deliberate misconduct and liability that cannot
  lawfully be limited (cl 12.5).
- Privacy breach notification "when required by law" (cl 5, Privacy Act 2020
  Part 6).
- The retained copy (cl 14).

## The plan nf-starter-2026-11-r3

It is the three-month complimentary trial with the same price (NZ$0),
period, limits and data rules as `nf-starter-2026-10-r2`. Its schedule
differs in three lines:

- `Included: Overview and manual Cyber Security assessment. The Improvement
  Plan is included when it is released.` The old line listed the Improvement
  Plan as included while it is still "Coming next", which risks Fair Trading
  Act ss 9 and 13.
- `Privacy notice: privacy.html, 9 November 2026.`
- `Agreement: nf-dashboard-2026-11-r4` with its digest.

Schedules already issued under the two earlier plans compile to the same
bytes as before, so setups in progress and accepted agreements still verify.

## Turning it on

Source alone does not change what customers are offered. A release needs
all of these, in this order:

1. A New Zealand lawyer reviews r4. The figures NZ$1,000 and NZ$10,000 are
   recommendations; check them against insurance cover. If the text changes,
   it needs a new version and digest, not an edit to r4.
2. Apply `database/proposals/customer_starter_plan_r3.sql` as a numbered
   migration. It has not been run against PostgreSQL in this branch; run
   it on a disposable database first.
3. Archive the exact r4 text in the customer terms store under its digest.
4. Set the trusted launcher's trial plan to `nf-starter-2026-11-r3`.
5. Update `/terms.html` to the r4 wording at the same release.
