-- Staff-initiated account reset and delete (Joel, 14 Nov 2026).
--
-- A new NOLOGIN capability, nofries_account_wipe, may read and delete rows of
-- exactly one account per transaction, selected by transaction-local settings:
--   nofries.wipe_tenant_id   one organisation tenant of the account
--   nofries.wipe_account_id  the starter account
--   nofries.wipe_subject_key the account's sign-in subject
-- It cannot insert or update anything, owns nothing, and is granted to no
-- login here. A login gets it only by a separate, owner-approved production
-- grant. The staff console sets the settings, deletes in a fixed order and
-- commits once (api/shared/dashboardAdmin/accountWipeRepository.js).
--
-- No other role's privileges or policies change. Funnel daily counts hold no
-- account data and are not touched.

DO $role$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nofries_account_wipe') THEN
        CREATE ROLE nofries_account_wipe NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
    ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nofries_account_wipe' AND
        (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
        RAISE EXCEPTION 'account_wipe_role_configuration_invalid';
    END IF;
END
$role$;

-- A pre-existing role must be as restricted as a new one: no members other
-- than the creator's ADMIN-only edge, no ownership and no table privileges.
DO $capability_baseline$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_roles capability
        WHERE capability.rolname = 'nofries_account_wipe'
          AND (EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = capability.oid)
            OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = capability.oid
                AND (m.set_option OR m.inherit_option OR m.member <> (SELECT oid FROM pg_roles WHERE rolname = current_user)))
            OR has_schema_privilege(capability.oid, 'nofries', 'CREATE')
            OR EXISTS (SELECT 1 FROM pg_class relation JOIN pg_namespace ns ON ns.oid = relation.relnamespace
                WHERE ns.nspname = 'nofries' AND (relation.relowner = capability.oid
                    OR relation.relkind IN ('r','p','v','m','f')
                    AND (has_table_privilege(capability.oid, relation.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
                        OR has_any_column_privilege(capability.oid, relation.oid, 'INSERT,UPDATE,REFERENCES')))))
    ) THEN
        RAISE EXCEPTION 'account_wipe_role_baseline_invalid';
    END IF;
END
$capability_baseline$;
GRANT USAGE ON SCHEMA nofries TO nofries_account_wipe;

-- Rows scoped by an organisation tenant.
DO $tenant_scoped$
DECLARE
    item text;
BEGIN
    FOREACH item IN ARRAY ARRAY[
        'dashboard_tenants', 'dashboard_organisations', 'dashboard_membership_states', 'dashboard_entitlement_states',
        'dashboard_feature_flags', 'dashboard_advisor_assignments', 'dashboard_usage', 'dashboard_operation_receipts',
        'dashboard_ncsc_assessment_revisions', 'dashboard_ncsc_assessments', 'dashboard_ncsc_assessment_receipts',
        'dashboard_admission_authorities', 'dashboard_admission_decisions', 'dashboard_onboarding_cases',
        'dashboard_onboarding_proofs', 'dashboard_onboarding_decisions', 'dashboard_identity_bindings',
        'dashboard_runtime_receipts', 'dashboard_runtime_audit', 'dashboard_evidence_revisions', 'dashboard_evidence_heads',
        'dashboard_evidence_receipts', 'signup_acceptance_receipts', 'dashboard_starter_scopes',
        'dashboard_improvement_revisions', 'dashboard_improvement_heads', 'email_outbox']
    LOOP
        EXECUTE format('GRANT SELECT, DELETE ON nofries.%I TO nofries_account_wipe', item);
        EXECUTE format('CREATE POLICY %I ON nofries.%I FOR ALL TO nofries_account_wipe '
            'USING (tenant_id::text = NULLIF(current_setting(''nofries.wipe_tenant_id'', true), '''')) WITH CHECK (false)',
            item || '_account_wipe', item);
    END LOOP;
END
$tenant_scoped$;

-- Rows scoped by the starter account.
GRANT SELECT, DELETE ON nofries.dashboard_starter_accounts, nofries.email_preferences TO nofries_account_wipe;
CREATE POLICY dashboard_starter_accounts_account_wipe ON nofries.dashboard_starter_accounts FOR ALL TO nofries_account_wipe
    USING (account_id::text = NULLIF(current_setting('nofries.wipe_account_id', true), '')
        AND subject_key::text = NULLIF(current_setting('nofries.wipe_subject_key', true), ''))
    WITH CHECK (false);
CREATE POLICY email_preferences_account_wipe ON nofries.email_preferences FOR ALL TO nofries_account_wipe
    USING (account_id::text = NULLIF(current_setting('nofries.wipe_account_id', true), ''))
    WITH CHECK (false);

-- Rows scoped by the sign-in subject.
GRANT SELECT, DELETE ON nofries.dashboard_session_gates, nofries.signup_registrations TO nofries_account_wipe;
CREATE POLICY dashboard_session_gates_account_wipe ON nofries.dashboard_session_gates FOR ALL TO nofries_account_wipe
    USING (subject_key::text = NULLIF(current_setting('nofries.wipe_subject_key', true), '')
        AND kind = 'customer')
    WITH CHECK (false);
CREATE POLICY signup_registrations_account_wipe ON nofries.signup_registrations FOR ALL TO nofries_account_wipe
    USING (subject_key::text = NULLIF(current_setting('nofries.wipe_subject_key', true), ''))
    WITH CHECK (false);
