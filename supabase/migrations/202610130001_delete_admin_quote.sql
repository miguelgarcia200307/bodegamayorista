-- Eliminar cotizaciones desde el panel. Solo se permite si la cotización nunca se
-- convirtió en venta: así no se pierde el rastro de ventas ni de inventario.
create or replace function public.delete_admin_quote(target_quote uuid) returns void
language plpgsql security definer set search_path = public as $$
declare result public.quotes;
begin
  if not public.is_admin() then raise exception 'Sin permiso'; end if;
  select * into result from public.quotes where id = target_quote for update;
  if not found then raise exception 'Cotización no encontrada'; end if;
  if result.status = 'convertida' or result.converted_sale_id is not null
     or exists (select 1 from public.sales where source_quote_id = target_quote) then
    raise exception 'La cotización % ya se convirtió en venta y no se puede eliminar', result.quote_number;
  end if;
  delete from public.quote_items where quote_id = target_quote;
  delete from public.quotes where id = target_quote;
end $$;

revoke execute on function public.delete_admin_quote(uuid) from public, anon, authenticated;
grant execute on function public.delete_admin_quote(uuid) to authenticated;
