-- Bodega Mayorista F.C. — CRM: privacidad por finalidad, eventos de navegación propios,
-- identidad por niveles, relaciones de productos y agregados privados del análisis.
-- Incremental: no modifica migraciones anteriores ni importes históricos.
-- La captura de navegación queda DESACTIVADA (site_settings.tracking_enabled = false)
-- hasta que el propietario configure textos, versiones y responsable del tratamiento.

-- ---------------------------------------------------------------------------
-- 0. Roles del personal. Los administradores existentes quedan como 'propietario' y
--    is_admin() conserva exactamente su significado (acceso total). 'vendedor' y
--    'catalogo' solo obtienen lo que se les concede explícitamente en el servidor.
-- ---------------------------------------------------------------------------
alter table public.admins add column if not exists role text not null default 'propietario' check (role in ('propietario','vendedor','catalogo'));

create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.admins where user_id = auth.uid() and role = 'propietario')
$$;
create or replace function public.has_staff_role(roles text[]) returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.admins where user_id = auth.uid() and role = any(roles))
$$;
create or replace function public.staff_role() returns text language sql stable security definer set search_path = public as $$
  select role from public.admins where user_id = auth.uid()
$$;
revoke all on function public.has_staff_role(text[]), public.staff_role() from public;
grant execute on function public.is_admin(), public.has_staff_role(text[]), public.staff_role() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. Configuración de privacidad y retención
-- ---------------------------------------------------------------------------
alter table public.site_settings
  add column if not exists privacy_controller_name text,
  add column if not exists privacy_controller_id text,
  add column if not exists privacy_requests_channel text,
  add column if not exists analytics_consent_text text,
  add column if not exists analytics_consent_version text,
  add column if not exists personalization_consent_text text,
  add column if not exists tracking_enabled boolean not null default false,
  add column if not exists raw_event_retention_days integer not null default 90 check (raw_event_retention_days between 7 and 730),
  add column if not exists aggregate_retention_days integer not null default 365 check (aggregate_retention_days between 30 and 1095),
  add column if not exists contact_cooldown_days integer not null default 7 check (contact_cooldown_days between 0 and 90);

-- Contexto de compra declarado o revisado por el comerciante (no se deduce solo).
alter table public.customers
  add column if not exists buying_context text not null default 'desconocido' check (buying_context in ('desconocido','consumo','regalo','reventa')),
  add column if not exists buying_context_source text,
  add column if not exists buying_context_at timestamptz;
grant update (buying_context, buying_context_source, buying_context_at) on public.customers to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Relaciones de productos configurables
-- ---------------------------------------------------------------------------
create table public.product_relationships (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('product','category')),
  source_id uuid not null,
  target_type text not null check (target_type in ('product','category')),
  target_id uuid not null,
  kind text not null check (kind in ('complemento','alternativa','compatible_con','reposicion','excluir')),
  strength numeric(3,2) not null default 0.7 check (strength > 0 and strength <= 1),
  reposition_days integer check (reposition_days is null or reposition_days between 1 and 3650),
  note text check (note is null or length(note) <= 200),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_type, source_id, target_type, target_id, kind),
  check (kind <> 'reposicion' or reposition_days is not null),
  -- Compatibilidad solo entre productos/modelos concretos, nunca por categoría o marca.
  check (kind <> 'compatible_con' or (source_type = 'product' and target_type = 'product'))
);
create trigger product_relationships_updated_at before update on public.product_relationships for each row execute function public.set_updated_at();

create or replace function public.product_relationships_validate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.source_type = 'product' and not exists (select 1 from public.products where id = new.source_id) then raise exception 'Producto de origen no encontrado'; end if;
  if new.source_type = 'category' and not exists (select 1 from public.categories where id = new.source_id) then raise exception 'Categoría de origen no encontrada'; end if;
  if new.target_type = 'product' and not exists (select 1 from public.products where id = new.target_id) then raise exception 'Producto destino no encontrado'; end if;
  if new.target_type = 'category' and not exists (select 1 from public.categories where id = new.target_id) then raise exception 'Categoría destino no encontrada'; end if;
  return new;
end $$;
create trigger product_relationships_validate before insert or update on public.product_relationships for each row execute function public.product_relationships_validate();

