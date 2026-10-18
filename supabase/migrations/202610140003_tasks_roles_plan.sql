-- Bodega Mayorista F.C. — plan de acción persistido ("A quién atender hoy"), permisos
-- por rol y modelo de plan de servicio (desactivado hasta tener proveedor de pagos).

-- ---------------------------------------------------------------------------
-- 1. Tareas comerciales
-- ---------------------------------------------------------------------------
create table public.customer_tasks (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  kind text not null check (kind in ('pedido_pendiente','cotizacion_seguimiento','borrador_interno','carrito_sin_compra','reposicion','postventa','reactivar','devolucion','cumpleanos','oferta_sin_respuesta','manual')),
  -- La clave de deduplicación es única para SIEMPRE: una tarea completada, pospuesta o
  -- descartada no se regenera para el mismo hecho. Las recurrentes incluyen su periodo.
  dedupe_key text not null unique,
  title text not null,
  objective text,
  evidence jsonb not null default '[]'::jsonb,
  priority integer not null default 50 check (priority between 0 and 100),
  priority_reason jsonb not null default '{}'::jsonb,
  promotional boolean not null default false,
  assignee uuid references auth.users(id) on delete set null,
  due_at date,
  status text not null default 'pendiente' check (status in ('pendiente','pospuesta','completada','descartada')),
  next_review_at date,
  discard_reason text,
  outcome text,
  rule_version text not null default 'tareas-v1',
  source_type text,
  source_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  check (status <> 'descartada' or discard_reason is not null),
  check (status <> 'pospuesta' or next_review_at is not null)
);
create trigger customer_tasks_updated_at before update on public.customer_tasks for each row execute function public.set_updated_at();
create index customer_tasks_open_idx on public.customer_tasks(status, priority desc, due_at) where status in ('pendiente','pospuesta');
create index customer_tasks_customer_idx on public.customer_tasks(customer_id, created_at desc);
alter table public.contact_attempts add constraint contact_attempts_task_fkey foreign key (task_id) references public.customer_tasks(id) on delete set null;

create or replace function public.customer_marketing_allowed(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select c.granted and c.withdrawn_at is null from public.customer_consents c where c.customer_id = target and c.purpose = 'marketing_birthday' order by c.recorded_at desc, c.id desc limit 1), false)
    and not exists (select 1 from public.birthday_contacts b where b.customer_id = target and b.status = 'no_contactar')
$$;

-- Saturación: no proponer contacto comercial si hubo uno reciente o hay una devolución abierta.
create or replace function public.customer_contact_saturated(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.contact_attempts a where a.customer_id = target and a.purpose = 'comercial' and a.kind in ('declarado_enviado','preparado')
      and a.created_at > now() - make_interval(days => (select contact_cooldown_days from public.site_settings where id = 1)))
    or exists (select 1 from public.customer_tasks t where t.customer_id = target and t.kind = 'devolucion' and t.status in ('pendiente','pospuesta'))
$$;

