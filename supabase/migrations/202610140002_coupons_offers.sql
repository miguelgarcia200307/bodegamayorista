-- Bodega Mayorista F.C. — ofertas privadas y cupones validados en servidor.
-- Política económica (cupones-v1):
--   1. Precio elegible de cada línea = regla vigente (variante → promoción → tramo por
--      volumen agregado por producto). El cupón NUNCA cambia promo_price ni precios públicos.
--   2. El cupón se aplica sobre el precio elegible ('sobre_precio_vigente') o solo a líneas
--      sin promoción ni tramo ('solo_precio_regular'). Un solo cupón por pedido.
--   3. Porcentaje (0 < v ≤ 100) o valor fijo (> 0); tope opcional; mínimo elegible opcional.
--      El descuento se redondea a pesos enteros (mitad hacia arriba), nunca supera la base
--      elegible y se reparte por línea con resto mayor: la suma de líneas = descuento total.
--   4. El envío no se descuenta (modalidad separada no habilitada).
--   5. Aplicar en el carrito solo valida. Crear pedido RESERVA un uso con caducidad.
--      Confirmar la venta CONSUME una sola vez. Cancelar libera según política; devolver
--      no libera salvo política explícita. Nada se reactiva automáticamente.

-- ---------------------------------------------------------------------------
-- 1. Tablas
-- ---------------------------------------------------------------------------
create table public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9-]{4,24}$'),
  name text not null check (length(btrim(name)) between 2 and 120),
  kind text not null check (kind in ('porcentaje','valor_fijo')),
  value numeric(14,2) not null,
  max_discount numeric(14,2) check (max_discount is null or max_discount > 0),
  min_eligible numeric(14,2) not null default 0 check (min_eligible >= 0),
  stacking text not null default 'sobre_precio_vigente' check (stacking in ('sobre_precio_vigente','solo_precio_regular')),
  starts_at timestamptz,
  ends_at timestamptz,
  max_uses_total integer check (max_uses_total is null or max_uses_total >= 1),
  max_uses_per_customer integer check (max_uses_per_customer is null or max_uses_per_customer >= 1),
  audience text not null default 'publico' check (audience in ('publico','portador','cliente_verificado')),
  customer_id uuid references public.customers(id) on delete restrict,
  reservation_hours integer not null default 72 check (reservation_hours between 1 and 720),
  release_on_cancel boolean not null default true,
  release_on_full_return boolean not null default false,
  applies_to_shipping boolean not null default false check (not applies_to_shipping),
  active boolean not null default true,
  rules_version text not null default 'cupones-v1',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'porcentaje' and value > 0 and value <= 100) or (kind = 'valor_fijo' and value > 0)),
  check (audience <> 'cliente_verificado' or customer_id is not null),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create trigger coupons_updated_at before update on public.coupons for each row execute function public.set_updated_at();

create table public.coupon_scopes (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons(id) on delete cascade,
  scope_type text not null check (scope_type in ('product','variant','category','brand')),
  target_id uuid not null,
  mode text not null default 'incluir' check (mode in ('incluir','excluir')),
  unique (coupon_id, scope_type, target_id, mode)
);

