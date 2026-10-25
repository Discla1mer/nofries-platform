-- Mutable current registration references, separate from immutable terms proof.
-- identity_tenant_id is the IdP partition, NOT the logical customer tenant.
CREATE TABLE nofries.signup_registrations (
    identity_tenant_id text NOT NULL,
    subject_key text NOT NULL,
    revision bigint NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (identity_tenant_id, subject_key),
    CHECK (subject_key ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}:[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
    CHECK (identity_tenant_id = split_part(subject_key, ':', 1)),
    CHECK (revision BETWEEN 0 AND 9007199254740991),
    CHECK (octet_length(payload::text) <= 262144),
    CHECK ((jsonb_typeof(payload) = 'object'
        AND payload ?& ARRAY['schemaVersion','subjectKey','revision','selected','registrations']
        AND payload - ARRAY['schemaVersion','subjectKey','revision','selected','registrations'] = '{}'::jsonb
        AND payload -> 'schemaVersion' = '1'::jsonb
        AND payload ->> 'subjectKey' = subject_key
        AND payload -> 'revision' = to_jsonb(revision)
        AND jsonb_typeof(payload -> 'registrations') = 'array'
        AND jsonb_array_length(payload -> 'registrations') <= 128
        AND (payload -> 'selected' = 'null'::jsonb OR jsonb_typeof(payload -> 'selected') = 'object')) IS TRUE)
);

ALTER TABLE nofries.signup_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.signup_registrations FORCE ROW LEVEL SECURITY;
CREATE POLICY signup_registrations_subject ON nofries.signup_registrations
    TO nofries_runtime
    USING (identity_tenant_id = NULLIF(current_setting('nofries.tenant_id', true), '')
        AND subject_key = NULLIF(current_setting('nofries.signup_subject_key', true), ''))
    WITH CHECK (identity_tenant_id = NULLIF(current_setting('nofries.tenant_id', true), '')
        AND subject_key = NULLIF(current_setting('nofries.signup_subject_key', true), ''));
REVOKE ALL ON nofries.signup_registrations FROM PUBLIC, nofries_runtime;
GRANT SELECT, INSERT, UPDATE ON nofries.signup_registrations TO nofries_runtime;
-- No DELETE, public route, membership grant or modification of receipt retention.
