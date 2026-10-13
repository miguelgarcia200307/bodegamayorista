-- Entorno mínimo que imita lo que Supabase ya trae instalado (roles, auth, storage
-- y privilegios por defecto). Solo se usa en pruebas locales con PGlite; jamás se
-- aplica a un proyecto remoto.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema extensions;
create schema auth;
create schema storage;
create table auth.users(id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create table storage.buckets(id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid);
alter table storage.objects enable row level security;
grant usage on schema auth, storage, extensions, public to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated;
grant select on storage.buckets to anon, authenticated;
grant all on storage.objects to anon, authenticated;
-- Supabase concede por defecto todo a anon/authenticated sobre objetos nuevos de public.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
