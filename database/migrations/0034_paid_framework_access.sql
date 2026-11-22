-- Held for separate approval. A decision applies to one product in one organisation.
-- The write capability is granted to no login here. The customer runtime can read
-- only the decision, never the staff subject, reason digest or operation ID.
DO $precheck$
BEGIN
    IF to_regclass('nofries.dashboard_paid_framework_access') IS NOT NULL THEN
        RAISE EXCEPTION 'paid_framework_access_already_exists';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nofries_framework_operator') THEN
        CREATE ROLE nofries_framework_operator NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS
            NOCREATEDB NOCREATEROLE NOREPLICATION;
    ELSIF EXISTS (SELECT FROM pg_roles WHERE rolname = 'nofries_framework_operator' AND
        (rolcanlogin OR rolinherit OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication))
        OR EXISTS (SELECT FROM pg_auth_members WHERE member = 'nofries_framework_operator'::regrole) THEN
        RAISE EXCEPTION 'paid_framework_operator_configuration_invalid';
    END IF;
END
$precheck$;

DO $capability_baseline$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_roles capability
        WHERE capability.rolname = 'nofries_framework_operator'
          AND (EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = capability.oid)
            OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = capability.oid
                AND (m.set_option OR m.inherit_option OR m.member <> (SELECT oid FROM pg_roles WHERE rolname = current_user)))
            OR has_schema_privilege(capability.oid, 'nofries', 'CREATE')
            OR EXISTS (SELECT 1 FROM pg_class relation JOIN pg_namespace ns ON ns.oid = relation.relnamespace
                WHERE ns.nspname = 'nofries' AND (relation.relowner = capability.oid
                    OR relation.relkind IN ('r','p','v','m','f')
                    AND (has_table_privilege(capability.oid, relation.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
                        OR has_any_column_privilege(capability.oid, relation.oid, 'SELECT,INSERT,UPDATE,REFERENCES')))))
    ) THEN
        RAISE EXCEPTION 'paid_framework_operator_baseline_invalid';
    END IF;
END
$capability_baseline$;

CREATE TABLE nofries.dashboard_paid_framework_access (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    product_grant_id text NOT NULL CHECK (length(product_grant_id) BETWEEN 1 AND 120),
    module_id text NOT NULL CHECK (module_id = 'cyber_security'),
    profile_id text NOT NULL,
    version text NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    granted boolean NOT NULL,
    operation_id uuid NOT NULL,
    operator_subject text NOT NULL CHECK (operator_subject ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    reason_sha256 text NOT NULL CHECK (reason_sha256 ~ '^[0-9a-f]{64}$'),
    PRIMARY KEY (tenant_id, organisation_id, product_grant_id, module_id, profile_id, version, revision),
    UNIQUE (tenant_id, organisation_id, operation_id),
    FOREIGN KEY (tenant_id, organisation_id) REFERENCES nofries.dashboard_organisations
        (tenant_id, organisation_id) ON DELETE RESTRICT,
    CHECK ((profile_id, version) IN (('nf-nist-csf-2-0-core', '2026-09-08.1'),
        ('nf-iso-27001-2022-readiness', '2026-11-19.1')))
);
ALTER TABLE nofries.dashboard_paid_framework_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_paid_framework_access FORCE ROW LEVEL SECURITY;
CREATE POLICY paid_framework_read ON nofries.dashboard_paid_framework_access
    FOR SELECT TO nofries_runtime, nofries_framework_operator
    USING (tenant_id = nullif(current_setting('nofries.tenant_id', true), '')
        AND organisation_id = nullif(current_setting('nofries.organisation_id', true), ''));
CREATE POLICY paid_framework_append ON nofries.dashboard_paid_framework_access
    FOR INSERT TO nofries_framework_operator
    WITH CHECK (tenant_id = nullif(current_setting('nofries.tenant_id', true), '')
        AND organisation_id = nullif(current_setting('nofries.organisation_id', true), '')
        AND operator_subject = nullif(current_setting('nofries.subject_key', true), ''));
CREATE POLICY paid_framework_account_wipe ON nofries.dashboard_paid_framework_access
    FOR ALL TO nofries_account_wipe
    USING (tenant_id = nullif(current_setting('nofries.wipe_tenant_id', true), '')) WITH CHECK (false);

REVOKE ALL ON nofries.dashboard_paid_framework_access FROM PUBLIC, nofries_runtime, nofries_account_wipe, nofries_framework_operator;
GRANT USAGE ON SCHEMA nofries TO nofries_framework_operator;
GRANT SELECT (tenant_id, organisation_id, product_grant_id, module_id, profile_id, version, revision, granted)
    ON nofries.dashboard_paid_framework_access TO nofries_runtime;
GRANT SELECT, INSERT ON nofries.dashboard_paid_framework_access TO nofries_framework_operator;
GRANT SELECT, DELETE ON nofries.dashboard_paid_framework_access TO nofries_account_wipe;

-- Reset preserves paid access and revocations. Account deletion removes its decisions.
-- Rollback: disable paid access and the staff control first. Retain the signed-off
-- history and external staff approval records under the retention policy. Removing
-- revocations while serving aggregate grants could re-enable access. Once all
-- consumers are withdrawn, drop the table, remove this migration's ledger entry and
-- revoke the capability's schema usage. Drop the role only after checking all
-- databases and removing any separately authorised login membership.
