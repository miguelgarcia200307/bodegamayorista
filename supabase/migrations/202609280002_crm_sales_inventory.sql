-- Bodega Mayorista F.C. — CRM, pedidos, cotizaciones, ventas, devoluciones,
-- inventario trazable y privilegios mínimos. Complementa la base limpia.
-- No inserta productos, clientes, ventas ni datos comerciales.

-- ---------------------------------------------------------------------------
-- 1. Estructura adicional
-- ---------------------------------------------------------------------------
alter table public.orders
  add column source text not null default 'tienda' check (source in ('tienda','WhatsApp','presencial','manual')),
  add column admin_notes text;

alter table public.customers
  add column merged_into uuid references public.customers(id) on delete restrict;

alter table public.quotes
  add column customer_snapshot jsonb not null default '{}'::jsonb,
  add column business_snapshot jsonb not null default '{}'::jsonb,
  add column sent_at timestamptz;

alter table public.sales
  add column customer_snapshot jsonb not null default '{}'::jsonb,
  add column business_snapshot jsonb not null default '{}'::jsonb,
  add column warranty_snapshot text,
  add column confirmed_at timestamptz,
  add column paid_at timestamptz,
  add column delivered_at timestamptz,
  add column cancelled_at timestamptz,
  add column cancel_reason text;

-- Las líneas históricas conservan snapshots; si una variante se elimina, el
-- movimiento queda sin vínculo en lugar de bloquear la edición del catálogo.
alter table public.stock_movements alter column variant_id drop not null;
alter table public.stock_movements drop constraint stock_movements_variant_id_fkey;
alter table public.stock_movements add constraint stock_movements_variant_id_fkey
  foreign key (variant_id) references public.product_variants(id) on delete set null;

create table public.sale_returns (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete restrict,
  sale_item_id uuid not null references public.sale_items(id) on delete restrict,
  request_key uuid not null,
  quantity integer not null check (quantity > 0),
  restocked boolean not null,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (request_key, sale_item_id)
);
alter table public.stock_movements add column sale_return_id uuid references public.sale_returns(id) on delete restrict;

-- Orden estable de las líneas en documentos y reimpresiones.
alter table public.order_items add column line_no bigint generated always as identity;
alter table public.quote_items add column line_no bigint generated always as identity;
alter table public.sale_items add column line_no bigint generated always as identity;

create index orders_customer_idx on public.orders(customer_id, created_at desc);
create index orders_status_idx on public.orders(status, created_at desc);
create index quotes_customer_idx on public.quotes(customer_id, created_at desc);
create index sales_customer_idx on public.sales(customer_id, created_at desc);
create index sales_status_idx on public.sales(status, created_at desc);
create index stock_movements_variant_idx on public.stock_movements(variant_id, created_at desc);
create index customers_birth_idx on public.customers(birth_date) where birth_date is not null and archived_at is null;

-- ---------------------------------------------------------------------------
-- 2. Utilidades de fecha, teléfono y snapshots
-- ---------------------------------------------------------------------------
create or replace function public.bogota_today() returns date
language sql stable set search_path = pg_catalog as $$
  select (now() at time zone 'America/Bogota')::date
$$;

-- Regla explícita: quien nació el 29 de febrero celebra el 28 de febrero en años
-- no bisiestos (ver birthday_in_year). La edad cambia ese mismo día.
create or replace function public.customer_age(birth date, on_date date default public.bogota_today()) returns integer
language sql stable set search_path = public, pg_catalog as $$
  select case when birth is null then null else
    extract(year from on_date)::int - extract(year from birth)::int
    - case when on_date < public.birthday_in_year(birth, extract(year from on_date)::int) then 1 else 0 end end
$$;

create or replace function public.next_birthday(birth date, on_date date default public.bogota_today()) returns date
language sql stable set search_path = public, pg_catalog as $$
  select case when birth is null then null
    when public.birthday_in_year(birth, extract(year from on_date)::int) >= on_date then public.birthday_in_year(birth, extract(year from on_date)::int)
    else public.birthday_in_year(birth, extract(year from on_date)::int + 1) end
$$;

create or replace function public.next_document_number(doc_kind text) returns text
language plpgsql security definer set search_path = public as $$
declare next_value bigint; prefix text;
begin
  if doc_kind not in ('order','quote','sale') then raise exception 'Tipo de documento inválido'; end if;
  -- UPDATE ... RETURNING bloquea la fila: dos transacciones concurrentes nunca
  -- reciben el mismo consecutivo.
  update public.document_sequences set last_value = last_value + 1 where kind = doc_kind returning last_value into next_value;
  prefix := case doc_kind when 'order' then 'PED' when 'quote' then 'COT' else 'CV' end;
  return prefix || '-' || to_char(public.bogota_today(), 'YYYY') || '-' || lpad(next_value::text, 6, '0');
end $$;

