-- Multi-user identity foundation (v1.1 Phase 1): one persisted user per
-- Google identity, keyed on the immutable Google `sub`, with the email as
-- the operational join key (stateless session JWTs carry only sub = email).
-- Roles and status are DB-authoritative: the server/user module reads them
-- from this table on every request (never cached at module scope).
CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  google_sub text UNIQUE,
  email text NOT NULL UNIQUE CHECK (email <> '') CHECK (email = lower(trim(email))),
  name text,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
