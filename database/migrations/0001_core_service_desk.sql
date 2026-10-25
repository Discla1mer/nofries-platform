CREATE SCHEMA IF NOT EXISTS nofries;

REVOKE ALL ON SCHEMA nofries FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

DO $role$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_roles
        WHERE rolname = 'nofries_runtime'
    ) THEN
        CREATE ROLE nofries_runtime
            NOLOGIN
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            NOINHERIT
            NOREPLICATION
            NOBYPASSRLS;
    ELSIF EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname = 'nofries_runtime'
          AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole
            OR rolinherit OR rolreplication OR rolbypassrls)
    ) THEN
        RAISE EXCEPTION 'runtime_role_configuration_invalid';
    END IF;
END
$role$;

DO $database_privileges$
BEGIN
    EXECUTE format(
        'REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC',
        current_database()
    );
    EXECUTE format(
        'REVOKE CREATE, TEMPORARY ON DATABASE %I FROM nofries_runtime',
        current_database()
    );
END
$database_privileges$;

CREATE TABLE IF NOT EXISTS nofries.tenants (
    tenant_id text PRIMARY KEY,
    logical_id text NOT NULL,
    tenant_key text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT tenants_logical_id_tenant_unique UNIQUE (tenant_id, logical_id),
    CONSTRAINT tenants_tenant_key_tenant_unique UNIQUE (tenant_id, tenant_key),
    CONSTRAINT tenants_slug_tenant_unique UNIQUE (tenant_id, slug),
    CONSTRAINT tenants_tenant_id_nonempty CHECK (length(btrim(tenant_id)) > 0),
    CONSTRAINT tenants_logical_id_nonempty CHECK (length(btrim(logical_id)) > 0),
    CONSTRAINT tenants_tenant_key_nonempty CHECK (length(btrim(tenant_key)) > 0),
    CONSTRAINT tenants_name_nonempty CHECK (length(btrim(name)) > 0),
    CONSTRAINT tenants_slug_nonempty CHECK (length(btrim(slug)) > 0)
);

CREATE TABLE IF NOT EXISTS nofries.module_revisions (
    tenant_id text NOT NULL,
    module text NOT NULL,
    schema_version integer NOT NULL,
    revision bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, module),
    CONSTRAINT module_revisions_tenant_fk
        FOREIGN KEY (tenant_id)
        REFERENCES nofries.tenants (tenant_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    CONSTRAINT module_revisions_module_nonempty CHECK (length(btrim(module)) > 0),
    CONSTRAINT module_revisions_schema_version_positive CHECK (schema_version > 0),
    CONSTRAINT module_revisions_revision_nonnegative CHECK (revision >= 0)
);

CREATE TABLE IF NOT EXISTS nofries.service_desk_users (
    tenant_id text NOT NULL,
    email text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, email),
    CONSTRAINT service_desk_users_tenant_fk
        FOREIGN KEY (tenant_id)
        REFERENCES nofries.tenants (tenant_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    CONSTRAINT service_desk_users_email_nonempty CHECK (length(btrim(email)) > 0)
);

CREATE TABLE IF NOT EXISTS nofries.service_desk_tickets (
    tenant_id text NOT NULL,
    ticket_id text NOT NULL,
    client_request_id text,
    customer_id text NOT NULL,
    status text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (tenant_id, ticket_id),
    CONSTRAINT service_desk_tickets_tenant_fk
        FOREIGN KEY (tenant_id)
        REFERENCES nofries.tenants (tenant_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    CONSTRAINT service_desk_tickets_ticket_id_nonempty CHECK (length(btrim(ticket_id)) > 0),
    CONSTRAINT service_desk_tickets_client_request_id_nonempty
        CHECK (client_request_id IS NULL OR length(btrim(client_request_id)) > 0),
    CONSTRAINT service_desk_tickets_customer_id_nonempty CHECK (length(btrim(customer_id)) > 0),
    CONSTRAINT service_desk_tickets_status_nonempty CHECK (length(btrim(status)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS service_desk_tickets_tenant_client_request_unique
    ON nofries.service_desk_tickets (tenant_id, client_request_id)
    WHERE client_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS nofries.service_desk_audit (
    tenant_id text NOT NULL,
    event_id text NOT NULL,
    sequence_no bigint GENERATED ALWAYS AS IDENTITY,
    occurred_at timestamptz NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (tenant_id, event_id),
    CONSTRAINT service_desk_audit_tenant_fk
        FOREIGN KEY (tenant_id)
        REFERENCES nofries.tenants (tenant_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    CONSTRAINT service_desk_audit_event_id_nonempty CHECK (length(btrim(event_id)) > 0)
);

CREATE INDEX IF NOT EXISTS service_desk_audit_tenant_sequence_idx
    ON nofries.service_desk_audit (tenant_id, sequence_no);

ALTER TABLE nofries.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.module_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.module_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.service_desk_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.service_desk_users FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.service_desk_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.service_desk_tickets FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.service_desk_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.service_desk_audit FORCE ROW LEVEL SECURITY;

CREATE POLICY tenants_tenant_isolation
    ON nofries.tenants
    FOR ALL
    TO nofries_runtime
    USING (
        tenant_id = NULLIF(current_setting('nofries.tenant_id', true), '')
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('nofries.tenant_id', true), '')
    );

CREATE POLICY module_revisions_tenant_isolation
    ON nofries.module_revisions
    FOR ALL
    TO nofries_runtime
    USING (
        tenant_id = NULLIF(current_setting('nofries.tenant_id', true), '')
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('nofries.tenant_id', true), '')
    );

CREATE POLICY service_desk_users_tenant_isolation
    ON nofries.service_desk_users
    FOR ALL
    TO nofries_runtime
    USING (
        tenant_id = NULLIF(current_setting('nofries.tenant_id', true), '')
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('nofries.tenant_id', true), '')
    );

CREATE POLICY service_desk_tickets_tenant_isolation
    ON nofries.service_desk_tickets
    FOR ALL
    TO nofries_runtime
    USING (
        tenant_id = NULLIF(current_setting('nofries.tenant_id', true), '')
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('nofries.tenant_id', true), '')
    );

CREATE POLICY service_desk_audit_tenant_select
    ON nofries.service_desk_audit
    FOR SELECT
    TO nofries_runtime
    USING (
        tenant_id = NULLIF(current_setting('nofries.tenant_id', true), '')
    );

CREATE POLICY service_desk_audit_tenant_insert
    ON nofries.service_desk_audit
    FOR INSERT
    TO nofries_runtime
    WITH CHECK (
        tenant_id = NULLIF(current_setting('nofries.tenant_id', true), '')
    );

REVOKE ALL ON ALL TABLES IN SCHEMA nofries FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA nofries FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA nofries FROM nofries_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA nofries FROM nofries_runtime;

GRANT USAGE ON SCHEMA nofries TO nofries_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE
    ON nofries.tenants,
       nofries.module_revisions,
       nofries.service_desk_users,
       nofries.service_desk_tickets
    TO nofries_runtime;
GRANT SELECT, INSERT
    ON nofries.service_desk_audit
    TO nofries_runtime;
GRANT USAGE
    ON SEQUENCE nofries.service_desk_audit_sequence_no_seq
    TO nofries_runtime;

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON nofries.service_desk_audit
    FROM nofries_runtime;
REVOKE ALL ON nofries.schema_migrations FROM PUBLIC;
REVOKE ALL ON nofries.schema_migrations FROM nofries_runtime;
