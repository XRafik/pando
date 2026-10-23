-- An attempt is counted before it is checked (R-075a, R-404, R-405), so a
-- row is pending until the check settles it as a failure or takes it back.
-- Pending rows still hold a burst of guesses to the limit, but a limit reached
-- only by pending rows waits for them instead of refusing, so concurrent right
-- passwords are not refused for each other.
ALTER TABLE failed_attempts ADD COLUMN pending boolean NOT NULL DEFAULT false;
