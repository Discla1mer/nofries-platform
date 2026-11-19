-- Owner decision, 19 November 2026 (#455, part of #409): dashboard contact
-- requests are kept for 24 months from requested_at, then deleted.
--
-- A new NOLOGIN capability, nofries_contact_request_retention, may see and
-- delete only contact requests older than 24 months, in every tenant. It may
-- read only the primary key and requested_at (enough to pick a bounded batch),
-- not the organisation, subject, topic or consent columns. It cannot insert,
-- update or truncate, owns nothing, holds no other privilege in the schema and
-- is granted to no login here. A login gets it only by a separate production
-- grant, WITH SET TRUE, INHERIT FALSE. The App Service job
-- (api/shared/contactRequestRetention.js) runs SET LOCAL ROLE inside each
-- purge transaction, off unless NOFRIES_CONTACT_REQUEST_RETENTION_ENABLED is
-- exactly 'true'.
--
-- No other role's privileges or policies change: nofries_runtime still cannot
-- delete, and nofries_account_wipe keeps its per-tenant delete from 0026.
--
-- Forward-only. It refuses with contact_request_retention_precondition if the
-- table is missing, and with contact_request_retention_role_* if a role of this
-- name already exists with any attribute, member or privilege a new one would
-- not have.
--
-- Rollback, before any login is granted the role: DROP POLICY
-- dashboard_contact_requests_retention_select and
-- dashboard_contact_requests_retention_delete ON
-- nofries.dashboard_contact_requests; REVOKE ALL ON
-- nofries.dashboard_contact_requests and USAGE ON SCHEMA nofries FROM
-- nofries_contact_request_retention; DROP ROLE nofries_contact_request_retention;
-- then delete its schema_migrations row. If a login was granted it, REVOKE that
-- membership first. Nothing else depends on the role.
DO $precheck$
BEGIN
    IF to_regclass('nofries.dashboard_contact_requests') IS NULL THEN
        RAISE EXCEPTION 'contact_request_retention_precondition';
    END IF;
END
$precheck$;

DO $role$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nofries_contact_request_retention') THEN
        CREATE ROLE nofries_contact_request_retention NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
    ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nofries_contact_request_retention' AND
        (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
        RAISE EXCEPTION 'contact_request_retention_role_configuration_invalid';
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
        WHERE capability.rolname = 'nofries_contact_request_retention'
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
        RAISE EXCEPTION 'contact_request_retention_role_baseline_invalid';
    END IF;
END
$capability_baseline$;

GRANT USAGE ON SCHEMA nofries TO nofries_contact_request_retention;
REVOKE ALL ON nofries.dashboard_contact_requests FROM nofries_contact_request_retention;
GRANT SELECT (tenant_id, request_id, requested_at), DELETE ON nofries.dashboard_contact_requests TO nofries_contact_request_retention;

-- RLS is already enabled and forced on the table (0026). A DELETE whose WHERE
-- reads columns needs both policies; each sees only rows past the 24 months.
-- now() is the transaction start, so one transaction has one cut-off.
CREATE POLICY dashboard_contact_requests_retention_select ON nofries.dashboard_contact_requests
    FOR SELECT TO nofries_contact_request_retention
    USING (requested_at < now() - interval '24 months');
CREATE POLICY dashboard_contact_requests_retention_delete ON nofries.dashboard_contact_requests
    FOR DELETE TO nofries_contact_request_retention
    USING (requested_at < now() - interval '24 months');
