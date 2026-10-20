-- Apps with no active owner (R-406 – R-408).
--
-- An app is orphaned when its owner of record and every account holding Owner
-- on it are suspended or deleted, and no group holds Owner on it. The orphan
-- pass marks it orphaned_at, stops it when host policy says to
-- (stop_orphaned_apps, on by default), and tells administrators, recording
-- when in orphan_announced_at. orphaned_at goes back to NULL once the app has
-- an active owner again, so losing that owner is a new orphaning.
--
-- stopped_for_orphan records that Pando stopped it, as stopped_for_idle does.
-- Starting the app clears it and leaves orphaned_at alone: an administrator
-- who starts an orphaned app keeps it running (R-407).
ALTER TABLE apps
    ADD COLUMN orphaned_at         timestamptz,
    ADD COLUMN orphan_announced_at timestamptz,
    ADD COLUMN stopped_for_orphan  boolean NOT NULL DEFAULT false;

-- Apps already orphaned are marked and not stopped: an upgrade does not take
-- apps down (R-407). orphan_announced_at stays NULL, so the first pass tells
-- administrators about them.
UPDATE apps SET orphaned_at = now()
FROM (
    SELECT a.id
    FROM apps a
    LEFT JOIN grants g ON g.app_id = a.id AND g.plane = 'control' AND g.role_id = 'role_owner'
    LEFT JOIN users u ON u.id = a.owner_user_id
                      OR (g.principal_kind = 'user' AND u.id = g.principal_id)
    WHERE a.deleted_at IS NULL
    GROUP BY a.id, a.owner_user_id
    HAVING count(g.id) FILTER (WHERE g.principal_kind = 'group') = 0
       AND count(u.id) FILTER (WHERE u.status = 'active' AND u.deleted_at IS NULL) = 0
       AND (a.owner_user_id IS NOT NULL OR count(g.id) FILTER (WHERE g.principal_kind = 'user') > 0)
) orphaned
WHERE apps.id = orphaned.id;

-- Starting an app clears what Pando recorded about why it stopped it, in the
-- same write (migrations 69 and 71), now including a stop for having no owner.
CREATE OR REPLACE FUNCTION app_activity_started() RETURNS trigger AS $$
BEGIN
    INSERT INTO app_activity (app_id, last_activity_at)
    VALUES (NEW.id, now())
    ON CONFLICT (app_id) DO UPDATE
        SET last_activity_at = GREATEST(app_activity.last_activity_at, EXCLUDED.last_activity_at);
    NEW.stopped_for_idle := false;
    NEW.idle_stop_noticed_at := NULL;
    NEW.idle_delete_noticed_at := NULL;
    NEW.stopped_for_disk := false;
    NEW.disk_warned_at := NULL;
    NEW.disk_over_at := NULL;
    NEW.stopped_for_orphan := false;
    -- clock_timestamp, not now: a stop and a start in one transaction are
    -- still two values.
    NEW.started_at := clock_timestamp();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The proxy reads stopped_for_orphan to tell a visitor why the app is down.
DROP TRIGGER proxy_cache_apps_update ON apps;
CREATE TRIGGER proxy_cache_apps_update AFTER UPDATE ON apps
    FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state
                       OR OLD.desired_state IS DISTINCT FROM NEW.desired_state
                       OR OLD.pinned_spec_id IS DISTINCT FROM NEW.pinned_spec_id
                       OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
                       OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
                       OR OLD.slug IS DISTINCT FROM NEW.slug
                       OR OLD.name IS DISTINCT FROM NEW.name
                       OR OLD.address_hostname IS DISTINCT FROM NEW.address_hostname
                       OR OLD.address_path IS DISTINCT FROM NEW.address_path
                       OR OLD.address_port IS DISTINCT FROM NEW.address_port
                       OR OLD.stopped_for_idle IS DISTINCT FROM NEW.stopped_for_idle
                       OR OLD.stopped_for_disk IS DISTINCT FROM NEW.stopped_for_disk
                       OR OLD.stopped_for_orphan IS DISTINCT FROM NEW.stopped_for_orphan)
    EXECUTE FUNCTION proxy_cache_changed();

-- Tells the orphan pass that who owns an app may have changed, so an app is
-- stopped when its last owner goes rather than at the next scheduled pass.
-- Triggers rather than calls in the store, as for the proxy cache (migration
-- 68): a person can be suspended by SCIM, by an administrator, or by linking,
-- and any later path is told too.
CREATE FUNCTION app_owners_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('pando_app_owners', '');
    RETURN NULL;
END $$;

CREATE TRIGGER app_owners_users_update AFTER UPDATE ON users
    FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status
                       OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
    EXECUTE FUNCTION app_owners_changed();
CREATE TRIGGER app_owners_grants_insert AFTER INSERT ON grants
    FOR EACH ROW WHEN (NEW.role_id = 'role_owner')
    EXECUTE FUNCTION app_owners_changed();
CREATE TRIGGER app_owners_grants_update AFTER UPDATE ON grants
    FOR EACH ROW WHEN (OLD.role_id = 'role_owner' OR NEW.role_id = 'role_owner')
    EXECUTE FUNCTION app_owners_changed();
CREATE TRIGGER app_owners_grants_delete AFTER DELETE ON grants
    FOR EACH ROW WHEN (OLD.role_id = 'role_owner')
    EXECUTE FUNCTION app_owners_changed();
CREATE TRIGGER app_owners_apps_update AFTER UPDATE ON apps
    FOR EACH ROW WHEN (OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id)
    EXECUTE FUNCTION app_owners_changed();
