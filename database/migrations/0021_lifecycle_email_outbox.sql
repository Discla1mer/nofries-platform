-- Lifecycle email, slice E1 (#151): the transactional outbox and per-account
-- email preferences only. Nothing reads or writes these tables yet; the
-- dispatcher, templates and application code arrive behind default-off flags.
--
-- No address, name, subject or body is stored. A queued email names a starter
-- account, a closed email type, a template version and at most two small
-- parameters; the sender resolves everything else at send time.
--
-- nofries_runtime may enqueue for its own tenant, read its own tenant's rows and
-- move a row from pending to cancelled, nothing else. Preferences are scoped to
-- the signed-in subject's starter account. nofries_email_dispatcher is a new
-- NOLOGIN capability with no members: it reads both tables across tenants and
-- updates delivery columns, and holds no other privilege in the schema. Nobody
-- is granted DELETE.
--
-- Rollback (only while no application code depends on it): DROP TABLE
-- nofries.email_outbox, nofries.email_preferences; DROP ROLE
-- nofries_email_dispatcher after revoking its schema USAGE.

CREATE TABLE nofries.email_outbox (
    outbox_id uuid PRIMARY KEY,
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    account_id uuid NOT NULL
        REFERENCES nofries.dashboard_starter_accounts (account_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    email_type text NOT NULL
        CHECK (email_type IN ('welcome','result_summary','nudge_unfinished','reassess_reminder')),
    dedupe_key text NOT NULL,
    template_version text NOT NULL,
    params jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','sending','sent','failed','cancelled','suppressed')),
    attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6),
    not_before timestamptz NOT NULL DEFAULT clock_timestamp(),
    locked_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    sent_at timestamptz,
    last_error_code text CHECK (last_error_code ~ '^[a-z0-9_]{1,40}$'),
    provider_message_id text CHECK (provider_message_id ~ '^[A-Za-z0-9._:@<>-]{1,200}$'),
    CONSTRAINT email_outbox_dedupe UNIQUE (account_id, organisation_id, email_type, dedupe_key),
    CHECK (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
        AND organisation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
        AND dedupe_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
        AND template_version ~ '^[a-z0-9][a-z0-9._-]{0,39}$'),
    -- Only assessmentId (string) and gapCount (number); never free text.
    CONSTRAINT email_outbox_params CHECK ((jsonb_typeof(params) = 'object'
        AND octet_length(params::text) <= 512
        AND params - ARRAY['assessmentId','gapCount'] = '{}'::jsonb
        AND (NOT params ? 'assessmentId' OR jsonb_typeof(params->'assessmentId') = 'string')
        AND (NOT params ? 'gapCount' OR jsonb_typeof(params->'gapCount') = 'number')) IS TRUE),
    CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX email_outbox_due ON nofries.email_outbox (not_before) WHERE status = 'pending';

CREATE TABLE nofries.email_preferences (
    account_id uuid NOT NULL
        REFERENCES nofries.dashboard_starter_accounts (account_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    email_type text NOT NULL
        CHECK (email_type IN ('welcome','result_summary','nudge_unfinished','reassess_reminder')),
    unsubscribed_at timestamptz,
    source text NOT NULL CHECK (source IN ('link','settings')),
    PRIMARY KEY (account_id, email_type)
);

-- New NOLOGIN capability; it acquires no ownership, membership or login.
DO $role$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nofries_email_dispatcher') THEN
        CREATE ROLE nofries_email_dispatcher NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
    ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nofries_email_dispatcher' AND
        (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
        RAISE EXCEPTION 'email_dispatcher_role_configuration_invalid';
    END IF;
END
$role$;

-- A pre-existing role must be as restricted as a new one. Fail closed rather
-- than silently revoking unrelated privileges. The PostgreSQL 17 creator's
-- ADMIN-only edge (no SET, no INHERIT) is the only membership tolerated.
DO $capability_baseline$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_roles capability
        WHERE capability.rolname = 'nofries_email_dispatcher'
          AND (EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = capability.oid)
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
GRANT USAGE ON SCHEMA nofries TO nofries_email_dispatcher;

ALTER TABLE nofries.email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.email_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY email_outbox_tenant ON nofries.email_outbox
    FOR ALL TO nofries_runtime
    USING (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), ''));
-- Restrictive: runtime enqueues only fresh pending rows and may only cancel one.
-- The supplied ids are not trusted on their own: the account, tenant and
-- organisation must be one starter scope of the signed-in subject (0011).
CREATE POLICY email_outbox_runtime_enqueue ON nofries.email_outbox
    AS RESTRICTIVE FOR INSERT TO nofries_runtime
    WITH CHECK (status = 'pending' AND attempts = 0 AND locked_until IS NULL AND sent_at IS NULL
        AND last_error_code IS NULL AND provider_message_id IS NULL
        AND organisation_id = NULLIF(current_setting('nofries.organisation_id', true), '')
        AND EXISTS (SELECT 1 FROM nofries.dashboard_starter_scopes s
            WHERE s.account_id = email_outbox.account_id
              AND s.tenant_id = email_outbox.tenant_id
              AND s.organisation_id = email_outbox.organisation_id
              AND s.subject_key = NULLIF(current_setting('nofries.subject_key', true), '')));
CREATE POLICY email_outbox_runtime_cancel ON nofries.email_outbox
    AS RESTRICTIVE FOR UPDATE TO nofries_runtime
    USING (status = 'pending')
    WITH CHECK (status = 'cancelled');
CREATE POLICY email_outbox_dispatcher ON nofries.email_outbox
    FOR ALL TO nofries_email_dispatcher
    USING (true) WITH CHECK (true);
REVOKE ALL ON nofries.email_outbox FROM PUBLIC, nofries_runtime, nofries_email_dispatcher;
GRANT SELECT, INSERT ON nofries.email_outbox TO nofries_runtime;
GRANT UPDATE (status) ON nofries.email_outbox TO nofries_runtime;
GRANT SELECT ON nofries.email_outbox TO nofries_email_dispatcher;
GRANT UPDATE (status, attempts, not_before, locked_until, last_error_code, provider_message_id, sent_at)
    ON nofries.email_outbox TO nofries_email_dispatcher;

ALTER TABLE nofries.email_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.email_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY email_preferences_subject ON nofries.email_preferences
    FOR ALL TO nofries_runtime
    USING (EXISTS (SELECT 1 FROM nofries.dashboard_starter_accounts a
        WHERE a.account_id = email_preferences.account_id
          AND a.subject_key = NULLIF(current_setting('nofries.subject_key', true), '')))
    WITH CHECK (EXISTS (SELECT 1 FROM nofries.dashboard_starter_accounts a
        WHERE a.account_id = email_preferences.account_id
          AND a.subject_key = NULLIF(current_setting('nofries.subject_key', true), '')));
CREATE POLICY email_preferences_dispatcher ON nofries.email_preferences
    FOR ALL TO nofries_email_dispatcher
    USING (true) WITH CHECK (true);
REVOKE ALL ON nofries.email_preferences FROM PUBLIC, nofries_runtime, nofries_email_dispatcher;
GRANT SELECT, INSERT ON nofries.email_preferences TO nofries_runtime;
GRANT UPDATE (unsubscribed_at, source) ON nofries.email_preferences TO nofries_runtime;
GRANT SELECT, INSERT ON nofries.email_preferences TO nofries_email_dispatcher;
GRANT UPDATE (unsubscribed_at, source) ON nofries.email_preferences TO nofries_email_dispatcher;
