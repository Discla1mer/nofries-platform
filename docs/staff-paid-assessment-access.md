# Grant or revoke one paid assessment

**Paid access is off by default (`NOFRIES_PAID_FRAMEWORKS_ENABLED`). Rehearse only with fictional accounts on disposable loopback.** Each change covers one organisation, current product and assessment version.

## Before you start

Sign in as a workforce admin on both staff allowlists, with a current operator session. Staff console, account lookup, account actions and `NOFRIES_PAID_FRAMEWORKS_ENABLED` must each be exactly `true` (paid defaults off). The customer needs active membership and product, enabled dashboard and Cyber Security module, a current session and assessment permission. [Staff console settings](staff-admin.md#turn-it-on)

Migrations 0028–0034 are applied, and the application login holds `nofries_framework_operator` SET-only (SET true, INHERIT false, ADMIN false). Turning paid assessments on still needs owner approval. [Approval order and checks](https://github.com/Discla1mer/nofries-platform/issues/500#issuecomment-7024473266)

## In the staff console

1. In `/operator`, look up the account by email. Choose **Show dashboard access** on the intended organisation’s row. Under **Paid assessment access**, match the email, organisation name and **organisation ID** to the request.
2. Choose **Grant** or **Revoke** and the exact assessment. Both use module `cyber_security`.

   | Assessment | Profile ID | Version |
   | --- | --- | --- |
   | NIST CSF 2.0 | `nf-nist-csf-2-0-core` | `2026-09-08.1` |
   | ISO 27001 readiness self-assessment | `nf-iso-27001-2022-readiness` | `2026-11-19.1` |

3. Give a business reason (240 characters maximum, no personal or payment details). Type the account email and choose **Approve change**. Check the action, profile ID, version and organisation ID in the confirmation.
4. Choose **Apply approved change** within 15 minutes in the same session. Look for **Recorded grant** or **Recorded revoke**. Approval is single-use, without fresh MFA or a second approver.

## Verify with a fictional customer

Use a separate customer session in the selected organisation. Open the Cyber Security assessment picker after each change.

| Stage | What to check |
| --- | --- |
| Before a first grant | NCSC is visible. The paid profile is absent for an NCSC-only customer, and its direct link is refused. |
| After grant | The profile appears. Open it, save an answer and note the assessment ID. Grant activates its organisation profile switch if needed. |
| After revoke | The profile disappears. Reopen and save are denied, as are collection, questionnaire and results assets. Saved answers are retained. |
| After regrant | With the same product, profile and version, reopen the same assessment ID and check the saved answer. |

Repeat for both profiles. Check NCSC still opens and a second, unentitled organisation has no paid selection.

**Check the private staff record.** Get `operationId` from the local approval response. Under `dashboard-admin-framework-access/<operationId>/`, match `approval.json`, `attempt.json` and `outcome.json` to the staff subject, organisation, profile/version, action and the reason's SHA-256 digest. The plaintext reason is not stored. Expect `succeeded`. **Outcome unconfirmed?** Stop. SQL may have committed before the success record. Reconcile the same operation ID in `nofries.dashboard_paid_framework_access` with the available private records before any retry.
