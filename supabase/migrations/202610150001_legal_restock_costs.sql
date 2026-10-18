-- Bodega Mayorista F.C. — aceptación legal registrada, avisos de disponibilidad y
-- costos privados para margen. Incremental; no modifica importes históricos.
--
-- La exigencia de aceptar Términos y Política en el SERVIDOR se activa con
-- site_settings.legal_acceptance_required. Queda en false para no bloquear pedidos de
-- una versión publicada del sitio que todavía no envía la aceptación; se enciende desde
-- Configuración en cuanto el sitio nuevo esté publicado. La tienda nueva siempre la exige.

-- ---------------------------------------------------------------------------
-- 1. Textos legales y evidencia de aceptación
-- ---------------------------------------------------------------------------
alter table public.site_settings
  add column if not exists terms_text text,
  add column if not exists terms_version text,
  add column if not exists shipping_policy_text text,
  add column if not exists returns_policy_text text,
  add column if not exists restock_consent_text text,
  add column if not exists legal_updated_at timestamptz,
  add column if not exists legal_acceptance_required boolean not null default false;

alter table public.orders
  add column if not exists terms_version text,
  add column if not exists data_policy_version text,
  add column if not exists legal_accepted_at timestamptz;

alter table public.customer_consents drop constraint if exists customer_consents_purpose_check;
alter table public.customer_consents add constraint customer_consents_purpose_check
  check (purpose in ('order_processing','marketing_birthday','terms_conditions','restock_notice'));

-- Checkout: mismo contrato que 202610140002 + aceptación legal versionada.
create or replace function public.create_storefront_order(payload jsonb, request_key uuid)
returns table(order_number text, total numeric, whatsapp text, items jsonb)
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  existing_id uuid; customer public.customers; line record; delivery public.delivery_methods; payment public.payment_methods; settings public.site_settings;
  normalized text; clean_name text; clean_phone text; clean_city text; clean_address text; clean_notes text; birth date;
  subtotal_value numeric(14,2) := 0; new_order_id uuid; conflicts jsonb := '{}'::jsonb; recent integer;
  coupon_code_value text; cp public.coupons; state text; computed jsonb; discount_value numeric(14,2) := 0; alloc jsonb; verified uuid;
  legal_ok boolean := false;
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

  -- Aceptación de Términos y de la Política de datos en la versión publicada.
  legal_ok := coalesce((payload->'legal'->>'accepted') = 'true', false);
  if settings.legal_acceptance_required and (nullif(settings.terms_version, '') is null or nullif(settings.data_policy_version, '') is null) then
    raise exception using errcode = 'BM030', message = 'La tienda está actualizando sus términos. Escríbenos por WhatsApp para hacer tu pedido.';
  end if;
  if settings.legal_acceptance_required and not legal_ok then
    raise exception using errcode = 'BM030', message = 'Para enviar el pedido debes aceptar los Términos y condiciones y la Política de tratamiento de datos personales.';
  end if;
  if legal_ok and ((payload->'legal'->>'terms_version') is distinct from settings.terms_version or (payload->'legal'->>'data_policy_version') is distinct from settings.data_policy_version) then
    raise exception using errcode = 'BM031', message = 'Los términos o la política de datos se actualizaron. Revísalos y acéptalos de nuevo.';
  end if;

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
    shipping_city, shipping_address, notes, customer_conflicts, subtotal, delivery_cost, total, idempotency_key,
    terms_version, data_policy_version, legal_accepted_at)
  values (public.next_document_number('order'), customer.id, 'tienda', delivery.id, delivery.name, payment.id, payment.name,
    clean_city, clean_address, clean_notes, conflicts, 0, delivery.base_cost, 0, request_key,
    case when legal_ok then settings.terms_version end, case when legal_ok then settings.data_policy_version end, case when legal_ok then now() end)
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
  if legal_ok then
    insert into public.customer_consents(customer_id, purpose, granted, text_version, source)
    values (customer.id, 'terms_conditions', true, settings.terms_version, 'checkout');
  end if;
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

