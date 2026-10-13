-- Bodega Mayorista F.C. — precios por volumen (tramos mayoristas).
--
-- Compatible con lo actual: un producto sin tramos se cobra exactamente igual que
-- antes (current_product_price). Con tramos, el precio unitario es el MENOR entre el
-- precio regular (variante, promoción o base) y el del tramo alcanzado, donde el tramo
-- se determina por la suma de unidades del MISMO producto en el documento (todas sus
-- variantes cuentan). La tienda lo muestra; el servidor siempre lo recalcula.
--
-- No ejecutar desde el navegador. Ver docs/APLICAR_MIGRACION_TRAMOS.md.


-- ---------------------------------------------------------------------------
-- 1. Tabla de tramos
-- ---------------------------------------------------------------------------
create table if not exists public.product_price_tiers (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  min_quantity integer not null check (min_quantity between 2 and 9999),
  unit_price numeric(14,2) not null check (unit_price > 0),
  created_at timestamptz not null default now(),
  unique (product_id, min_quantity)
);
create index if not exists product_price_tiers_product_idx on public.product_price_tiers(product_id, min_quantity);

alter table public.product_price_tiers enable row level security;
drop policy if exists price_tiers_public_read on public.product_price_tiers;
create policy price_tiers_public_read on public.product_price_tiers for select to anon, authenticated
  using (exists (select 1 from public.products p where p.id = product_id and (p.status = 'published' or public.is_admin())));
drop policy if exists price_tiers_admin_all on public.product_price_tiers;
create policy price_tiers_admin_all on public.product_price_tiers for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Lectura pública; la escritura solo mediante save_product_price_tiers (transaccional).
revoke all on public.product_price_tiers from anon, authenticated;
grant select on public.product_price_tiers to anon, authenticated;

-- Interruptor que la tienda lee para empezar a consultar los tramos. Antes de esta
-- migración la columna no existe y la tienda no hace ninguna petición a la tabla.
alter table public.site_settings add column if not exists price_tiers_enabled boolean not null default true;

-- ---------------------------------------------------------------------------
-- 2. Precio unitario con tramo
-- ---------------------------------------------------------------------------
create or replace function public.tier_unit_price(target_product uuid, total_quantity integer, regular numeric)
returns numeric language sql stable set search_path = public as $$
  select least(regular, coalesce((
    select t.unit_price from public.product_price_tiers t
    where t.product_id = target_product and t.min_quantity <= greatest(coalesce(total_quantity, 0), 0)
    order by t.min_quantity desc limit 1
  ), regular))
$$;

-- ---------------------------------------------------------------------------
-- 3. Gestión desde el panel (reemplaza todos los tramos de un producto)
-- ---------------------------------------------------------------------------
create or replace function public.save_product_price_tiers(target_product uuid, tiers jsonb)
returns setof public.product_price_tiers
language plpgsql security definer set search_path = public as $$
declare item record; base numeric(14,2); last_quantity integer := 1; last_price numeric(14,2);
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  select p.base_price into base from public.products p where p.id = target_product;
  if not found then raise exception 'Producto no encontrado'; end if;
  if tiers is null or jsonb_typeof(tiers) is distinct from 'array' then raise exception 'Los tramos no son válidos'; end if;
  if jsonb_array_length(tiers) > 10 then raise exception 'Máximo 10 tramos por producto'; end if;
  if exists (select 1 from jsonb_array_elements(tiers) e
             where coalesce(e->>'min_quantity', '') !~ '^[0-9]{1,4}$' or coalesce(e->>'unit_price', '') !~ '^[0-9]{1,12}(\.[0-9]{1,2})?$') then
    raise exception 'Revisa las cantidades y los precios de los tramos';
  end if;

  delete from public.product_price_tiers where product_id = target_product;
  last_price := base;
  for item in
    select (e->>'min_quantity')::int as quantity, (e->>'unit_price')::numeric as price
    from jsonb_array_elements(tiers) e order by 1
  loop
    if item.quantity < 2 then raise exception 'La cantidad mínima de un tramo debe ser 2 o más'; end if;
    if item.quantity = last_quantity then raise exception 'Hay dos tramos con la misma cantidad mínima'; end if;
    if item.price <= 0 then raise exception 'El precio de cada tramo debe ser mayor que cero'; end if;
    if item.price >= last_price then raise exception 'Cada tramo debe costar menos que el anterior y que el precio normal'; end if;
    insert into public.product_price_tiers(product_id, min_quantity, unit_price) values (target_product, item.quantity, item.price);
    last_quantity := item.quantity; last_price := item.price;
  end loop;
  return query select * from public.product_price_tiers t where t.product_id = target_product order by t.min_quantity;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Checkout público: mismo contrato, precio con tramo