-- Generación por reglas explícitas (tareas-v1). Idempotente: ON CONFLICT DO NOTHING.
create or replace function public.generate_customer_tasks(target_customer uuid default null) returns integer
language plpgsql security definer set search_path = public as $$
declare created integer := 0; n integer; today date := public.bogota_today();
begin
  if not public.has_staff_role(array['propietario','vendedor']) then raise exception 'Sin permiso'; end if;

  -- Pedido real pendiente de atención (no promocional).
  insert into public.customer_tasks(customer_id, kind, dedupe_key, title, objective, evidence, priority, priority_reason, due_at, source_type, source_id)
  select o.customer_id, 'pedido_pendiente', 'pedido:' || o.id, 'Atender el pedido ' || o.order_number, 'Confirmar entrega, pago y disponibilidad con el cliente.',
    jsonb_build_array(jsonb_build_object('label', 'Pedido ' || o.order_number || ' por ' || to_char(o.total, 'FM999G999G999'), 'date', (o.created_at at time zone 'America/Bogota')::date, 'kind', 'observado')),
    least(98, 88 + (today - (o.created_at at time zone 'America/Bogota')::date)), jsonb_build_object('urgencia', 'Pedido sin atender', 'evidencia', 'Solicitud del cliente registrada en el servidor'),
    today, 'order', o.id
  from public.orders o where o.status = 'pendiente' and not exists (select 1 from public.sales s where s.source_order_id = o.id) and (target_customer is null or o.customer_id = target_customer)
  on conflict (dedupe_key) do nothing;
  get diagnostics n = row_count; created := created + n;

  -- Cotización aceptada o enviada sin respuesta (dos o más días).
  insert into public.customer_tasks(customer_id, kind, dedupe_key, title, objective, evidence, priority, priority_reason, due_at, source_type, source_id)
  select q.customer_id, 'cotizacion_seguimiento', 'cotizacion-' || q.status || ':' || q.id,
    case when q.status = 'aceptada' then 'Convertir la cotización aceptada ' || q.quote_number else 'Dar seguimiento a ' || q.quote_number end,
    case when q.status = 'aceptada' then 'Revisar precio y stock de cada línea y convertir en venta.' else 'Preguntar si tiene dudas; no reenviar descuentos sin respuesta.' end,
    jsonb_build_array(jsonb_build_object('label', 'Cotización ' || q.status, 'date', (coalesce(q.sent_at, q.created_at) at time zone 'America/Bogota')::date, 'kind', 'observado')),
    case when q.status = 'aceptada' then 88 else 68 end, jsonb_build_object('urgencia', case when q.valid_until is not null then 'Vigente hasta ' || q.valid_until else 'Sin vigencia' end),
    least(coalesce(q.valid_until, today + 3), today + 3), 'quote', q.id
  from public.quotes q
  where ((q.status = 'aceptada') or (q.status = 'enviada' and coalesce(q.sent_at, q.created_at) < now() - interval '2 days'))
    and (q.valid_until is null or q.valid_until >= today) and (target_customer is null or q.customer_id = target_customer)
  on conflict (dedupe_key) do nothing;
  get diagnostics n = row_count; created := created + n;

  -- Borrador interno: tarea del vendedor, sin atribuir intención al cliente.
  insert into public.customer_tasks(customer_id, kind, dedupe_key, title, objective, evidence, priority, priority_reason, due_at, source_type, source_id)
  select q.customer_id, 'borrador_interno', 'borrador:' || q.id, 'Completar o enviar el borrador ' || q.quote_number, 'Documento interno: no indica interés del cliente hasta enviarlo.',
    jsonb_build_array(jsonb_build_object('label', 'Borrador creado', 'date', (q.created_at at time zone 'America/Bogota')::date, 'kind', 'observado')),
    40, jsonb_build_object('esfuerzo', 'Tarea interna'), today + 2, 'quote', q.id
  from public.quotes q where q.status = 'borrador' and q.sent_at is null and q.created_at < now() - interval '1 day' and (target_customer is null or q.customer_id = target_customer)
  on conflict (dedupe_key) do nothing;
  get diagnostics n = row_count; created := created + n;

  -- Devolución reciente por resolver (bloquea propuestas comerciales mientras esté abierta).
  insert into public.customer_tasks(customer_id, kind, dedupe_key, title, objective, evidence, priority, priority_reason, due_at, source_type, source_id)
  select s.customer_id, 'devolucion', 'devolucion:' || s.id, 'Resolver la devolución de ' || s.sale_number, 'Confirmar que el problema quedó resuelto antes de ofrecer algo nuevo.',
    jsonb_build_array(jsonb_build_object('label', 'Devolución registrada', 'date', max((r.created_at at time zone 'America/Bogota')::date), 'kind', 'observado')),
    85, jsonb_build_object('urgencia', 'Experiencia del cliente'), today + 1, 'sale', s.id
  from public.sale_returns r join public.sales s on s.id = r.sale_id
  where r.created_at > now() - interval '30 days' and (target_customer is null or s.customer_id = target_customer)
  group by s.id, s.customer_id, s.sale_number
  on conflict (dedupe_key) do nothing;
  get diagnostics n = row_count; created := created + n;

  -- Postventa de la primera compra (servicio, no promoción).
  insert into public.customer_tasks(customer_id, kind, dedupe_key, title, objective, evidence, priority, priority_reason, due_at, source_type, source_id)
  select s.customer_id, 'postventa', 'postventa:' || s.id, 'Seguimiento postventa de ' || s.sale_number, 'Preguntar cómo le fue con su primera compra. No es una oferta.',
    jsonb_build_array(jsonb_build_object('label', 'Primera compra confirmada', 'date', (s.confirmed_at at time zone 'America/Bogota')::date, 'kind', 'observado')),
    62, jsonb_build_object('oportunidad', 'Segunda compra'), today + 2, 'sale', s.id
  from public.sales s
  where s.confirmed_at between now() - interval '15 days' and now() - interval '3 days' and s.status in ('confirmada','pagada','entregada')
    and not exists (select 1 from public.sales o where o.customer_id = s.customer_id and o.id <> s.id and o.confirmed_at is not null and o.status <> 'cancelada' and o.confirmed_at < s.confirmed_at)
    and (target_customer is null or s.customer_id = target_customer)
  on conflict (dedupe_key) do nothing;
  get diagnostics n = row_count; created := created + n;

  -- Oferta declarada como enviada sin respuesta: esperar o cerrar, no insistir.
  insert into public.customer_tasks(customer_id, kind, dedupe_key, title, objective, evidence, priority, priority_reason, due_at, source_type, source_id)
  select f.customer_id, 'oferta_sin_respuesta', 'oferta:' || f.id, 'Registrar respuesta o cerrar: ' || f.title, 'Un solo seguimiento. No reenviar descuentos automáticamente.',
    jsonb_build_array(jsonb_build_object('label', 'Oferta declarada como enviada', 'date', (f.sent_declared_at at time zone 'America/Bogota')::date, 'kind', 'declarado por el vendedor')),
    50, jsonb_build_object('saturacion', 'Máximo un seguimiento'), today + 1, 'offer', f.id
  from public.customer_offers f where f.status = 'enviada_declarada' and f.sent_declared_at < now() - interval '3 days' and (target_customer is null or f.customer_id = target_customer)
  on conflict (dedupe_key) do nothing;
  get diagnostics n = row_count; created := created + n;

  -- Promocionales: requieren autorización vigente y sin saturación.
  -- Reposición configurada.
  insert into public.customer_tasks(customer_id, kind, dedupe_key, title, objective, evidence, priority, priority_reason, promotional, due_at, source_type, source_id)
  select distinct on (x.customer_id, x.rule_id) x.customer_id, 'reposicion', 'reposicion:' || x.customer_id || ':' || x.rule_id || ':' || x.sale_id,
    'Recordar reposición de ' || x.product_name, 'Ventana orientativa según la regla configurada; confirmar si aún lo necesita.',
    jsonb_build_array(jsonb_build_object('label', 'Compró ' || x.product_name, 'date', x.day, 'kind', 'observado'), jsonb_build_object('label', 'Ciclo configurado de ' || x.cycle || ' días', 'kind', 'configurado')),
    60, jsonb_build_object('oportunidad', 'Reposición', 'permiso', 'Autorizó contacto promocional'), true, today + 3, 'sale', x.sale_id
  from (
    select s.customer_id, r.id as rule_id, s.id as sale_id, i.product_name, (s.confirmed_at at time zone 'America/Bogota')::date as day, r.reposition_days as cycle
    from public.product_relationships r
    join public.sale_items i on (r.source_type = 'product' and i.product_id = r.source_id) or (r.source_type = 'category' and exists (select 1 from public.product_categories pc where pc.product_id = i.product_id and pc.category_id = r.source_id))
    join public.sales s on s.id = i.sale_id and s.confirmed_at is not null and s.status in ('confirmada','pagada','entregada')
    where r.kind = 'reposicion' and r.active
      and today - (s.confirmed_at at time zone 'America/Bogota')::date between r.reposition_days - 7 and r.reposition_days * 2
  ) x
  where (target_customer is null or x.customer_id = target_customer) and public.customer_marketing_allowed(x.customer_id) and not public.customer_contact_saturated(x.customer_id)
    and not exists (select 1 from public.sales later where later.customer_id = x.customer_id and later.confirmed_at > (x.day + 1)::timestamptz and later.status <> 'cancelada'
      and exists (select 1 from public.sale_items li where li.sale_id = later.id and li.product_name = x.product_name))
  order by x.customer_id, x.rule_id, x.day desc
  on conflict (dedupe_key) do nothing;
  get diagnostics n = row_count; created := created + n;

  -- Cliente con 3+ compras en días distintos sin comprar hace 120+ días (máx. 1 por mes).
  insert into public.customer_tasks(customer_id, kind, dedupe_key, title, objective, evidence, priority, priority_reason, promotional, due_at, source_type, source_id)
  select c.customer_id, 'reactivar', 'reactivar:' || c.customer_id || ':' || to_char(today, 'YYYY-MM'), 'Reactivar con una propuesta puntual',
    'Evidencia: ' || c.days || ' compras en días distintos. Contacto personal, sin descuento automático.',
    jsonb_build_array(jsonb_build_object('label', 'Última compra', 'date', c.last_day, 'kind', 'observado'), jsonb_build_object('label', c.days || ' compras en días distintos', 'kind', 'calculado')),
    55, jsonb_build_object('evidencia', 'Suficiente (3+ compras)', 'permiso', 'Autorizó contacto promocional'), true, today + 5, 'customer', c.customer_id
  from (
    select s.customer_id, count(distinct (s.confirmed_at at time zone 'America/Bogota')::date) as days, max((s.confirmed_at at time zone 'America/Bogota')::date) as last_day
    from public.sales s where s.confirmed_at is not null and s.status in ('confirmada','pagada','entregada') group by s.customer_id
  ) c
  where c.days >= 3 and today - c.last_day between 120 and 365 and (target_customer is null or c.customer_id = target_customer)
    and public.customer_marketing_allowed(c.customer_id) and not public.customer_contact_saturated(c.customer_id)
  on conflict (dedupe_key) do nothing;
  get diagnostics n = row_count; created := created + n;

  -- Cumpleaños autorizado sin contacto registrado este año.
  insert into public.customer_tasks(customer_id, kind, dedupe_key, title, objective, evidence, priority, priority_reason, promotional, due_at, source_type, source_id)
  select c.id, 'cumpleanos', 'cumple:' || c.id || ':' || extract(year from public.next_birthday(c.birth_date, today)), 'Saludo de cumpleaños de ' || c.full_name,
    'Saludo con beneficio opcional; un solo contacto por año.',
    jsonb_build_array(jsonb_build_object('label', 'Cumpleaños', 'date', public.next_birthday(c.birth_date, today), 'kind', 'declarado')),
    case when public.next_birthday(c.birth_date, today) - today <= 2 then 72 else 58 end, jsonb_build_object('permiso', 'Autorizó contacto promocional'), true,
    public.next_birthday(c.birth_date, today), 'customer', c.id
  from public.customers c
  where c.birth_date is not null and c.archived_at is null and c.merged_into is null and public.next_birthday(c.birth_date, today) - today between 0 and 7
    and (target_customer is null or c.id = target_customer) and public.customer_marketing_allowed(c.id)
    and not exists (select 1 from public.birthday_contacts b where b.customer_id = c.id and b.contact_year = extract(year from public.next_birthday(c.birth_date, today)) and b.status in ('contactado','obsequio_ofrecido','completado'))
  on conflict (dedupe_key) do nothing;
  get diagnostics n = row_count; created := created + n;

  -- Carrito con identidad VERIFICADA y personalización, sin pedido posterior tras 48 h.
  insert into public.customer_tasks(customer_id, kind, dedupe_key, title, objective, evidence, priority, priority_reason, promotional, due_at, source_type, source_id)
  select x.customer_id, 'carrito_sin_compra', 'carrito:' || x.customer_id || ':' || x.product_id || ':' || x.day, 'Revisar el carrito de ' || x.product_name,
    'Preguntar si tuvo algún obstáculo (envío, pago, stock). No es abandono confirmado.',
    jsonb_build_array(jsonb_build_object('label', 'Agregó ' || x.product_name || ' al carrito', 'date', x.day, 'kind', 'observado')),
    58, jsonb_build_object('evidencia', 'Identidad verificada', 'permiso', 'Autorizó contacto promocional'), true, today + 1, 'product', x.product_id
  from (
    select distinct on (l.customer_id, e.product_id) l.customer_id, e.product_id, p.name as product_name, (e.received_at at time zone 'America/Bogota')::date as day, e.event_type, e.received_at
    from public.identity_links l join public.visitors v on v.id = l.visitor_id and v.consent_personalization and v.revoked_at is null
    join public.behavior_events e on e.visitor_id = l.visitor_id and e.received_at >= l.scope_from and (l.scope_to is null or e.received_at <= l.scope_to)
    join public.products p on p.id = e.product_id
    where l.level = 'verificado' and e.event_type like 'cart_item_%'
    order by l.customer_id, e.product_id, e.received_at desc
  ) x
  where x.event_type <> 'cart_item_removed' and x.received_at between now() - interval '14 days' and now() - interval '48 hours'
    and (target_customer is null or x.customer_id = target_customer)
    and not exists (select 1 from public.orders o where o.customer_id = x.customer_id and o.created_at > x.received_at)
    and public.customer_marketing_allowed(x.customer_id) and not public.customer_contact_saturated(x.customer_id)
  on conflict (dedupe_key) do nothing;
  get diagnostics n = row_count; created := created + n;

  -- Tareas cuyo hecho ya se resolvió se cierran solas (sin borrar el historial).
  update public.customer_tasks t set status = 'completada', completed_at = now(), outcome = coalesce(t.outcome, 'resuelto_en_documento')
  where t.status in ('pendiente','pospuesta') and (
    (t.kind = 'pedido_pendiente' and exists (select 1 from public.orders o where o.id = t.source_id and (o.status <> 'pendiente' or exists (select 1 from public.sales s where s.source_order_id = o.id))))
    or (t.kind in ('cotizacion_seguimiento','borrador_interno') and exists (select 1 from public.quotes q where q.id = t.source_id and q.status in ('convertida','rechazada','vencida')))
    or (t.kind = 'oferta_sin_respuesta' and exists (select 1 from public.customer_offers f where f.id = t.source_id and f.status <> 'enviada_declarada')));
  return created;
