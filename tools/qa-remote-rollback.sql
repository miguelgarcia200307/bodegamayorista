-- Pruebas de negocio en el proyecto remoto SIN dejar datos: todo ocurre dentro de un
-- bloque que termina lanzando una excepción con los resultados, por lo que Postgres
-- revierte absolutamente todo (filas, consecutivos y usuarios de prueba).
do $qa$
declare
  admin_id uuid := gen_random_uuid(); intruder_id uuid := gen_random_uuid();
  product_id uuid; color_id uuid; size_id uuid; variant_id uuid;
  delivery_id uuid; payment_id uuid; o record; order_ref uuid; sale_a public.sales; sale_b public.sales;
  results text[] := '{}'; n integer; ok boolean; stock_now integer;
begin
  -- Datos temporales (se revierten al final).
  insert into auth.users(id, instance_id, aud, role, email) values
    (admin_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'qa-admin@prueba.invalid'),
    (intruder_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'qa-intruso@prueba.invalid');
  insert into public.admins(user_id) values (admin_id);
  update public.site_settings set whatsapp = '570000000000' where id = 1;
  insert into public.delivery_methods(name) values ('QA entrega') returning id into delivery_id;
  insert into public.payment_methods(name) values ('QA pago') returning id into payment_id;
  insert into public.products(name, slug, base_price, status) values ('QA nevera', 'qa-nevera', 1500000, 'published') returning id into product_id;
  insert into public.product_colors(product_id, name) values (product_id, 'Única') returning id into color_id;
  insert into public.product_sizes(product_id, name) values (product_id, 'Única') returning id into size_id;
  insert into public.product_variants(product_id, color_id, size_id, stock) values (product_id, color_id, size_id, 3) returning id into variant_id;

  -- 1. Visitante: precio manipulado ignorado, total de servidor.
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  select * into o from public.create_storefront_order(jsonb_build_object('name','QA Cliente','phone','300 123 4567','delivery_method_id',delivery_id,'payment_method_id',payment_id,
    'items', jsonb_build_array(jsonb_build_object('variant_id',variant_id,'quantity',2,'unit_price',1)),'total',1), gen_random_uuid());
  results := results || format('precio manipulado ignorado: %s', o.total = 3000000);
  -- 2. Mismo teléfono en otro formato.
  perform public.create_storefront_order(jsonb_build_object('name','Otro Nombre','phone','+57 300 123 4567','delivery_method_id',delivery_id,'payment_method_id',payment_id,
    'items', jsonb_build_array(jsonb_build_object('variant_id',variant_id,'quantity',1))), gen_random_uuid());
  -- 3. Visitante no lee clientes.
  begin perform count(*) from public.customers; ok := false; exception when insufficient_privilege then ok := true; end;
  results := results || format('anónimo sin lectura de clientes: %s', ok);
  reset role;
  select count(*) into n from public.customers; results := results || format('un solo cliente para 300…/+57 300…: %s', n = 1);
  select count(*) into n from public.orders; results := results || format('dos pedidos: %s', n = 2);
  select v.stock into stock_now from public.product_variants v where v.id = variant_id; results := results || format('pedido no descuenta stock: %s', stock_now = 3);

  -- 4. Autenticado que no es admin.
  perform set_config('request.jwt.claims', json_build_object('sub', intruder_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.customers; results := results || format('no-admin ve 0 clientes: %s', n = 0);
  begin perform public.create_manual_sale('{}'::jsonb); ok := false; exception when others then ok := sqlerrm = 'Sin permiso'; end;
  results := results || format('no-admin no crea ventas: %s', ok);
  reset role;

  -- 5. Administrador: confirmar una vez, segunda venta sin stock, cancelación única.
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select id into order_ref from public.orders order by order_number limit 1;
  sale_a := public.create_sale_from_order(order_ref);
  perform public.confirm_sale(sale_a.id); perform public.confirm_sale(sale_a.id);
  select v.stock into stock_now from public.product_variants v where v.id = variant_id; results := results || format('confirmar dos veces descuenta una: %s', stock_now = 1);
  sale_b := public.create_manual_sale(jsonb_build_object('customer_id', sale_a.customer_id, 'source', 'presencial', 'items', jsonb_build_array(jsonb_build_object('variant_id', variant_id, 'quantity', 2))));
  begin perform public.confirm_sale(sale_b.id); ok := false; exception when others then ok := sqlerrm like 'Stock insuficiente%'; end;
  select v.stock into stock_now from public.product_variants v where v.id = variant_id; results := results || format('sin stock negativo: %s', ok and stock_now = 1);
  begin update public.sales set status = 'confirmada' where id = sale_b.id; ok := false; exception when insufficient_privilege then ok := true; end;
  results := results || format('estado de venta no editable directo: %s', ok);
  perform public.cancel_sale(sale_a.id); perform public.cancel_sale(sale_a.id);
  select v.stock into stock_now from public.product_variants v where v.id = variant_id; results := results || format('cancelar restaura una vez: %s', stock_now = 3);
  reset role;

  results := results || format('29-feb en año no bisiesto: %s', public.birthday_in_year('2000-02-29', 2027) = date '2027-02-28');
  results := results || format('edad cruce de año: %s', public.customer_age('1990-01-02', '2026-12-30') = 36 and public.next_birthday('1990-01-02', '2026-12-30') = date '2027-01-02');
  raise exception 'QA_RESULTADOS|%', array_to_string(results, '|');
end $qa$;
