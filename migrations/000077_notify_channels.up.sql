-- A notification adapter that posts to any of a workspace's channels — Slack,
-- as Pando's own app — has each subscription name the channel it posts to
-- (R-367, R-374). Only a subscription to an adapter can name one; a webhook's
-- destination is its URL.
ALTER TABLE subscriptions ADD COLUMN channel text;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_channel_is_notify
    CHECK (channel IS NULL OR destination = 'notify');
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_channel_shape
    CHECK (channel IS NULL OR (channel <> '' AND length(channel) <= 200));

-- Every replica keeps the enabled subscriptions in memory (000061) and sends
-- with what it holds, so where one sends is what routing reads too: a changed
-- adapter or channel is told like a changed filter.
DROP TRIGGER subscriptions_changed_update ON subscriptions;
CREATE TRIGGER subscriptions_changed_update
    AFTER UPDATE ON subscriptions
    FOR EACH ROW WHEN (OLD.enabled IS DISTINCT FROM NEW.enabled
                       OR OLD.events IS DISTINCT FROM NEW.events
                       OR OLD.app_id IS DISTINCT FROM NEW.app_id
                       OR OLD.adapter_id IS DISTINCT FROM NEW.adapter_id
                       OR OLD.channel IS DISTINCT FROM NEW.channel
                       OR OLD.created_at IS DISTINCT FROM NEW.created_at)
    EXECUTE FUNCTION subscriptions_changed();

-- Connecting a notification adapter that has not finished: what the adapter
-- needs back at the callback (for Slack, the app it created and its client
-- secret), the state the callback must present, and when it stops being
-- worth waiting for. Sealed by the install's secrets adapter under the scope
-- `notify-authorization:`, the same shape as source_authorizations (000063),
-- so a callback that reaches another replica finds it. Removed when the
-- connection completes or a new one starts.
CREATE TABLE notify_authorizations (
    adapter_id   text NOT NULL REFERENCES adapter_configs(id) ON DELETE CASCADE,
    field        text NOT NULL CHECK (field ~ '^[a-z][a-z0-9_]*$'),
    adapter_ref  text NOT NULL,     -- the secrets adapter that sealed it
    ciphertext   bytea,
    external_ref text,
    version      integer NOT NULL DEFAULT 1,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (adapter_id, field),
    CHECK (ciphertext IS NOT NULL OR external_ref IS NOT NULL)
);