create table public.customer_offers (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  coupon_id uuid references public.coupons(id) on delete restrict,
  title text not null,
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  totals jsonb not null default '{}'::jsonb,
  recommendation jsonb not null default '{}'::jsonb,
  message_text text,
  status text not null default 'preparada' check (status in ('preparada','enviada_declarada','respondida','aceptada','rechazada','cerrada','expirada')),
  response_note text,
  outcome text check (outcome is null or outcome in ('compro','no_compro','sin_respuesta','pospuso')),
  quote_id uuid references public.quotes(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  sent_declared_at timestamptz,
  responded_at timestamptz,
  updated_at timestamptz not null default now()
);
create trigger customer_offers_updated_at before update on public.customer_offers for each row execute function public.set_updated_at();
create index customer_offers_customer_idx on public.customer_offers(customer_id, created_at desc);

-- Contacto: "preparado" ≠ "declarado como enviado por el vendedor" ≠ "respuesta".
-- Abrir wa.me no prueba envío ni lectura.
create table public.contact_attempts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  offer_id uuid references public.customer_offers(id) on delete set null,
  task_id uuid,
  channel text not null check (channel in ('whatsapp','llamada','presencial','correo','otro')),
  kind text not null check (kind in ('preparado','declarado_enviado','respuesta','resultado')),
  purpose text not null default 'comercial' check (purpose in ('comercial','servicio','postventa','cumpleanos')),
  note text check (note is null or length(note) <= 500),
  outcome text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index contact_attempts_customer_idx on public.contact_attempts(customer_id, created_at desc);

create table public.coupon_uses (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons(id) on delete restrict,
  order_id uuid unique references public.orders(id) on delete restrict,
  sale_id uuid references public.sales(id) on delete restrict,
  customer_id uuid references public.customers(id) on delete restrict,
  status text not null default 'reservada' check (status in ('reservada','consumida','liberada')),
  discount_total numeric(14,2) not null check (discount_total >= 0),
  snapshot jsonb not null,
  reserved_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  released_at timestamptz,
  release_reason text,
  honored_after_review boolean not null default false
);
create index coupon_uses_coupon_idx on public.coupon_uses(coupon_id, status);
create index coupon_uses_sale_idx on public.coupon_uses(sale_id) where sale_id is not null;

create table public.coupon_attempts (
  id bigint generated always as identity primary key,
  requester text not null,
  ok boolean not null,
  attempted_at timestamptz not null default now()
);
create index coupon_attempts_requester_idx on public.coupon_attempts(requester, attempted_at desc);

alter table public.orders
  add column if not exists discount_total numeric(14,2) not null default 0 check (discount_total >= 0),
  add column if not exists coupon_id uuid references public.coupons(id) on delete restrict,
  add column if not exists coupon_code text,
  add column if not exists coupon_snapshot jsonb;
alter table public.order_items add column if not exists discount numeric(14,2) not null default 0 check (discount >= 0);
alter table public.sales add column if not exists coupon_snapshot jsonb;

-- ---------------------------------------------------------------------------
-- 2. Motor económico compartido (validación, pedido, vista previa de oferta)
-- ---------------------------------------------------------------------------
create or replace function public.priced_cart_lines(items jsonb)
returns table(line_no integer, variant_id uuid, product_id uuid, product_name text, sku text, quantity integer, regular_unit numeric,
  unit_price numeric, gross numeric, promo_active boolean, tier_applied boolean, brand_id uuid, category_ids uuid[], stock integer, available boolean)
language sql stable security definer set search_path = public as $$
  with req as (
    select (e->>'variant_id')::uuid as vid, sum((e->>'quantity')::int)::int as qty from jsonb_array_elements(items) e group by 1
  ), base as (
    select r.vid, r.qty, v.stock as vstock, v.active as vactive, coalesce(v.sku, p.sku) as vsku, v.price as vprice, p.id as pid, p.name as pname, p.status as pstatus,
      p.force_sold_out as pforced, p.brand_id as pbrand, p.promo_enabled and p.promo_price is not null and (p.promo_start is null or p.promo_start <= now()) and (p.promo_end is null or p.promo_end >= now()) as ppromo,
      public.current_product_price(p, v) as regular, sum(r.qty) over (partition by p.id)::int as product_units
    from req r join public.product_variants v on v.id = r.vid join public.products p on p.id = v.product_id
  )
  select (row_number() over (order by b.vid))::int, b.vid, b.pid, b.pname, b.vsku, b.qty, b.regular,
    public.tier_unit_price(b.pid, b.product_units, b.regular), public.tier_unit_price(b.pid, b.product_units, b.regular) * b.qty,
    b.vprice is null and coalesce(b.ppromo, false), public.tier_unit_price(b.pid, b.product_units, b.regular) < b.regular, b.pbrand,
    (select coalesce(array_agg(distinct x.cid), '{}') from (select pc.category_id as cid from public.product_categories pc where pc.product_id = b.pid
       union select c.parent_id from public.product_categories pc join public.categories c on c.id = pc.category_id where pc.product_id = b.pid and c.parent_id is not null) x),
    b.vstock, b.pstatus = 'published' and b.vactive and not b.pforced and b.vstock >= b.qty
  from base b
$$;

create or replace function public.coupon_scope_matches(scope jsonb, product_ref uuid, variant_ref uuid, brand_ref uuid, categories uuid[]) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select case scope->>'scope_type'
    when 'product' then (scope->>'target_id')::uuid = product_ref
    when 'variant' then (scope->>'target_id')::uuid = variant_ref
    when 'brand' then (scope->>'target_id')::uuid is not distinct from brand_ref
    when 'category' then (scope->>'target_id')::uuid = any(categories)
    else false end
$$;

-- Cálculo puro (sin estado de usos): base elegible, descuento y reparto por línea.
-- cfg: { kind, value, max_discount, min_eligible, stacking }; scopes: [{scope_type,target_id,mode}].
create or replace function public.coupon_compute(cfg jsonb, scopes jsonb, items jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  l record; lines jsonb := '[]'::jsonb; subtotal_value numeric := 0; eligible_value numeric := 0; has_include boolean; is_eligible boolean;
  w numeric[] := '{}'; idx integer[] := '{}'; parts numeric[]; fracs numeric[]; discount numeric := 0; remainder integer; k integer; pick integer;
  requested integer; found_lines integer := 0; unavailable integer := 0; status text := 'valido'; reason text;
begin
  scopes := coalesce(scopes, '[]'::jsonb);
  has_include := exists (select 1 from jsonb_array_elements(scopes) s where s->>'mode' = 'incluir');
  select count(distinct e->>'variant_id') into requested from jsonb_array_elements(items) e;
  for l in select * from public.priced_cart_lines(items) order by 1 loop
    found_lines := found_lines + 1;
    if not l.available then unavailable := unavailable + 1; end if;
    subtotal_value := subtotal_value + l.gross;
    is_eligible := (not has_include or exists (select 1 from jsonb_array_elements(scopes) s where s->>'mode' = 'incluir' and public.coupon_scope_matches(s, l.product_id, l.variant_id, l.brand_id, l.category_ids)))
      and not exists (select 1 from jsonb_array_elements(scopes) s where s->>'mode' = 'excluir' and public.coupon_scope_matches(s, l.product_id, l.variant_id, l.brand_id, l.category_ids));
    reason := case when not is_eligible then 'fuera_de_alcance' end;
    if is_eligible and cfg->>'stacking' = 'solo_precio_regular' and (l.promo_active or l.tier_applied) then is_eligible := false; reason := 'ya_tiene_promocion_o_tramo'; end if;
    if is_eligible then eligible_value := eligible_value + l.gross; w := w || l.gross; idx := idx || l.line_no; end if;
    lines := lines || jsonb_build_object('line_no', l.line_no, 'variant_id', l.variant_id, 'product_id', l.product_id, 'product_name', l.product_name, 'quantity', l.quantity,
      'regular_unit', l.regular_unit, 'unit_price', l.unit_price, 'gross', l.gross, 'eligible', is_eligible, 'reason', reason, 'available', l.available, 'discount', 0, 'line_total', l.gross);
  end loop;
  if found_lines <> requested then status := 'carrito_no_valido';
  elsif eligible_value <= 0 then status := 'sin_productos_elegibles';
  elsif eligible_value < coalesce((cfg->>'min_eligible')::numeric, 0) then status := 'minimo_no_alcanzado';
  end if;
  if status = 'valido' then
    discount := case when cfg->>'kind' = 'porcentaje' then round(eligible_value * (cfg->>'value')::numeric / 100, 0) else round((cfg->>'value')::numeric, 0) end;
    if nullif(cfg->>'max_discount', '') is not null then discount := least(discount, floor((cfg->>'max_discount')::numeric)); end if;
    discount := greatest(0, least(discount, floor(eligible_value)));
    -- Reparto en pesos enteros, proporcional a cada línea elegible (resto mayor; empate por línea).
    parts := '{}'; fracs := '{}';
    for k in 1..coalesce(array_length(w, 1), 0) loop
      parts := parts || floor(discount * w[k] / eligible_value);
      fracs := fracs || (discount * w[k] / eligible_value - floor(discount * w[k] / eligible_value));
    end loop;
    remainder := (discount - coalesce((select sum(x) from unnest(parts) x), 0))::int;
    for pick in select t.ord from unnest(fracs) with ordinality t(f, ord) order by t.f desc, t.ord limit greatest(remainder, 0) loop
      parts[pick] := parts[pick] + 1;
    end loop;
    for k in 1..coalesce(array_length(idx, 1), 0) loop
      lines := (select jsonb_agg(case when (x->>'line_no')::int = idx[k] then x || jsonb_build_object('discount', parts[k], 'line_total', (x->>'gross')::numeric - parts[k]) else x end order by (x->>'line_no')::int) from jsonb_array_elements(lines) x);
    end loop;
  end if;
  return jsonb_build_object('status', status, 'subtotal', subtotal_value, 'eligible_subtotal', eligible_value, 'discount_total', case when status = 'valido' then discount else 0 end,
    'missing_for_minimum', case when status = 'minimo_no_alcanzado' then coalesce((cfg->>'min_eligible')::numeric, 0) - eligible_value else 0 end,
    'unavailable_lines', unavailable, 'lines', lines);
end $$;

create or replace function public.coupon_config(cp public.coupons) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('kind', cp.kind, 'value', cp.value, 'max_discount', cp.max_discount, 'min_eligible', cp.min_eligible, 'stacking', cp.stacking)
$$;
create or replace function public.coupon_scope_list(target uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('scope_type', s.scope_type, 'target_id', s.target_id, 'mode', s.mode) order by s.mode, s.scope_type, s.target_id), '[]'::jsonb)
  from public.coupon_scopes s where s.coupon_id = target
$$;

-- Usos vigentes: consumidos + reservas no vencidas (excepto el uso que se esté revisando).
create or replace function public.coupon_uses_count(target uuid, customer_ref uuid default null, except_use uuid default null) returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.coupon_uses u where u.coupon_id = target and (except_use is null or u.id <> except_use)
    and (customer_ref is null or u.customer_id = customer_ref)
    and (u.status = 'consumida' or (u.status = 'reservada' and u.expires_at > now()))
$$;

-- Estado del cupón para un comprador. verified: cliente con identidad verificada vigente.
create or replace function public.coupon_state(cp public.coupons, customer_ref uuid, verified uuid, except_use uuid default null) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if cp.id is null or not cp.active then return 'no_valido'; end if;
  if cp.starts_at is not null and cp.starts_at > now() then return 'no_iniciado'; end if;
  if cp.ends_at is not null and cp.ends_at < now() then return 'vencido'; end if;
  if cp.audience = 'cliente_verificado' and verified is distinct from cp.customer_id then return 'requiere_verificacion'; end if;
  if cp.max_uses_total is not null and public.coupon_uses_count(cp.id, null, except_use) >= cp.max_uses_total then return 'sin_usos'; end if;
  if cp.max_uses_per_customer is not null and coalesce(customer_ref, verified) is not null
     and public.coupon_uses_count(cp.id, coalesce(customer_ref, verified), except_use) >= cp.max_uses_per_customer then return 'limite_cliente'; end if;
  return 'valido';
end $$;

create or replace function public.coupon_snapshot(cp public.coupons) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('coupon_id', cp.id, 'code', cp.code, 'name', cp.name, 'kind', cp.kind, 'value', cp.value, 'max_discount', cp.max_discount, 'min_eligible', cp.min_eligible,
    'stacking', cp.stacking, 'audience', cp.audience, 'ends_at', cp.ends_at, 'scopes', public.coupon_scope_list(cp.id), 'rules_version', cp.rules_version)
$$;

-- Cliente verificado vigente asociado al visitante (nunca por teléfono escrito).
create or replace function public.visitor_verified_customer(visitor jsonb) returns uuid
language plpgsql stable security definer set search_path = public, pg_catalog as $$
declare v public.visitors; result uuid;
begin
  if visitor is null or jsonb_typeof(visitor) <> 'object' then return null; end if;
  begin select * into v from public.visitor_valid((visitor->>'id')::uuid, visitor->>'secret'); exception when others then return null; end;
  if v.id is null then return null; end if;
  select l.customer_id into result from public.identity_links l where l.visitor_id = v.id and l.level = 'verificado' and l.scope_to is null order by l.created_at desc limit 1;
  return result;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Validación pública en el carrito (no consume usos ni stock)
-- ---------------------------------------------------------------------------
create or replace function public.validate_cart_coupon(cart_items jsonb, code text, visitor jsonb default null, delivery_method uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare cp public.coupons; clean text; req_key text; failures integer; result jsonb; state text; verified uuid; delivery_value numeric := 0;
begin
  clean := upper(btrim(coalesce(code, '')));
  if clean = '' then return jsonb_build_object('status', 'vacio'); end if;
  if jsonb_typeof(cart_items) is distinct from 'array' or jsonb_array_length(cart_items) not between 1 and 50
     or exists (select 1 from jsonb_array_elements(cart_items) e where coalesce(e->>'variant_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(e->>'quantity', '') !~ '^[0-9]{1,3}$' or (e->>'quantity')::int not between 1 and 99) then
    return jsonb_build_object('status', 'carrito_no_valido');
  end if;
  -- Límite por origen de la petición (IP según el proxy), no por un id que el navegador puede rotar.
  req_key := public.request_fingerprint();
  select count(*) into failures from public.coupon_attempts a where a.requester = req_key and not a.ok and a.attempted_at > now() - interval '10 minutes';
  if failures >= 15 then return jsonb_build_object('status', 'demasiados_intentos'); end if;
  if clean !~ '^[A-Z0-9-]{4,24}$' then insert into public.coupon_attempts(requester, ok) values (req_key, false); return jsonb_build_object('status', 'no_valido'); end if;
  select * into cp from public.coupons c where c.code = clean;
  verified := public.visitor_verified_customer(visitor);
  state := public.coupon_state(cp, null, verified);
  insert into public.coupon_attempts(requester, ok) values (req_key, state not in ('no_valido'));
  if state <> 'valido' then
    return jsonb_build_object('status', state, 'code', case when state = 'no_valido' then null else cp.code end, 'ends_at', case when state = 'vencido' then cp.ends_at end);
  end if;
  result := public.coupon_compute(public.coupon_config(cp), public.coupon_scope_list(cp.id), cart_items);
  if delivery_method is not null then select coalesce(d.base_cost, 0) into delivery_value from public.delivery_methods d where d.id = delivery_method and d.active; end if;
  return result || jsonb_build_object('code', cp.code, 'name', cp.name, 'kind', cp.kind, 'value', cp.value, 'max_discount', cp.max_discount, 'min_eligible', cp.min_eligible,
    'stacking', cp.stacking, 'ends_at', cp.ends_at, 'audience', cp.audience, 'delivery', coalesce(delivery_value, 0),
    'total', (result->>'subtotal')::numeric - (result->>'discount_total')::numeric + coalesce(delivery_value, 0), 'checked_at', now());
end $$;

-- ---------------------------------------------------------------------------
-- 4. Checkout: mismo contrato + cupón reservado + vínculo declarado de la sesión
-- ---------------------------------------------------------------------------
create or replace function public.storefront_order_result(target_order uuid)
returns table(order_number text, total numeric, whatsapp text, items jsonb)
language sql stable security definer set search_path = public as $$
  select o.order_number, o.total, (select s.whatsapp from public.site_settings s where s.id = 1),
    (select coalesce(jsonb_agg(jsonb_build_object('name', i.product_name, 'sku', i.sku, 'options', i.option_snapshot,
       'quantity', i.quantity, 'unit_price', i.unit_price, 'discount', i.discount, 'line_total', i.line_total) order by i.line_no), '[]'::jsonb)
     || case when o.coupon_code is not null then jsonb_build_array(jsonb_build_object('coupon', o.coupon_code, 'discount_total', o.discount_total, 'subtotal', o.subtotal, 'delivery', o.delivery_cost)) else '[]'::jsonb end
     from public.order_items i where i.order_id = o.id)
  from public.orders o where o.id = target_order
$$;

create or replace function public.create_storefront_order(payload jsonb, request_key uuid)
returns table(order_number text, total numeric, whatsapp text, items jsonb)
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  existing_id uuid; customer public.customers; line record; delivery public.delivery_methods; payment public.payment_methods; settings public.site_settings;
  normalized text; clean_name text; clean_phone text; clean_city text; clean_address text; clean_notes text; birth date;
  subtotal_value numeric(14,2) := 0; new_order_id uuid; conflicts jsonb := '{}'::jsonb; recent integer;
  coupon_code_value text; cp public.coupons; state text; computed jsonb; discount_value numeric(14,2) := 0; alloc jsonb; verified uuid;
begin
  if request_key is null then raise exception 'Falta la clave de idempotencia'; end if;
  select o.id into existing_id from public.orders o where o.idempotency_key = request_key;
  if found then return query select * from public.storefront_order_result(existing_id); return; end if;

  if jsonb_typeof(payload) is distinct from 'object' or jsonb_typeof(payload->'items') is distinct from 'array'
     or jsonb_array_length(payload->'items') not between 1 and 50 then
    raise exception 'El carrito no es válido';
  end if;
  if exists (select 1 from jsonb_array_elements(payload->'items') e
             where coalesce(e->>'variant_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                or coalesce(e->>'quantity', '') !~ '^[0-9]{1,3}$'
                or (e->>'quantity')::int not between 1 and 99) then
    raise exception 'Un producto o una cantidad del carrito no es válido';
  end if;

  clean_name := btrim(regexp_replace(coalesce(payload->>'name', ''), '\s+', ' ', 'g'));
  if length(clean_name) not between 2 and 120 then raise exception 'El nombre no es válido'; end if;
  clean_phone := btrim(coalesce(payload->>'phone', ''));
  if length(clean_phone) > 30 then raise exception 'Número de teléfono no válido'; end if;
  normalized := public.normalize_phone(clean_phone);
  clean_city := nullif(btrim(coalesce(payload->>'city', '')), '');
  clean_address := nullif(btrim(coalesce(payload->>'address', '')), '');
  clean_notes := nullif(btrim(coalesce(payload->>'notes', '')), '');
  if length(clean_city) > 80 or length(clean_address) > 250 or length(clean_notes) > 1000 then
    raise exception 'Uno de los campos supera la longitud permitida';
  end if;
  if coalesce(payload->>'birth_date', '') <> '' then
    if payload->>'birth_date' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'La fecha de nacimiento no es válida'; end if;
    begin birth := (payload->>'birth_date')::date;
    exception when others then raise exception 'La fecha de nacimiento no es válida'; end;
    if birth > public.bogota_today() or birth < date '1900-01-01' then raise exception 'La fecha de nacimiento no es válida'; end if;
  end if;

  select count(*) into recent from public.orders o join public.customers c on c.id = o.customer_id
    where c.phone_normalized = normalized and o.created_at > now() - interval '10 minutes';
  if recent >= 5 then raise exception 'Recibimos varias solicitudes seguidas con este teléfono. Espera unos minutos antes de intentarlo de nuevo.'; end if;
  select count(*) into recent from public.orders o where o.source = 'tienda' and o.created_at > now() - interval '1 hour';
  if recent >= 300 then raise exception 'Estamos recibiendo muchas solicitudes. Intenta nuevamente en unos minutos.'; end if;

  select * into settings from public.site_settings where id = 1;
  if nullif(btrim(coalesce(settings.whatsapp, '')), '') is null then raise exception 'El WhatsApp del negocio está pendiente de configuración'; end if;
  if coalesce(payload->>'delivery_method_id', '') !~* '^[0-9a-f-]{36}$' then raise exception 'Selecciona un método de entrega válido'; end if;
  select * into delivery from public.delivery_methods where id = (payload->>'delivery_method_id')::uuid and active;
  if not found then raise exception 'Selecciona un método de entrega válido'; end if;
  if coalesce(payload->>'payment_method_id', '') !~* '^[0-9a-f-]{36}$' then raise exception 'Selecciona un método de pago válido'; end if;
  select * into payment from public.payment_methods where id = (payload->>'payment_method_id')::uuid and active;
  if not found then raise exception 'Selecciona un método de pago válido'; end if;
  if (delivery.requires_city or delivery.requires_address) and clean_city is null then raise exception 'La ciudad es obligatoria'; end if;
  if delivery.requires_address and clean_address is null then raise exception 'La dirección es obligatoria'; end if;
  if not delivery.requires_city and not delivery.requires_address then clean_city := null; clean_address := null; end if;

  insert into public.customers(full_name, phone_original, phone_normalized, city, address, birth_date, source)
  values (clean_name, clean_phone, normalized, clean_city, clean_address, birth, 'tienda')
  on conflict (phone_normalized) do nothing
  returning * into customer;
  if customer.id is null then
    select * into customer from public.customers c where c.phone_normalized = normalized;
    if customer.merged_into is not null then
      conflicts := conflicts || jsonb_build_object('telefono_de_ficha_fusionada', customer.phone_original);
      select * into customer from public.customers c where c.id = customer.merged_into;
    end if;
    if customer.archived_at is not null then conflicts := conflicts || jsonb_build_object('cliente_archivado', true); end if;
    if customer.full_name is distinct from clean_name then conflicts := conflicts || jsonb_build_object('full_name', clean_name); end if;
    if clean_city is not null and customer.city is distinct from clean_city then conflicts := conflicts || jsonb_build_object('city', clean_city); end if;
    if clean_address is not null and customer.address is distinct from clean_address then conflicts := conflicts || jsonb_build_object('address', clean_address); end if;
    if birth is not null and customer.birth_date is distinct from birth then conflicts := conflicts || jsonb_build_object('birth_date', birth); end if;
  end if;

  insert into public.orders(order_number, customer_id, source, delivery_method_id, delivery_name, payment_method_id, payment_name,
    shipping_city, shipping_address, notes, customer_conflicts, subtotal, delivery_cost, total, idempotency_key)
  values (public.next_document_number('order'), customer.id, 'tienda', delivery.id, delivery.name, payment.id, payment.name,
    clean_city, clean_address, clean_notes, conflicts, 0, delivery.base_cost, 0, request_key)
  returning id into new_order_id;

  -- Líneas agrupadas por variante con la regla de precio vigente (variante → promoción → tramo).
  for line in select * from public.priced_cart_lines(payload->'items') order by 1 loop
    perform 1 from public.product_variants v where v.id = line.variant_id and v.active for share;
    if not found then raise exception 'Uno de los productos ya no está disponible'; end if;
    if not exists (select 1 from public.products p where p.id = line.product_id and p.status = 'published' and not p.force_sold_out) then
      raise exception 'Uno de los productos ya no está disponible';
    end if;
    if line.stock < line.quantity then raise exception 'Stock insuficiente para %: quedan % unidad(es)', line.product_name, line.stock; end if;
    subtotal_value := subtotal_value + line.gross;
    insert into public.order_items(order_id, product_id, variant_id, product_name, sku, option_snapshot, quantity, unit_price, line_total)
    values (new_order_id, line.product_id, line.variant_id, line.product_name, line.sku, public.variant_option_snapshot(line.variant_id), line.quantity, line.unit_price, line.gross);
  end loop;
  if (select count(*) from public.order_items i where i.order_id = new_order_id) <> (select count(distinct e->>'variant_id') from jsonb_array_elements(payload->'items') e) then
    raise exception 'Uno de los productos ya no está disponible';
  end if;

  -- Cupón: se recalcula aquí (nunca se confía en importes del navegador) y se reserva.
  coupon_code_value := upper(btrim(coalesce(payload->>'coupon_code', '')));
  if coupon_code_value <> '' then
    select * into cp from public.coupons c where c.code = coupon_code_value for update;
    verified := public.visitor_verified_customer(payload->'visitor');
    state := public.coupon_state(cp, customer.id, verified);
    if state <> 'valido' then
      raise exception using errcode = 'BM010', message = 'El código de descuento ya no aplica a este pedido.', detail = state;
    end if;
    computed := public.coupon_compute(public.coupon_config(cp), public.coupon_scope_list(cp.id), payload->'items');
    if computed->>'status' <> 'valido' then
      raise exception using errcode = 'BM010', message = 'El código de descuento ya no aplica a este pedido.', detail = computed->>'status';
    end if;
    discount_value := (computed->>'discount_total')::numeric;
    if nullif(payload->>'expected_discount', '') is not null and (payload->>'expected_discount')::numeric <> discount_value then
      raise exception using errcode = 'BM011', message = 'El descuento cambió desde que lo validaste. Revisa el nuevo total antes de enviar.',
        detail = format('validado %s, vigente %s', payload->>'expected_discount', discount_value);
    end if;
    for alloc in select value from jsonb_array_elements(computed->'lines') where (value->>'discount')::numeric > 0 loop
      update public.order_items i set discount = (alloc->>'discount')::numeric, line_total = i.unit_price * i.quantity - (alloc->>'discount')::numeric
      where i.order_id = new_order_id and i.variant_id = (alloc->>'variant_id')::uuid;
    end loop;
    insert into public.coupon_uses(coupon_id, order_id, customer_id, status, discount_total, snapshot, expires_at)
    values (cp.id, new_order_id, customer.id, 'reservada', discount_value, public.coupon_snapshot(cp) || jsonb_build_object('allocation', computed->'lines'), now() + make_interval(hours => cp.reservation_hours));
    update public.orders o set coupon_id = cp.id, coupon_code = cp.code, coupon_snapshot = public.coupon_snapshot(cp), discount_total = discount_value where o.id = new_order_id;
  end if;
  update public.orders o set subtotal = subtotal_value, total = subtotal_value - o.discount_total + o.delivery_cost where o.id = new_order_id;

  insert into public.customer_consents(customer_id, purpose, granted, text_version, source)
  values (customer.id, 'order_processing', true, coalesce(nullif(settings.data_policy_version, ''), 'pendiente'), 'checkout');
  if coalesce(payload->>'marketing_consent', 'false') = 'true' then
    insert into public.customer_consents(customer_id, purpose, granted, text_version, source)
    values (customer.id, 'marketing_birthday', true, coalesce(nullif(settings.marketing_consent_version, ''), 'pendiente'), 'checkout');
  end if;
  -- Vínculo declarado: solo la sesión del pedido y solo con analítica autorizada.
  perform public.link_order_session(new_order_id, customer.id, payload->'visitor');

  return query select * from public.storefront_order_result(new_order_id);
exception when unique_violation then
  select o.id into existing_id from public.orders o where o.idempotency_key = request_key;
  if existing_id is not null then return query select * from public.storefront_order_result(existing_id); return; end if;
  raise;
end $$;

-- Pedido cancelado/abandonado: libera la reserva una sola vez. Reabrirlo no la reactiva.
create or replace function public.orders_release_coupon() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('cancelado','abandonado') and old.status is distinct from new.status then
    update public.coupon_uses set status = 'liberada', released_at = now(), release_reason = 'pedido_' || new.status
    where order_id = new.id and status = 'reservada' and sale_id is null;
  end if;
  return new;
end $$;
create trigger orders_release_coupon after update of status on public.orders for each row execute function public.orders_release_coupon();

-- ---------------------------------------------------------------------------
-- 5. Ventas: descuento por línea, consumo único y liberación por política
-- ---------------------------------------------------------------------------
create or replace function public.create_sale_from_order(target_order uuid, accept_changes boolean default false) returns public.sales
language plpgsql security definer set search_path = public as $$
declare result public.sales; source public.orders;
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  select * into result from public.sales where source_order_id = target_order;
  if found then return result; end if;
  select * into source from public.orders where id = target_order for update;
  if not found then raise exception 'Pedido no encontrado'; end if;
  if source.status in ('cancelado','abandonado') then raise exception 'El pedido está %; reábrelo antes de convertirlo', source.status; end if;
  perform public.review_document_lines((select jsonb_agg(to_jsonb(i)) from public.order_items i where i.order_id = source.id), accept_changes);
  insert into public.sales(sale_number, customer_id, source, source_order_id, status, payment_method, subtotal, discount_total, delivery_cost, total,
    notes, terms_snapshot, warranty_snapshot, customer_snapshot, business_snapshot, coupon_snapshot)
  values (public.next_document_number('sale'), source.customer_id, 'pedido', source.id, 'solicitud', source.payment_name, source.subtotal, source.discount_total,
    source.delivery_cost, source.total, source.notes, (select sale_terms from public.site_settings where id = 1),
    (select warranty_text from public.site_settings where id = 1), public.customer_document_snapshot(source.customer_id), public.business_document_snapshot(), source.coupon_snapshot)
  returning * into result;
  insert into public.sale_items(sale_id, product_id, variant_id, product_name, sku, option_snapshot, quantity, unit_price, discount, line_total)
  select result.id, product_id, variant_id, product_name, sku, option_snapshot, quantity, unit_price, discount, line_total from public.order_items where order_id = source.id order by line_no;
  update public.coupon_uses set sale_id = result.id where order_id = source.id;
  update public.orders set status = 'confirmado' where id = source.id;
  return result;
end $$;

drop function if exists public.confirm_sale(uuid);
create or replace function public.confirm_sale(target_sale uuid, accept_coupon_review boolean default false) returns public.sales
language plpgsql security definer set search_path = public as $$
declare result public.sales; line record; changed integer; use_row public.coupon_uses; cp public.coupons;
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  select * into result from public.sales where id = target_sale for update;
  if not found then raise exception 'Venta no encontrada'; end if;
  if result.stock_applied_at is not null then return result; end if;
  if result.status <> 'solicitud' then raise exception 'Transición no permitida desde %', result.status; end if;
  -- Orden de bloqueo estable: venta → cupón → variantes (por id).
  select * into use_row from public.coupon_uses where sale_id = target_sale for update;
  if use_row.id is not null and use_row.status <> 'consumida' then
    select * into cp from public.coupons where id = use_row.coupon_id for update;
    if use_row.status = 'liberada' or use_row.expires_at < now() then
      if not accept_coupon_review then
        raise exception using errcode = 'BM002', message = 'La reserva del cupón venció o se liberó. Revisa antes de confirmar.',
          detail = format('Cupón %s · descuento %s · reserva %s hasta %s · usos vigentes %s de %s', cp.code, use_row.discount_total, use_row.status, use_row.expires_at,
            public.coupon_uses_count(cp.id, null, use_row.id), coalesce(cp.max_uses_total::text, 'sin límite'));
      end if;
      update public.coupon_uses set status = 'consumida', consumed_at = now(), honored_after_review = true, release_reason = null where id = use_row.id;
    else
      update public.coupon_uses set status = 'consumida', consumed_at = now() where id = use_row.id;
    end if;
  end if;
  perform set_config('bodega.stock_context', 'document', true);
  for line in
    select i.variant_id, min(i.product_name) as product_name, sum(i.quantity)::int as quantity
    from public.sale_items i where i.sale_id = target_sale group by i.variant_id order by i.variant_id
  loop
    if line.variant_id is null then raise exception 'La línea % ya no tiene variante en el catálogo', line.product_name; end if;
    update public.product_variants set stock = stock - line.quantity where id = line.variant_id and stock >= line.quantity;
    get diagnostics changed = row_count;
    if changed <> 1 then raise exception 'Stock insuficiente para %', line.product_name; end if;
    insert into public.stock_movements(variant_id, sale_id, quantity_delta, reason, created_by)
    values (line.variant_id, target_sale, -line.quantity, 'venta', auth.uid());
  end loop;
  perform set_config('bodega.stock_context', '', true);
  update public.sales set status = 'confirmada', stock_applied_at = now(), confirmed_at = now() where id = target_sale returning * into result;
  return result;
end $$;

create or replace function public.cancel_sale(target_sale uuid, reason text default null) returns public.sales
language plpgsql security definer set search_path = public as $$
declare result public.sales; line record;
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  select * into result from public.sales where id = target_sale for update;
  if not found then raise exception 'Venta no encontrada'; end if;
  if result.status = 'cancelada' then return result; end if;
  if result.status = 'devuelta' then raise exception 'Una venta devuelta no se cancela'; end if;
  if exists (select 1 from public.sale_returns where sale_id = target_sale) then
    raise exception 'La venta tiene devoluciones registradas; registra la devolución del resto en lugar de cancelar';
  end if;
  if result.stock_applied_at is not null and result.stock_restored_at is null then
    perform set_config('bodega.stock_context', 'document', true);
    for line in
      select i.variant_id, sum(i.quantity)::int as quantity from public.sale_items i
      where i.sale_id = target_sale and i.variant_id is not null group by i.variant_id order by i.variant_id
    loop
      update public.product_variants set stock = stock + line.quantity where id = line.variant_id;
      insert into public.stock_movements(variant_id, sale_id, quantity_delta, reason, created_by)
      values (line.variant_id, target_sale, line.quantity, 'cancelacion', auth.uid());
    end loop;
    perform set_config('bodega.stock_context', '', true);
    update public.sales set stock_restored_at = now() where id = target_sale;
  end if;
  -- Política del cupón: liberar una sola vez si así está configurado.
  update public.coupon_uses u set status = 'liberada', released_at = now(), release_reason = 'venta_cancelada'
  from public.coupons c where c.id = u.coupon_id and u.sale_id = target_sale and u.status in ('reservada','consumida') and c.release_on_cancel;
  update public.sales set status = 'cancelada', cancelled_at = now(), cancel_reason = nullif(btrim(coalesce(reason, '')), '')
  where id = target_sale returning * into result;
  return result;
end $$;

create or replace function public.register_sale_return(target_sale uuid, lines jsonb, restock boolean, request_key uuid, note text default null)
returns public.sales language plpgsql security definer set search_path = public as $$
declare result public.sales; line jsonb; item public.sale_items; returned integer; qty integer; new_return uuid; pending integer;
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  if restock is null then raise exception 'Indica si las unidades vuelven al inventario'; end if;
  if request_key is null then raise exception 'Falta la clave de la operación'; end if;
  select * into result from public.sales where id = target_sale for update;
  if not found then raise exception 'Venta no encontrada'; end if;
  if exists (select 1 from public.sale_returns r where r.sale_id = target_sale and r.request_key = register_sale_return.request_key) then
    return result;
  end if;
  if result.stock_applied_at is null or result.status not in ('confirmada','pagada','entregada') then
    raise exception 'Solo se registran devoluciones de ventas confirmadas';
  end if;
  if jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) = 0 then raise exception 'Indica qué productos se devuelven'; end if;
  perform set_config('bodega.stock_context', 'document', true);
  for line in select value from jsonb_array_elements(lines) loop
    select * into item from public.sale_items where id = (line->>'sale_item_id')::uuid and sale_id = target_sale;
    if not found then raise exception 'La línea no pertenece a esta venta'; end if;
    qty := case when coalesce(line->>'quantity', '') ~ '^[0-9]{1,4}$' then (line->>'quantity')::int else 0 end;
    select coalesce(sum(r.quantity), 0) into returned from public.sale_returns r where r.sale_item_id = item.id;
    if qty < 1 or qty > item.quantity - returned then
      raise exception 'Cantidad a devolver no válida para % (máximo %)', item.product_name, item.quantity - returned;
    end if;
    insert into public.sale_returns(sale_id, sale_item_id, request_key, quantity, restocked, note, created_by)
    values (target_sale, item.id, register_sale_return.request_key, qty, restock and item.variant_id is not null, nullif(btrim(coalesce(note, '')), ''), auth.uid())
    returning id into new_return;
    if restock and item.variant_id is not null then
      update public.product_variants set stock = stock + qty where id = item.variant_id;
      insert into public.stock_movements(variant_id, sale_id, sale_return_id, quantity_delta, reason, note, created_by)
      values (item.variant_id, target_sale, new_return, qty, 'devolucion', nullif(btrim(coalesce(note, '')), ''), auth.uid());
    end if;
  end loop;
  perform set_config('bodega.stock_context', '', true);
  select coalesce(sum(i.quantity), 0) - coalesce((select sum(r.quantity) from public.sale_returns r where r.sale_id = target_sale), 0)
    into pending from public.sale_items i where i.sale_id = target_sale;
  if pending = 0 then
    update public.sales set status = 'devuelta' where id = target_sale;
    update public.coupon_uses u set status = 'liberada', released_at = now(), release_reason = 'devolucion_total'
    from public.coupons c where c.id = u.coupon_id and u.sale_id = target_sale and u.status = 'consumida' and c.release_on_full_return;
  end if;
  select * into result from public.sales where id = target_sale;
  return result;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Administración de cupones y ofertas privadas
-- ---------------------------------------------------------------------------
create or replace function public.generate_coupon_code(prefix text default 'OF') returns text
language plpgsql volatile set search_path = public as $$
declare alphabet text := 'ACDEFGHJKMNPQRTUVWXY34679'; candidate text; i integer;
begin
  loop
    candidate := upper(coalesce(nullif(regexp_replace(prefix, '[^A-Za-z0-9]', '', 'g'), ''), 'OF')) || '-';
    for i in 1..8 loop candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1); end loop;
    exit when not exists (select 1 from public.coupons where code = candidate);
  end loop;
  return candidate;
end $$;

create or replace function public.save_coupon(target uuid, payload jsonb) returns public.coupons
language plpgsql security definer set search_path = public as $$
declare result public.coupons; scope jsonb; clean_code text;
begin
  -- El vendedor solo crea cupones personales a través de create_customer_offer.
  if not (public.is_admin() or (public.has_staff_role(array['vendedor']) and coalesce(current_setting('bodega.offer_context', true), '') = 'on'
      and payload->>'audience' in ('portador','cliente_verificado') and nullif(payload->>'customer_id', '') is not null)) then raise exception 'Sin permiso'; end if;
  clean_code := upper(btrim(coalesce(payload->>'code', '')));
  if clean_code = '' then clean_code := public.generate_coupon_code(coalesce(payload->>'prefix', 'CUP')); end if;
  if target is null then
    insert into public.coupons(code, name, kind, value, max_discount, min_eligible, stacking, starts_at, ends_at, max_uses_total, max_uses_per_customer,
      audience, customer_id, reservation_hours, release_on_cancel, release_on_full_return, active, created_by)
    values (clean_code, btrim(payload->>'name'), payload->>'kind', (payload->>'value')::numeric, nullif(payload->>'max_discount', '')::numeric,
      coalesce(nullif(payload->>'min_eligible', '')::numeric, 0), coalesce(nullif(payload->>'stacking', ''), 'sobre_precio_vigente'),
      nullif(payload->>'starts_at', '')::timestamptz, nullif(payload->>'ends_at', '')::timestamptz, nullif(payload->>'max_uses_total', '')::int,
      nullif(payload->>'max_uses_per_customer', '')::int, coalesce(nullif(payload->>'audience', ''), 'publico'), nullif(payload->>'customer_id', '')::uuid,
      coalesce(nullif(payload->>'reservation_hours', '')::int, 72), coalesce((payload->>'release_on_cancel')::boolean, true),
      coalesce((payload->>'release_on_full_return')::boolean, false), coalesce((payload->>'active')::boolean, true), auth.uid())
    returning * into result;
  else
    -- Cambiar la configuración futura no altera snapshots de pedidos/ventas ya creados.
    update public.coupons set name = btrim(payload->>'name'), kind = payload->>'kind', value = (payload->>'value')::numeric,
      max_discount = nullif(payload->>'max_discount', '')::numeric, min_eligible = coalesce(nullif(payload->>'min_eligible', '')::numeric, 0),
      stacking = coalesce(nullif(payload->>'stacking', ''), 'sobre_precio_vigente'), starts_at = nullif(payload->>'starts_at', '')::timestamptz,
      ends_at = nullif(payload->>'ends_at', '')::timestamptz, max_uses_total = nullif(payload->>'max_uses_total', '')::int,
      max_uses_per_customer = nullif(payload->>'max_uses_per_customer', '')::int, audience = coalesce(nullif(payload->>'audience', ''), 'publico'),
      customer_id = nullif(payload->>'customer_id', '')::uuid, reservation_hours = coalesce(nullif(payload->>'reservation_hours', '')::int, 72),
      release_on_cancel = coalesce((payload->>'release_on_cancel')::boolean, true), release_on_full_return = coalesce((payload->>'release_on_full_return')::boolean, false),
      active = coalesce((payload->>'active')::boolean, true)
    where id = target returning * into result;
    if result.id is null then raise exception 'Cupón no encontrado'; end if;
    delete from public.coupon_scopes where coupon_id = result.id;
  end if;
  for scope in select value from jsonb_array_elements(coalesce(payload->'scopes', '[]'::jsonb)) loop
    insert into public.coupon_scopes(coupon_id, scope_type, target_id, mode) values (result.id, scope->>'scope_type', (scope->>'target_id')::uuid, coalesce(scope->>'mode', 'incluir'))
    on conflict do nothing;
  end loop;
  return result;
end $$;

-- Vista previa de una oferta con el mismo cálculo del checkout (no guarda nada).
create or replace function public.preview_offer(items jsonb, benefit jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare scopes jsonb;
begin
  if not public.has_staff_role(array['propietario','vendedor']) then raise exception 'Sin permiso'; end if;
  if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items) not between 1 and 20 then raise exception 'Elige entre 1 y 20 productos'; end if;
  if benefit->>'kind' not in ('porcentaje','valor_fijo') or coalesce(nullif(benefit->>'value', '')::numeric, 0) <= 0
     or (benefit->>'kind' = 'porcentaje' and (benefit->>'value')::numeric > 100) then raise exception 'Beneficio no válido'; end if;
  select jsonb_agg(jsonb_build_object('scope_type', 'variant', 'target_id', e->>'variant_id', 'mode', 'incluir')) into scopes from jsonb_array_elements(items) e;
  return public.coupon_compute(benefit, scopes, items);
end $$;

create or replace function public.create_customer_offer(payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare customer public.customers; preview jsonb; cp public.coupons; offer public.customer_offers; scopes jsonb; audience text; benefit jsonb;
begin
  if not public.has_staff_role(array['propietario','vendedor']) then raise exception 'Sin permiso'; end if;
  select * into customer from public.customers where id = (payload->>'customer_id')::uuid and merged_into is null;
  if customer.id is null then raise exception 'Cliente no válido'; end if;
  benefit := payload->'benefit';
  preview := public.preview_offer(payload->'items', benefit);
  if preview->>'status' <> 'valido' then raise exception 'La oferta no es válida: %', preview->>'status'; end if;
  if (preview->>'unavailable_lines')::int > 0 then raise exception 'Hay productos sin stock suficiente en la variante elegida'; end if;
  audience := coalesce(nullif(payload->>'audience', ''), 'portador');
  if audience not in ('portador','cliente_verificado') then raise exception 'Audiencia no válida'; end if;
  select jsonb_agg(jsonb_build_object('scope_type', 'variant', 'target_id', e->>'variant_id', 'mode', 'incluir')) into scopes from jsonb_array_elements(payload->'items') e;
  perform set_config('bodega.offer_context', 'on', true);
  cp := public.save_coupon(null, jsonb_build_object('name', left(coalesce(nullif(btrim(payload->>'title'), ''), 'Oferta para ' || customer.full_name), 120), 'prefix', 'OF',
    'kind', benefit->>'kind', 'value', benefit->>'value', 'max_discount', benefit->>'max_discount', 'min_eligible', benefit->>'min_eligible',
    'stacking', coalesce(benefit->>'stacking', 'sobre_precio_vigente'), 'ends_at', benefit->>'ends_at',
    'max_uses_total', coalesce(nullif(payload->>'max_uses', ''), '1'), 'max_uses_per_customer', '1', 'audience', audience, 'customer_id', customer.id,
    'reservation_hours', coalesce(benefit->>'reservation_hours', '72'), 'scopes', scopes));
  perform set_config('bodega.offer_context', '', true);
  insert into public.customer_offers(customer_id, coupon_id, title, items, totals, recommendation, message_text, created_by)
  values (customer.id, cp.id, left(coalesce(nullif(btrim(payload->>'title'), ''), 'Oferta personal'), 120), preview->'lines',
    jsonb_build_object('subtotal', preview->'subtotal', 'discount_total', preview->'discount_total', 'total', (preview->>'subtotal')::numeric - (preview->>'discount_total')::numeric, 'benefit', benefit),
    coalesce(payload->'recommendation', '{}'::jsonb), nullif(payload->>'message', ''), auth.uid())
  returning * into offer;
  insert into public.contact_attempts(customer_id, offer_id, channel, kind, note, created_by) values (customer.id, offer.id, 'whatsapp', 'preparado', 'Oferta preparada', auth.uid());
  return jsonb_build_object('offer', to_jsonb(offer), 'coupon', jsonb_build_object('id', cp.id, 'code', cp.code, 'ends_at', cp.ends_at, 'audience', cp.audience));
end $$;

-- Estado de la oferta. "enviada_declarada" la declara el vendedor; abrir WhatsApp no cuenta.
create or replace function public.update_customer_offer(target uuid, payload jsonb) returns public.customer_offers
language plpgsql security definer set search_path = public as $$
declare offer public.customer_offers; new_status text := payload->>'status';
begin
  if not public.has_staff_role(array['propietario','vendedor']) then raise exception 'Sin permiso'; end if;
  select * into offer from public.customer_offers where id = target for update;
  if not found then raise exception 'Oferta no encontrada'; end if;
  if new_status is not null and new_status not in ('preparada','enviada_declarada','respondida','aceptada','rechazada','cerrada','expirada') then raise exception 'Estado no válido'; end if;
  update public.customer_offers set
    status = coalesce(new_status, status),
    message_text = coalesce(nullif(payload->>'message', ''), message_text),
    response_note = coalesce(nullif(btrim(coalesce(payload->>'note', '')), ''), response_note),
    outcome = coalesce(nullif(payload->>'outcome', ''), outcome),
    sent_declared_at = case when new_status = 'enviada_declarada' then coalesce(sent_declared_at, now()) else sent_declared_at end,
    responded_at = case when new_status in ('respondida','aceptada','rechazada') then coalesce(responded_at, now()) else responded_at end
  where id = target returning * into offer;
  if new_status in ('enviada_declarada','respondida','aceptada','rechazada') then
    insert into public.contact_attempts(customer_id, offer_id, channel, kind, note, outcome, created_by)
    values (offer.customer_id, offer.id, coalesce(nullif(payload->>'channel', ''), 'whatsapp'), case when new_status = 'enviada_declarada' then 'declarado_enviado' else 'respuesta' end,
      nullif(btrim(coalesce(payload->>'note', '')), ''), new_status, auth.uid());
  end if;
  if new_status in ('rechazada','cerrada','expirada') and offer.coupon_id is not null then
    update public.coupons set active = false where id = offer.coupon_id and not exists (select 1 from public.coupon_uses u where u.coupon_id = offer.coupon_id and u.status in ('reservada','consumida'));
  end if;
  return offer;
end $$;

-- Cotización vinculada con los mismos importes por línea de la oferta.
create or replace function public.create_quote_from_offer(target uuid) returns public.quotes
language plpgsql security definer set search_path = public as $$
declare offer public.customer_offers; result public.quotes;
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  select * into offer from public.customer_offers where id = target for update;
  if not found then raise exception 'Oferta no encontrada'; end if;
  if offer.quote_id is not null then select * into result from public.quotes where id = offer.quote_id; return result; end if;
  result := public.save_admin_quote(null, jsonb_build_object('customer_id', offer.customer_id,
    'valid_until', coalesce(((offer.totals->'benefit'->>'ends_at')::timestamptz at time zone 'America/Bogota')::date::text, ''),
    'notes', 'Oferta ' || offer.title,
    'items', (select jsonb_agg(jsonb_build_object('variant_id', x->>'variant_id', 'quantity', (x->>'quantity')::int, 'unit_price', x->>'unit_price', 'discount', x->>'discount') order by (x->>'line_no')::int) from jsonb_array_elements(offer.items) x)));
  update public.customer_offers set quote_id = result.id where id = target;
  return result;
end $$;

-- ---------------------------------------------------------------------------
-- 7. RLS y privilegios
-- ---------------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['coupons','coupon_scopes','customer_offers','contact_attempts','coupon_uses','coupon_attempts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (%s)', t || '_staff_read', t,
      case when t = 'coupon_attempts' then 'public.is_admin()' else 'public.has_staff_role(array[''propietario'',''vendedor''])' end);
  end loop;
end $$;
revoke all on public.coupons, public.coupon_scopes, public.customer_offers, public.contact_attempts, public.coupon_uses, public.coupon_attempts from anon, authenticated;
grant select on public.coupons, public.coupon_scopes, public.customer_offers, public.contact_attempts, public.coupon_uses to authenticated;

revoke execute on function public.priced_cart_lines(jsonb), public.coupon_scope_matches(jsonb, uuid, uuid, uuid, uuid[]), public.coupon_compute(jsonb, jsonb, jsonb),
  public.coupon_config(public.coupons), public.coupon_scope_list(uuid), public.coupon_uses_count(uuid, uuid, uuid), public.coupon_state(public.coupons, uuid, uuid, uuid),
  public.coupon_snapshot(public.coupons), public.visitor_verified_customer(jsonb), public.orders_release_coupon(), public.generate_coupon_code(text),
  public.storefront_order_result(uuid) from public, anon, authenticated;
grant execute on function public.validate_cart_coupon(jsonb, text, jsonb, uuid), public.create_storefront_order(jsonb, uuid) to anon, authenticated;
grant execute on function public.confirm_sale(uuid, boolean), public.cancel_sale(uuid, text), public.register_sale_return(uuid, jsonb, boolean, uuid, text),
  public.create_sale_from_order(uuid, boolean), public.save_coupon(uuid, jsonb), public.preview_offer(jsonb, jsonb), public.create_customer_offer(jsonb),
  public.update_customer_offer(uuid, jsonb), public.create_quote_from_offer(uuid) to authenticated;

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
