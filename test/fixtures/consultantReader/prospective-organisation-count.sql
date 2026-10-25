-- Organisation count is not a product limit. Keep the original own-workspace
-- uniqueness and company-only-own rule; client identity is its existing unique
-- tenant/organisation/binding/authority tuple, not an account-wide slot number.
-- Existing ordinal values and all retained preparation/activation bytes stay put.
ALTER TABLE nofries.dashboard_starter_scopes
    DROP CONSTRAINT dashboard_starter_scopes_check,
    DROP CONSTRAINT dashboard_starter_scopes_account_id_ordinal_key;
ALTER TABLE nofries.dashboard_starter_scopes
    ADD CONSTRAINT dashboard_starter_scopes_ordinal_check
        CHECK (ordinal >= 0 AND (account_type = 'consultant' OR ordinal = 0));
CREATE UNIQUE INDEX dashboard_starter_scopes_own_account_unique
    ON nofries.dashboard_starter_scopes (account_id) WHERE ordinal = 0;
