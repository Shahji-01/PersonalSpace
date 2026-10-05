-- Better Auth's JWT plugin (short-lived access tokens, ADR-013) stores its signing
-- key pairs in a `jwks` table. Without it, auth operations that resolve the signing
-- key fail. Keys are global (not per-user), so no RLS; only the auth role touches it.
CREATE TABLE jwks (
  id uuid PRIMARY KEY,
  public_key text NOT NULL,
  private_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  alg text,
  crv text
);
GRANT SELECT, INSERT, UPDATE, DELETE ON jwks TO personalspace_auth;