create or replace function public.variant_option_snapshot(target_variant uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_strip_nulls(jsonb_build_object(
      coalesce(nullif(btrim(p.option1_name), ''), 'Opción'),
      case when c.name is null or lower(c.name) in ('única','unica') then null else c.name end,
      coalesce(nullif(btrim(p.option2_name), ''), 'Variante'),
      case when s.name is null or lower(s.name) in ('única','unica') then null else s.name end
    )), '{}'::jsonb) || coalesce(v.option_values, '{}'::jsonb)
  from public.product_variants v
  join public.products p on p.id = v.product_id
  left join public.product_colors c on c.id = v.color_id
  left join public.product_sizes s on s.id = v.size_id
  where v.id = target_variant
$$;

create or replace function public.customer_document_snapshot(target_customer uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('full_name', c.full_name, 'phone', c.phone_original, 'city', c.city,
    'address', c.address, 'identification', c.identification)
  from public.customers c where c.id = target_customer
$$;

create or replace function public.business_document_snapshot() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('business_name', s.business_name, 'tagline', s.tagline, 'whatsapp', s.whatsapp,
    'phone', s.phone, 'email', s.email, 'address', s.address, 'city', s.city, 'tax_id', s.tax_id,
    'logo_url', s.logo_url)
  from public.site_settings s where s.id = 1
$$;

-- ---------------------------------------------------------------------------
-- 3. Clientes: normalización obligatoria en servidor
-- ---------------------------------------------------------------------------
create or replace function public.customers_normalize() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  new.full_name := btrim(regexp_replace(coalesce(new.full_name, ''), '\s+', ' ', 'g'));
  if length(new.full_name) not between 2 and 120 then raise exception 'El nombre del cliente no es válido'; end if;
  new.phone_original := btrim(coalesce(new.phone_original, ''));
  if length(new.phone_original) > 30 then raise exception 'Número de teléfono no válido'; end if;
  new.phone_normalized := public.normalize_phone(new.phone_original);
  new.city := nullif(btrim(coalesce(new.city, '')), '');
  new.address := nullif(btrim(coalesce(new.address, '')), '');
  new.identification := nullif(btrim(coalesce(new.identification, '')), '');
  if new.birth_date is not null and (new.birth_date > public.bogota_today() or new.birth_date < date '1900-01-01') then
    raise exception 'La fecha de nacimiento no es válida';
  end if;
  return new;
end $$;
create trigger customers_normalize before insert or update of full_name, phone_original, city, address, identification, birth_date
  on public.customers for each row execute function public.customers_normalize();

create or replace function public.merge_customers(keep_customer uuid, duplicate_customer uuid) returns public.customers
language plpgsql security definer set search_path = public as $$
declare keeper public.customers; duplicate public.customers;
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  if keep_customer is null or duplicate_customer is null or keep_customer = duplicate_customer then
    raise exception 'Selecciona dos clientes distintos';
  end if;
  -- Bloqueo en orden estable para evitar interbloqueos.
  perform 1 from public.customers where id in (keep_customer, duplicate_customer) order by id for update;
  select * into keeper from public.customers where id = keep_customer;
  select * into duplicate from public.customers where id = duplicate_customer;
  if keeper.id is null or duplicate.id is null then raise exception 'Cliente no encontrado'; end if;
  if keeper.merged_into is not null or duplicate.merged_into is not null then raise exception 'Uno de los clientes ya fue fusionado'; end if;

  update public.orders set customer_id = keeper.id where customer_id = duplicate.id;
  update public.quotes set customer_id = keeper.id where customer_id = duplicate.id;
  update public.sales set customer_id = keeper.id where customer_id = duplicate.id;
  update public.customer_consents set customer_id = keeper.id where customer_id = duplicate.id;
  update public.birthday_contacts b set customer_id = keeper.id
    where b.customer_id = duplicate.id
      and not exists (select 1 from public.birthday_contacts k where k.customer_id = keeper.id and k.contact_year = b.contact_year);
  delete from public.birthday_contacts where customer_id = duplicate.id;

  update public.customers set
    city = coalesce(city, duplicate.city),
    address = coalesce(address, duplicate.address),
    birth_date = coalesce(birth_date, duplicate.birth_date),
    identification = coalesce(identification, duplicate.identification),
    notes = concat_ws(E'\n', nullif(notes, ''), format('Fusionado con %s (%s) el %s.%s', duplicate.full_name, duplicate.phone_original,
      to_char(public.bogota_today(), 'YYYY-MM-DD'), coalesce(' ' || nullif(duplicate.notes, ''), '')))
  where id = keeper.id returning * into keeper;
  update public.customers set archived_at = now(), merged_into = keeper.id where id = duplicate.id;
  return keeper;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Checkout público: pedido pendiente antes de WhatsApp
-- ---------------------------------------------------------------------------
create or replace function public.storefront_order_result(target_order uuid)
returns table(order_number text, total numeric, whatsapp text, items jsonb)
language sql stable security definer set search_path = public as $$
  select o.order_number, o.total, (select s.whatsapp from public.site_settings s where s.id = 1),
    (select coalesce(jsonb_agg(jsonb_build_object('name', i.product_name, 'sku', i.sku, 'options', i.option_snapshot,
       'quantity', i.quantity, 'unit_price', i.unit_price, 'line_total', i.line_total) order by i.line_no), '[]'::jsonb)
     from public.order_items i where i.order_id = o.id)
  from public.orders o where o.id = target_order
$$;

create or replace function public.create_storefront_order(payload jsonb, request_key uuid)
returns table(order_number text, total numeric, whatsapp text, items jsonb)
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  existing_id uuid; customer public.customers; line record; variant public.product_variants; product public.products;
  delivery public.delivery_methods; payment public.payment_methods; settings public.site_settings;
  normalized text; clean_name text; clean_phone text; clean_city text; clean_address text; clean_notes text; birth date;
  subtotal_value numeric(14,2) := 0; unit_value numeric(14,2); new_order_id uuid; conflicts jsonb := '{}'::jsonb; recent integer;
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

  -- Control de abuso: límite por teléfono y límite global por hora.
  select count(*) into recent from public.orders o join public.customers c on c.id = o.customer_id
    where c.phone_normalized = normalized and o.created_at > now() - interval '10 minutes';
  if recent >= 5 then raise exception 'Recibimos varias solicitudes seguidas con este teléfono. Espera unos minutos antes de intentarlo de nuevo.'; end if;
  select count(*) into recent from public.orders o where o.source = 'tienda' and o.created_at > now() - interval '1 hour';
  if recent >= 300 then raise exception 'Estamos recibiendo muchas solicitudes. Intenta nuevamente en unos minutos.'; end if;

  select * into settings from public.site_settings where id = 1;
  if nullif(btrim(coalesce(settings.whatsapp, '')), '') is null then
    raise exception 'El WhatsApp del negocio está pendiente de configuración';
  end if;
  if coalesce(payload->>'delivery_method_id', '') !~* '^[0-9a-f-]{36}$' then raise exception 'Selecciona un método de entrega válido'; end if;
  select * into delivery from public.delivery_methods where id = (payload->>'delivery_method_id')::uuid and active;
  if not found then raise exception 'Selecciona un método de entrega válido'; end if;
  if coalesce(payload->>'payment_method_id', '') !~* '^[0-9a-f-]{36}$' then raise exception 'Selecciona un método de pago válido'; end if;
  select * into payment from public.payment_methods where id = (payload->>'payment_method_id')::uuid and active;
  if not found then raise exception 'Selecciona un método de pago válido'; end if;
  if (delivery.requires_city or delivery.requires_address) and clean_city is null then raise exception 'La ciudad es obligatoria'; end if;
  if delivery.requires_address and clean_address is null then raise exception 'La dirección es obligatoria'; end if;
  if not delivery.requires_city and not delivery.requires_address then clean_city := null; clean_address := null; end if;

  -- Crea o asocia el cliente por teléfono normalizado. Un cliente existente nunca
  -- se sobrescribe ni se devuelve al navegador: las diferencias quedan para revisión.
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

  -- Líneas agrupadas por variante: dos líneas iguales no esquivan el control de stock.
  for line in
    select (e->>'variant_id')::uuid as variant_ref, sum((e->>'quantity')::int)::int as qty
    from jsonb_array_elements(payload->'items') e group by 1 order by 1
  loop
    select * into variant from public.product_variants v where v.id = line.variant_ref and v.active for share;
    if not found then raise exception 'Uno de los productos ya no está disponible'; end if;
    select * into product from public.products p where p.id = variant.product_id and p.status = 'published' and not p.force_sold_out;
    if not found then raise exception 'Uno de los productos ya no está disponible'; end if;
    if variant.stock < line.qty then
      raise exception 'Stock insuficiente para %: quedan % unidad(es)', product.name, variant.stock;
    end if;
    unit_value := public.current_product_price(product, variant);
    subtotal_value := subtotal_value + unit_value * line.qty;
    insert into public.order_items(order_id, product_id, variant_id, product_name, sku, option_snapshot, quantity, unit_price, line_total)
    values (new_order_id, product.id, variant.id, product.name, coalesce(variant.sku, product.sku),
      public.variant_option_snapshot(variant.id), line.qty, unit_value, unit_value * line.qty);
  end loop;
  update public.orders o set subtotal = subtotal_value, total = subtotal_value + o.delivery_cost where o.id = new_order_id;

  insert into public.customer_consents(customer_id, purpose, granted, text_version, source)
  values (customer.id, 'order_processing', true, coalesce(nullif(settings.data_policy_version, ''), 'pendiente'), 'checkout');
  if coalesce(payload->>'marketing_consent', 'false') = 'true' then
    insert into public.customer_consents(customer_id, purpose, granted, text_version, source)
    values (customer.id, 'marketing_birthday', true, coalesce(nullif(settings.marketing_consent_version, ''), 'pendiente'), 'checkout');
  end if;

  return query select * from public.storefront_order_result(new_order_id);
exception when unique_violation then
  select o.id into existing_id from public.orders o where o.idempotency_key = request_key;
  if existing_id is not null then return query select * from public.storefront_order_result(existing_id); return; end if;
  raise;
end $$;

-- Solo deja constancia de que se preparó/abrió el enlace; no prueba el envío.
create or replace function public.mark_order_whatsapp_opened(request_key uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update public.orders o set whatsapp_opened_at = coalesce(o.whatsapp_opened_at, now())
  where o.idempotency_key = request_key and o.created_at > now() - interval '1 day';
  return found;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Líneas de documentos administrativos
-- ---------------------------------------------------------------------------
create or replace function public.admin_document_lines(items jsonb, allow_custom_price boolean)
returns table(product_id uuid, variant_id uuid, product_name text, sku text, option_snapshot jsonb,
  quantity integer, unit_price numeric, discount numeric, line_total numeric, catalog_price numeric)
language plpgsql stable security definer set search_path = public as $$
declare item jsonb; v public.product_variants; p public.products; qty integer; price numeric(14,2); disc numeric(14,2); cat numeric(14,2);
begin
  if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items) not between 1 and 100 then
    raise exception 'Agrega entre 1 y 100 productos';
  end if;
  for item in select value from jsonb_array_elements(items) loop
    if coalesce(item->>'variant_id', '') !~* '^[0-9a-f-]{36}$' then raise exception 'Selecciona un producto válido'; end if;
    select * into v from public.product_variants pv where pv.id = (item->>'variant_id')::uuid;
    if not found then raise exception 'Una de las variantes ya no existe'; end if;
    select * into p from public.products pr where pr.id = v.product_id;
    if coalesce(item->>'quantity', '') !~ '^[0-9]{1,4}$' or (item->>'quantity')::int < 1 then
      raise exception 'Cantidad no válida para %', p.name;
    end if;
    qty := (item->>'quantity')::int;
    cat := public.current_product_price(p, v);
    price := case when allow_custom_price and coalesce(item->>'unit_price', '') <> '' then (item->>'unit_price')::numeric else cat end;
    disc := coalesce(nullif(item->>'discount', '')::numeric, 0);
    if price < 0 or disc < 0 or disc > price * qty then raise exception 'Importe o descuento no válido para %', p.name; end if;
    product_id := p.id; variant_id := v.id; product_name := p.name; sku := coalesce(v.sku, p.sku);
    option_snapshot := public.variant_option_snapshot(v.id); quantity := qty; unit_price := price; discount := disc;
    line_total := price * qty - disc; catalog_price := cat;
    return next;
  end loop;
end $$;

-- Pedido registrado por el administrador (contacto por WhatsApp o presencial).
create or replace function public.create_admin_order(payload jsonb) returns public.orders
language plpgsql security definer set search_path = public as $$
declare result public.orders; delivery public.delivery_methods; payment public.payment_methods; order_source text;
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  order_source := coalesce(payload->>'source', 'WhatsApp');
  if order_source not in ('WhatsApp','presencial','manual') then raise exception 'Origen no válido'; end if;
  if not exists (select 1 from public.customers c where c.id = (payload->>'customer_id')::uuid and c.merged_into is null) then
    raise exception 'Selecciona un cliente válido';
  end if;
  if coalesce(payload->>'delivery_method_id', '') <> '' then select * into delivery from public.delivery_methods where id = (payload->>'delivery_method_id')::uuid; end if;
  if coalesce(payload->>'payment_method_id', '') <> '' then select * into payment from public.payment_methods where id = (payload->>'payment_method_id')::uuid; end if;
  insert into public.orders(order_number, customer_id, source, status, delivery_method_id, delivery_name, payment_method_id, payment_name,
    shipping_city, shipping_address, notes, subtotal, delivery_cost, total, idempotency_key)
  values (public.next_document_number('order'), (payload->>'customer_id')::uuid, order_source, 'contactado', delivery.id, delivery.name,
    payment.id, payment.name, nullif(btrim(coalesce(payload->>'city', '')), ''), nullif(btrim(coalesce(payload->>'address', '')), ''),
    nullif(btrim(coalesce(payload->>'notes', '')), ''), 0, greatest(coalesce(nullif(payload->>'delivery_cost', '')::numeric, delivery.base_cost, 0), 0), 0,
    coalesce(nullif(payload->>'request_key', '')::uuid, gen_random_uuid()))
  returning * into result;
  insert into public.order_items(order_id, product_id, variant_id, product_name, sku, option_snapshot, quantity, unit_price, line_total)
  select result.id, l.product_id, l.variant_id, l.product_name, l.sku, l.option_snapshot, l.quantity, l.unit_price, l.line_total
  from public.admin_document_lines(payload->'items', false) l;
  update public.orders o set subtotal = s.value, total = s.value + o.delivery_cost
  from (select coalesce(sum(i.line_total), 0) as value from public.order_items i where i.order_id = result.id) s
  where o.id = result.id returning o.* into result;
  return result;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Cotizaciones
-- ---------------------------------------------------------------------------
drop function if exists public.create_admin_quote(jsonb);

create or replace function public.save_admin_quote(target_quote uuid, payload jsonb) returns public.quotes
language plpgsql security definer set search_path = public as $$
declare result public.quotes; customer_ref uuid; valid_date date; delivery_value numeric(14,2);
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  customer_ref := nullif(payload->>'customer_id', '')::uuid;
  if not exists (select 1 from public.customers c where c.id = customer_ref and c.merged_into is null) then raise exception 'Selecciona un cliente válido'; end if;
  valid_date := nullif(payload->>'valid_until', '')::date;
  delivery_value := coalesce(nullif(payload->>'delivery_cost', '')::numeric, 0);
  if delivery_value < 0 then raise exception 'El costo de entrega no es válido'; end if;

  if target_quote is null then
    if valid_date is not null and valid_date < public.bogota_today() then raise exception 'La vigencia no puede estar en el pasado'; end if;
    insert into public.quotes(quote_number, customer_id, status, valid_until, delivery_cost, notes, terms_snapshot, customer_snapshot, business_snapshot)
    values (public.next_document_number('quote'), customer_ref, 'borrador', valid_date, delivery_value, nullif(btrim(coalesce(payload->>'notes', '')), ''),
      coalesce(nullif(btrim(coalesce(payload->>'terms', '')), ''), (select quote_terms from public.site_settings where id = 1)),
      public.customer_document_snapshot(customer_ref), public.business_document_snapshot())
    returning * into result;
  else
    select * into result from public.quotes where id = target_quote for update;
    if not found then raise exception 'Cotización no encontrada'; end if;
    if result.status not in ('borrador','enviada') then raise exception 'Solo se editan cotizaciones en borrador o enviadas'; end if;
    delete from public.quote_items where quote_id = result.id;
    update public.quotes set customer_id = customer_ref, valid_until = valid_date, delivery_cost = delivery_value,
      notes = nullif(btrim(coalesce(payload->>'notes', '')), ''),
      terms_snapshot = coalesce(nullif(btrim(coalesce(payload->>'terms', '')), ''), terms_snapshot),
      customer_snapshot = public.customer_document_snapshot(customer_ref), business_snapshot = public.business_document_snapshot()
    where id = result.id;
  end if;

  insert into public.quote_items(quote_id, product_id, variant_id, product_name, sku, option_snapshot, quantity, unit_price, discount, line_total)
  select result.id, l.product_id, l.variant_id, l.product_name, l.sku, l.option_snapshot, l.quantity, l.unit_price, l.discount, l.line_total
  from public.admin_document_lines(payload->'items', true) l;
  update public.quotes q set subtotal = t.gross, discount_total = t.disc, total = t.gross - t.disc + q.delivery_cost
  from (select coalesce(sum(i.unit_price * i.quantity), 0) as gross, coalesce(sum(i.discount), 0) as disc from public.quote_items i where i.quote_id = result.id) t
  where q.id = result.id returning q.* into result;
  return result;
end $$;

create or replace function public.set_quote_status(target_quote uuid, new_status text) returns public.quotes
language plpgsql security definer set search_path = public as $$
declare result public.quotes;
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  if new_status not in ('borrador','enviada','aceptada','rechazada','vencida') then raise exception 'Estado no permitido. Para convertir usa “Convertir a venta”.'; end if;
  select * into result from public.quotes where id = target_quote for update;
  if not found then raise exception 'Cotización no encontrada'; end if;
  if result.status = 'convertida' then raise exception 'La cotización ya fue convertida en venta'; end if;
  update public.quotes set status = new_status, sent_at = case when new_status = 'enviada' then coalesce(sent_at, now()) else sent_at end
  where id = target_quote returning * into result;
  return result;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Ventas
-- ---------------------------------------------------------------------------
-- Revisión común antes de crear una venta desde pedido o cotización: comprueba
-- disponibilidad y compara el importe pactado con el precio vigente.
create or replace function public.review_document_lines(lines jsonb, accept_changes boolean) returns void
language plpgsql stable security definer set search_path = public as $$
declare line jsonb; v public.product_variants; p public.products; differences text[] := '{}';
begin
  for line in select value from jsonb_array_elements(lines) loop
    if line->>'variant_id' is null then raise exception 'La línea % ya no tiene una variante en el catálogo', line->>'product_name'; end if;
    select * into v from public.product_variants pv where pv.id = (line->>'variant_id')::uuid;
    select * into p from public.products pr where pr.id = v.product_id;
    if v.id is null or not v.active or p.status = 'hidden' then raise exception '% ya no está disponible', line->>'product_name'; end if;
    if v.stock < (line->>'quantity')::int then
      raise exception 'Stock insuficiente para %: disponible %, solicitado %', line->>'product_name', v.stock, line->>'quantity';
    end if;
    if public.current_product_price(p, v) <> (line->>'unit_price')::numeric then
      differences := differences || format('%s: pactado %s, vigente %s', line->>'product_name',
        to_char((line->>'unit_price')::numeric, 'FM999G999G999G990'), to_char(public.current_product_price(p, v), 'FM999G999G999G990'));
    end if;
  end loop;
  if array_length(differences, 1) > 0 and not accept_changes then
    raise exception using errcode = 'BM001', message = 'Los precios cambiaron desde el documento original. Revisa y confirma que se respetan los importes pactados.',
      detail = array_to_string(differences, E'\n');
  end if;
end $$;

drop function if exists public.create_sale_from_order(uuid);
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
  insert into public.sales(sale_number, customer_id, source, source_order_id, status, payment_method, subtotal, delivery_cost, total,
    notes, terms_snapshot, warranty_snapshot, customer_snapshot, business_snapshot)
  values (public.next_document_number('sale'), source.customer_id, 'pedido', source.id, 'solicitud', source.payment_name, source.subtotal,
    source.delivery_cost, source.total, source.notes, (select sale_terms from public.site_settings where id = 1),
    (select warranty_text from public.site_settings where id = 1), public.customer_document_snapshot(source.customer_id), public.business_document_snapshot())
  returning * into result;
  insert into public.sale_items(sale_id, product_id, variant_id, product_name, sku, option_snapshot, quantity, unit_price, discount, line_total)
  select result.id, product_id, variant_id, product_name, sku, option_snapshot, quantity, unit_price, 0, line_total from public.order_items where order_id = source.id order by line_no;
  update public.orders set status = 'confirmado' where id = source.id;
  return result;
end $$;

drop function if exists public.convert_quote_to_sale(uuid);
create or replace function public.convert_quote_to_sale(target_quote uuid, accept_changes boolean default false) returns public.sales
language plpgsql security definer set search_path = public as $$
declare result public.sales; source public.quotes;
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  select * into result from public.sales where source_quote_id = target_quote;
  if found then return result; end if;
  select * into source from public.quotes where id = target_quote for update;
  if not found then raise exception 'Cotización no encontrada'; end if;
  if source.status not in ('borrador','enviada','aceptada') then raise exception 'La cotización está % y no se puede convertir', source.status; end if;
  if source.valid_until is not null and source.valid_until < public.bogota_today() and not accept_changes then
    raise exception using errcode = 'BM001', message = 'La cotización está vencida. Confirma que respetarás los importes pactados.',
      detail = format('Vigencia: %s', source.valid_until);
  end if;
  perform public.review_document_lines((select jsonb_agg(to_jsonb(i)) from public.quote_items i where i.quote_id = source.id), accept_changes);
  insert into public.sales(sale_number, customer_id, source, source_quote_id, status, subtotal, discount_total, delivery_cost, total,
    notes, terms_snapshot, warranty_snapshot, customer_snapshot, business_snapshot)
  values (public.next_document_number('sale'), source.customer_id, 'cotizacion', source.id, 'solicitud', source.subtotal, source.discount_total,
    source.delivery_cost, source.total, source.notes, (select sale_terms from public.site_settings where id = 1),
    (select warranty_text from public.site_settings where id = 1), public.customer_document_snapshot(source.customer_id), public.business_document_snapshot())
  returning * into result;
  insert into public.sale_items(sale_id, product_id, variant_id, product_name, sku, option_snapshot, quantity, unit_price, discount, line_total)
  select result.id, product_id, variant_id, product_name, sku, option_snapshot, quantity, unit_price, discount, line_total from public.quote_items where quote_id = source.id order by line_no;
  update public.quotes set status = 'convertida', converted_sale_id = result.id where id = source.id;
  return result;
end $$;

create or replace function public.create_manual_sale(payload jsonb) returns public.sales
language plpgsql security definer set search_path = public as $$
declare result public.sales; customer_ref uuid; sale_source text; delivery_value numeric(14,2);
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  customer_ref := nullif(payload->>'customer_id', '')::uuid;
  if not exists (select 1 from public.customers c where c.id = customer_ref and c.merged_into is null) then raise exception 'Selecciona un cliente válido'; end if;
  sale_source := coalesce(payload->>'source', 'presencial');
  if sale_source not in ('WhatsApp','presencial','manual') then raise exception 'Origen no válido'; end if;
  delivery_value := coalesce(nullif(payload->>'delivery_cost', '')::numeric, 0);
  if delivery_value < 0 then raise exception 'El costo de entrega no es válido'; end if;
  insert into public.sales(sale_number, customer_id, source, status, payment_method, delivery_cost, notes, terms_snapshot, warranty_snapshot,
    customer_snapshot, business_snapshot)
  values (public.next_document_number('sale'), customer_ref, sale_source, 'solicitud', nullif(btrim(coalesce(payload->>'payment_method', '')), ''),
    delivery_value, nullif(btrim(coalesce(payload->>'notes', '')), ''), (select sale_terms from public.site_settings where id = 1),
    (select warranty_text from public.site_settings where id = 1), public.customer_document_snapshot(customer_ref), public.business_document_snapshot())
  returning * into result;
  insert into public.sale_items(sale_id, product_id, variant_id, product_name, sku, option_snapshot, quantity, unit_price, discount, line_total)
  select result.id, l.product_id, l.variant_id, l.product_name, l.sku, l.option_snapshot, l.quantity, l.unit_price, l.discount, l.line_total
  from public.admin_document_lines(payload->'items', true) l;
  update public.sales s set subtotal = t.gross, discount_total = t.disc, total = t.gross - t.disc + s.delivery_cost
  from (select coalesce(sum(i.unit_price * i.quantity), 0) as gross, coalesce(sum(i.discount), 0) as disc from public.sale_items i where i.sale_id = result.id) t
  where s.id = result.id returning s.* into result;
  return result;
end $$;

-- Confirmar descuenta stock una sola vez. El UPDATE condicional (stock >= cantidad)
-- con bloqueo de fila impide stock negativo aunque dos ventas se confirmen a la vez;
-- las variantes se bloquean en orden de id para evitar interbloqueos.
create or replace function public.confirm_sale(target_sale uuid) returns public.sales
language plpgsql security definer set search_path = public as $$
declare result public.sales; line record; changed integer;
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  select * into result from public.sales where id = target_sale for update;
  if not found then raise exception 'Venta no encontrada'; end if;
  if result.stock_applied_at is not null then return result; end if;
  if result.status <> 'solicitud' then raise exception 'Transición no permitida desde %', result.status; end if;
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

drop function if exists public.cancel_sale(uuid);
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
  update public.sales set status = 'cancelada', cancelled_at = now(), cancel_reason = nullif(btrim(coalesce(reason, '')), '')
  where id = target_sale returning * into result;
  return result;
end $$;

create or replace function public.set_sale_status(target_sale uuid, new_status text, payment_method text default null) returns public.sales
language plpgsql security definer set search_path = public as $$
declare result public.sales;
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  select * into result from public.sales where id = target_sale for update;
  if not found then raise exception 'Venta no encontrada'; end if;
  if result.stock_applied_at is null then raise exception 'Primero confirma la venta'; end if;
  if not ((result.status = 'confirmada' and new_status in ('pagada','entregada'))
       or (result.status = 'pagada' and new_status = 'entregada')
       or (result.status = 'entregada' and new_status = 'pagada')) then
    raise exception 'Transición no permitida: % → %', result.status, new_status;
  end if;
  update public.sales s set status = new_status,
    paid_at = case when new_status = 'pagada' then now() else s.paid_at end,
    delivered_at = case when new_status = 'entregada' then now() else s.delivered_at end,
    payment_method = coalesce(nullif(btrim(coalesce(set_sale_status.payment_method, '')), ''), s.payment_method)
  where s.id = target_sale returning s.* into result;
  return result;
end $$;

-- Devolución parcial o total con decisión explícita de reintegrar inventario.
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
  if pending = 0 then update public.sales set status = 'devuelta' where id = target_sale; end if;
  select * into result from public.sales where id = target_sale;
  return result;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Inventario: variantes estables y ajustes trazables
-- ---------------------------------------------------------------------------
create or replace function public.log_manual_stock_adjustment() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.stock is distinct from old.stock and coalesce(current_setting('bodega.stock_context', true), '') = '' then
    insert into public.stock_movements(variant_id, quantity_delta, reason, note, created_by)
    values (new.id, new.stock - old.stock, 'ajuste', 'Ajuste manual desde el panel', auth.uid());
  end if;
  return new;
end $$;
create trigger product_variants_stock_log after update of stock on public.product_variants
  for each row execute function public.log_manual_stock_adjustment();

-- Guarda la matriz de variantes conservando los id existentes (carritos, pedidos y
-- movimientos siguen apuntando a la misma variante).
create or replace function public.save_product_variants(target_product uuid, variants jsonb) returns setof public.product_variants
language plpgsql security definer set search_path = public as $$
declare item jsonb; color_ref uuid; size_ref uuid; kept uuid[] := '{}'; variant_ref uuid; stock_value integer;
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  if not exists (select 1 from public.products where id = target_product) then raise exception 'Producto no encontrado'; end if;
  if jsonb_typeof(variants) is distinct from 'array' then raise exception 'Variantes no válidas'; end if;
  for item in select value from jsonb_array_elements(variants) loop
    color_ref := nullif(item->>'color_id', '')::uuid;
    size_ref := nullif(item->>'size_id', '')::uuid;
    stock_value := greatest(coalesce(nullif(item->>'stock', '')::int, 0), 0);
    if color_ref is not null and not exists (select 1 from public.product_colors where id = color_ref and product_id = target_product) then raise exception 'Opción no válida'; end if;
    if size_ref is not null and not exists (select 1 from public.product_sizes where id = size_ref and product_id = target_product) then raise exception 'Opción no válida'; end if;
    select id into variant_ref from public.product_variants
      where product_id = target_product and color_id is not distinct from color_ref and size_id is not distinct from size_ref;
    if variant_ref is null then
      insert into public.product_variants(product_id, color_id, size_id, stock, active, sku)
      values (target_product, color_ref, size_ref, stock_value, coalesce((item->>'active')::boolean, true), nullif(btrim(coalesce(item->>'sku', '')), ''))
      returning id into variant_ref;
    else
      update public.product_variants set stock = stock_value, active = coalesce((item->>'active')::boolean, true), updated_at = now()
      where id = variant_ref;
    end if;
    kept := kept || variant_ref;
  end loop;
  delete from public.product_variants where product_id = target_product and not (id = any(kept));
  return query select * from public.product_variants where product_id = target_product order by id;
end $$;

-- ---------------------------------------------------------------------------
-- 9. RLS y privilegios mínimos
-- ---------------------------------------------------------------------------
alter table public.sale_returns enable row level security;
create policy sale_returns_admin_all on public.sale_returns for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Supabase concede por defecto ALL a anon/authenticated. Se retira y se concede
-- solo lo necesario; RLS sigue siendo la segunda barrera.
revoke all on all tables in schema public from anon, authenticated;
grant select on public.site_settings, public.categories, public.brands, public.products, public.product_categories,
  public.product_colors, public.product_sizes, public.product_variants, public.product_images, public.homepage_banners,
  public.payment_methods, public.delivery_methods to anon, authenticated;
grant select on public.admins to authenticated;
grant insert, update, delete on public.categories, public.brands, public.products, public.product_categories,
  public.product_colors, public.product_sizes, public.product_variants, public.product_images, public.homepage_banners,
  public.payment_methods, public.delivery_methods to authenticated;
grant update on public.site_settings to authenticated;
grant select on public.customers, public.customer_consents, public.birthday_contacts, public.orders, public.order_items,
  public.quotes, public.quote_items, public.sales, public.sale_items, public.sale_returns, public.stock_movements to authenticated;
-- Clientes: alta y edición; nunca borrado físico (se archivan o fusionan).
grant insert on public.customers to authenticated;
grant update (full_name, phone_original, city, address, birth_date, identification, notes, source, archived_at) on public.customers to authenticated;
grant insert on public.customer_consents to authenticated;
grant update (withdrawn_at) on public.customer_consents to authenticated;
grant insert, update on public.birthday_contacts to authenticated;
-- Documentos: estados e importes solo cambian mediante funciones transaccionales.
grant update (status, admin_notes) on public.orders to authenticated;
grant update (notes) on public.quotes to authenticated;
grant update (notes) on public.sales to authenticated;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.current_product_price(public.products, public.product_variants) to anon, authenticated;
grant execute on function public.search_products(text, integer) to anon, authenticated;
grant execute on function public.validate_cart(jsonb) to anon, authenticated;
grant execute on function public.create_storefront_order(jsonb, uuid) to anon, authenticated;
grant execute on function public.mark_order_whatsapp_opened(uuid) to anon, authenticated;
grant execute on function public.birthday_in_year(date, integer), public.customer_age(date, date), public.next_birthday(date, date),
  public.bogota_today() to authenticated;
grant execute on function public.catalog_entity_dependencies(text, uuid), public.delete_catalog_entity_safely(text, uuid),
  public.save_homepage_banners(boolean, numeric, jsonb), public.save_product_variants(uuid, jsonb),
  public.merge_customers(uuid, uuid), public.create_admin_order(jsonb), public.save_admin_quote(uuid, jsonb),
  public.set_quote_status(uuid, text), public.create_sale_from_order(uuid, boolean), public.convert_quote_to_sale(uuid, boolean),
  public.create_manual_sale(jsonb), public.confirm_sale(uuid), public.cancel_sale(uuid, text), public.set_sale_status(uuid, text, text),
  public.register_sale_return(uuid, jsonb, boolean, uuid, text) to authenticated;

-- Objetos futuros de public no quedan expuestos a anon por defecto.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on functions from anon;
alter default privileges in schema public revoke execute on functions from public;

-- Storage: las políticas de escritura quedan restringidas a los buckets propios.
drop policy if exists admin_update_assets on storage.objects;
drop policy if exists admin_delete_assets on storage.objects;
create policy admin_update_assets on storage.objects for update to authenticated
  using (bucket_id in ('product-images','brand-assets','category-images','site-assets','banner-images','private-documents') and public.is_admin())
  with check (bucket_id in ('product-images','brand-assets','category-images','site-assets','banner-images','private-documents') and public.is_admin());
create policy admin_delete_assets on storage.objects for delete to authenticated
  using (bucket_id in ('product-images','brand-assets','category-images','site-assets','banner-images','private-documents') and public.is_admin());
