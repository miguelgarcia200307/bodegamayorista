-- Bodega Mayorista F.C. — base limpia e independiente.
-- No contiene datos comerciales ni referencias al negocio heredado.
create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;
create extension if not exists pg_graphql;

create table public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.site_settings (
  id smallint primary key default 1 check (id = 1),
  business_name text not null default 'Bodega Mayorista F.C.',
  tagline text not null default 'Tecnología, calidad y confianza',
  whatsapp text,
  phone text,
  email text,
  address text,
  city text,
  schedule text,
  instagram text,
  facebook text,
  tiktok text,
  maps_url text,
  logo_url text,
  tax_id text,
  default_sort text not null default 'featured',
  checkout_behavior text not null default 'keep' check (checkout_behavior in ('keep','clear')),
  data_policy_text text,
  data_policy_version text,
  marketing_consent_text text,
  marketing_consent_version text,
  quote_terms text,
  sale_terms text,
  warranty_text text,
  birthday_message text not null default 'Hola {nombre}, te deseamos un feliz cumpleaños de parte de Bodega Mayorista F.C.',
  announcement_enabled boolean not null default true,
  announcement_mode text not null default 'static' check (announcement_mode in ('static','carousel')),
  announcement_static_text text not null default 'Bodega Mayorista F.C. · Tecnología, calidad y confianza',
  announcement_interval_seconds smallint not null default 5 check (announcement_interval_seconds between 2 and 120),
  announcement_messages jsonb not null default '[]'::jsonb check (jsonb_typeof(announcement_messages) = 'array'),
  banner_enabled boolean not null default false,
  banner_interval_seconds numeric(4,1) not null default 5 check (banner_interval_seconds between 0.5 and 60),
  updated_at timestamptz not null default now()
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references public.categories(id) on delete restrict,
  name text not null,
  slug text not null unique,
  description text,
  image_url text,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (parent_id is null or parent_id <> id)
);

create table public.brands (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  logo_url text,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  sku text unique,
  model text,
  description text,
  material text,
  care_instructions text,
  purchase_delivery_info text,
  specifications jsonb not null default '{}'::jsonb check (jsonb_typeof(specifications) = 'object'),
  base_price numeric(14,2) not null check (base_price >= 0),
  promo_price numeric(14,2) check (promo_price is null or promo_price >= 0),
  promo_enabled boolean not null default true,
  promo_start timestamptz,
  promo_end timestamptz,
  status text not null default 'draft' check (status in ('draft','published','hidden')),
  brand_id uuid references public.brands(id) on delete set null,
  featured boolean not null default false,
  low_stock_threshold integer not null default 3 check (low_stock_threshold >= 0),
  option1_name text,
  option2_name text,
  force_last_units boolean not null default false,
  force_sold_out boolean not null default false,
  is_personalizable boolean not null default false,
  personalization_price numeric(14,2) not null default 0,
  allow_name boolean not null default false,
  allow_number boolean not null default false,
  allow_logo boolean not null default false,
  allow_font boolean not null default false,
  allow_text_color boolean not null default false,
  size_guide_text text,
  size_guide_image_url text,
  front_template_url text,
  back_template_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (promo_price is null or promo_price < base_price),
  check (promo_end is null or promo_start is null or promo_end > promo_start)
);

create table public.product_categories (
  product_id uuid not null references public.products(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  primary key (product_id, category_id)
);

-- Nombres heredados solo como compatibilidad de interfaz. Representan opción 1 y opción 2,
-- no obligan a que sean color o talla.
create table public.product_colors (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  name text not null,
  hex_code text check (hex_code is null or hex_code ~ '^#[0-9A-Fa-f]{6}$'),
  sort_order integer not null default 0,
  unique (product_id, name)
);
create table public.product_sizes (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  unique (product_id, name)
);
create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  color_id uuid references public.product_colors(id) on delete cascade,
  size_id uuid references public.product_sizes(id) on delete cascade,
  sku text unique,
  option_values jsonb not null default '{}'::jsonb check (jsonb_typeof(option_values) = 'object'),
  price numeric(14,2) check (price is null or price >= 0),
  stock integer not null default 0 check (stock >= 0),
  active boolean not null default true,
  updated_at timestamptz not null default now()
);
create unique index product_variant_option_pair_idx on public.product_variants(product_id, color_id, size_id)
  where color_id is not null or size_id is not null;
create unique index product_default_variant_idx on public.product_variants(product_id)
  where color_id is null and size_id is null;

create table public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete set null,
  color_id uuid references public.product_colors(id) on delete set null,
  url text not null,
  alt_text text,
  is_primary boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index product_images_one_primary_idx on public.product_images(product_id) where is_primary;