-- ---------------------------------------------------------------------------
-- 3. Visitantes seudónimos, consentimiento por finalidad, sesiones y eventos
-- ---------------------------------------------------------------------------
-- El navegador guarda id + secreto aleatorio; aquí solo vive el hash del secreto. Sin
-- autorización de analítica no se crea visitante ni se guarda ningún evento.
create table public.visitors (
  id uuid primary key default gen_random_uuid(),
  secret_hash text not null,
  consent_analytics boolean not null default false,
  consent_personalization boolean not null default false,
  consent_version text not null,
  consent_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create table public.visitor_consent_events (
  id bigint generated always as identity primary key,
  visitor_id uuid not null references public.visitors(id) on delete cascade,
  analytics boolean not null,
  personalization boolean not null,
  text_version text not null,
  action text not null check (action in ('otorgado','actualizado','retirado')),
  recorded_at timestamptz not null default now()
);
create table public.visitor_sessions (
  id uuid primary key,
  visitor_id uuid not null references public.visitors(id) on delete cascade,
  started_at timestamptz not null default now(),
  last_event_at timestamptz not null default now(),
  campaign jsonb not null default '{}'::jsonb
);
create table public.behavior_events (
  event_id uuid primary key,
  visitor_id uuid not null references public.visitors(id) on delete cascade,
  session_id uuid not null references public.visitor_sessions(id) on delete cascade,
  event_type text not null,
  event_version smallint not null default 1,
  product_id uuid references public.products(id) on delete set null,
  variant_id uuid references public.product_variants(id) on delete set null,
  properties jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  source text not null default 'tienda',
  consent_version text not null
);
create index behavior_events_visitor_idx on public.behavior_events(visitor_id, occurred_at desc);
create index behavior_events_product_idx on public.behavior_events(product_id, received_at desc) where product_id is not null;
create index behavior_events_received_idx on public.behavior_events(received_at);
create index visitor_sessions_visitor_idx on public.visitor_sessions(visitor_id, started_at desc);

-- Agregados minimizados (sin visitante) para tendencias y medición tras depurar crudos.
create table public.behavior_daily_aggregates (
  day date not null,
  product_id uuid not null references public.products(id) on delete cascade,
  event_type text not null,
  events integer not null default 0,
  sessions integer not null default 0,
  primary key (day, product_id, event_type)
);

-- ---------------------------------------------------------------------------
-- 4. Identidad por niveles: declarado (pedido) ≠ verificado (posesión del canal)
-- ---------------------------------------------------------------------------
create table public.identity_links (
  id uuid primary key default gen_random_uuid(),
  visitor_id uuid not null references public.visitors(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete restrict,
  level text not null check (level in ('declarado','verificado','conflicto','desvinculado')),
  method text not null check (method in ('telefono_en_pedido','whatsapp_entrante','verificacion_comercial')),
  evidence jsonb not null default '{}'::jsonb,
  -- Alcance: solo eventos dentro de [scope_from, scope_to] (y de la sesión, si se indica).
  session_id uuid references public.visitor_sessions(id) on delete set null,
  scope_from timestamptz not null,
  scope_to timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  ended_reason text
);
create index identity_links_customer_idx on public.identity_links(customer_id, level);
create index identity_links_visitor_idx on public.identity_links(visitor_id);

create table public.identity_verifications (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  visitor_id uuid not null references public.visitors(id) on delete cascade,
  session_id uuid,
  phone_normalized text not null,
  status text not null default 'pendiente' check (status in ('pendiente','verificada','rechazada','expirada')),
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  note text
);
create index identity_verifications_status_idx on public.identity_verifications(status, requested_at desc);

create table public.maintenance_runs (
  id bigint generated always as identity primary key,
  task text not null,
  result jsonb not null default '{}'::jsonb,
  ran_by uuid,
  ran_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5. Funciones del visitante (anónimas, solo escritura acotada)
-- ---------------------------------------------------------------------------
create or replace function public.request_fingerprint() returns text
language sql stable set search_path = pg_catalog as $$
  select encode(sha256(convert_to(coalesce(split_part(nullif(current_setting('request.headers', true), '')::json->>'x-forwarded-for', ',', 1), 'sin-ip'), 'UTF8')), 'hex')
$$;

create or replace function public.visitor_valid(target uuid, secret text) returns public.visitors
language sql stable security definer set search_path = public, pg_catalog as $$
  select v.* from public.visitors v
  where v.id = target and v.revoked_at is null and length(coalesce(secret, '')) between 32 and 128
    and v.secret_hash = encode(sha256(convert_to(secret, 'UTF8')), 'hex')
$$;

-- Crea el visitante solo con autorización de analítica y la captura habilitada.
create or replace function public.register_visitor(consent jsonb)
returns table(visitor_id uuid, visitor_secret text)
language plpgsql security definer set search_path = public, pg_catalog as $$
declare cfg public.site_settings; secret text; created uuid; recent integer;
begin
  select * into cfg from public.site_settings where id = 1;
  if not cfg.tracking_enabled then raise exception using errcode = 'BM020', message = 'La analítica no está habilitada'; end if;
  if coalesce((consent->>'analytics')::boolean, false) is not true then raise exception 'Se requiere autorización de analítica'; end if;
  if coalesce(consent->>'version', '') <> coalesce(cfg.analytics_consent_version, '') or cfg.analytics_consent_version is null then
    raise exception 'La versión del texto de autorización no coincide';
  end if;
  select count(*) into recent from public.visitors where created_at > now() - interval '1 hour';
  if recent >= 3000 then raise exception using errcode = 'BM021', message = 'Límite temporal de registro alcanzado'; end if;
  secret := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.visitors(secret_hash, consent_analytics, consent_personalization, consent_version)
  values (encode(sha256(convert_to(secret, 'UTF8')), 'hex'), true, coalesce((consent->>'personalization')::boolean, false), cfg.analytics_consent_version)
  returning id into created;
  insert into public.visitor_consent_events(visitor_id, analytics, personalization, text_version, action)
  values (created, true, coalesce((consent->>'personalization')::boolean, false), cfg.analytics_consent_version, 'otorgado');
  return query select created, secret;
end $$;

-- Cambia o retira la autorización. Retirar la analítica detiene la captura, borra los
-- eventos crudos del visitante y termina sus vínculos de identidad (se conserva la prueba
-- del consentimiento y los documentos comerciales).
create or replace function public.set_visitor_consent(target uuid, secret text, consent jsonb) returns boolean
language plpgsql security definer set search_path = public, pg_catalog as $$
declare v public.visitors; analytics boolean; personalization boolean;
begin
  select * into v from public.visitor_valid(target, secret);
  if v.id is null then return false; end if;
  analytics := coalesce((consent->>'analytics')::boolean, false);
  personalization := analytics and coalesce((consent->>'personalization')::boolean, false);
  insert into public.visitor_consent_events(visitor_id, analytics, personalization, text_version, action)
  values (v.id, analytics, personalization, coalesce(nullif(consent->>'version', ''), v.consent_version), case when analytics then 'actualizado' else 'retirado' end);
  if not analytics then
    delete from public.behavior_events where visitor_id = v.id;
    update public.identity_links set level = 'desvinculado', scope_to = coalesce(scope_to, now()), ended_reason = 'autorizacion_retirada' where visitor_id = v.id and level <> 'desvinculado';
    update public.identity_verifications set status = 'expirada', resolved_at = now(), note = 'Autorización retirada' where visitor_id = v.id and status = 'pendiente';
    update public.visitors set consent_analytics = false, consent_personalization = false, revoked_at = now() where id = v.id;
  else
    update public.visitors set consent_personalization = personalization where id = v.id;
    if not personalization then
      update public.identity_links set level = 'desvinculado', scope_to = coalesce(scope_to, now()), ended_reason = 'personalizacion_retirada' where visitor_id = v.id and level <> 'desvinculado';
    end if;
  end if;
  return true;
end $$;

-- Saneamiento de búsquedas: sin correos, sin secuencias numéricas largas (teléfonos,
-- documentos), solo letras/números/espacios y máximo 60 caracteres.
create or replace function public.sanitize_search_term(term text) returns text
language sql immutable set search_path = pg_catalog as $$
  select nullif(left(btrim(regexp_replace(regexp_replace(regexp_replace(lower(coalesce(term, '')),
    '[^\s@]+@[^\s@]+', ' ', 'g'), '[0-9][0-9 .-]{4,}[0-9]', ' ', 'g'), '[^a-záéíóúüñ0-9 ]', ' ', 'g')), 60), '')
$$;

-- Colector: lotes pequeños, tipos y propiedades permitidos, deduplicación por event_id,
-- límites de frecuencia y de contribución. Nunca crea ventas, identidades ni descuentos.
create or replace function public.track_events(target uuid, secret text, events jsonb)
returns table(accepted integer, rejected integer)
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v public.visitors; cfg public.site_settings; e jsonb; ok integer := 0; bad integer := 0; kind text; occurred timestamptz;
  product_ref uuid; variant_ref uuid; session_ref uuid; props jsonb; clean jsonb; recent integer; sid_owner uuid; inserted integer;
  allowed_types text[] := array['view_product','select_variant','search_submitted','favorite_added','favorite_removed','cart_item_added','cart_item_updated','cart_item_removed','checkout_started','whatsapp_link_prepared','whatsapp_link_clicked','recommendation_impression','recommendation_clicked','offer_selected','coupon_validated','coupon_applied','coupon_rejected','campaign_landing'];
  product_types text[] := array['view_product','select_variant','favorite_added','favorite_removed','cart_item_added','cart_item_updated','cart_item_removed','recommendation_impression','recommendation_clicked'];
begin
  select * into cfg from public.site_settings where id = 1;
  if not cfg.tracking_enabled then return query select 0, coalesce(jsonb_array_length(events), 0); return; end if;
  select * into v from public.visitor_valid(target, secret);
  if v.id is null or not v.consent_analytics then return query select 0, coalesce(jsonb_array_length(events), 0); return; end if;
  if jsonb_typeof(events) is distinct from 'array' or jsonb_array_length(events) not between 1 and 25 or length(events::text) > 20000 then
    raise exception 'Lote de eventos no válido';
  end if;
  select count(*) into recent from public.behavior_events b where b.visitor_id = v.id and b.received_at > now() - interval '1 hour';
  if recent >= 600 then return query select 0, jsonb_array_length(events); return; end if;
  update public.visitors set last_seen_at = now() where id = v.id;

  for e in select value from jsonb_array_elements(events) loop
    begin
      kind := e->>'type';
      if kind is null or not (kind = any(allowed_types)) then bad := bad + 1; continue; end if;
      if coalesce(e->>'event_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or coalesce(e->>'session_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then bad := bad + 1; continue; end if;
      session_ref := (e->>'session_id')::uuid;
      -- Hora del navegador solo como referencia; se descartan fechas absurdas.
      occurred := coalesce(nullif(e->>'occurred_at', '')::timestamptz, now());
      if occurred > now() + interval '5 minutes' or occurred < now() - interval '2 days' then bad := bad + 1; continue; end if;
      product_ref := null; variant_ref := null;
      if coalesce(e->>'product_id', '') <> '' then
        product_ref := (e->>'product_id')::uuid;
        if not exists (select 1 from public.products p where p.id = product_ref and p.status = 'published') then bad := bad + 1; continue; end if;
      end if;
      if kind = any(product_types) and product_ref is null then bad := bad + 1; continue; end if;
      if coalesce(e->>'variant_id', '') <> '' then
        variant_ref := (e->>'variant_id')::uuid;
        if not exists (select 1 from public.product_variants pv where pv.id = variant_ref and pv.product_id = product_ref) then bad := bad + 1; continue; end if;
      end if;
      if kind = 'select_variant' and variant_ref is null then bad := bad + 1; continue; end if;
      props := case when jsonb_typeof(e->'properties') = 'object' then e->'properties' else '{}'::jsonb end;
      clean := '{}'::jsonb;
      if kind = 'view_product' then
        if coalesce(props->>'active_ms', '') !~ '^[0-9]{1,7}$' or (props->>'active_ms')::int < 3000 then bad := bad + 1; continue; end if;
        clean := jsonb_build_object('active_ms', least((props->>'active_ms')::int, 3600000));
        -- Límite de contribución: máximo 5 visitas cualificadas por visitante/producto/día.
        select count(*) into recent from public.behavior_events b where b.visitor_id = v.id and b.product_id = product_ref and b.event_type = 'view_product' and b.received_at > date_trunc('day', now());
        if recent >= 5 then bad := bad + 1; continue; end if;
      elsif kind = 'search_submitted' then
        clean := jsonb_strip_nulls(jsonb_build_object('term', public.sanitize_search_term(props->>'term'), 'results', case when coalesce(props->>'results', '') ~ '^[0-9]{1,4}$' then (props->>'results')::int end));
        if clean->>'term' is null then bad := bad + 1; continue; end if;
      elsif kind in ('cart_item_added','cart_item_updated','cart_item_removed') then
        clean := jsonb_build_object('quantity', case when coalesce(props->>'quantity', '') ~ '^[0-9]{1,2}$' then (props->>'quantity')::int else 0 end);
      elsif kind = 'checkout_started' then
        clean := jsonb_build_object('items', case when coalesce(props->>'items', '') ~ '^[0-9]{1,2}$' then (props->>'items')::int else 0 end);
      elsif kind in ('whatsapp_link_prepared','whatsapp_link_clicked') then
        clean := jsonb_build_object('context', case when props->>'context' in ('checkout','producto','flotante','pedido') then props->>'context' else 'otro' end);
      elsif kind in ('recommendation_impression','recommendation_clicked') then
        clean := jsonb_strip_nulls(jsonb_build_object('placement', case when props->>'placement' in ('ficha_alternativas','ficha_complementos','carrito','inicio') then props->>'placement' end,
          'position', case when coalesce(props->>'position', '') ~ '^[0-9]{1,2}$' then (props->>'position')::int end,
          'reco_version', case when coalesce(props->>'reco_version', '') ~ '^[a-z0-9.\-]{1,40}$' then props->>'reco_version' end));
      elsif kind in ('coupon_validated','coupon_applied','coupon_rejected') then
        clean := jsonb_build_object('reason', case when props->>'reason' ~ '^[a-z_]{1,32}$' then props->>'reason' else 'otro' end);
      elsif kind = 'offer_selected' then
        clean := jsonb_strip_nulls(jsonb_build_object('offer_ref', case when coalesce(props->>'offer_ref', '') ~ '^[A-Za-z0-9\-]{1,40}$' then props->>'offer_ref' end));
      elsif kind = 'campaign_landing' then
        clean := jsonb_strip_nulls(jsonb_build_object(
          'utm_source', case when coalesce(props->>'utm_source', '') ~ '^[a-z0-9_\-]{1,40}$' then props->>'utm_source' end,
          'utm_medium', case when coalesce(props->>'utm_medium', '') ~ '^[a-z0-9_\-]{1,40}$' then props->>'utm_medium' end,
          'utm_campaign', case when coalesce(props->>'utm_campaign', '') ~ '^[a-z0-9_\-]{1,40}$' then props->>'utm_campaign' end));
      end if;
      -- La sesión pertenece a un único visitante.
      select s.visitor_id into sid_owner from public.visitor_sessions s where s.id = session_ref;
      if sid_owner is null then
        insert into public.visitor_sessions(id, visitor_id, campaign) values (session_ref, v.id, case when kind = 'campaign_landing' then clean else '{}'::jsonb end) on conflict (id) do nothing;
        select s.visitor_id into sid_owner from public.visitor_sessions s where s.id = session_ref;
      end if;
      if sid_owner is distinct from v.id then bad := bad + 1; continue; end if;
      update public.visitor_sessions set last_event_at = greatest(last_event_at, now()) where id = session_ref;
      insert into public.behavior_events(event_id, visitor_id, session_id, event_type, event_version, product_id, variant_id, properties, occurred_at, consent_version)
      values ((e->>'event_id')::uuid, v.id, session_ref, kind, 1, product_ref, variant_ref, clean, occurred, v.consent_version)
      on conflict (event_id) do nothing;
      get diagnostics inserted = row_count;
      if inserted = 1 then ok := ok + 1; else bad := bad + 1; end if;
    exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format then bad := bad + 1;
    end;
  end loop;
  return query select ok, bad;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Verificación de identidad por posesión del canal (WhatsApp entrante)
-- ---------------------------------------------------------------------------
-- El visitante pide un código y lo envía DESDE su WhatsApp al del negocio. El vendedor
-- confirma en el panel que el mensaje llegó desde ese número. La respuesta pública es
-- idéntica exista o no un cliente con ese teléfono (no permite consultar perfiles).
create or replace function public.request_identity_verification(target uuid, secret text, phone text, session_ref uuid default null)
returns table(code text, whatsapp text, expires_at timestamptz)
language plpgsql security definer set search_path = public, pg_catalog as $$
declare v public.visitors; normalized text; recent integer; new_code text; alphabet text := 'ACDEFGHJKMNPQRTUVWXY34679'; i integer;
begin
  select * into v from public.visitor_valid(target, secret);
  if v.id is null or not v.consent_personalization then raise exception 'Activa la personalización para vincular tus compras'; end if;
  normalized := public.normalize_phone(phone);
  select count(*) into recent from public.identity_verifications iv where iv.visitor_id = v.id and iv.requested_at > now() - interval '1 hour';
  if recent >= 3 then raise exception using errcode = 'BM021', message = 'Ya solicitaste varios códigos. Intenta más tarde.'; end if;
  select count(*) into recent from public.identity_verifications iv where iv.phone_normalized = normalized and iv.requested_at > now() - interval '1 day';
  if recent >= 5 then raise exception using errcode = 'BM021', message = 'Ya solicitaste varios códigos. Intenta más tarde.'; end if;
  loop
    new_code := 'V-';
    for i in 1..6 loop new_code := new_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1); end loop;
    exit when not exists (select 1 from public.identity_verifications where identity_verifications.code = new_code);
  end loop;
  insert into public.identity_verifications(code, visitor_id, session_id, phone_normalized, expires_at)
  values (new_code, v.id, session_ref, normalized, now() + interval '30 minutes');
  return query select new_code, (select s.whatsapp from public.site_settings s where s.id = 1), now() + interval '30 minutes';
end $$;

-- Confirmación por el vendedor: el número desde el que llegó el código debe coincidir.
create or replace function public.confirm_identity_verification(target_code text, observed_phone text, note text default null) returns public.identity_links
language plpgsql security definer set search_path = public, pg_catalog as $$
declare ver public.identity_verifications; observed text; customer public.customers; link public.identity_links;
begin
  if not public.has_staff_role(array['propietario','vendedor']) then raise exception 'Sin permiso'; end if;
  select * into ver from public.identity_verifications where code = upper(btrim(target_code)) for update;
  if not found or ver.status <> 'pendiente' then raise exception 'Código no encontrado o ya resuelto'; end if;
  if ver.expires_at < now() then update public.identity_verifications set status = 'expirada', resolved_at = now() where id = ver.id; raise exception 'El código venció'; end if;
  observed := public.normalize_phone(observed_phone);
  if observed <> ver.phone_normalized then
    update public.identity_verifications set status = 'rechazada', resolved_at = now(), resolved_by = auth.uid(), note = 'El mensaje llegó desde otro número' where id = ver.id;
    raise exception 'El número desde el que llegó el código no coincide con el solicitado';
  end if;
  select * into customer from public.customers c where c.phone_normalized = observed;
  if customer.merged_into is not null then select * into customer from public.customers c where c.id = customer.merged_into; end if;
  if customer.id is null then raise exception 'No hay una ficha de cliente con ese número. Créala primero.'; end if;
  -- Un visitante solo queda vinculado a una persona a la vez.
  update public.identity_links set level = 'desvinculado', scope_to = now(), ended_reason = 'nueva_verificacion'
  where visitor_id = ver.visitor_id and level in ('declarado','verificado') and customer_id <> customer.id;
  insert into public.identity_links(visitor_id, customer_id, level, method, evidence, session_id, scope_from, created_by)
  values (ver.visitor_id, customer.id, 'verificado', 'whatsapp_entrante', jsonb_build_object('verification', ver.code, 'note', nullif(btrim(coalesce(note, '')), '')),
    ver.session_id, ver.requested_at, auth.uid())
  returning * into link;
  update public.identity_verifications set status = 'verificada', resolved_at = now(), resolved_by = auth.uid(), note = nullif(btrim(coalesce(confirm_identity_verification.note, '')), '') where id = ver.id;
  return link;
end $$;

create or replace function public.unlink_identity(target_link uuid, reason text) returns public.identity_links
language plpgsql security definer set search_path = public as $$
declare link public.identity_links;
begin
  if not public.has_staff_role(array['propietario','vendedor']) then raise exception 'Sin permiso'; end if;
  update public.identity_links set level = 'desvinculado', scope_to = coalesce(scope_to, now()), ended_reason = coalesce(nullif(btrim(reason), ''), 'desvinculado_por_comerciante')
  where id = target_link returning * into link;
  if link.id is null then raise exception 'Vínculo no encontrado'; end if;
  return link;
end $$;

-- Vínculo declarado al crear un pedido: SOLO la sesión del pedido, nunca el historial
-- completo del dispositivo. Lo usa create_storefront_order.
create or replace function public.link_order_session(target_order uuid, target_customer uuid, visitor jsonb) returns void
language plpgsql security definer set search_path = public, pg_catalog as $$
declare v public.visitors; session_ref uuid;
begin
  if visitor is null or jsonb_typeof(visitor) <> 'object' then return; end if;
  begin
    select * into v from public.visitor_valid((visitor->>'id')::uuid, visitor->>'secret');
    session_ref := nullif(visitor->>'session_id', '')::uuid;
  exception when others then return; end;
  if v.id is null or not v.consent_analytics then return; end if;
  if session_ref is null or not exists (select 1 from public.visitor_sessions s where s.id = session_ref and s.visitor_id = v.id) then session_ref := null; end if;
  insert into public.identity_links(visitor_id, customer_id, level, method, evidence, session_id, scope_from, scope_to)
  values (v.id, target_customer, 'declarado', 'telefono_en_pedido', jsonb_build_object('order_id', target_order), session_ref,
    coalesce((select s.started_at from public.visitor_sessions s where s.id = session_ref), now()), now());
end $$;

-- ---------------------------------------------------------------------------
-- 7. Agregados privados para el análisis (sin descargar ventas de toda la tienda)
-- ---------------------------------------------------------------------------
-- Contrato idéntico a js/lib/metrics.js: compra = venta confirmada alguna vez y no
-- cancelada; neto = líneas − devoluciones valoradas al neto de cada línea.
create or replace function public.sale_kept_cents(target_sale uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(round(i.line_total * 100) - round(round(i.line_total * 100) * least(i.quantity, coalesce(r.returned, 0)) / i.quantity)), 0)::bigint
  from public.sale_items i
  left join (select sale_item_id, sum(quantity) as returned from public.sale_returns group by sale_item_id) r on r.sale_item_id = i.id
  where i.sale_id = target_sale
$$;

create or replace function public.crm_customer_ranking(target_customer uuid, since date default null)
returns table(position_rank integer, total_customers integer, share_bp integer, kept_cents bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_staff_role(array['propietario','vendedor']) then raise exception 'Sin permiso'; end if;
  return query
  with purchases as (
    select s.customer_id, public.sale_kept_cents(s.id) as cents
    from public.sales s
    where (s.stock_applied_at is not null or s.confirmed_at is not null or s.status in ('confirmada','pagada','entregada','devuelta'))
      and s.status <> 'cancelada'
      and (since is null or (coalesce(s.confirmed_at, s.created_at) at time zone 'America/Bogota')::date >= since)
  ), totals as (
    select customer_id, sum(cents)::bigint as cents from purchases group by customer_id having sum(cents) > 0
  ), ranked as (
    select customer_id, cents, row_number() over (order by cents desc, customer_id::text) as pos, count(*) over () as n, sum(cents) over () as allc from totals
  )
  select pos::int, n::int, case when allc > 0 then round(cents * 10000.0 / allc)::int else 0 end, cents from ranked where customer_id = target_customer;
end $$;

-- Patrones entre clientes por categoría, solo agregados con soporte mínimo. "both" cuenta
-- compradores (distintos del analizado) que compraron la categoría destino en la misma
-- compra o dentro de la ventana posterior. No devuelve identidades.
create or replace function public.crm_peer_patterns(target_customer uuid, window_days integer default 90, min_support integer default 5)
returns table(from_category uuid, to_category uuid, support integer, both_count integer, window_days_used integer)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_staff_role(array['propietario','vendedor']) then raise exception 'Sin permiso'; end if;
  return query
  with bought as (
    select distinct s.customer_id, pc.category_id, (coalesce(s.confirmed_at, s.created_at) at time zone 'America/Bogota')::date as day
    from public.sales s join public.sale_items i on i.sale_id = s.id
    join public.product_categories pc on pc.product_id = i.product_id
    left join (select sale_item_id, sum(quantity) as returned from public.sale_returns group by sale_item_id) r on r.sale_item_id = i.id
    where (s.stock_applied_at is not null or s.confirmed_at is not null) and s.status <> 'cancelada' and i.quantity > coalesce(r.returned, 0)
  ), mine as (select distinct category_id from bought where customer_id = target_customer),
  firsts as (select customer_id, category_id, min(day) as first_day from bought where customer_id <> target_customer group by 1, 2),
  pairs as (
    select a.category_id as from_cat, b.category_id as to_cat, count(distinct a.customer_id)::int as both_n
    from firsts a join bought b on b.customer_id = a.customer_id and b.category_id <> a.category_id
      and b.day between a.first_day and a.first_day + window_days
    where a.category_id in (select category_id from mine) group by 1, 2
  ), supports as (select category_id, count(*)::int as n from firsts where category_id in (select category_id from mine) group by 1)
  select p.from_cat, p.to_cat, s.n, p.both_n, window_days from pairs p join supports s on s.category_id = p.from_cat
  where s.n >= greatest(min_support, 3) and p.both_n >= 2;
end $$;

-- Señales de navegación del cliente: solo vínculos verificados (dentro de su alcance) o
-- la sesión concreta de un pedido declarado, y solo con personalización autorizada.
create or replace function public.crm_customer_signals(target_customer uuid)
returns table(product_id uuid, product_name text, variant_id uuid, sessions integer, views integer, last_seen timestamptz, favorite boolean, cart_qty integer, identity_level text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_staff_role(array['propietario','vendedor']) then raise exception 'Sin permiso'; end if;
  return query
  with scoped as (
    select e.*, l.level as link_level from public.identity_links l
    join public.visitors v on v.id = l.visitor_id and v.consent_personalization and v.revoked_at is null
    join public.behavior_events e on e.visitor_id = l.visitor_id
      and e.received_at >= l.scope_from and (l.scope_to is null or e.received_at <= l.scope_to)
      and (l.level = 'verificado' or e.session_id = l.session_id)
    where l.customer_id = target_customer and l.level in ('verificado','declarado') and e.product_id is not null
  ), last_fav as (
    select distinct on (s.product_id) s.product_id, s.event_type from scoped s where s.event_type in ('favorite_added','favorite_removed') order by s.product_id, s.occurred_at desc
  ), last_cart as (
    select distinct on (s.product_id) s.product_id, s.event_type, coalesce((s.properties->>'quantity')::int, 0) as qty from scoped s where s.event_type like 'cart_item_%' order by s.product_id, s.occurred_at desc
  )
  select s.product_id, max(p.name), (array_agg(s.variant_id order by s.occurred_at desc) filter (where s.variant_id is not null))[1],
    count(distinct s.session_id) filter (where s.event_type = 'view_product')::int, count(*) filter (where s.event_type = 'view_product')::int,
    max(s.received_at), coalesce(bool_or(f.event_type = 'favorite_added'), false),
    coalesce(max(case when c.event_type = 'cart_item_removed' then 0 else c.qty end), 0)::int,
    case when bool_or(s.link_level = 'verificado') then 'verificada' else 'declarada' end
  from scoped s join public.products p on p.id = s.product_id
  left join last_fav f on f.product_id = s.product_id left join last_cart c on c.product_id = s.product_id
  group by s.product_id;
end $$;

-- Tendencias públicas: solo agregados con al menos 3 compradores distintos (sin datos
-- individuales) y productos elegibles.
create or replace function public.public_trending_products(days integer default 30, result_limit integer default 12)
returns table(product_id uuid, buyers integer)
language sql stable security definer set search_path = public as $$
  select i.product_id, count(distinct s.customer_id)::int
  from public.sales s join public.sale_items i on i.sale_id = s.id
  join public.products p on p.id = i.product_id and p.status = 'published' and not p.force_sold_out
  where (s.stock_applied_at is not null or s.confirmed_at is not null) and s.status <> 'cancelada'
    and coalesce(s.confirmed_at, s.created_at) > now() - make_interval(days => least(greatest(days, 7), 180))
    and exists (select 1 from public.product_variants v where v.product_id = p.id and v.active and v.stock > 0)
  group by i.product_id having count(distinct s.customer_id) >= 3
  order by 2 desc, 1 limit least(greatest(result_limit, 1), 24)
$$;

-- ---------------------------------------------------------------------------
-- 8. Retención, acceso y supresión
-- ---------------------------------------------------------------------------
create or replace function public.purge_behavior_data() returns jsonb
language plpgsql security definer set search_path = public as $$
declare cfg public.site_settings; aggregated integer; raw_deleted integer; agg_deleted integer; sessions_deleted integer; expired integer; result jsonb;
begin
  if not (public.is_admin() or current_user in ('postgres','service_role')) then raise exception 'Sin permiso'; end if;
  select * into cfg from public.site_settings where id = 1;
  insert into public.behavior_daily_aggregates(day, product_id, event_type, events, sessions)
  select (e.received_at at time zone 'America/Bogota')::date, e.product_id, e.event_type, count(*), count(distinct e.session_id)
  from public.behavior_events e
  where e.product_id is not null and e.received_at < now() - make_interval(days => cfg.raw_event_retention_days)
  group by 1, 2, 3
  on conflict (day, product_id, event_type) do update set events = behavior_daily_aggregates.events + excluded.events, sessions = behavior_daily_aggregates.sessions + excluded.sessions;
  get diagnostics aggregated = row_count;
  delete from public.behavior_events where received_at < now() - make_interval(days => cfg.raw_event_retention_days);
  get diagnostics raw_deleted = row_count;
  delete from public.visitor_sessions s where s.last_event_at < now() - make_interval(days => cfg.raw_event_retention_days)
    and not exists (select 1 from public.behavior_events e where e.session_id = s.id)
    and not exists (select 1 from public.identity_links l where l.session_id = s.id and l.level <> 'desvinculado');
  get diagnostics sessions_deleted = row_count;
  delete from public.behavior_daily_aggregates where day < (now() at time zone 'America/Bogota')::date - cfg.aggregate_retention_days;
  get diagnostics agg_deleted = row_count;
  update public.identity_verifications set status = 'expirada', resolved_at = now() where status = 'pendiente' and expires_at < now();
  get diagnostics expired = row_count;
  result := jsonb_build_object('agregados', aggregated, 'eventos_borrados', raw_deleted, 'sesiones_borradas', sessions_deleted, 'agregados_borrados', agg_deleted, 'verificaciones_expiradas', expired,
    'retencion_crudos_dias', cfg.raw_event_retention_days, 'retencion_agregados_dias', cfg.aggregate_retention_days);
  insert into public.maintenance_runs(task, result, ran_by) values ('purge_behavior_data', result, auth.uid());
  return result;
end $$;

-- Exportación para solicitudes de acceso del titular (la descarga la hace el comerciante).
create or replace function public.export_customer_data(target_customer uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  return jsonb_build_object(
    'generado', now(),
    'cliente', (select to_jsonb(c) - 'merged_into' from public.customers c where c.id = target_customer),
    'autorizaciones', (select coalesce(jsonb_agg(to_jsonb(x) order by x.recorded_at), '[]') from public.customer_consents x where x.customer_id = target_customer),
    'pedidos', (select coalesce(jsonb_agg(jsonb_build_object('numero', o.order_number, 'fecha', o.created_at, 'estado', o.status, 'total', o.total) order by o.created_at), '[]') from public.orders o where o.customer_id = target_customer),
    'cotizaciones', (select coalesce(jsonb_agg(jsonb_build_object('numero', q.quote_number, 'fecha', q.created_at, 'estado', q.status, 'total', q.total) order by q.created_at), '[]') from public.quotes q where q.customer_id = target_customer),
    'ventas', (select coalesce(jsonb_agg(jsonb_build_object('numero', s.sale_number, 'fecha', s.created_at, 'estado', s.status, 'total', s.total) order by s.created_at), '[]') from public.sales s where s.customer_id = target_customer),
    'vinculos_navegacion', (select coalesce(jsonb_agg(jsonb_build_object('nivel', l.level, 'metodo', l.method, 'desde', l.scope_from, 'hasta', l.scope_to) order by l.created_at), '[]') from public.identity_links l where l.customer_id = target_customer),
    'senales_navegacion', (select coalesce(jsonb_agg(to_jsonb(sig)), '[]') from public.crm_customer_signals(target_customer) sig)
  );
end $$;

-- Supresión de señales de navegación vinculadas. Los documentos comerciales se conservan
-- (obligaciones de soporte contable); solo dejan de usarse para fines promocionales si
-- se retira la autorización promocional.
create or replace function public.suppress_customer_signals(target_customer uuid, reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare removed integer := 0; unlinked integer := 0;
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  delete from public.behavior_events e using public.identity_links l
  where l.customer_id = target_customer and e.visitor_id = l.visitor_id and e.received_at >= l.scope_from and (l.scope_to is null or e.received_at <= l.scope_to)
    and (l.level = 'verificado' or e.session_id = l.session_id);
  get diagnostics removed = row_count;
  update public.identity_links set level = 'desvinculado', scope_to = coalesce(scope_to, now()), ended_reason = coalesce(nullif(btrim(reason), ''), 'supresion_solicitada')
  where customer_id = target_customer and level <> 'desvinculado';
  get diagnostics unlinked = row_count;
  insert into public.maintenance_runs(task, result, ran_by) values ('suppress_customer_signals', jsonb_build_object('customer', target_customer, 'eventos', removed, 'vinculos', unlinked), auth.uid());
  return jsonb_build_object('eventos_borrados', removed, 'vinculos_terminados', unlinked);
end $$;

-- ---------------------------------------------------------------------------
-- 9. RLS, privilegios e índices para paginación estable
-- ---------------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['product_relationships','visitors','visitor_consent_events','visitor_sessions','behavior_events','behavior_daily_aggregates','identity_links','identity_verifications','maintenance_runs'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
create policy relationships_public_read on public.product_relationships for select to anon, authenticated using (active or public.is_admin());
create policy relationships_admin_all on public.product_relationships for all to authenticated using (public.is_admin()) with check (public.is_admin());
do $$ declare t text; begin
  foreach t in array array['visitors','visitor_consent_events','visitor_sessions','behavior_events','behavior_daily_aggregates','identity_links','identity_verifications','maintenance_runs'] loop
    execute format('create policy %I on public.%I for select to authenticated using (public.has_staff_role(array[''propietario'',''vendedor'']))', t || '_staff_read', t);
  end loop;
end $$;

revoke all on public.product_relationships, public.visitors, public.visitor_consent_events, public.visitor_sessions, public.behavior_events,
  public.behavior_daily_aggregates, public.identity_links, public.identity_verifications, public.maintenance_runs from anon, authenticated;
grant select (id, source_type, source_id, target_type, target_id, kind, strength, reposition_days, note, active) on public.product_relationships to anon;
grant select, insert, update, delete on public.product_relationships to authenticated;
-- Lectura administrativa; ninguna escritura directa: solo mediante funciones.
grant select on public.visitor_consent_events, public.visitor_sessions, public.behavior_daily_aggregates, public.identity_links, public.identity_verifications, public.maintenance_runs to authenticated;
grant select (id, consent_analytics, consent_personalization, consent_version, consent_at, revoked_at, created_at, last_seen_at) on public.visitors to authenticated;
grant select (event_id, visitor_id, session_id, event_type, product_id, variant_id, properties, occurred_at, received_at) on public.behavior_events to authenticated;

revoke execute on function public.request_fingerprint(), public.visitor_valid(uuid, text), public.link_order_session(uuid, uuid, jsonb),
  public.sale_kept_cents(uuid), public.product_relationships_validate(), public.sanitize_search_term(text) from public, anon, authenticated;
grant execute on function public.register_visitor(jsonb), public.set_visitor_consent(uuid, text, jsonb), public.track_events(uuid, text, jsonb),
  public.request_identity_verification(uuid, text, text, uuid), public.public_trending_products(integer, integer) to anon, authenticated;
grant execute on function public.confirm_identity_verification(text, text, text), public.unlink_identity(uuid, text), public.crm_customer_ranking(uuid, date),
  public.crm_peer_patterns(uuid, integer, integer), public.crm_customer_signals(uuid), public.purge_behavior_data(), public.export_customer_data(uuid),
  public.suppress_customer_signals(uuid, text) to authenticated;

-- Orden estable para recorrer páginas sin saltos ni duplicados.
create index if not exists orders_created_id_idx on public.orders(created_at desc, id);
create index if not exists quotes_created_id_idx on public.quotes(created_at desc, id);
create index if not exists sales_created_id_idx on public.sales(created_at desc, id);
create index if not exists sales_source_quote_idx on public.sales(source_quote_id) where source_quote_id is not null;
create index if not exists sale_items_product_idx on public.sale_items(product_id);

-- Los privilegios por defecto "in schema public" no pueden retirar el EXECUTE que
-- PostgreSQL concede a PUBLIC en cada función nueva. Se retira explícitamente aquí; los
-- accesos públicos necesarios se concedieron arriba de forma explícita a anon/authenticated.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f' and (p.proacl is null or p.proacl::text ~ '(^|[{,])=X')
             and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') loop
    execute format('revoke execute on function %s from public', f.sig);
  end loop;
end $$;
