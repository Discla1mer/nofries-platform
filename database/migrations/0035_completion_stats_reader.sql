-- #584: staff may read one cohort aggregate. A separate NOLOGIN view owner
-- reads the five source columns under forced RLS. No login receives that role.
-- Only the reader may be granted separately WITH SET TRUE, INHERIT FALSE.
--
-- Rollback: revoke any reader login membership first. Drop the view
-- nofries.free_check_completion_stats, then drop policy completion_stats_select
-- on nofries.dashboard_ncsc_assessment_revisions. Revoke the five column
-- privileges below from the view owner and schema USAGE from both roles.
-- Drop the roles once unused across databases. Reconcile only the 0035
-- schema_migrations entry after full rollback and before reapplying.
-- The migration and rollback do not modify assessment rows.
DO $precheck$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_class WHERE oid=to_regclass('nofries.dashboard_ncsc_assessment_revisions')
        AND relrowsecurity AND relforcerowsecurity) THEN
        RAISE EXCEPTION 'completion_stats_reader_precondition';
    END IF;
END
$precheck$;

DO $role$
DECLARE capability_name text;
BEGIN
    FOREACH capability_name IN ARRAY ARRAY['nofries_completion_stats_reader','nofries_completion_stats_owner'] LOOP
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=capability_name) THEN
            EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION', capability_name);
        ELSIF EXISTS (SELECT FROM pg_roles WHERE rolname=capability_name AND
            (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
            RAISE EXCEPTION 'completion_stats_role_configuration_invalid';
        END IF;
    END LOOP;
END
$role$;

-- A pre-existing role must be as restricted as a new one: no members other
-- than the creator's ADMIN-only edge, no memberships, no ownership and no
-- privileges on any relation in the schema.
DO $capability_baseline$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_roles capability
        WHERE capability.rolname IN ('nofries_completion_stats_reader','nofries_completion_stats_owner')
          AND (EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = capability.oid)
            OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = capability.oid
                AND (m.set_option OR m.inherit_option OR m.member <> (SELECT oid FROM pg_roles WHERE rolname = current_user)))
            OR (capability.rolname = 'nofries_completion_stats_owner' AND EXISTS (
                SELECT FROM pg_auth_members m JOIN pg_roles member_role ON member_role.oid=m.member
                WHERE m.roleid=capability.oid AND member_role.rolcanlogin))
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

GRANT USAGE ON SCHEMA nofries TO nofries_completion_stats_reader, nofries_completion_stats_owner;
REVOKE ALL ON nofries.dashboard_ncsc_assessment_revisions FROM nofries_completion_stats_reader;
GRANT SELECT (tenant_id, organisation_id, assessment_id, revision, payload)
    ON nofries.dashboard_ncsc_assessment_revisions TO nofries_completion_stats_owner;
CREATE POLICY completion_stats_select ON nofries.dashboard_ncsc_assessment_revisions
    FOR SELECT TO nofries_completion_stats_owner USING (
        (payload#>>'{state,createdAt}')::timestamptz BETWEEN now() - interval '90 days' AND now()
        AND ((payload#>>'{state,submission,revision}') IS NULL
            OR revision <= (payload#>>'{state,submission,revision}')::integer)
    );

-- The owner is subject to the base-table policy. The barrier view has no
-- grouping dimensions in its output, and applies the sample floor in SQL.
CREATE VIEW nofries.free_check_completion_stats WITH (security_barrier=true) AS
WITH saves AS (
    SELECT tenant_id, organisation_id, assessment_id, revision,
        (payload#>>'{state,createdAt}')::timestamptz AS started,
        (payload#>>'{state,updatedAt}')::timestamptz AS saved,
        (payload#>>'{state,submission,submittedAt}')::timestamptz AS submitted,
        (payload#>>'{state,submission,revision}')::integer AS submission_revision
    FROM nofries.dashboard_ncsc_assessment_revisions
    WHERE (payload#>>'{state,createdAt}')::timestamptz BETWEEN now() - interval '90 days' AND now()
), gaps AS (
    SELECT *, saved - lag(saved) OVER (PARTITION BY tenant_id, organisation_id, assessment_id ORDER BY revision) AS gap
    FROM saves WHERE submission_revision IS NULL OR revision <= submission_revision
), checks AS (
    SELECT extract(epoch FROM max(submitted) - min(started)) / 60 AS elapsed,
        sum(least(coalesce(extract(epoch FROM gap), 0), 300)) / 60 AS active
    FROM gaps GROUP BY tenant_id, organisation_id, assessment_id
    HAVING max(submitted) <= now()
)
SELECT CASE WHEN count(*) >= 10 THEN count(*)::integer END AS count,
    CASE WHEN count(*) >= 10 THEN percentile_cont(0.5) WITHIN GROUP (ORDER BY elapsed) END AS "elapsedMedian",
    CASE WHEN count(*) >= 10 THEN percentile_cont(0.8) WITHIN GROUP (ORDER BY elapsed) END AS "elapsedP80",
    CASE WHEN count(*) >= 10 THEN percentile_cont(0.5) WITHIN GROUP (ORDER BY active) END AS "activeMedian",
    CASE WHEN count(*) >= 10 THEN percentile_cont(0.8) WITHIN GROUP (ORDER BY active) END AS "activeP80"
FROM checks;
REVOKE ALL ON nofries.free_check_completion_stats FROM PUBLIC;
GRANT SELECT ON nofries.free_check_completion_stats TO nofries_completion_stats_reader;

-- A non-superuser transferring a view needs SET on the target role and the
-- target needs schema CREATE. These permissions exist only in this transaction.
DO $transfer$
BEGIN
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
        GRANT nofries_completion_stats_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;
    END IF;
    GRANT CREATE ON SCHEMA nofries TO nofries_completion_stats_owner;
    ALTER VIEW nofries.free_check_completion_stats OWNER TO nofries_completion_stats_owner;
    REVOKE CREATE ON SCHEMA nofries FROM nofries_completion_stats_owner;
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
        REVOKE nofries_completion_stats_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
    END IF;
END
$transfer$;
