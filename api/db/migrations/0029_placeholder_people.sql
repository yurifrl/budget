-- 0029 · Placeholder people (grouping, not permission).
--   A budget can list a person before they have an email: users.email becomes
--   nullable, but only for placeholders, which must carry a name. A placeholder
--   has no google_sub, role 'user', and can never sign in (a session always
--   carries an email, and NULL never matches in `on conflict (email)` or the
--   allow-list). Linking an email later sets it, or merges the placeholder into
--   the existing user with that email (server/user/store.ts).
--   The email CHECKs from 0012 are unnamed, so they are found in the catalog.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.users'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%email%'
  loop
    execute format('alter table public.users drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.users alter column email drop not null;

alter table public.users
  add constraint users_email_valid
    check (email is null or (email <> '' and email = lower(trim(email))));

alter table public.users
  add constraint users_placeholder_named
    check (email is not null or (name is not null and trim(name) <> ''));

create index if not exists users_placeholder_idx on public.users(id) where email is null;
