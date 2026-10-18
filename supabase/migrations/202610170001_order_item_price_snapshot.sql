-- Foto del precio de cada línea de pedido: precio de lista y regla aplicada (promoción o
-- precio por volumen) en el momento de crearla. unit_price ya trae la regla aplicada; sin
-- esta foto, cuando la promoción termina ya no se puede explicar por qué el cliente pagó
-- menos que el precio de lista. Aditivo: no cambia importes ni funciones existentes.
alter table public.order_items add column if not exists price_snapshot jsonb;

create or replace function public.order_item_price_snapshot() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
declare p public.products; v public.product_variants; list_value numeric; regular numeric; tier_min integer; reason text;
begin
  if new.price_snapshot is not null then return new; end if;
  select * into v from public.product_variants where id = new.variant_id;
  select * into p from public.products where id = coalesce(new.product_id, v.product_id);
  if p.id is null then return new; end if;
  list_value := coalesce(v.price, p.base_price);
  regular := public.current_product_price(p, v);
  if new.unit_price < list_value then
    if new.unit_price < regular then
      -- El tramo se identifica por su precio (las líneas del mismo producto se insertan una a una).
      select t.min_quantity into tier_min from public.product_price_tiers t
      where t.product_id = p.id and abs(least(regular, t.unit_price) - new.unit_price) < 0.5 order by t.min_quantity desc limit 1;
      reason := case when tier_min is null then 'precio_especial' when regular < list_value then 'promocion_tramo' else 'tramo' end;
    elsif abs(new.unit_price - regular) < 0.5 then reason := 'promocion';
    else reason := 'precio_especial';
    end if;
  end if;
  new.price_snapshot := jsonb_build_object('list_price', list_value, 'regular_price', regular, 'reason', reason, 'tier_min_quantity', tier_min,
    'promo_price', case when v.price is null and regular < p.base_price then regular end, 'captured_at', now(), 'version', 'precio-v1');
  return new;
end $$;

drop trigger if exists order_items_price_snapshot on public.order_items;
create trigger order_items_price_snapshot before insert on public.order_items for each row execute function public.order_item_price_snapshot();
revoke execute on function public.order_item_price_snapshot() from public, anon, authenticated;