-- ---------------------------------------------------------------------------
-- 2. "Avísame cuando llegue" (solicitud expresa del cliente, no es publicidad)
-- ---------------------------------------------------------------------------
create table public.restock_requests (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete restrict,
  phone_normalized text not null,
  consent_version text not null,
  status text not null default 'pendiente' check (status in ('pendiente','avisado','cancelado','expirado')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days',
  notified_at timestamptz
);
create unique index restock_requests_pending_idx on public.restock_requests(variant_id, phone_normalized) where status = 'pendiente';
create index restock_requests_status_idx on public.restock_requests(status, created_at desc);

-- Respuesta idéntica exista o no el cliente; no devuelve datos.
create or replace function public.request_restock_notice(target_variant uuid, name text, phone text, accepted boolean)
returns boolean language plpgsql security definer set search_path = public, pg_catalog as $$
declare v public.product_variants; p public.products; normalized text; clean_name text; customer public.customers; recent integer; cfg public.site_settings;
begin
  if accepted is distinct from true then raise exception 'Debes autorizar el aviso para registrarlo'; end if;
  select * into cfg from public.site_settings where id = 1;
  clean_name := btrim(regexp_replace(coalesce(name, ''), '\s+', ' ', 'g'));
  if length(clean_name) not between 2 and 120 then raise exception 'Escribe tu nombre'; end if;
  if length(btrim(coalesce(phone, ''))) > 30 then raise exception 'Número de teléfono no válido'; end if;
  normalized := public.normalize_phone(phone);
  select * into v from public.product_variants where id = target_variant;
  select * into p from public.products where id = v.product_id and status = 'published';
  if v.id is null or p.id is null then raise exception 'Producto no disponible'; end if;
  select count(*) into recent from public.restock_requests r where r.phone_normalized = normalized and r.created_at > now() - interval '1 day';
  if recent >= 5 then raise exception 'Ya registraste varios avisos hoy. Intenta mañana.'; end if;
  select count(*) into recent from public.restock_requests r where r.created_at > now() - interval '1 hour';
  if recent >= 300 then raise exception 'Estamos recibiendo muchas solicitudes. Intenta más tarde.'; end if;
  -- Igual que el checkout: crea la ficha si no existe y nunca sobrescribe una existente.
  insert into public.customers(full_name, phone_original, phone_normalized, source) values (clean_name, btrim(phone), normalized, 'tienda')
  on conflict (phone_normalized) do nothing returning * into customer;
  if customer.id is null then
    select * into customer from public.customers c where c.phone_normalized = normalized;
    if customer.merged_into is not null then select * into customer from public.customers c where c.id = customer.merged_into; end if;
  end if;
  insert into public.restock_requests(product_id, variant_id, customer_id, phone_normalized, consent_version)
  values (p.id, v.id, customer.id, normalized, coalesce(nullif(cfg.data_policy_version, ''), 'pendiente'))
  on conflict (variant_id, phone_normalized) where status = 'pendiente' do nothing;
  insert into public.customer_consents(customer_id, purpose, granted, text_version, source)
  values (customer.id, 'restock_notice', true, coalesce(nullif(cfg.data_policy_version, ''), 'pendiente'), 'aviso_disponibilidad');
  return true;
end $$;

-- Tareas: reglas tareas-v1 + aviso de disponibilidad (tareas-v2).
alter table public.customer_tasks drop constraint if exists customer_tasks_kind_check;
alter table public.customer_tasks add constraint customer_tasks_kind_check check (kind in ('pedido_pendiente','cotizacion_seguimiento','borrador_interno','carrito_sin_compra','reposicion','postventa','reactivar','devolucion','cumpleanos','oferta_sin_respuesta','disponible_de_nuevo','manual'));
alter function public.generate_customer_tasks(uuid) rename to generate_customer_tasks_v1;
revoke execute on function public.generate_customer_tasks_v1(uuid) from public, anon, authenticated;

create or replace function public.generate_customer_tasks(target_customer uuid default null) returns integer
language plpgsql security definer set search_path = public as $$
declare created integer; n integer;
begin
  if not public.has_staff_role(array['propietario','vendedor']) then raise exception 'Sin permiso'; end if;
  created := public.generate_customer_tasks_v1(target_customer);
  update public.restock_requests set status = 'expirado' where status = 'pendiente' and expires_at < now();
  insert into public.customer_tasks(customer_id, kind, dedupe_key, title, objective, evidence, priority, priority_reason, due_at, source_type, source_id, rule_version)
  select r.customer_id, 'disponible_de_nuevo', 'restock:' || r.id, 'Avisar que llegó ' || p.name,
    'El cliente pidió que le avisaran. Confirma precio y disponibilidad; no es una promoción.',
    jsonb_build_array(jsonb_build_object('label', 'Pidió aviso de disponibilidad', 'date', (r.created_at at time zone 'America/Bogota')::date, 'kind', 'declarado'),
      jsonb_build_object('label', 'Hay ' || v.stock || ' unidad(es) en la variante', 'kind', 'observado')),
    72, jsonb_build_object('urgencia', 'Solicitud del cliente', 'permiso', 'Aviso solicitado por el cliente'), public.bogota_today(), 'restock', r.id, 'tareas-v2'
  from public.restock_requests r join public.product_variants v on v.id = r.variant_id and v.active and v.stock > 0
  join public.products p on p.id = r.product_id and p.status = 'published' and not p.force_sold_out
  where r.status = 'pendiente' and (target_customer is null or r.customer_id = target_customer)
  on conflict (dedupe_key) do nothing;
  get diagnostics n = row_count;
  return created + n;
end $$;

create or replace function public.restock_task_done() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'disponible_de_nuevo' and new.status = 'completada' and old.status is distinct from 'completada' then
    update public.restock_requests set status = 'avisado', notified_at = now() where id = new.source_id and status = 'pendiente';
  elsif new.kind = 'disponible_de_nuevo' and new.status = 'descartada' and old.status is distinct from 'descartada' then
    update public.restock_requests set status = 'cancelado' where id = new.source_id and status = 'pendiente';
  end if;
  return new;
end $$;
create trigger customer_tasks_restock_done after update of status on public.customer_tasks for each row execute function public.restock_task_done();

-- ---------------------------------------------------------------------------
-- 3. Costos privados (solo propietario) y margen en la vista previa de ofertas
-- ---------------------------------------------------------------------------
create table public.product_costs (
  product_id uuid primary key references public.products(id) on delete cascade,
  unit_cost numeric(14,2) not null check (unit_cost >= 0),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create trigger product_costs_updated_at before update on public.product_costs for each row execute function public.set_updated_at();

create or replace function public.preview_offer(items jsonb, benefit jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare scopes jsonb; result jsonb; cost_total numeric := 0; missing integer := 0; line jsonb; unit_cost numeric; net numeric;
begin
  if not public.has_staff_role(array['propietario','vendedor']) then raise exception 'Sin permiso'; end if;
  if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items) not between 1 and 20 then raise exception 'Elige entre 1 y 20 productos'; end if;
  if benefit->>'kind' not in ('porcentaje','valor_fijo') or coalesce(nullif(benefit->>'value', '')::numeric, 0) <= 0
     or (benefit->>'kind' = 'porcentaje' and (benefit->>'value')::numeric > 100) then raise exception 'Beneficio no válido'; end if;
  select jsonb_agg(jsonb_build_object('scope_type', 'variant', 'target_id', e->>'variant_id', 'mode', 'incluir')) into scopes from jsonb_array_elements(items) e;
  result := public.coupon_compute(benefit, scopes, items);
  -- El margen solo lo ve el propietario y solo si todas las líneas tienen costo.
  if not public.is_admin() then return result || jsonb_build_object('margin_available', false, 'margin_reason', 'Solo el propietario ve costos'); end if;
  for line in select value from jsonb_array_elements(result->'lines') loop
    select c.unit_cost into unit_cost from public.product_costs c where c.product_id = (line->>'product_id')::uuid;
    if unit_cost is null then missing := missing + 1; else cost_total := cost_total + unit_cost * (line->>'quantity')::int; end if;
  end loop;
  net := (result->>'subtotal')::numeric - (result->>'discount_total')::numeric;
  if missing > 0 then return result || jsonb_build_object('margin_available', false, 'margin_reason', format('Falta el costo de %s producto(s)', missing)); end if;
  return result || jsonb_build_object('margin_available', true, 'cost_total', cost_total, 'margin_total', net - cost_total,
    'margin_rate', case when net > 0 then round((net - cost_total) / net, 4) end);
end $$;

-- ---------------------------------------------------------------------------
-- 4. RLS y privilegios
-- ---------------------------------------------------------------------------
alter table public.restock_requests enable row level security;
alter table public.product_costs enable row level security;
create policy restock_requests_staff_read on public.restock_requests for select to authenticated using (public.has_staff_role(array['propietario','vendedor']));
create policy product_costs_owner_all on public.product_costs for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.restock_requests, public.product_costs from anon, authenticated;
grant select on public.restock_requests to authenticated;
grant select, insert, update, delete on public.product_costs to authenticated;
revoke execute on function public.restock_task_done() from public, anon, authenticated;
grant execute on function public.request_restock_notice(uuid, text, text, boolean), public.create_storefront_order(jsonb, uuid) to anon, authenticated;
grant execute on function public.generate_customer_tasks(uuid), public.preview_offer(jsonb, jsonb) to authenticated;

-- Ninguna función nueva queda ejecutable por PUBLIC (ver hallazgo N1).
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f' and (p.proacl is null or p.proacl::text ~ '(^|[{,])=X')
             and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') loop
    execute format('revoke execute on function %s from public', f.sig);
  end loop;
end $$;
