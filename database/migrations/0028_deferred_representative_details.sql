-- Stream E: supplemental agreement evidence only. No historical row is rewritten.
-- Runtime may insert once and read within its selected tenant/organisation.
-- Retain with the linked acceptance receipt; no runtime/wipe update or delete grant.
CREATE TABLE nofries.dashboard_representative_details (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    subject_key text NOT NULL,
    receipt_id text NOT NULL,
    payload jsonb NOT NULL,
    payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
    PRIMARY KEY (tenant_id, organisation_id),
    FOREIGN KEY (tenant_id, organisation_id, receipt_id)
        REFERENCES nofries.signup_acceptance_receipts (tenant_id, organisation_id, receipt_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (octet_length(payload::text) <= 16384 AND (
        jsonb_typeof(payload) = 'object'
        AND payload ?& ARRAY['link','details','recordedAt']
        AND payload - ARRAY['link','details','recordedAt'] = '{}'::jsonb
        AND payload#>>'{link,tenantId}' = tenant_id
        AND payload#>>'{link,organisationId}' = organisation_id
        AND payload#>>'{link,subjectKey}' = subject_key
        AND payload#>>'{link,receiptId}' = receipt_id
        AND payload#>>'{link,schemaVersion}' = '1'
        AND jsonb_typeof(payload->'details') = 'object'
        AND (payload->'details') ?& ARRAY['name','role','address']
        AND (payload->'details') - ARRAY['name','role','address'] = '{}'::jsonb
    ) IS TRUE)
);
ALTER TABLE nofries.dashboard_representative_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_representative_details FORCE ROW LEVEL SECURITY;
CREATE POLICY representative_details_scope ON nofries.dashboard_representative_details TO nofries_runtime
    USING (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), '')
        AND organisation_id = NULLIF(current_setting('nofries.organisation_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), '')
        AND organisation_id = NULLIF(current_setting('nofries.organisation_id', true), '')
        AND subject_key = NULLIF(current_setting('nofries.subject_key', true), '')
        AND EXISTS (SELECT 1 FROM nofries.signup_acceptance_receipts a
            WHERE a.tenant_id = dashboard_representative_details.tenant_id
            AND a.organisation_id = dashboard_representative_details.organisation_id
            AND a.receipt_id = dashboard_representative_details.receipt_id AND a.subject_key = dashboard_representative_details.subject_key));
REVOKE ALL ON nofries.dashboard_representative_details FROM PUBLIC, nofries_runtime;
GRANT SELECT, INSERT ON nofries.dashboard_representative_details TO nofries_runtime;

-- A non-personal enrollment marker prevents a subject-private starter row
-- hidden by RLS from being mistaken for a legacy agreement. No backfill.
CREATE TABLE nofries.dashboard_deferred_agreements (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    PRIMARY KEY (tenant_id, organisation_id),
    FOREIGN KEY (tenant_id, organisation_id) REFERENCES nofries.dashboard_starter_scopes (tenant_id, organisation_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);
ALTER TABLE nofries.dashboard_deferred_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_deferred_agreements FORCE ROW LEVEL SECURITY;
CREATE POLICY deferred_agreements_scope ON nofries.dashboard_deferred_agreements TO nofries_runtime
    USING (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), '')
        AND organisation_id = NULLIF(current_setting('nofries.organisation_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), '')
        AND organisation_id = NULLIF(current_setting('nofries.organisation_id', true), ''));
REVOKE ALL ON nofries.dashboard_deferred_agreements FROM PUBLIC, nofries_runtime;
GRANT SELECT, INSERT ON nofries.dashboard_deferred_agreements TO nofries_runtime;
CREATE FUNCTION nofries.record_deferred_agreement() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, nofries AS $guard$
BEGIN
    IF NEW.preparation#>>'{source,offerInput,detailsPolicy}' = 'after-first-result-v1' THEN
        INSERT INTO nofries.dashboard_deferred_agreements (tenant_id, organisation_id)
            VALUES (NEW.tenant_id, NEW.organisation_id);
    END IF;
    RETURN NEW;
END
$guard$;
REVOKE ALL ON FUNCTION nofries.record_deferred_agreement() FROM PUBLIC, nofries_runtime;
CREATE TRIGGER record_deferred_agreement AFTER INSERT ON nofries.dashboard_starter_scopes
    FOR EACH ROW EXECUTE FUNCTION nofries.record_deferred_agreement();
