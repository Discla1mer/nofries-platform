-- Held inverse for a separately approved transaction; outside the migration catalogue.
-- Lock before the emptiness check, including the parent tables that the FKs reference.
-- Abort if forced row security would hide even one retained link from this owner.
SET LOCAL row_security = off;
LOCK TABLE nofries.dashboard_improvement_heads, nofries.dashboard_improvement_revisions,
           nofries.dashboard_framework_revisions IN ACCESS EXCLUSIVE MODE;
DO $rollback$
BEGIN
    IF EXISTS (SELECT 1 FROM nofries.dashboard_improvement_revisions WHERE paid_item_id IS NOT NULL) THEN
        RAISE EXCEPTION 'retained paid plans require a recovery decision';
    END IF;
END
$rollback$;
DROP POLICY plan_head_runtime_legacy ON nofries.dashboard_improvement_heads;
DROP POLICY plan_runtime_legacy ON nofries.dashboard_improvement_revisions;
DROP TRIGGER plan_gap_source ON nofries.dashboard_improvement_revisions;
DROP FUNCTION nofries.check_plan_gap_source();
ALTER TABLE nofries.dashboard_improvement_revisions
    DROP CONSTRAINT plan_ncsc_source, DROP CONSTRAINT plan_paid_source, DROP CONSTRAINT plan_source_shape,
    DROP COLUMN ncsc_assessment_id, DROP COLUMN paid_item_id, DROP COLUMN paid_profile_version, DROP COLUMN paid_profile_id,
    ADD CONSTRAINT dashboard_improvement_revisions_assessment_revision_check CHECK (assessment_revision BETWEEN 0 AND 128),
    ADD CONSTRAINT dashboard_improvement_revisio_tenant_id_organisation_id_as_fkey FOREIGN KEY
        (tenant_id, organisation_id, assessment_id, assessment_revision, assessment_sha256)
        REFERENCES nofries.dashboard_ncsc_assessment_revisions (tenant_id, organisation_id, assessment_id, revision, payload_sha256)
        ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE nofries.dashboard_framework_revisions DROP CONSTRAINT framework_revision_digest_key;