end $$;

create or replace function public.set_task_status(target uuid, payload jsonb) returns public.customer_tasks
language plpgsql security definer set search_path = public as $$
declare task public.customer_tasks; new_status text := payload->>'status';
begin
  if not public.has_staff_role(array['propietario','vendedor']) then raise exception 'Sin permiso'; end if;
  select * into task from public.customer_tasks where id = target for update;
  if not found then raise exception 'Tarea no encontrada'; end if;
  if new_status not in ('pendiente','pospuesta','completada','descartada') then raise exception 'Estado no válido'; end if;
  if new_status = 'descartada' and nullif(btrim(coalesce(payload->>'discard_reason', '')), '') is null then raise exception 'Indica el motivo del descarte'; end if;
  if new_status = 'pospuesta' and (nullif(payload->>'next_review_at', '') is null or (payload->>'next_review_at')::date <= public.bogota_today()) then raise exception 'Elige una fecha futura para revisar'; end if;
  update public.customer_tasks set status = new_status,
    next_review_at = case when new_status = 'pospuesta' then (payload->>'next_review_at')::date else next_review_at end,
    discard_reason = case when new_status = 'descartada' then btrim(payload->>'discard_reason') else discard_reason end,
    outcome = coalesce(nullif(btrim(coalesce(payload->>'outcome', '')), ''), outcome),
    assignee = coalesce(nullif(payload->>'assignee', '')::uuid, assignee),
    completed_at = case when new_status = 'completada' then now() else null end
  where id = target returning * into task;
  return task;
