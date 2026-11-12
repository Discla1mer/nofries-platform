-- Owner decision, 12 November 2026 (issue #151, lifecycle email slice E4):
-- the dispatcher resolves a recipient at send time as account_id -> subject_key
-- -> the existing customer-subjects authority record. The outbox stores no
-- address, and starter accounts store only an email hash, so the dispatcher
-- needs to read exactly two columns of nofries.dashboard_starter_accounts.
--
-- nofries_email_dispatcher gains column-level SELECT on (account_id,
-- subject_key) and one permissive SELECT policy on that table. It gains no
-- other column (email_sha256, account_type, created_at, activated_at stay
-- unreadable), no write, and nothing on any other table. The runtime policy
-- and grants on the table are unchanged.
--
-- Forward-only. The migration ledger skips it once recorded, so a second
-- migrate is a no-op. It refuses with email_dispatcher_subject_lookup_precondition
-- if the dispatcher role or the table is missing, or the policy already exists
-- outside the ledger.
--
-- Rollback: DROP POLICY starter_accounts_email_dispatcher ON
-- nofries.dashboard_starter_accounts; REVOKE SELECT (account_id, subject_key)
-- ON nofries.dashboard_starter_accounts FROM nofries_email_dispatcher; then
-- delete its schema_migrations row.
DO $precheck$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'nofries_email_dispatcher')
        OR to_regclass('nofries.dashboard_starter_accounts') IS NULL
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'nofries'
            AND tablename = 'dashboard_starter_accounts' AND policyname = 'starter_accounts_email_dispatcher') THEN
        RAISE EXCEPTION 'email_dispatcher_subject_lookup_precondition';
    END IF;
END
$precheck$;

CREATE POLICY starter_accounts_email_dispatcher ON nofries.dashboard_starter_accounts
    FOR SELECT TO nofries_email_dispatcher
    USING (true);
GRANT SELECT (account_id, subject_key) ON nofries.dashboard_starter_accounts TO nofries_email_dispatcher;
