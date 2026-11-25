-- #584: the staff funnel reads completion times from the existing free-check
-- revisions. The purpose role can only read eligible rows. SET-only login
-- membership (WITH SET TRUE, INHERIT FALSE) is a separate owner operation.
-- The payload column contains answers as well as timestamps: the row policy
-- below limits eligible revisions but cannot mask JSON keys within each row.
--
-- Rollback: first revoke any runtime login membership to disable the panel's
-- timing query. Existing daily counts continue. In the target database:
--   DROP POLICY completion_stats_select ON nofries.dashboard_ncsc_assessment_revisions;
--   REVOKE SELECT (tenant_id, organisation_id, assessment_id, revision, payload)
--     ON nofries.dashboard_ncsc_assessment_revisions FROM nofries_completion_stats_reader;
--   REVOKE USAGE ON SCHEMA nofries FROM nofries_completion_stats_reader;
-- Drop the cluster role only after confirming it has no remaining dependencies
-- or memberships in other databases. Reconcile only 0035's schema_migrations
-- row after a full rollback and before reapplying. No assessment rows change.
DO $precheck$
BEGIN
    IF to_regclass('nofries.dashboard_ncsc_assessment_revisions') IS NULL THEN
        RAISE EXCEPTION 'completion_stats_reader_precondition';
    END IF;
END
$precheck$;

DO $role$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nofries_completion_stats_reader') THEN
        CREATE ROLE nofries_completion_stats_reader NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
    ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nofries_completion_stats_reader' AND
        (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
        RAISE EXCEPTION 'completion_stats_reader_role_configuration_invalid';
    END IF;
END
$role$;

-- A pre-existing role must be as restricted as a new one: no members other
-- than the creator's ADMIN-only edge, no memberships, no ownership and no
-- privileges on any relation in the schema.
DO $capability_baseline$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_roles capability
        WHERE capability.rolname = 'nofries_completion_stats_reader'
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
        RAISE EXCEPTION 'completion_stats_reader_role_baseline_invalid';
    END IF;
END
$capability_baseline$;

GRANT USAGE ON SCHEMA nofries TO nofries_completion_stats_reader;
REVOKE ALL ON nofries.dashboard_ncsc_assessment_revisions FROM nofries_completion_stats_reader;
GRANT SELECT (tenant_id, organisation_id, assessment_id, revision, payload)
    ON nofries.dashboard_ncsc_assessment_revisions TO nofries_completion_stats_reader;
CREATE POLICY completion_stats_select ON nofries.dashboard_ncsc_assessment_revisions
    FOR SELECT TO nofries_completion_stats_reader USING (
        (payload#>>'{state,createdAt}')::timestamptz BETWEEN now() - interval '90 days' AND now()
        AND ((payload#>>'{state,submission,revision}') IS NULL
            OR revision <= (payload#>>'{state,submission,revision}')::integer)
    );