end $$;

create or replace function public.create_manual_task(payload jsonb) returns public.customer_tasks
language plpgsql security definer set search_path = public as $$
declare task public.customer_tasks;
begin
  if not public.has_staff_role(array['propietario','vendedor']) then raise exception 'Sin permiso'; end if;
  if length(btrim(coalesce(payload->>'title', ''))) not between 3 and 160 then raise exception 'Escribe un título'; end if;
  insert into public.customer_tasks(customer_id, kind, dedupe_key, title, objective, evidence, priority, priority_reason, due_at, assignee, rule_version)
  values ((payload->>'customer_id')::uuid, 'manual', 'manual:' || gen_random_uuid(), btrim(payload->>'title'), nullif(btrim(coalesce(payload->>'objective', '')), ''),
    coalesce(payload->'evidence', '[]'::jsonb), least(100, greatest(0, coalesce(nullif(payload->>'priority', '')::int, 50))), jsonb_build_object('origen', 'Creada por el vendedor'),
    nullif(payload->>'due_at', '')::date, coalesce(nullif(payload->>'assignee', '')::uuid, auth.uid()), 'manual')
  returning * into task;
  return task;
end $$;

create or replace function public.record_contact_attempt(payload jsonb) returns public.contact_attempts
language plpgsql security definer set search_path = public as $$
declare row_value public.contact_attempts;
begin
  if not public.has_staff_role(array['propietario','vendedor']) then raise exception 'Sin permiso'; end if;
  insert into public.contact_attempts(customer_id, offer_id, task_id, channel, kind, purpose, note, outcome, created_by)
  values ((payload->>'customer_id')::uuid, nullif(payload->>'offer_id', '')::uuid, nullif(payload->>'task_id', '')::uuid, coalesce(nullif(payload->>'channel', ''), 'whatsapp'),
    payload->>'kind', coalesce(nullif(payload->>'purpose', ''), 'comercial'), nullif(btrim(coalesce(payload->>'note', '')), ''), nullif(payload->>'outcome', ''), auth.uid())
  returning * into row_value;
  return row_value;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Permisos por rol (el propietario conserva todo vía is_admin())
