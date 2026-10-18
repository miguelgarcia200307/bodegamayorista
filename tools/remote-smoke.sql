-- Prueba de humo del checkout en el proyecto remoto SIN dejar rastro: todo ocurre en
-- una transacción que termina con un error intencional (rollback total). El mensaje de
-- ese error contiene los resultados. Ejecutar con tools/remote-smoke.mjs.
begin;
select set_config('bm.result', '', true);
do $$
declare v uuid; d uuid; pay uuid; r record; tv text; pv text;
  base jsonb;
  procedure_note text := '';
begin
  select pv2.id into v from public.product_variants pv2 join public.products p on p.id = pv2.product_id
    where p.status = 'published' and pv2.active and pv2.stock > 0 and not p.force_sold_out order by pv2.id limit 1;
  select id into d from public.delivery_methods where active and not requires_address and not requires_city order by sort_order limit 1;
  select id into pay from public.payment_methods where active order by sort_order limit 1;
  select terms_version, data_policy_version into tv, pv from public.site_settings where id = 1;
  base := jsonb_build_object('name', 'Prueba Humo', 'phone', '3009990011', 'delivery_method_id', d, 'payment_method_id', pay, 'items', jsonb_build_array(jsonb_build_object('variant_id', v, 'quantity', 1)));
  -- 1) Exigencia apagada: el sitio publicado (sin aceptación) sigue funcionando.
  begin select * into r from public.create_storefront_order(base, gen_random_uuid()); procedure_note := procedure_note || format('sin_exigencia=OK(%s) ', r.order_number);
  exception when others then procedure_note := procedure_note || format('sin_exigencia=ERROR(%s) ', sqlerrm); end;
  -- 2) Exigencia encendida (solo en esta transacción).
  update public.site_settings set legal_acceptance_required = true where id = 1;
  begin perform public.create_storefront_order(base || jsonb_build_object('phone', '3009990012'), gen_random_uuid()); procedure_note := procedure_note || 'sin_aceptar=ACEPTADO(MAL) ';
  exception when others then procedure_note := procedure_note || format('sin_aceptar=RECHAZADO(%s) ', sqlstate); end;
  begin select * into r from public.create_storefront_order(base || jsonb_build_object('phone', '3009990013', 'legal', jsonb_build_object('accepted', true, 'terms_version', tv, 'data_policy_version', pv)), gen_random_uuid());
    procedure_note := procedure_note || format('aceptando=OK(%s, términos %s) ', r.order_number,
      (select o.terms_version from public.orders o where o.order_number = r.order_number));
  exception when others then procedure_note := procedure_note || format('aceptando=ERROR(%s) ', sqlerrm); end;
  perform set_config('bm.result', procedure_note, true);
end $$;
do $$ begin raise exception 'RESULTADO (revertido): %', current_setting('bm.result', true); end $$;
