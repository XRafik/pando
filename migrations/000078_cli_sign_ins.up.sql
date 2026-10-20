-- Signing the CLI in through the browser (R-406, design 06 §3.5). A person
-- signed in to the console approves a CLI on their machine; the CLI gets a
-- one-time code at a loopback address, or from the person's clipboard, and
-- trades it with the PKCE verifier only it holds for a delegated token
-- (R-058). This is the approval between those two steps.
--
-- Only the code's SHA-256 is kept, as with an SSO handoff code (000037). A row
-- is deleted the first time anyone tries its code, right verifier or wrong,
-- so a code is spent once; one nobody tried is removed by retention once
-- expired. Nothing here is a credential until it is traded: the token is made
-- then, so no token secret is ever stored waiting to be collected.
CREATE TABLE cli_sign_ins (
    code_hash      text PRIMARY KEY,
    user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    approved_by    text NOT NULL,
    -- base64url(SHA-256(verifier)) without padding: always 43 characters (RFC 7636).
    code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
    token_name     text NOT NULL CHECK (length(token_name) BETWEEN 1 AND 200),
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL
);

CREATE INDEX cli_sign_ins_expires_at ON cli_sign_ins (expires_at);
