-- Requires the restricted capability in 0025 and both forced-RLS tables in 0028.
-- Rollback: revert the repository wipe list, drop these two policies and revoke
-- these two table grants from the wipe role. This cannot restore wiped rows.
GRANT SELECT, DELETE ON nofries.dashboard_deferred_agreements, nofries.dashboard_representative_details
    TO nofries_account_wipe;

CREATE POLICY deferred_agreements_account_wipe ON nofries.dashboard_deferred_agreements
    FOR ALL TO nofries_account_wipe
    USING (tenant_id = NULLIF(current_setting('nofries.wipe_tenant_id', true), ''))
    WITH CHECK (false);

CREATE POLICY representative_details_account_wipe ON nofries.dashboard_representative_details
    FOR ALL TO nofries_account_wipe
    USING (tenant_id = NULLIF(current_setting('nofries.wipe_tenant_id', true), ''))
    WITH CHECK (false);
