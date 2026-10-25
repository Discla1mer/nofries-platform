CREATE TABLE IF NOT EXISTS nofries.lifecycle_users (
    tenant_key text NOT NULL,
    email text NOT NULL,
    identity_tenant_id text,
    principal_id text,
    subject_key text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_key, email),
    CONSTRAINT lifecycle_users_tenant_fk
        FOREIGN KEY (tenant_key)
        REFERENCES nofries.tenants (tenant_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_users_tenant_key_nonempty CHECK (length(btrim(tenant_key)) > 0),
    CONSTRAINT lifecycle_users_email_nonempty CHECK (length(btrim(email)) > 0),
    CONSTRAINT lifecycle_users_identity_tenant_id_nonempty
        CHECK (identity_tenant_id IS NULL OR length(btrim(identity_tenant_id)) > 0),
    CONSTRAINT lifecycle_users_principal_id_nonempty
        CHECK (principal_id IS NULL OR length(btrim(principal_id)) > 0),
    CONSTRAINT lifecycle_users_subject_key_nonempty
        CHECK (subject_key IS NULL OR length(btrim(subject_key)) > 0),
    CONSTRAINT lifecycle_users_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_users_tenant_email_canonical_unique
    ON nofries.lifecycle_users (tenant_key, lower(email));

CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_users_tenant_subject_unique
    ON nofries.lifecycle_users (tenant_key, lower(subject_key))
    WHERE subject_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS nofries.lifecycle_organisations (
    tenant_key text NOT NULL,
    organisation_id text NOT NULL,
    sequence_no bigint NOT NULL,
    datto_rmm_site_uid text,
    datto_rmm_site_name_key text,
    datto_rmm_provisioning_claim_id text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_key, organisation_id),
    CONSTRAINT lifecycle_organisations_tenant_sequence_unique
        UNIQUE (tenant_key, sequence_no),
    CONSTRAINT lifecycle_organisations_tenant_fk
        FOREIGN KEY (tenant_key)
        REFERENCES nofries.tenants (tenant_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_organisations_tenant_key_nonempty CHECK (length(btrim(tenant_key)) > 0),
    CONSTRAINT lifecycle_organisations_id_nonempty CHECK (length(btrim(organisation_id)) > 0),
    CONSTRAINT lifecycle_organisations_datto_site_uid_nonempty
        CHECK (datto_rmm_site_uid IS NULL OR length(btrim(datto_rmm_site_uid)) > 0),
    CONSTRAINT lifecycle_organisations_datto_site_name_key_nonempty
        CHECK (datto_rmm_site_name_key IS NULL OR length(btrim(datto_rmm_site_name_key)) > 0),
    CONSTRAINT lifecycle_organisations_datto_claim_id_nonempty
        CHECK (datto_rmm_provisioning_claim_id IS NULL OR length(btrim(datto_rmm_provisioning_claim_id)) > 0),
    CONSTRAINT lifecycle_organisations_sequence_nonnegative CHECK (sequence_no >= 0),
    CONSTRAINT lifecycle_organisations_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_organisations_datto_site_uid_unique
    ON nofries.lifecycle_organisations (tenant_key, lower(datto_rmm_site_uid))
    WHERE datto_rmm_site_uid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_organisations_datto_site_name_key_unique
    ON nofries.lifecycle_organisations (tenant_key, lower(datto_rmm_site_name_key))
    WHERE datto_rmm_site_name_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_organisations_datto_claim_id_unique
    ON nofries.lifecycle_organisations (tenant_key, lower(datto_rmm_provisioning_claim_id))
    WHERE datto_rmm_provisioning_claim_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS nofries.lifecycle_onboarding_devices (
    tenant_key text NOT NULL,
    organisation_id text NOT NULL,
    device_id text NOT NULL,
    sequence_no bigint NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_key, organisation_id, device_id),
    CONSTRAINT lifecycle_onboarding_devices_tenant_sequence_unique
        UNIQUE (tenant_key, organisation_id, sequence_no),
    CONSTRAINT lifecycle_onboarding_devices_tenant_fk
        FOREIGN KEY (tenant_key)
        REFERENCES nofries.tenants (tenant_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_onboarding_devices_organisation_fk
        FOREIGN KEY (tenant_key, organisation_id)
        REFERENCES nofries.lifecycle_organisations (tenant_key, organisation_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_onboarding_devices_organisation_id_nonempty
        CHECK (length(btrim(organisation_id)) > 0),
    CONSTRAINT lifecycle_onboarding_devices_device_id_nonempty CHECK (length(btrim(device_id)) > 0),
    CONSTRAINT lifecycle_onboarding_devices_sequence_nonnegative CHECK (sequence_no >= 0),
    CONSTRAINT lifecycle_onboarding_devices_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE IF NOT EXISTS nofries.lifecycle_device_provider_refs (
    tenant_key text NOT NULL,
    organisation_id text NOT NULL,
    device_id text NOT NULL,
    sequence_no bigint NOT NULL,
    provider_system text NOT NULL,
    external_id text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_key, organisation_id, device_id, sequence_no),
    CONSTRAINT lifecycle_device_provider_refs_tenant_provider_unique
        UNIQUE (tenant_key, organisation_id, device_id, provider_system),
    CONSTRAINT lifecycle_device_provider_refs_tenant_fk
        FOREIGN KEY (tenant_key)
        REFERENCES nofries.tenants (tenant_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_device_provider_refs_device_fk
        FOREIGN KEY (tenant_key, organisation_id, device_id)
        REFERENCES nofries.lifecycle_onboarding_devices (tenant_key, organisation_id, device_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_device_provider_refs_provider_nonempty
        CHECK (length(btrim(provider_system)) > 0),
    CONSTRAINT lifecycle_device_provider_refs_external_id_nonempty CHECK (length(btrim(external_id)) > 0),
    CONSTRAINT lifecycle_device_provider_refs_sequence_nonnegative CHECK (sequence_no >= 0),
    CONSTRAINT lifecycle_device_provider_refs_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_device_provider_refs_claim_unique
    ON nofries.lifecycle_device_provider_refs (
        tenant_key,
        lower(provider_system),
        lower(external_id)
    );

CREATE TABLE IF NOT EXISTS nofries.lifecycle_external_references (
    tenant_key text NOT NULL,
    organisation_id text NOT NULL,
    external_reference_id text NOT NULL,
    sequence_no bigint NOT NULL,
    provider_system text NOT NULL,
    record_type text NOT NULL,
    provider_scope_id text NOT NULL DEFAULT '',
    external_id text NOT NULL,
    claim_status text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_key, organisation_id, external_reference_id),
    CONSTRAINT lifecycle_external_references_tenant_sequence_unique
        UNIQUE (tenant_key, organisation_id, sequence_no),
    CONSTRAINT lifecycle_external_references_tenant_fk
        FOREIGN KEY (tenant_key)
        REFERENCES nofries.tenants (tenant_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_external_references_organisation_fk
        FOREIGN KEY (tenant_key, organisation_id)
        REFERENCES nofries.lifecycle_organisations (tenant_key, organisation_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_external_references_id_nonempty
        CHECK (length(btrim(external_reference_id)) > 0),
    CONSTRAINT lifecycle_external_references_provider_nonempty
        CHECK (length(btrim(provider_system)) > 0),
    CONSTRAINT lifecycle_external_references_record_type_nonempty CHECK (length(btrim(record_type)) > 0),
    CONSTRAINT lifecycle_external_references_external_id_nonempty CHECK (length(btrim(external_id)) > 0),
    CONSTRAINT lifecycle_external_references_status_valid
        CHECK (claim_status IN ('pending', 'verified', 'retired')),
    CONSTRAINT lifecycle_external_references_sequence_nonnegative CHECK (sequence_no >= 0),
    CONSTRAINT lifecycle_external_references_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_external_references_active_claim_unique
    ON nofries.lifecycle_external_references (
        tenant_key,
        lower(provider_system),
        lower(record_type),
        lower(provider_scope_id),
        lower(external_id)
    )
    WHERE claim_status <> 'retired';

CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_external_references_active_slot_unique
    ON nofries.lifecycle_external_references (
        tenant_key,
        organisation_id,
        lower(provider_system),
        lower(record_type),
        lower(provider_scope_id)
    )
    WHERE claim_status <> 'retired'
      AND (lower(provider_system), lower(record_type)) IN (
          ('hubspot', 'company'),
          ('autotask', 'account'),
          ('datto_rmm', 'site'),
          ('kaseya_mdr', 'tenant'),
          ('kaseya_mdr', 'organisation'),
          ('backup', 'tenant')
      );

CREATE TABLE IF NOT EXISTS nofries.lifecycle_activation_requests (
    tenant_key text NOT NULL,
    organisation_id text NOT NULL,
    activation_request_id text NOT NULL,
    sequence_no bigint NOT NULL,
    idempotency_key text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_key, organisation_id, activation_request_id),
    CONSTRAINT lifecycle_activation_requests_tenant_sequence_unique
        UNIQUE (tenant_key, organisation_id, sequence_no),
    CONSTRAINT lifecycle_activation_requests_tenant_idempotency_unique
        UNIQUE (tenant_key, organisation_id, idempotency_key),
    CONSTRAINT lifecycle_activation_requests_tenant_fk
        FOREIGN KEY (tenant_key)
        REFERENCES nofries.tenants (tenant_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_activation_requests_organisation_fk
        FOREIGN KEY (tenant_key, organisation_id)
        REFERENCES nofries.lifecycle_organisations (tenant_key, organisation_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_activation_requests_id_nonempty CHECK (length(btrim(activation_request_id)) > 0),
    CONSTRAINT lifecycle_activation_requests_idempotency_nonempty CHECK (length(btrim(idempotency_key)) > 0),
    CONSTRAINT lifecycle_activation_requests_sequence_nonnegative CHECK (sequence_no >= 0),
    CONSTRAINT lifecycle_activation_requests_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE IF NOT EXISTS nofries.lifecycle_conversations (
    tenant_key text NOT NULL,
    conversation_id text NOT NULL,
    sequence_no bigint NOT NULL,
    organisation_id text,
    session_hash text NOT NULL DEFAULT '',
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_key, conversation_id),
    CONSTRAINT lifecycle_conversations_tenant_sequence_unique UNIQUE (tenant_key, sequence_no),
    CONSTRAINT lifecycle_conversations_tenant_fk
        FOREIGN KEY (tenant_key)
        REFERENCES nofries.tenants (tenant_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_conversations_organisation_fk
        FOREIGN KEY (tenant_key, organisation_id)
        REFERENCES nofries.lifecycle_organisations (tenant_key, organisation_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_conversations_id_nonempty CHECK (length(btrim(conversation_id)) > 0),
    CONSTRAINT lifecycle_conversations_organisation_id_nonempty
        CHECK (organisation_id IS NULL OR length(btrim(organisation_id)) > 0),
    CONSTRAINT lifecycle_conversations_sequence_nonnegative CHECK (sequence_no >= 0),
    CONSTRAINT lifecycle_conversations_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_conversations_tenant_session_unique
    ON nofries.lifecycle_conversations (tenant_key, lower(session_hash))
    WHERE length(btrim(session_hash)) > 0;

CREATE TABLE IF NOT EXISTS nofries.lifecycle_prospect_admissions (
    tenant_key text NOT NULL,
    sequence_no bigint NOT NULL,
    session_hash text NOT NULL,
    client_key_hash text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_key, sequence_no),
    CONSTRAINT lifecycle_prospect_admissions_tenant_fk
        FOREIGN KEY (tenant_key)
        REFERENCES nofries.tenants (tenant_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_prospect_admissions_session_hash_nonempty CHECK (length(btrim(session_hash)) > 0),
    CONSTRAINT lifecycle_prospect_admissions_client_hash_nonempty CHECK (length(btrim(client_key_hash)) > 0),
    CONSTRAINT lifecycle_prospect_admissions_sequence_nonnegative CHECK (sequence_no >= 0),
    CONSTRAINT lifecycle_prospect_admissions_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_prospect_admissions_tenant_session_unique
    ON nofries.lifecycle_prospect_admissions (tenant_key, lower(session_hash));

CREATE TABLE IF NOT EXISTS nofries.lifecycle_prospect_security_events (
    tenant_key text NOT NULL,
    event_id text NOT NULL,
    sequence_no bigint NOT NULL,
    session_hash text NOT NULL,
    client_key_hash text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_key, event_id),
    CONSTRAINT lifecycle_prospect_security_events_tenant_sequence_unique
        UNIQUE (tenant_key, sequence_no),
    CONSTRAINT lifecycle_prospect_security_events_tenant_fk
        FOREIGN KEY (tenant_key)
        REFERENCES nofries.tenants (tenant_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_prospect_security_events_id_nonempty CHECK (length(btrim(event_id)) > 0),
    CONSTRAINT lifecycle_prospect_security_events_session_hash_nonempty CHECK (length(btrim(session_hash)) > 0),
    CONSTRAINT lifecycle_prospect_security_events_client_hash_nonempty CHECK (length(btrim(client_key_hash)) > 0),
    CONSTRAINT lifecycle_prospect_security_events_sequence_nonnegative CHECK (sequence_no >= 0),
    CONSTRAINT lifecycle_prospect_security_events_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE IF NOT EXISTS nofries.lifecycle_approvals (
    tenant_key text NOT NULL,
    sequence_no bigint NOT NULL,
    organisation_id text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_key, sequence_no),
    CONSTRAINT lifecycle_approvals_tenant_fk
        FOREIGN KEY (tenant_key)
        REFERENCES nofries.tenants (tenant_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_approvals_organisation_id_nonempty
        CHECK (organisation_id IS NULL OR length(btrim(organisation_id)) > 0),
    CONSTRAINT lifecycle_approvals_sequence_nonnegative CHECK (sequence_no >= 0)
);

CREATE TABLE IF NOT EXISTS nofries.lifecycle_operator_tasks (
    tenant_key text NOT NULL,
    task_id text NOT NULL,
    sequence_no bigint NOT NULL,
    organisation_id text NOT NULL,
    conversation_id text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_key, task_id),
    CONSTRAINT lifecycle_operator_tasks_tenant_sequence_unique UNIQUE (tenant_key, sequence_no),
    CONSTRAINT lifecycle_operator_tasks_tenant_fk
        FOREIGN KEY (tenant_key)
        REFERENCES nofries.tenants (tenant_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_operator_tasks_organisation_fk
        FOREIGN KEY (tenant_key, organisation_id)
        REFERENCES nofries.lifecycle_organisations (tenant_key, organisation_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_operator_tasks_conversation_fk
        FOREIGN KEY (tenant_key, conversation_id)
        REFERENCES nofries.lifecycle_conversations (tenant_key, conversation_id)
        ON UPDATE RESTRICT
        ON DELETE SET NULL (conversation_id),
    CONSTRAINT lifecycle_operator_tasks_id_nonempty CHECK (length(btrim(task_id)) > 0),
    CONSTRAINT lifecycle_operator_tasks_organisation_id_nonempty CHECK (length(btrim(organisation_id)) > 0),
    CONSTRAINT lifecycle_operator_tasks_conversation_id_nonempty
        CHECK (conversation_id IS NULL OR length(btrim(conversation_id)) > 0),
    CONSTRAINT lifecycle_operator_tasks_sequence_nonnegative CHECK (sequence_no >= 0),
    CONSTRAINT lifecycle_operator_tasks_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE IF NOT EXISTS nofries.lifecycle_schedules (
    tenant_key text NOT NULL,
    schedule_id text NOT NULL,
    sequence_no bigint NOT NULL,
    organisation_id text NOT NULL,
    job_type text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_key, schedule_id),
    CONSTRAINT lifecycle_schedules_tenant_sequence_unique UNIQUE (tenant_key, sequence_no),
    CONSTRAINT lifecycle_schedules_tenant_organisation_job_unique
        UNIQUE (tenant_key, organisation_id, job_type),
    CONSTRAINT lifecycle_schedules_tenant_fk
        FOREIGN KEY (tenant_key)
        REFERENCES nofries.tenants (tenant_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_schedules_organisation_fk
        FOREIGN KEY (tenant_key, organisation_id)
        REFERENCES nofries.lifecycle_organisations (tenant_key, organisation_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_schedules_id_nonempty CHECK (length(btrim(schedule_id)) > 0),
    CONSTRAINT lifecycle_schedules_organisation_id_nonempty CHECK (length(btrim(organisation_id)) > 0),
    CONSTRAINT lifecycle_schedules_job_type_nonempty CHECK (length(btrim(job_type)) > 0),
    CONSTRAINT lifecycle_schedules_sequence_nonnegative CHECK (sequence_no >= 0),
    CONSTRAINT lifecycle_schedules_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE IF NOT EXISTS nofries.lifecycle_control_runs (
    tenant_key text NOT NULL,
    run_id text NOT NULL,
    sequence_no bigint NOT NULL,
    organisation_id text,
    schedule_id text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_key, run_id),
    CONSTRAINT lifecycle_control_runs_tenant_sequence_unique UNIQUE (tenant_key, sequence_no),
    CONSTRAINT lifecycle_control_runs_tenant_fk
        FOREIGN KEY (tenant_key)
        REFERENCES nofries.tenants (tenant_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_control_runs_id_nonempty CHECK (length(btrim(run_id)) > 0),
    CONSTRAINT lifecycle_control_runs_organisation_id_nonempty
        CHECK (organisation_id IS NULL OR length(btrim(organisation_id)) > 0),
    CONSTRAINT lifecycle_control_runs_schedule_id_nonempty
        CHECK (schedule_id IS NULL OR length(btrim(schedule_id)) > 0),
    CONSTRAINT lifecycle_control_runs_sequence_nonnegative CHECK (sequence_no >= 0),
    CONSTRAINT lifecycle_control_runs_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE IF NOT EXISTS nofries.lifecycle_dead_letters (
    tenant_key text NOT NULL,
    dead_letter_id text NOT NULL,
    sequence_no bigint NOT NULL,
    organisation_id text,
    operation_id text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_key, dead_letter_id),
    CONSTRAINT lifecycle_dead_letters_tenant_sequence_unique UNIQUE (tenant_key, sequence_no),
    CONSTRAINT lifecycle_dead_letters_tenant_fk
        FOREIGN KEY (tenant_key)
        REFERENCES nofries.tenants (tenant_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_dead_letters_id_nonempty CHECK (length(btrim(dead_letter_id)) > 0),
    CONSTRAINT lifecycle_dead_letters_organisation_id_nonempty
        CHECK (organisation_id IS NULL OR length(btrim(organisation_id)) > 0),
    CONSTRAINT lifecycle_dead_letters_operation_id_nonempty
        CHECK (operation_id IS NULL OR length(btrim(operation_id)) > 0),
    CONSTRAINT lifecycle_dead_letters_sequence_nonnegative CHECK (sequence_no >= 0),
    CONSTRAINT lifecycle_dead_letters_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE IF NOT EXISTS nofries.lifecycle_inbox_receipts (
    tenant_key text NOT NULL,
    operation_id text NOT NULL,
    payload_hash char(64) NOT NULL,
    receipt_kind text NOT NULL,
    organisation_id text NOT NULL,
    sales_customer_id text NOT NULL,
    assessment_id text NOT NULL,
    received_at timestamptz NOT NULL,
    received_by text NOT NULL,
    rematerialized_at timestamptz,
    rematerialized_by text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (tenant_key, operation_id),
    CONSTRAINT lifecycle_inbox_receipts_tenant_fk
        FOREIGN KEY (tenant_key)
        REFERENCES nofries.tenants (tenant_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    CONSTRAINT lifecycle_inbox_receipts_operation_id_nonempty CHECK (length(btrim(operation_id)) > 0),
    CONSTRAINT lifecycle_inbox_receipts_payload_hash_format CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT lifecycle_inbox_receipts_kind_valid CHECK (receipt_kind = 'lifecycle.scoping.link'),
    CONSTRAINT lifecycle_inbox_receipts_organisation_id_nonempty CHECK (length(btrim(organisation_id)) > 0),
    CONSTRAINT lifecycle_inbox_receipts_sales_customer_id_nonempty CHECK (length(btrim(sales_customer_id)) > 0),
    CONSTRAINT lifecycle_inbox_receipts_assessment_id_nonempty CHECK (length(btrim(assessment_id)) > 0),
    CONSTRAINT lifecycle_inbox_receipts_received_by_nonempty CHECK (length(btrim(received_by)) > 0),
    CONSTRAINT lifecycle_inbox_receipts_rematerialization_complete CHECK (
        (rematerialized_at IS NULL AND rematerialized_by IS NULL) OR
        (rematerialized_at IS NOT NULL AND rematerialized_by IS NOT NULL AND
            length(btrim(rematerialized_by)) > 0 AND rematerialized_at >= received_at)
    ),
    CONSTRAINT lifecycle_inbox_receipts_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE IF NOT EXISTS nofries.lifecycle_audit (
    tenant_key text NOT NULL,
    event_id text NOT NULL,
    sequence_no bigint NOT NULL,
    organisation_id text,
    actor_principal_id text,
    occurred_at timestamptz NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (tenant_key, event_id),
    CONSTRAINT lifecycle_audit_tenant_sequence_unique UNIQUE (tenant_key, sequence_no),
    CONSTRAINT lifecycle_audit_tenant_fk
        FOREIGN KEY (tenant_key)
        REFERENCES nofries.tenants (tenant_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    CONSTRAINT lifecycle_audit_event_id_nonempty CHECK (length(btrim(event_id)) > 0),
    CONSTRAINT lifecycle_audit_organisation_id_nonempty
        CHECK (organisation_id IS NULL OR length(btrim(organisation_id)) > 0),
    CONSTRAINT lifecycle_audit_actor_principal_id_nonempty
        CHECK (actor_principal_id IS NULL OR length(btrim(actor_principal_id)) > 0),
    CONSTRAINT lifecycle_audit_sequence_nonnegative CHECK (sequence_no >= 0),
    CONSTRAINT lifecycle_audit_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS lifecycle_audit_tenant_organisation_sequence_idx
    ON nofries.lifecycle_audit (tenant_key, organisation_id, sequence_no);

CREATE TABLE IF NOT EXISTS nofries.lifecycle_observability (
    tenant_key text NOT NULL,
    event_id text NOT NULL,
    sequence_no bigint NOT NULL,
    organisation_id text,
    conversation_id text,
    observed_at timestamptz NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (tenant_key, event_id),
    CONSTRAINT lifecycle_observability_tenant_sequence_unique UNIQUE (tenant_key, sequence_no),
    CONSTRAINT lifecycle_observability_tenant_fk
        FOREIGN KEY (tenant_key)
        REFERENCES nofries.tenants (tenant_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_observability_organisation_fk
        FOREIGN KEY (tenant_key, organisation_id)
        REFERENCES nofries.lifecycle_organisations (tenant_key, organisation_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_observability_conversation_fk
        FOREIGN KEY (tenant_key, conversation_id)
        REFERENCES nofries.lifecycle_conversations (tenant_key, conversation_id)
        ON UPDATE RESTRICT
        ON DELETE SET NULL (conversation_id),
    CONSTRAINT lifecycle_observability_event_id_nonempty CHECK (length(btrim(event_id)) > 0),
    CONSTRAINT lifecycle_observability_organisation_id_nonempty
        CHECK (organisation_id IS NULL OR length(btrim(organisation_id)) > 0),
    CONSTRAINT lifecycle_observability_conversation_id_nonempty
        CHECK (conversation_id IS NULL OR length(btrim(conversation_id)) > 0),
    CONSTRAINT lifecycle_observability_sequence_nonnegative CHECK (sequence_no >= 0),
    CONSTRAINT lifecycle_observability_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE IF NOT EXISTS nofries.lifecycle_operator_corrections (
    tenant_key text NOT NULL,
    correction_id text NOT NULL,
    sequence_no bigint NOT NULL,
    organisation_id text NOT NULL,
    occurred_at timestamptz NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (tenant_key, correction_id),
    CONSTRAINT lifecycle_operator_corrections_tenant_sequence_unique UNIQUE (tenant_key, sequence_no),
    CONSTRAINT lifecycle_operator_corrections_tenant_fk
        FOREIGN KEY (tenant_key)
        REFERENCES nofries.tenants (tenant_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_operator_corrections_organisation_fk
        FOREIGN KEY (tenant_key, organisation_id)
        REFERENCES nofries.lifecycle_organisations (tenant_key, organisation_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    CONSTRAINT lifecycle_operator_corrections_id_nonempty CHECK (length(btrim(correction_id)) > 0),
    CONSTRAINT lifecycle_operator_corrections_organisation_id_nonempty CHECK (length(btrim(organisation_id)) > 0),
    CONSTRAINT lifecycle_operator_corrections_sequence_nonnegative CHECK (sequence_no >= 0),
    CONSTRAINT lifecycle_operator_corrections_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

ALTER TABLE nofries.lifecycle_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_users FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_organisations FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_onboarding_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_onboarding_devices FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_device_provider_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_device_provider_refs FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_external_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_external_references FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_activation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_activation_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_prospect_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_prospect_admissions FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_prospect_security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_prospect_security_events FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_operator_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_operator_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_control_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_control_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_dead_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_dead_letters FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_inbox_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_inbox_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_audit FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_observability ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_observability FORCE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_operator_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.lifecycle_operator_corrections FORCE ROW LEVEL SECURITY;

CREATE POLICY lifecycle_users_tenant_isolation
    ON nofries.lifecycle_users
    FOR ALL
    TO nofries_runtime
    USING (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''));

CREATE POLICY lifecycle_organisations_tenant_isolation
    ON nofries.lifecycle_organisations
    FOR ALL
    TO nofries_runtime
    USING (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''));

CREATE POLICY lifecycle_onboarding_devices_tenant_isolation
    ON nofries.lifecycle_onboarding_devices
    FOR ALL
    TO nofries_runtime
    USING (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''));

CREATE POLICY lifecycle_device_provider_refs_tenant_isolation
    ON nofries.lifecycle_device_provider_refs
    FOR ALL
    TO nofries_runtime
    USING (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''));

CREATE POLICY lifecycle_external_references_tenant_isolation
    ON nofries.lifecycle_external_references
    FOR ALL
    TO nofries_runtime
    USING (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''));

CREATE POLICY lifecycle_activation_requests_tenant_isolation
    ON nofries.lifecycle_activation_requests
    FOR ALL
    TO nofries_runtime
    USING (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''));

CREATE POLICY lifecycle_conversations_tenant_isolation
    ON nofries.lifecycle_conversations
    FOR ALL
    TO nofries_runtime
    USING (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''));

CREATE POLICY lifecycle_prospect_admissions_tenant_isolation
    ON nofries.lifecycle_prospect_admissions
    FOR ALL
    TO nofries_runtime
    USING (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''));

CREATE POLICY lifecycle_prospect_security_events_tenant_isolation
    ON nofries.lifecycle_prospect_security_events
    FOR ALL
    TO nofries_runtime
    USING (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''));

CREATE POLICY lifecycle_approvals_tenant_isolation
    ON nofries.lifecycle_approvals
    FOR ALL
    TO nofries_runtime
    USING (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''));

CREATE POLICY lifecycle_operator_tasks_tenant_isolation
    ON nofries.lifecycle_operator_tasks
    FOR ALL
    TO nofries_runtime
    USING (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''));

CREATE POLICY lifecycle_schedules_tenant_isolation
    ON nofries.lifecycle_schedules
    FOR ALL
    TO nofries_runtime
    USING (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''));

CREATE POLICY lifecycle_control_runs_tenant_isolation
    ON nofries.lifecycle_control_runs
    FOR ALL
    TO nofries_runtime
    USING (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''));

CREATE POLICY lifecycle_dead_letters_tenant_isolation
    ON nofries.lifecycle_dead_letters
    FOR ALL
    TO nofries_runtime
    USING (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''));

CREATE POLICY lifecycle_inbox_receipts_tenant_select
    ON nofries.lifecycle_inbox_receipts
    FOR SELECT
    TO nofries_runtime
    USING (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''));

CREATE POLICY lifecycle_inbox_receipts_tenant_insert
    ON nofries.lifecycle_inbox_receipts
    FOR INSERT
    TO nofries_runtime
    WITH CHECK (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''));

CREATE POLICY lifecycle_inbox_receipts_tenant_update
    ON nofries.lifecycle_inbox_receipts
    FOR UPDATE
    TO nofries_runtime
    USING (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''));

CREATE POLICY lifecycle_audit_tenant_select
    ON nofries.lifecycle_audit
    FOR SELECT
    TO nofries_runtime
    USING (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''));

CREATE POLICY lifecycle_audit_tenant_insert
    ON nofries.lifecycle_audit
    FOR INSERT
    TO nofries_runtime
    WITH CHECK (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''));

CREATE POLICY lifecycle_observability_tenant_isolation
    ON nofries.lifecycle_observability
    FOR ALL
    TO nofries_runtime
    USING (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''));

CREATE POLICY lifecycle_operator_corrections_tenant_isolation
    ON nofries.lifecycle_operator_corrections
    FOR ALL
    TO nofries_runtime
    USING (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''))
    WITH CHECK (tenant_key = NULLIF(current_setting('nofries.tenant_id', true), ''));

REVOKE ALL ON
    nofries.lifecycle_users,
    nofries.lifecycle_organisations,
    nofries.lifecycle_onboarding_devices,
    nofries.lifecycle_device_provider_refs,
    nofries.lifecycle_external_references,
    nofries.lifecycle_activation_requests,
    nofries.lifecycle_conversations,
    nofries.lifecycle_prospect_admissions,
    nofries.lifecycle_prospect_security_events,
    nofries.lifecycle_approvals,
    nofries.lifecycle_operator_tasks,
    nofries.lifecycle_schedules,
    nofries.lifecycle_control_runs,
    nofries.lifecycle_dead_letters,
    nofries.lifecycle_inbox_receipts,
    nofries.lifecycle_audit,
    nofries.lifecycle_observability,
    nofries.lifecycle_operator_corrections
FROM PUBLIC;

REVOKE ALL ON
    nofries.lifecycle_users,
    nofries.lifecycle_organisations,
    nofries.lifecycle_onboarding_devices,
    nofries.lifecycle_device_provider_refs,
    nofries.lifecycle_external_references,
    nofries.lifecycle_activation_requests,
    nofries.lifecycle_conversations,
    nofries.lifecycle_prospect_admissions,
    nofries.lifecycle_prospect_security_events,
    nofries.lifecycle_approvals,
    nofries.lifecycle_operator_tasks,
    nofries.lifecycle_schedules,
    nofries.lifecycle_control_runs,
    nofries.lifecycle_dead_letters,
    nofries.lifecycle_inbox_receipts,
    nofries.lifecycle_audit,
    nofries.lifecycle_observability,
    nofries.lifecycle_operator_corrections
FROM nofries_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON
    nofries.lifecycle_users,
    nofries.lifecycle_organisations,
    nofries.lifecycle_onboarding_devices,
    nofries.lifecycle_device_provider_refs,
    nofries.lifecycle_external_references,
    nofries.lifecycle_activation_requests,
    nofries.lifecycle_conversations,
    nofries.lifecycle_prospect_admissions,
    nofries.lifecycle_prospect_security_events,
    nofries.lifecycle_approvals,
    nofries.lifecycle_operator_tasks,
    nofries.lifecycle_schedules,
    nofries.lifecycle_control_runs,
    nofries.lifecycle_dead_letters,
    nofries.lifecycle_observability,
    nofries.lifecycle_operator_corrections
TO nofries_runtime;

GRANT SELECT, INSERT
    ON nofries.lifecycle_audit
    TO nofries_runtime;

GRANT SELECT, INSERT
    ON nofries.lifecycle_inbox_receipts
    TO nofries_runtime;

GRANT UPDATE (rematerialized_at, rematerialized_by)
    ON nofries.lifecycle_inbox_receipts
    TO nofries_runtime;

REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON nofries.lifecycle_audit
    FROM nofries_runtime;

REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON nofries.lifecycle_inbox_receipts
    FROM nofries_runtime;

-- The runtime repositories only identify tenants and advance their module revision.
-- Removing destructive/ownership-adjacent rights keeps a compromised runtime from
-- deleting a tenant (and cascading all tenant data) or altering dependency graphs.
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON nofries.tenants, nofries.module_revisions
    FROM nofries_runtime;
