DROP TRIGGER app_owners_apps_update ON apps;
DROP TRIGGER app_owners_grants_delete ON grants;
DROP TRIGGER app_owners_grants_update ON grants;
DROP TRIGGER app_owners_grants_insert ON grants;
DROP TRIGGER app_owners_users_update ON users;
DROP FUNCTION app_owners_changed();

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
                       OR OLD.stopped_for_disk IS DISTINCT FROM NEW.stopped_for_disk)
    EXECUTE FUNCTION proxy_cache_changed();

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
    NEW.started_at := clock_timestamp();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE apps
    DROP COLUMN stopped_for_orphan,
    DROP COLUMN orphan_announced_at,
    DROP COLUMN orphaned_at;
