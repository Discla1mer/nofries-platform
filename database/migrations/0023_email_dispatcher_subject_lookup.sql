-- Lifecycle email slice E4 (Refs #151): the dispatcher resolves a recipient at send time as account_id -> subject_key
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
-- outside the ledger, and with email_dispatcher_role_baseline_invalid if the
-- role has drifted from 0021's baseline (members, ownership or other grants).
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

-- Re-assert 0021's capability baseline before widening it: still no members
-- (only the PostgreSQL 17 creator's ADMIN-only edge), no ownership, no schema
-- CREATE and no privilege on any nofries relation but the outbox and preferences.
DO $capability_baseline$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_roles capability
        WHERE capability.rolname = 'nofries_email_dispatcher'
          AND (capability.rolcanlogin OR capability.rolsuper OR capability.rolbypassrls OR capability.rolinherit
            OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = capability.oid)
            OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = capability.oid
                AND (m.set_option OR m.inherit_option OR m.member <> (SELECT oid FROM pg_roles WHERE rolname = current_user)))
            OR has_schema_privilege(capability.oid, 'nofries', 'CREATE')
            OR EXISTS (SELECT 1 FROM pg_class relation JOIN pg_namespace ns ON ns.oid = relation.relnamespace
                WHERE ns.nspname = 'nofries' AND (relation.relowner = capability.oid
                    OR relation.relkind IN ('r','p','v','m','f')
                    AND relation.relname NOT IN ('email_outbox','email_preferences')
                    AND (has_table_privilege(capability.oid, relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
                        OR has_any_column_privilege(capability.oid, relation.oid, 'SELECT,INSERT,UPDATE,REFERENCES')))))
    ) THEN
        RAISE EXCEPTION 'email_dispatcher_role_baseline_invalid';
    END IF;
END
$capability_baseline$;

CREATE POLICY starter_accounts_email_dispatcher ON nofries.dashboard_starter_accounts
    FOR SELECT TO nofries_email_dispatcher
    USING (true);
GRANT SELECT (account_id, subject_key) ON nofries.dashboard_starter_accounts TO nofries_email_dispatcher;