create table public.homepage_banners (
  id uuid primary key default gen_random_uuid(),
  desktop_image_url text not null,
  mobile_image_url text,
  alt_text text not null check (length(btrim(alt_text)) between 1 and 200),
  link_url text,
  active boolean not null default true,
  sort_order integer not null check (sort_order between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  instructions text,
  logo_url text,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create table public.delivery_methods (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  instructions text,
  requires_city boolean not null default false,
  requires_address boolean not null default false,
  base_cost numeric(14,2) not null default 0 check (base_cost >= 0),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone_original text not null,
  phone_normalized text not null unique,
  city text,
  address text,
  birth_date date check (birth_date is null or birth_date <= current_date),
  identification text,
  notes text,
  source text not null default 'manual' check (source in ('tienda','WhatsApp','presencial','manual')),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.customer_consents (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  purpose text not null check (purpose in ('order_processing','marketing_birthday')),
  granted boolean not null,
  text_version text not null,
  source text not null,
  recorded_at timestamptz not null default now(),
  withdrawn_at timestamptz
);
create table public.birthday_contacts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  contact_year integer not null,
  status text not null default 'pendiente' check (status in ('pendiente','contactado','obsequio_ofrecido','completado','no_contactar')),
  note text,
  contacted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id, contact_year)
);

create table public.document_sequences (
  kind text primary key check (kind in ('order','quote','sale')),
  last_value bigint not null default 0
);
insert into public.document_sequences(kind) values ('order'),('quote'),('sale');

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  customer_id uuid not null references public.customers(id) on delete restrict,
  status text not null default 'pendiente' check (status in ('pendiente','contactado','confirmado','cancelado','abandonado')),
  delivery_method_id uuid references public.delivery_methods(id) on delete restrict,
  delivery_name text,
  payment_method_id uuid references public.payment_methods(id) on delete restrict,
  payment_name text,
  shipping_city text,
  shipping_address text,
  notes text,
  customer_conflicts jsonb not null default '{}'::jsonb,
  subtotal numeric(14,2) not null check (subtotal >= 0),
  delivery_cost numeric(14,2) not null default 0 check (delivery_cost >= 0),
  total numeric(14,2) not null check (total >= 0),
  idempotency_key uuid not null unique,
  whatsapp_opened_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  product_id uuid references public.products(id) on delete set null,
  variant_id uuid references public.product_variants(id) on delete set null,
  product_name text not null,
  sku text,
  option_snapshot jsonb not null default '{}'::jsonb,
  quantity integer not null check (quantity > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  line_total numeric(14,2) not null check (line_total >= 0)
);

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  quote_number text not null unique,
  customer_id uuid not null references public.customers(id) on delete restrict,
  status text not null default 'borrador' check (status in ('borrador','enviada','aceptada','rechazada','vencida','convertida')),
  valid_until date,
  subtotal numeric(14,2) not null default 0,
  discount_total numeric(14,2) not null default 0,
  delivery_cost numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  notes text,
  terms_snapshot text,
  converted_sale_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.quote_items (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete restrict,
  product_id uuid references public.products(id) on delete set null,
  variant_id uuid references public.product_variants(id) on delete set null,
  product_name text not null,
  sku text,
  option_snapshot jsonb not null default '{}'::jsonb,
  quantity integer not null check (quantity > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  discount numeric(14,2) not null default 0 check (discount >= 0),
  line_total numeric(14,2) not null check (line_total >= 0)
);

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  sale_number text not null unique,
  customer_id uuid not null references public.customers(id) on delete restrict,
  source text not null check (source in ('pedido','cotizacion','WhatsApp','presencial','manual')),
  source_order_id uuid references public.orders(id) on delete restrict,
  source_quote_id uuid references public.quotes(id) on delete restrict,
  status text not null default 'solicitud' check (status in ('solicitud','confirmada','pagada','entregada','cancelada','devuelta')),
  payment_method text,
  subtotal numeric(14,2) not null default 0,
  discount_total numeric(14,2) not null default 0,
  delivery_cost numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  notes text,
  terms_snapshot text,
  stock_applied_at timestamptz,
  stock_restored_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.quotes add constraint quotes_converted_sale_fkey foreign key (converted_sale_id) references public.sales(id) on delete restrict;
create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete restrict,
  product_id uuid references public.products(id) on delete set null,
  variant_id uuid references public.product_variants(id) on delete set null,
  product_name text not null,
  sku text,
  option_snapshot jsonb not null default '{}'::jsonb,
  quantity integer not null check (quantity > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  discount numeric(14,2) not null default 0 check (discount >= 0),
  line_total numeric(14,2) not null check (line_total >= 0)
);
create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants(id) on delete restrict,
  sale_id uuid references public.sales(id) on delete restrict,
  quantity_delta integer not null check (quantity_delta <> 0),
  reason text not null check (reason in ('venta','cancelacion','devolucion','ajuste')),
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index one_sale_per_order_idx on public.sales(source_order_id) where source_order_id is not null;
create unique index one_sale_per_quote_idx on public.sales(source_quote_id) where source_quote_id is not null;

create or replace function public.set_updated_at() returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end $$;
do $$ declare t text; begin
  foreach t in array array['site_settings','categories','brands','products','product_variants','homepage_banners','customers','birthday_contacts','orders','quotes','sales']
  loop execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()', t || '_updated_at', t); end loop;
end $$;

create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.admins where user_id = auth.uid())
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

create or replace function public.normalize_phone(value text) returns text language plpgsql immutable set search_path = pg_catalog as $$
declare digits text := regexp_replace(coalesce(value,''), '\D', '', 'g');
begin
  if digits ~ '^0?3[0-9]{9}$' then return '+57' || right(digits,10); end if;
  if digits ~ '^57(3[0-9]{9})$' then return '+' || digits; end if;
  if digits ~ '^[1-9][0-9]{7,14}$' then return '+' || digits; end if;
  raise exception 'Número de teléfono no válido';
end $$;

create or replace function public.next_document_number(doc_kind text) returns text language plpgsql security definer set search_path = public as $$
declare next_value bigint; prefix text;
begin
  if doc_kind not in ('order','quote','sale') then raise exception 'Tipo de documento inválido'; end if;
  update public.document_sequences set last_value = last_value + 1 where kind = doc_kind returning last_value into next_value;
  prefix := case doc_kind when 'order' then 'PED' when 'quote' then 'COT' else 'CV' end;
  return prefix || '-' || to_char(current_date,'YYYY') || '-' || lpad(next_value::text,6,'0');
end $$;
revoke all on function public.next_document_number(text) from public;

create or replace function public.current_product_price(p public.products, v public.product_variants) returns numeric language sql stable set search_path = public as $$
  select coalesce(v.price, case when p.promo_enabled and p.promo_price is not null and (p.promo_start is null or p.promo_start <= now()) and (p.promo_end is null or p.promo_end >= now()) then p.promo_price else p.base_price end)
$$;

create or replace function public.create_storefront_order(payload jsonb, request_key uuid)
returns table(order_number text, total numeric, whatsapp text, items jsonb)
language plpgsql security definer set search_path = public, pg_catalog as $$
declare existing public.orders; customer public.customers; item jsonb; variant public.product_variants; product public.products;
  normalized text; subtotal_value numeric := 0; delivery_value numeric := 0; unit_value numeric; qty integer;
  delivery public.delivery_methods; payment public.payment_methods; new_order_id uuid; conflicts jsonb := '{}'::jsonb;
  settings public.site_settings; processing_version text; marketing_version text;
begin
  if request_key is null then raise exception 'Falta la clave de idempotencia'; end if;
  select * into existing from public.orders where idempotency_key=request_key;
  if found then return query select existing.order_number, existing.total, (select s.whatsapp from public.site_settings s where s.id=1),
    (select coalesce(jsonb_agg(jsonb_build_object('name',i.product_name,'sku',i.sku,'options',i.option_snapshot,'quantity',i.quantity,'unit_price',i.unit_price,'line_total',i.line_total) order by i.id),'[]'::jsonb) from public.order_items i where i.order_id=existing.id); return; end if;
  if jsonb_typeof(payload->'items') <> 'array' or jsonb_array_length(payload->'items') not between 1 and 50 then raise exception 'El carrito no es válido'; end if;
  if length(btrim(coalesce(payload->>'name',''))) not between 2 and 120 then raise exception 'El nombre no es válido'; end if;
  normalized := public.normalize_phone(payload->>'phone');
  select * into settings from public.site_settings where id=1;
  select * into delivery from public.delivery_methods where id=nullif(payload->>'delivery_method_id','')::uuid and active;
  if not found then raise exception 'Selecciona un método de entrega válido'; end if;
  select * into payment from public.payment_methods where id=nullif(payload->>'payment_method_id','')::uuid and active;
  if not found then raise exception 'Selecciona un método de pago válido'; end if;
  if delivery.requires_city and nullif(btrim(payload->>'city'),'') is null then raise exception 'La ciudad es obligatoria'; end if;
  if delivery.requires_address and nullif(btrim(payload->>'address'),'') is null then raise exception 'La dirección es obligatoria'; end if;
  delivery_value := delivery.base_cost;
  insert into public.customers(full_name,phone_original,phone_normalized,city,address,birth_date,source)
  values (btrim(payload->>'name'),payload->>'phone',normalized,nullif(btrim(payload->>'city'),''),nullif(btrim(payload->>'address'),''),nullif(payload->>'birth_date','')::date,'tienda')
  on conflict(phone_normalized) do update set updated_at=now()
  returning * into customer;
  if customer.full_name is distinct from btrim(payload->>'name') then conflicts := conflicts || jsonb_build_object('name',payload->>'name'); end if;
  if customer.city is not null and nullif(btrim(payload->>'city'),'') is distinct from customer.city then conflicts := conflicts || jsonb_build_object('city',payload->>'city'); end if;
  if customer.address is not null and nullif(btrim(payload->>'address'),'') is distinct from customer.address then conflicts := conflicts || jsonb_build_object('address',payload->>'address'); end if;
  insert into public.orders(order_number,customer_id,delivery_method_id,delivery_name,payment_method_id,payment_name,shipping_city,shipping_address,notes,customer_conflicts,subtotal,delivery_cost,total,idempotency_key)
  values (public.next_document_number('order'),customer.id,delivery.id,delivery.name,payment.id,payment.name,nullif(btrim(payload->>'city'),''),nullif(btrim(payload->>'address'),''),nullif(btrim(payload->>'notes'),''),conflicts,0,delivery_value,0,request_key)
  returning id into new_order_id;
  for item in select value from jsonb_array_elements(payload->'items') loop
    qty := nullif(item->>'quantity','')::integer;
    if qty is null or qty < 1 or qty > 99 then raise exception 'Cantidad no válida'; end if;
    select * into variant from public.product_variants where id=(item->>'variant_id')::uuid and active for share;
    if not found then raise exception 'Una variante ya no está disponible'; end if;
    select * into product from public.products where id=variant.product_id and status='published' and not force_sold_out;
    if not found or variant.stock < qty then raise exception 'Stock insuficiente para %', coalesce(product.name,'el producto'); end if;
    unit_value := public.current_product_price(product,variant);
    subtotal_value := subtotal_value + unit_value*qty;
    insert into public.order_items(order_id,product_id,variant_id,product_name,sku,option_snapshot,quantity,unit_price,line_total)
    values(new_order_id,product.id,variant.id,product.name,coalesce(variant.sku,product.sku),variant.option_values,qty,unit_value,unit_value*qty);
  end loop;
  update public.orders set subtotal=subtotal_value,total=subtotal_value+delivery_value where id=new_order_id returning * into existing;
  processing_version := coalesce(nullif(settings.data_policy_version,''),'pendiente');
  insert into public.customer_consents(customer_id,purpose,granted,text_version,source) values(customer.id,'order_processing',true,processing_version,'checkout');
  if coalesce((payload->>'marketing_consent')::boolean,false) then
    marketing_version := coalesce(nullif(settings.marketing_consent_version,''),'pendiente');
    insert into public.customer_consents(customer_id,purpose,granted,text_version,source) values(customer.id,'marketing_birthday',true,marketing_version,'checkout');
  end if;
  return query select existing.order_number, existing.total, settings.whatsapp,
    (select coalesce(jsonb_agg(jsonb_build_object('name',i.product_name,'sku',i.sku,'options',i.option_snapshot,'quantity',i.quantity,'unit_price',i.unit_price,'line_total',i.line_total) order by i.id),'[]'::jsonb) from public.order_items i where i.order_id=new_order_id);
exception when unique_violation then
  select * into existing from public.orders where idempotency_key=request_key;
  if found then return query select existing.order_number,existing.total,(select s.whatsapp from public.site_settings s where s.id=1),
    (select coalesce(jsonb_agg(jsonb_build_object('name',i.product_name,'sku',i.sku,'options',i.option_snapshot,'quantity',i.quantity,'unit_price',i.unit_price,'line_total',i.line_total) order by i.id),'[]'::jsonb) from public.order_items i where i.order_id=existing.id); return; end if;
  raise;
end $$;
revoke all on function public.create_storefront_order(jsonb,uuid) from public;
grant execute on function public.create_storefront_order(jsonb,uuid) to anon, authenticated;

create or replace function public.confirm_sale(target_sale uuid) returns public.sales language plpgsql security definer set search_path = public as $$
declare result public.sales; line record; changed integer;
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  select * into result from public.sales where id=target_sale for update;
  if not found then raise exception 'Venta no encontrada'; end if;
  if result.stock_applied_at is not null then return result; end if;
  if result.status not in ('solicitud','confirmada') then raise exception 'Transición no permitida'; end if;
  for line in select * from public.sale_items where sale_id=target_sale order by id loop
    if line.variant_id is null then raise exception 'La línea % no tiene variante',line.product_name; end if;
    update public.product_variants set stock=stock-line.quantity where id=line.variant_id and stock>=line.quantity;
    get diagnostics changed=row_count; if changed<>1 then raise exception 'Stock insuficiente para %',line.product_name; end if;
    insert into public.stock_movements(variant_id,sale_id,quantity_delta,reason,created_by) values(line.variant_id,target_sale,-line.quantity,'venta',auth.uid());
  end loop;
  update public.sales set status='confirmada',stock_applied_at=now() where id=target_sale returning * into result;
  return result;
end $$;
revoke all on function public.confirm_sale(uuid) from public; grant execute on function public.confirm_sale(uuid) to authenticated;

create or replace function public.cancel_sale(target_sale uuid) returns public.sales language plpgsql security definer set search_path = public as $$
declare result public.sales; line record;
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  select * into result from public.sales where id=target_sale for update;
  if not found then raise exception 'Venta no encontrada'; end if;
  if result.status='cancelada' then return result; end if;
  if result.status='devuelta' then raise exception 'Una devolución no se cancela'; end if;
  if result.stock_applied_at is not null and result.stock_restored_at is null then
    for line in select * from public.sale_items where sale_id=target_sale loop
      update public.product_variants set stock=stock+line.quantity where id=line.variant_id;
      insert into public.stock_movements(variant_id,sale_id,quantity_delta,reason,created_by) values(line.variant_id,target_sale,line.quantity,'cancelacion',auth.uid());
    end loop;
    update public.sales set stock_restored_at=now() where id=target_sale;
  end if;
  update public.sales set status='cancelada' where id=target_sale returning * into result; return result;
end $$;
revoke all on function public.cancel_sale(uuid) from public; grant execute on function public.cancel_sale(uuid) to authenticated;

create or replace function public.create_admin_quote(payload jsonb) returns public.quotes
language plpgsql security definer set search_path=public as $$
declare result public.quotes; item jsonb; product public.products; variant public.product_variants; qty integer; unit_value numeric; discount_value numeric; subtotal_value numeric:=0; discount_total_value numeric:=0; line_value numeric;
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  if jsonb_typeof(payload->'items')<>'array' or jsonb_array_length(payload->'items')<1 then raise exception 'Agrega al menos un producto'; end if;
  insert into public.quotes(quote_number,customer_id,status,valid_until,delivery_cost,notes,terms_snapshot)
  values(public.next_document_number('quote'),(payload->>'customer_id')::uuid,'borrador',nullif(payload->>'valid_until','')::date,coalesce((payload->>'delivery_cost')::numeric,0),nullif(payload->>'notes',''),(select quote_terms from public.site_settings where id=1)) returning * into result;
  for item in select value from jsonb_array_elements(payload->'items') loop
    qty:=(item->>'quantity')::int; discount_value:=coalesce((item->>'discount')::numeric,0);
    select * into variant from public.product_variants where id=(item->>'variant_id')::uuid;
    select * into product from public.products where id=variant.product_id;
    if qty<1 or not found then raise exception 'Línea no válida'; end if;
    unit_value:=coalesce((item->>'unit_price')::numeric,public.current_product_price(product,variant));
    if unit_value<0 or discount_value<0 or discount_value>unit_value*qty then raise exception 'Importe no válido'; end if;
    line_value:=unit_value*qty-discount_value; subtotal_value:=subtotal_value+unit_value*qty; discount_total_value:=discount_total_value+discount_value;
    insert into public.quote_items(quote_id,product_id,variant_id,product_name,sku,option_snapshot,quantity,unit_price,discount,line_total)
    values(result.id,product.id,variant.id,product.name,coalesce(variant.sku,product.sku),variant.option_values,qty,unit_value,discount_value,line_value);
  end loop;
  update public.quotes set subtotal=subtotal_value,discount_total=discount_total_value,total=subtotal_value-discount_total_value+delivery_cost where id=result.id returning * into result; return result;
end $$;
revoke all on function public.create_admin_quote(jsonb) from public; grant execute on function public.create_admin_quote(jsonb) to authenticated;

create or replace function public.create_sale_from_order(target_order uuid) returns public.sales
language plpgsql security definer set search_path=public as $$
declare result public.sales; source public.orders;
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  select * into result from public.sales where source_order_id=target_order; if found then return result; end if;
  select * into source from public.orders where id=target_order for update; if not found then raise exception 'Pedido no encontrado'; end if;
  insert into public.sales(sale_number,customer_id,source,source_order_id,status,payment_method,subtotal,delivery_cost,total,terms_snapshot)
  values(public.next_document_number('sale'),source.customer_id,'pedido',source.id,'solicitud',source.payment_name,source.subtotal,source.delivery_cost,source.total,(select sale_terms from public.site_settings where id=1)) returning * into result;
  insert into public.sale_items(sale_id,product_id,variant_id,product_name,sku,option_snapshot,quantity,unit_price,discount,line_total)
  select result.id,product_id,variant_id,product_name,sku,option_snapshot,quantity,unit_price,0,line_total from public.order_items where order_id=source.id;
  update public.orders set status='confirmado' where id=source.id; return result;
end $$;
revoke all on function public.create_sale_from_order(uuid) from public; grant execute on function public.create_sale_from_order(uuid) to authenticated;

create or replace function public.convert_quote_to_sale(target_quote uuid) returns public.sales
language plpgsql security definer set search_path=public as $$
declare result public.sales; source public.quotes;
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  select * into result from public.sales where source_quote_id=target_quote; if found then return result; end if;
  select * into source from public.quotes where id=target_quote for update; if not found then raise exception 'Cotización no encontrada'; end if;
  insert into public.sales(sale_number,customer_id,source,source_quote_id,status,subtotal,discount_total,delivery_cost,total,terms_snapshot)
  values(public.next_document_number('sale'),source.customer_id,'cotizacion',source.id,'solicitud',source.subtotal,source.discount_total,source.delivery_cost,source.total,(select sale_terms from public.site_settings where id=1)) returning * into result;
  insert into public.sale_items(sale_id,product_id,variant_id,product_name,sku,option_snapshot,quantity,unit_price,discount,line_total)
  select result.id,product_id,variant_id,product_name,sku,option_snapshot,quantity,unit_price,discount,line_total from public.quote_items where quote_id=source.id;
  update public.quotes set status='convertida',converted_sale_id=result.id where id=source.id; return result;
end $$;
revoke all on function public.convert_quote_to_sale(uuid) from public; grant execute on function public.convert_quote_to_sale(uuid) to authenticated;

create or replace function public.birthday_in_year(birth date, target_year integer) returns date language sql immutable set search_path=pg_catalog as $$
  select case when extract(month from birth)=2 and extract(day from birth)=29 and not ((target_year%4=0 and target_year%100<>0) or target_year%400=0)
    then make_date(target_year,2,28) else make_date(target_year,extract(month from birth)::int,extract(day from birth)::int) end
$$;
comment on function public.birthday_in_year(date,integer) is 'El 29 de febrero se celebra el 28 de febrero en años no bisiestos.';

create or replace function public.search_products(search_term text,result_limit integer default 12)
returns table(id uuid,name text,slug text,base_price numeric,promo_price numeric,promo_start timestamptz,promo_end timestamptz,team_name text,brand_name text,image_url text,score real)
language sql stable security invoker set search_path=public,extensions as $$
 select p.id,p.name,p.slug,p.base_price,p.promo_price,p.promo_start,p.promo_end,null::text,b.name,
   (select pi.url from public.product_images pi where pi.product_id=p.id order by pi.is_primary desc,pi.sort_order limit 1),
   greatest(similarity(unaccent(lower(p.name)),unaccent(lower(search_term))),similarity(unaccent(lower(coalesce(b.name,''))),unaccent(lower(search_term))))::real
 from public.products p left join public.brands b on b.id=p.brand_id
 where p.status='published' and unaccent(lower(concat_ws(' ',p.name,p.description,p.model,p.sku,b.name))) like '%'||unaccent(lower(search_term))||'%'
 order by 11 desc,p.name limit least(greatest(result_limit,1),50)
$$;
grant execute on function public.search_products(text,integer) to anon,authenticated;

create or replace function public.catalog_entity_dependencies(entity_type text,entity_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare related integer:=0; children integer:=0; entity_exists boolean:=false;
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  if entity_type='categories' then
    select exists(select 1 from public.categories where id=entity_id) into entity_exists;
    select count(*) into related from public.product_categories where category_id=entity_id;
    select count(*) into children from public.categories where parent_id=entity_id;
  elsif entity_type='brands' then
    select exists(select 1 from public.brands where id=entity_id) into entity_exists;
    select count(*) into related from public.products where brand_id=entity_id;
  else raise exception 'Tipo no permitido'; end if;
  return jsonb_build_object('exists',entity_exists,'related_products',related,'child_categories',children,'can_delete',entity_exists and related=0 and children=0);
end $$;
create or replace function public.delete_catalog_entity_safely(entity_type text,entity_id uuid)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  if entity_type='categories' then
    if exists(select 1 from public.product_categories where category_id=entity_id) or exists(select 1 from public.categories where parent_id=entity_id) then raise exception 'La categoría tiene dependencias'; end if;
    delete from public.categories where id=entity_id;
  elsif entity_type='brands' then
    if exists(select 1 from public.products where brand_id=entity_id) then raise exception 'La marca tiene productos'; end if;
    delete from public.brands where id=entity_id;
  else raise exception 'Tipo no permitido'; end if;
  return found;
end $$;
revoke all on function public.catalog_entity_dependencies(text,uuid) from public; grant execute on function public.catalog_entity_dependencies(text,uuid) to authenticated;
revoke all on function public.delete_catalog_entity_safely(text,uuid) from public; grant execute on function public.delete_catalog_entity_safely(text,uuid) to authenticated;

create or replace function public.save_homepage_banners(new_enabled boolean,new_interval numeric,new_banners jsonb)
returns setof public.homepage_banners language plpgsql security definer set search_path=public as $$
declare item jsonb; position integer:=0; banner_id uuid; keep_ids uuid[]:='{}';
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  if new_interval not between .5 and 60 then raise exception 'Intervalo no válido'; end if;
  if jsonb_typeof(new_banners)<>'array' or jsonb_array_length(new_banners)>5 then raise exception 'Máximo cinco banners'; end if;
  perform pg_advisory_xact_lock(714582);
  for item in select value from jsonb_array_elements(new_banners) loop
    position:=position+1; banner_id:=coalesce(nullif(item->>'id','')::uuid,gen_random_uuid()); keep_ids:=array_append(keep_ids,banner_id);
    if nullif(btrim(item->>'desktop_image_url'),'') is null or nullif(btrim(item->>'alt_text'),'') is null then raise exception 'Imagen y descripción obligatorias'; end if;
    insert into public.homepage_banners(id,desktop_image_url,mobile_image_url,alt_text,link_url,active,sort_order)
    values(banner_id,item->>'desktop_image_url',nullif(item->>'mobile_image_url',''),item->>'alt_text',nullif(item->>'link_url',''),coalesce((item->>'active')::boolean,true),position)
    on conflict(id) do update set desktop_image_url=excluded.desktop_image_url,mobile_image_url=excluded.mobile_image_url,alt_text=excluded.alt_text,link_url=excluded.link_url,active=excluded.active,sort_order=excluded.sort_order;
  end loop;
  delete from public.homepage_banners where not(id=any(keep_ids));
  update public.site_settings set banner_enabled=coalesce(new_enabled,false),banner_interval_seconds=new_interval where id=1;
  return query select * from public.homepage_banners order by sort_order;
end $$;
revoke all on function public.save_homepage_banners(boolean,numeric,jsonb) from public; grant execute on function public.save_homepage_banners(boolean,numeric,jsonb) to authenticated;

create or replace function public.validate_cart(cart_items jsonb)
returns table(variant_id uuid,product_id uuid,product_name text,product_slug text,product_status text,color_name text,size_name text,stock integer,current_price numeric,requested_quantity integer,valid boolean,reason text)
language sql stable security invoker set search_path=public as $$
 select v.id,p.id,p.name,p.slug,p.status,c.name,s.name,v.stock,public.current_product_price(p,v),greatest(coalesce((item->>'quantity')::int,0),0),
   p.status='published' and v.active and not p.force_sold_out and v.stock>=greatest(coalesce((item->>'quantity')::int,0),0) and greatest(coalesce((item->>'quantity')::int,0),0)>0,
   case when p.status<>'published' then 'El producto ya no está publicado.' when not v.active or p.force_sold_out then 'Esta variante está agotada.' when v.stock<greatest(coalesce((item->>'quantity')::int,0),0) then 'Stock insuficiente.' else null end
 from jsonb_array_elements(cart_items) item join public.product_variants v on v.id=(item->>'variant_id')::uuid join public.products p on p.id=v.product_id
 left join public.product_colors c on c.id=v.color_id left join public.product_sizes s on s.id=v.size_id
$$;
grant execute on function public.validate_cart(jsonb) to anon,authenticated;

-- RLS: catálogo público; CRM y documentos totalmente privados.
do $$ declare t text; begin foreach t in array array['admins','site_settings','categories','brands','products','product_categories','product_colors','product_sizes','product_variants','product_images','homepage_banners','payment_methods','delivery_methods','customers','customer_consents','birthday_contacts','document_sequences','orders','order_items','quotes','quote_items','sales','sale_items','stock_movements'] loop execute format('alter table public.%I enable row level security',t); end loop; end $$;
create policy admins_self on public.admins for select to authenticated using(user_id=auth.uid());
create policy settings_public_read on public.site_settings for select to anon,authenticated using(true);
create policy settings_admin_all on public.site_settings for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy categories_public_read on public.categories for select to anon,authenticated using(active or public.is_admin());
create policy categories_admin_all on public.categories for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy brands_public_read on public.brands for select to anon,authenticated using(active or public.is_admin());
create policy brands_admin_all on public.brands for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy products_public_read on public.products for select to anon,authenticated using(status='published' or public.is_admin());
create policy products_admin_all on public.products for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy product_categories_public_read on public.product_categories for select to anon,authenticated using(exists(select 1 from public.products p where p.id=product_id and (p.status='published' or public.is_admin())));
create policy product_categories_admin_all on public.product_categories for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy colors_public_read on public.product_colors for select to anon,authenticated using(exists(select 1 from public.products p where p.id=product_id and (p.status='published' or public.is_admin())));
create policy colors_admin_all on public.product_colors for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy sizes_public_read on public.product_sizes for select to anon,authenticated using(exists(select 1 from public.products p where p.id=product_id and (p.status='published' or public.is_admin())));
create policy sizes_admin_all on public.product_sizes for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy variants_public_read on public.product_variants for select to anon,authenticated using(exists(select 1 from public.products p where p.id=product_id and (p.status='published' or public.is_admin())));
create policy variants_admin_all on public.product_variants for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy images_public_read on public.product_images for select to anon,authenticated using(exists(select 1 from public.products p where p.id=product_id and (p.status='published' or public.is_admin())));
create policy images_admin_all on public.product_images for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy banners_public_read on public.homepage_banners for select to anon,authenticated using(active or public.is_admin());
create policy banners_admin_all on public.homepage_banners for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy payments_public_read on public.payment_methods for select to anon,authenticated using(active or public.is_admin());
create policy payments_admin_all on public.payment_methods for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy deliveries_public_read on public.delivery_methods for select to anon,authenticated using(active or public.is_admin());
create policy deliveries_admin_all on public.delivery_methods for all to authenticated using(public.is_admin()) with check(public.is_admin());
do $$ declare t text; begin foreach t in array array['customers','customer_consents','birthday_contacts','document_sequences','orders','order_items','quotes','quote_items','sales','sale_items','stock_movements'] loop execute format('create policy %I on public.%I for all to authenticated using(public.is_admin()) with check(public.is_admin())',t || '_admin_all',t); end loop; end $$;

grant usage on schema public to anon,authenticated;
grant select on public.site_settings,public.categories,public.brands,public.products,public.product_categories,public.product_colors,public.product_sizes,public.product_variants,public.product_images,public.homepage_banners,public.payment_methods,public.delivery_methods to anon,authenticated;
grant select on public.admins to authenticated;
grant select,insert,update,delete on all tables in schema public to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
 ('product-images','product-images',true,10485760,array['image/jpeg','image/png','image/webp','image/avif']),
 ('brand-assets','brand-assets',true,5242880,array['image/jpeg','image/png','image/webp','image/svg+xml']),
 ('category-images','category-images',true,5242880,array['image/jpeg','image/png','image/webp','image/avif']),
 ('site-assets','site-assets',true,5242880,array['image/jpeg','image/png','image/webp','image/svg+xml']),
 ('banner-images','banner-images',true,1048576,array['image/jpeg','image/png','image/webp','image/avif']),
 ('private-documents','private-documents',false,10485760,array['application/pdf'])
on conflict(id) do update set public=excluded.public,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy public_read_assets on storage.objects for select to anon,authenticated using(bucket_id in ('product-images','brand-assets','category-images','site-assets','banner-images'));
create policy admin_insert_assets on storage.objects for insert to authenticated with check(bucket_id in ('product-images','brand-assets','category-images','site-assets','banner-images','private-documents') and public.is_admin());
create policy admin_update_assets on storage.objects for update to authenticated using(public.is_admin()) with check(public.is_admin());
create policy admin_delete_assets on storage.objects for delete to authenticated using(public.is_admin());
create policy admin_read_private_documents on storage.objects for select to authenticated using(bucket_id='private-documents' and public.is_admin());

insert into public.site_settings(id) values(1);
-- Catálogo, métodos, CRM y documentos permanecen vacíos deliberadamente.
