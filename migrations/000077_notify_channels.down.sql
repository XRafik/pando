DROP TABLE IF EXISTS notify_authorizations;

DROP TRIGGER subscriptions_changed_update ON subscriptions;
CREATE TRIGGER subscriptions_changed_update
    AFTER UPDATE ON subscriptions
    FOR EACH ROW WHEN (OLD.enabled IS DISTINCT FROM NEW.enabled
                       OR OLD.events IS DISTINCT FROM NEW.events
                       OR OLD.app_id IS DISTINCT FROM NEW.app_id
                       OR OLD.created_at IS DISTINCT FROM NEW.created_at)
    EXECUTE FUNCTION subscriptions_changed();

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_channel_shape;
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_channel_is_notify;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS channel;
