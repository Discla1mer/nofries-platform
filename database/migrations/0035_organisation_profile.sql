-- #608 step 1: an organisation's own profile (website, industry, region, size).
-- One row per organisation, written by the customer runtime inside its selected
-- tenant and organisation, stamped with the signed-in subject. No fetch happens
-- here; the website is stored as a normalised https root only.
-- Staff reset keeps the profile (it describes the organisation, like its name);
-- staff delete removes it with the organisation. Revision ordering (optimistic
-- concurrency) is enforced by the application, not by this table.
-- Forward-only. It refuses with organisation_profiles_precondition if a role it
-- grants to is missing.
DO $precheck$
BEGIN
    IF to_regclass('nofries.dashboard_organisation_profiles') IS NOT NULL THEN
        RAISE EXCEPTION 'organisation_profiles_already_exists';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'nofries_runtime')
        OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'nofries_account_wipe') THEN
        RAISE EXCEPTION 'organisation_profiles_precondition';
    END IF;
END
$precheck$;

CREATE TABLE nofries.dashboard_organisation_profiles (
    tenant_id text NOT NULL,
    organisation_id text NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    website text CHECK (website IS NULL OR (length(website) <= 255
        AND website ~ '^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z]([a-z0-9-]{0,61}[a-z0-9])?/$')),
    industry text CHECK (industry IS NULL OR industry IN ('agriculture', 'construction', 'manufacturing', 'retail',
        'hospitality', 'transport', 'professional', 'finance', 'health', 'education', 'community', 'technology', 'other')),
    region text CHECK (region IS NULL OR region IN ('northland', 'auckland', 'waikato', 'bay-of-plenty', 'gisborne',
        'hawkes-bay', 'taranaki', 'manawatu-whanganui', 'wellington', 'tasman', 'nelson', 'marlborough', 'west-coast',
        'canterbury', 'otago', 'southland', 'outside-nz')),
    size_band text CHECK (size_band IS NULL OR size_band IN ('just-me', '2-5', '6-20', '21-50', '51-200', '200-plus')),
    updated_at timestamptz(3) NOT NULL CHECK (isfinite(updated_at)),
    updated_by text NOT NULL CHECK (updated_by ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    PRIMARY KEY (tenant_id, organisation_id),
    FOREIGN KEY (tenant_id, organisation_id) REFERENCES nofries.dashboard_organisations
        (tenant_id, organisation_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
ALTER TABLE nofries.dashboard_organisation_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.dashboard_organisation_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY organisation_profiles_scope ON nofries.dashboard_organisation_profiles TO nofries_runtime
    USING (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), '')
        AND organisation_id = NULLIF(current_setting('nofries.organisation_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('nofries.tenant_id', true), '')
        AND organisation_id = NULLIF(current_setting('nofries.organisation_id', true), '')
        AND updated_by = NULLIF(current_setting('nofries.subject_key', true), ''));
CREATE POLICY organisation_profiles_account_wipe ON nofries.dashboard_organisation_profiles
    FOR ALL TO nofries_account_wipe
    USING (tenant_id = NULLIF(current_setting('nofries.wipe_tenant_id', true), '')) WITH CHECK (false);

REVOKE ALL ON nofries.dashboard_organisation_profiles FROM PUBLIC, nofries_runtime, nofries_account_wipe;
GRANT SELECT, INSERT ON nofries.dashboard_organisation_profiles TO nofries_runtime;
GRANT UPDATE (revision, website, industry, region, size_band, updated_at, updated_by)
    ON nofries.dashboard_organisation_profiles TO nofries_runtime;
GRANT SELECT (tenant_id), DELETE ON nofries.dashboard_organisation_profiles TO nofries_account_wipe;

-- Rollback, while no runtime reads or writes the table: DROP TABLE
-- nofries.dashboard_organisation_profiles (its policies and grants go with it)
-- and remove this migration's ledger entry. Customer-entered profile data is lost.
