-- Lifecycle email hardening (Part of #151): a link unsubscribe is permanent in
-- the database, not only in application code. Until now nofries_runtime held
-- UPDATE (unsubscribed_at, source) on nofries.email_preferences under the
-- subject policy, so any runtime path could clear or relabel a 'link' row.
--
-- One BEFORE INSERT OR UPDATE row trigger, nofries.guard_email_preference():
-- - a 'link' row must carry an unsubscribed_at (insert and update);
-- - once a row is 'link', no update may change any column of it, so its time
--   cannot move and it can never become 'settings' or be cleared.
-- A 'settings' row still toggles freely, and may become 'link' (the
-- unsubscribe endpoint's upsert, before and after the E7 settings change). A
-- no-op update of a link row passes. DELETE and TRUNCATE are not granted to
-- anyone and are not affected. The guard binds every role, the owner included;
-- a deliberate owner correction needs this trigger disabled in a reviewed step.
--
-- Like the 0011 guards it is an invoker function with a fixed search path and
-- no EXECUTE grant; it confers no privilege. No grant, policy or role changes.
--
-- Forward-only. The migration ledger skips it once recorded, so a second
-- migrate is a no-op. It refuses with email_preferences_link_guard_precondition
-- if the table is missing, the function or trigger already exists outside the
-- ledger, or nofries_runtime or nofries_email_dispatcher could act as the
-- table owner (and so disable the trigger); and with
-- email_preferences_link_rows_invalid if any 'link' row has no unsubscribed_at.
--
-- Rollback: DROP TRIGGER email_preferences_link_guard ON
-- nofries.email_preferences; DROP FUNCTION nofries.guard_email_preference();
-- then delete its schema_migrations row. Rolling back reopens runtime writes to
-- link rows, so do it only together with the application code that relies on it.
DO $precheck$
BEGIN
    IF to_regclass('nofries.email_preferences') IS NULL
        OR to_regprocedure('nofries.guard_email_preference()') IS NOT NULL
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'email_preferences_link_guard')
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_roles capability
            ON capability.rolname IN ('nofries_runtime', 'nofries_email_dispatcher')
            WHERE relation.oid = to_regclass('nofries.email_preferences')
              AND pg_catalog.pg_has_role(capability.oid, relation.relowner, 'MEMBER')) THEN
        RAISE EXCEPTION 'email_preferences_link_guard_precondition';
    END IF;
    IF EXISTS (SELECT 1 FROM nofries.email_preferences WHERE source = 'link' AND unsubscribed_at IS NULL) THEN
        RAISE EXCEPTION 'email_preferences_link_rows_invalid';
    END IF;
END
$precheck$;

CREATE FUNCTION nofries.guard_email_preference() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, nofries AS $guard$
BEGIN
    IF NEW.source = 'link' AND NEW.unsubscribed_at IS NULL
        OR TG_OP = 'UPDATE' AND OLD.source = 'link' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
        RAISE EXCEPTION 'email_preference_link_permanent';
    END IF;
    RETURN NEW;
END
$guard$;
REVOKE ALL ON FUNCTION nofries.guard_email_preference() FROM PUBLIC, nofries_runtime, nofries_email_dispatcher;
CREATE TRIGGER email_preferences_link_guard BEFORE INSERT OR UPDATE ON nofries.email_preferences
    FOR EACH ROW EXECUTE FUNCTION nofries.guard_email_preference();