-- ---------------------------------------------------------------------------
alter table public.customer_tasks enable row level security;
create policy customer_tasks_staff_read on public.customer_tasks for select to authenticated using (public.has_staff_role(array['propietario','vendedor']));
revoke all on public.customer_tasks from anon, authenticated;
grant select on public.customer_tasks to authenticated;

-- Vendedor: lectura del CRM y documentos (las escrituras económicas siguen siendo del propietario).
do $$ declare t text; begin
  foreach t in array array['customers','customer_consents','birthday_contacts','orders','order_items','quotes','quote_items','sales','sale_items','sale_returns'] loop
    execute format('create policy %I on public.%I for select to authenticated using (public.has_staff_role(array[''vendedor'']))', t || '_seller_read', t);
  end loop;
end $$;
-- Gestor de catálogo: productos, variantes, imágenes, categorías, marcas, tramos y relaciones.
do $$ declare t text; begin
  foreach t in array array['products','product_categories','product_colors','product_sizes','product_variants','product_images','categories','brands','product_price_tiers','product_relationships'] loop
    execute format('create policy %I on public.%I for all to authenticated using (public.has_staff_role(array[''catalogo''])) with check (public.has_staff_role(array[''catalogo'']))', t || '_catalog_manager', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Plan del servicio (comercialización). Solo el operador (service_role) escribe;
--    el comerciante solo lee. Sin proveedor de pagos configurado: cobro automático
--    DESACTIVADO y enforcement_enabled = false (no bloquea la tienda).
-- ---------------------------------------------------------------------------
create table public.store_plan (
  id smallint primary key default 1 check (id = 1),
  plan_code text not null check (plan_code in ('mensual','anual','permanente','prueba')),
  status text not null check (status in ('activo','gracia','vencido','suspendido','permanente')),
  period_start date,
  period_end date,
  grace_days integer not null default 7 check (grace_days between 0 and 60),
  features jsonb not null default '{}'::jsonb,
  provider text,
  provider_reference text,
  enforcement_enabled boolean not null default false,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table public.store_plan enable row level security;
create policy store_plan_owner_read on public.store_plan for select to authenticated using (public.is_admin());
revoke all on public.store_plan from anon, authenticated;
grant select on public.store_plan to authenticated;

create or replace function public.plan_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p public.store_plan; today date := public.bogota_today(); effective text;
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  select * into p from public.store_plan where id = 1;
  if not found then return jsonb_build_object('status', 'sin_plan', 'enforcement_enabled', false, 'message', 'Plan no configurado por el operador del servicio.'); end if;
  effective := case when p.status in ('permanente','suspendido') then p.status
    when p.period_end is null or p.period_end >= today then 'activo'
    when p.period_end + p.grace_days >= today then 'gracia' else 'vencido' end;
  return jsonb_build_object('status', effective, 'plan', p.plan_code, 'period_end', p.period_end, 'grace_until', p.period_end + p.grace_days,
    'days_left', case when p.period_end is not null then p.period_end - today end, 'enforcement_enabled', p.enforcement_enabled, 'provider', p.provider);
end $$;

revoke execute on function public.customer_marketing_allowed(uuid), public.customer_contact_saturated(uuid) from public, anon, authenticated;
grant execute on function public.generate_customer_tasks(uuid), public.set_task_status(uuid, jsonb), public.create_manual_task(jsonb),
  public.record_contact_attempt(jsonb), public.plan_status() to authenticated;

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
