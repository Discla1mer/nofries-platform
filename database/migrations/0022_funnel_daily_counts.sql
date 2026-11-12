-- Owner decision, 12 November 2026 (issue #151, Phase 2 design section 3):
-- aggregate-only daily funnel counts, built behind the default-off
-- NOFRIES_FUNNEL_COUNTS_ENABLED flag that arrives with the writer in F2. This
-- migration only creates the table; nothing writes to it until then.
--
-- One row per NZ calendar day (Pacific/Auckland, computed by the writer) and
-- closed event name. There is deliberately no tenant, account, subject, IP,
-- user-agent, referrer or cookie column: rows are site-wide totals and cannot
-- identify a visitor or customer. The count CHECK bounds a single day/event.
--
-- nofries_runtime may SELECT, INSERT and UPDATE (count) only, which is exactly
-- what INSERT ... ON CONFLICT (day, event) DO UPDATE SET count = count + 1
-- needs. It has no DELETE, TRUNCATE or key UPDATE, and no DELETE policy. RLS is
-- enabled and forced; the runtime policies are permissive because the rows
-- carry no tenant scope to bind.
--
-- Forward-only. The migration ledger skips it once recorded, so a second
-- migrate is a no-op. It refuses with funnel_daily_counts_precondition if the
-- runtime role is missing or the table already exists outside the ledger.
--
-- Rollback: DROP TABLE nofries.funnel_daily_counts (aggregate counts only; no
-- other object depends on it), then delete its schema_migrations row.
DO $precheck$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'nofries_runtime')
        OR to_regclass('nofries.funnel_daily_counts') IS NOT NULL THEN
        RAISE EXCEPTION 'funnel_daily_counts_precondition';
    END IF;
END
$precheck$;

CREATE TABLE nofries.funnel_daily_counts (
    day date NOT NULL,
    event text NOT NULL CHECK (event IN ('visit','signup_started','code_confirmed',
        'first_answer','submitted','result_viewed','enquiry_sent')),
    count bigint NOT NULL DEFAULT 0 CHECK (count BETWEEN 0 AND 10000000),
    PRIMARY KEY (day, event)
);

ALTER TABLE nofries.funnel_daily_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE nofries.funnel_daily_counts FORCE ROW LEVEL SECURITY;
CREATE POLICY funnel_daily_counts_runtime_select ON nofries.funnel_daily_counts
    FOR SELECT TO nofries_runtime
    USING (true);
CREATE POLICY funnel_daily_counts_runtime_insert ON nofries.funnel_daily_counts
    FOR INSERT TO nofries_runtime
    WITH CHECK (true);
CREATE POLICY funnel_daily_counts_runtime_update ON nofries.funnel_daily_counts
    FOR UPDATE TO nofries_runtime
    USING (true)
    WITH CHECK (true);
REVOKE ALL ON nofries.funnel_daily_counts FROM PUBLIC, nofries_runtime;
GRANT SELECT, INSERT ON nofries.funnel_daily_counts TO nofries_runtime;
GRANT UPDATE (count) ON nofries.funnel_daily_counts TO nofries_runtime;