--    (copia de 202609280002 con el cálculo del tramo; nada más cambia)
-- ---------------------------------------------------------------------------
create or replace function public.create_storefront_order(payload jsonb, request_key uuid)
returns table(order_number text, total numeric, whatsapp text, items jsonb)
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  existing_id uuid; customer public.customers; line record; variant public.product_variants; product public.products;
  delivery public.delivery_methods; payment public.payment_methods; settings public.site_settings;
  normalized text; clean_name text; clean_phone text; clean_city text; clean_address text; clean_notes text; birth date;
  subtotal_value numeric(14,2) := 0; unit_value numeric(14,2); new_order_id uuid; conflicts jsonb := '{}'::jsonb; recent integer;
  product_units integer;
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
    -- Tramo por volumen: suma de unidades del mismo producto en todo el pedido.
    select coalesce(sum((e->>'quantity')::int), 0)::int into product_units
    from jsonb_array_elements(payload->'items') e
    join public.product_variants pv on pv.id = (e->>'variant_id')::uuid
    where pv.product_id = product.id;
    unit_value := public.tier_unit_price(product.id, product_units, public.current_product_price(product, variant));
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

-- ---------------------------------------------------------------------------
-- 5. Documentos del panel: el precio de catálogo respeta los tramos
-- ---------------------------------------------------------------------------
create or replace function public.admin_document_lines(items jsonb, allow_custom_price boolean)
returns table(product_id uuid, variant_id uuid, product_name text, sku text, option_snapshot jsonb,
  quantity integer, unit_price numeric, discount numeric, line_total numeric, catalog_price numeric)
language plpgsql stable security definer set search_path = public as $$
declare item jsonb; v public.product_variants; p public.products; qty integer; price numeric(14,2); disc numeric(14,2); cat numeric(14,2); units integer;
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
    select coalesce(sum((e->>'quantity')::int), 0)::int into units
    from jsonb_array_elements(items) e
    join public.product_variants pv on pv.id::text = e->>'variant_id'
    where pv.product_id = p.id and coalesce(e->>'quantity', '') ~ '^[0-9]{1,4}$';
    cat := public.tier_unit_price(p.id, units, public.current_product_price(p, v));
    price := case when allow_custom_price and coalesce(item->>'unit_price', '') <> '' then (item->>'unit_price')::numeric else cat end;
    disc := coalesce(nullif(item->>'discount', '')::numeric, 0);
    if price < 0 or disc < 0 or disc > price * qty then raise exception 'Importe o descuento no válido para %', p.name; end if;
    product_id := p.id; variant_id := v.id; product_name := p.name; sku := coalesce(v.sku, p.sku);
    option_snapshot := public.variant_option_snapshot(v.id); quantity := qty; unit_price := price; discount := disc;
    line_total := price * qty - disc; catalog_price := cat;
    return next;
  end loop;
end $$;

-- Al convertir un pedido o cotización en venta, el precio "vigente" incluye el tramo:
-- un pedido cobrado con precio por mayor no aparece como "precio cambiado".
create or replace function public.review_document_lines(lines jsonb, accept_changes boolean) returns void
language plpgsql stable security definer set search_path = public as $$
declare line jsonb; v public.product_variants; p public.products; differences text[] := '{}'; units integer; expected numeric;
begin
  for line in select value from jsonb_array_elements(lines) loop
    if line->>'variant_id' is null then raise exception 'La línea % ya no tiene una variante en el catálogo', line->>'product_name'; end if;
    select * into v from public.product_variants pv where pv.id = (line->>'variant_id')::uuid;
    select * into p from public.products pr where pr.id = v.product_id;
    if v.id is null or not v.active or p.status = 'hidden' then raise exception '% ya no está disponible', line->>'product_name'; end if;
    if v.stock < (line->>'quantity')::int then
      raise exception 'Stock insuficiente para %: disponible %, solicitado %', line->>'product_name', v.stock, line->>'quantity';
    end if;
    select coalesce(sum((l->>'quantity')::int), 0)::int into units
    from jsonb_array_elements(lines) l
    join public.product_variants pv on pv.id::text = l->>'variant_id'
    where pv.product_id = p.id;
    expected := public.tier_unit_price(p.id, units, public.current_product_price(p, v));
    if expected <> (line->>'unit_price')::numeric then
      differences := differences || format('%s: pactado %s, vigente %s', line->>'product_name',
        to_char((line->>'unit_price')::numeric, 'FM999G999G999G990'), to_char(expected, 'FM999G999G999G990'));
    end if;
  end loop;
  if array_length(differences, 1) > 0 and not accept_changes then
    raise exception using errcode = 'BM001', message = 'Los precios cambiaron desde el documento original. Revisa y confirma que se respetan los importes pactados.',
      detail = array_to_string(differences, E'\n');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Privilegios mínimos
-- ---------------------------------------------------------------------------
revoke execute on function public.tier_unit_price(uuid, integer, numeric) from public, anon, authenticated;
revoke execute on function public.save_product_price_tiers(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_product_price_tiers(uuid, jsonb) to authenticated;
revoke execute on function public.admin_document_lines(jsonb, boolean) from public, anon, authenticated;
revoke execute on function public.review_document_lines(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.create_storefront_order(jsonb, uuid) to anon, authenticated;

