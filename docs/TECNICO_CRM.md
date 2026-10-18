# CRM, recomendaciones, ofertas y cupones — documentación técnica

Versiones de reglas visibles en el panel: `metricas-2026.10-v1`, `intencion-v1`, `evidencia-v1`, `segmentos-v1`, `reco-2026.10-v2`, `cupones-v1`, `tareas-v1`.

## 1. Mapa de módulos

| Pieza | Archivo |
|---|---|
| Contrato de métricas (dinero en centavos, Bogotá, reloj inyectado) | `js/lib/metrics.js` |
| Análisis de un cliente (recorridos, disponibilidad por línea, hallazgos) | `js/lib/customer-insights.js` |
| Segmentación única, interés, etapa, acciones | `js/lib/customer-diagnosis.js` |
| Núcleo común del recomendador (elegibilidad, relaciones, precio elegible) | `js/lib/reco-core.js` |
| Recomendador privado (CRM) | `js/lib/recommender.js` |
| Recomendador público (ficha, carrito, inicio) | `js/lib/public-reco.js` |
| Autorizaciones y colector | `js/lib/privacy.js`, `js/components/privacy-banner.js` |
| Cupón en carrito/checkout | `js/lib/coupon-client.js`, `js/pages/cart.js`, `js/pages/checkout.js` |
| Panel: análisis con URL, tareas, cupones y relaciones | `js/pages/admin-analysis.js`, `admin-tasks.js`, `admin-coupons.js` |
| Paginación explícita | `js/lib/paging.js` |
| Migraciones | `supabase/migrations/20261014000{1,2,3}_*.sql` |

## 2. Contrato de métricas

- **Compra**: venta con `stock_applied_at`/`confirmed_at` (o estado confirmada/pagada/entregada/devuelta) y no cancelada. Una devolución total deja la operación con neto 0 y la devolución visible.
- **Neto conservado**: `line_total` (ya incluye descuentos de línea y de cupón) − devoluciones valoradas al neto de cada línea (`round(neto × devuelto / cantidad)` acumulado, sin sumar errores de redondeo).
- **Cohorte vs. movimientos**: los KPI del periodo usan la fecha de compra; "Devoluciones del periodo" usa la fecha de la devolución.
- **Operaciones** = compras de la cohorte; **ticket** = neto / compras con neto positivo (denominador explícito, `null` si no hay).
- **Ocasiones** = días distintos (Bogotá) con compra positiva; recencia e intervalos se calculan entre ocasiones; hábito solo con ≥ 2 intervalos (mediana, mínimo, máximo y ventana P25–P75).
- **Ranking**: mismo neto y periodo en SQL (`crm_customer_ranking`); devuelve solo posición, total y participación.
- **Conversión**: borradores nunca enviados no cuentan. Denominador = cotizaciones enviadas con resultado. Tres numeradores: aceptada, pasó a solicitud de venta, venta confirmada vigente. Sin porcentaje si el denominador es < 3.
- **Compras por mes**: siempre 12 meses anteriores a la fecha de evaluación con el historial completo.
- **Cobertura**: cada fuente se consulta por páginas; un error o un tope de lectura marca el análisis como parcial y baja el nivel de evidencia. `null` ≠ 0.

## 3. Recorridos e intención (`intencion-v1`)

Cada pedido/cotización → venta es un solo recorrido. Pesos: pedido pendiente/contactado/confirmado 1; cotización aceptada 1; enviada 0,5; vencida 0,2; borrador nunca enviado 0 (documento interno); rechazada, cancelada o abandonada 0 (motivo no registrado). Venta en solicitud 1.

## 4. Recomendador privado (`reco-2026.10-v2`)

1. Universo: productos publicados; elegible si una variante activa cubre la cantidad.
2. Restricciones: `excluir`; la variante pedida debe tener stock (no se sustituye en silencio); recompra solo con reposición, reventa con historial o pedido explícito.
3. Contribuciones (puntos, tope 100): intención explícita 40, navegación autorizada 25, interés en categoría 18, complemento 26, compatible 30, reposición 35, marca 10, patrón entre clientes 10 (soporte ≥ 5, ≥ 2 coincidencias), promoción 5; penalizaciones: misma categoría reciente −15 (no en reventa), precio fuera de rango −12.
4. Diversificación por subcategoría/marca y orden final por afinidad. Motivos = dos mayores contribuciones finales.
5. Sin historial: lista general rotulada (tendencias agregadas o destacados).

La afinidad **no es una probabilidad**. Para estimar probabilidad hace falta definir el resultado (p. ej. compra neta del producto en 30 días tras una exposición), acumular exposiciones (`recommendation_impression`), separar evaluación por tiempo y calibrar. Esa fase no está implementada.

## 5. Relaciones de productos

`product_relationships(source_type, source_id, target_type, target_id, kind, strength, reposition_days, note, active)`. `compatible_con` solo producto↔producto (restricción SQL) y la interfaz pide la evidencia en la nota. Las reglas de categoría aplican a sus subcategorías. Lectura pública (son reglas de catálogo, sin datos personales).

## 6. Privacidad, eventos e identidad

- **Desactivado por defecto**: `site_settings.tracking_enabled = false`. Para activarlo el panel exige responsable, texto y versión de analítica.
- **Finalidades**: gestión del pedido (siempre, sin perfil); analítica (crea visitante seudónimo); personalización (uso en recomendaciones y, con verificación, en la ficha); promocional (`customer_consents.marketing_birthday`, sin cambios).
- **Visitante**: id + secreto aleatorio en el navegador; en servidor solo el hash. Sin autorización no hay visitante ni eventos.
- **Colector `track_events`**: lotes ≤ 25 y ≤ 20 KB; tipos y propiedades en lista blanca; `event_id` único (reintentos idempotentes); hora del servidor como fuente de verdad (se descartan fechas absurdas); producto/variante válidos y publicados; la sesión pertenece a un solo visitante; ≤ 600 eventos/h por visitante; ≤ 5 visitas cualificadas por visitante/producto/día; búsquedas saneadas (sin correos ni números largos). Eventos de servidor (`order_created`, `sale_*`) **no** se aceptan del navegador: salen de las tablas de pedidos y ventas.
- **Visita cualificada**: tiempo con pestaña visible y ventana activa ≥ 8 s (configurable en `privacy.js`). **Impresión**: ≥ 50 % visible durante 1 s.
- **Cola local**: `sessionStorage`, máx. 50 eventos, 24 h, 3 reintentos; se vacía al retirar la autorización.
- **Retiro**: `set_visitor_consent` borra eventos crudos, termina vínculos y revoca el visitante; un borrador local antiguo no lo reactiva.
- **Identidad**: `declarado` (teléfono en un pedido; solo la sesión de ese pedido), `verificado` (código enviado desde el WhatsApp del cliente y confirmado por el vendedor; vincula desde la solicitud hacia adelante), `desvinculado`. Verificar a otra persona en el mismo dispositivo termina el vínculo anterior. Nunca se fusiona por IP, huella o nombre. La respuesta pública de verificación es igual exista o no un cliente.
- **Retención propuesta** (configurable, no es un plazo legal): crudos 90 días, agregados minimizados 365 días. `purge_behavior_data()` agrega y borra; ejecútala con un programador del proyecto (p. ej. `pg_cron`: `select cron.schedule('purga-navegacion', '15 3 * * *', 'select public.purge_behavior_data()');`) o desde Configuración.
- **Titular**: `export_customer_data` (JSON) y `suppress_customer_signals` (borra navegación, conserva documentos comerciales).

## 7. Motor económico del cupón (`cupones-v1`)

- Precio elegible por línea = regla vigente (variante → promoción → tramo por unidades del mismo producto), idéntica a `create_storefront_order` (función común `priced_cart_lines`).
- Acumulación: `sobre_precio_vigente` (por defecto) o `solo_precio_regular` (excluye líneas con promoción o tramo). Un código por pedido. Envío nunca se descuenta.
- Descuento: porcentaje (0 < v ≤ 100) redondeado a peso entero, o valor fijo; tope opcional; nunca supera la base elegible; total nunca negativo. Reparto por línea con resto mayor (suma exacta). Ejemplo verificado: 100.000 + 50.000, 10 % solo al primero, envío 8.000 → descuento 10.000, total 148.000.
- Estados: `vacio, valido, no_valido (inexistente o inactivo, indistinguibles), no_iniciado, vencido, sin_usos, limite_cliente, minimo_no_alcanzado, sin_productos_elegibles, requiere_verificacion, demasiados_intentos (15 fallos/10 min por origen), carrito_no_valido`. El navegador muestra `servicio_no_disponible` si la llamada falla.
- Ciclo de uso: validar no consume; crear pedido **reserva** (caduca a las `reservation_hours`); confirmar venta **consume** una vez bajo bloqueo (venta → cupón → variantes por id); reserva vencida o liberada exige revisión explícita (`BM002`, `accept_coupon_review`); cancelar libera si `release_on_cancel`; devolución total libera solo si `release_on_full_return`; pedido cancelado/abandonado libera y reabrirlo no la reactiva.
- Checkout: el navegador envía solo variantes, cantidades, código y el descuento que vio (`expected_discount`). Si el servidor calcula otro (`BM011`) o el código dejó de aplicar (`BM010`), no se crea el pedido y el cliente decide.
- Snapshots: `orders.coupon_snapshot`, `order_items.discount`, `sales.coupon_snapshot`, `coupon_uses.snapshot` (incluye reparto). Las devoluciones usan el neto pactado de cada línea.
- Ofertas privadas: `create_customer_offer` crea un cupón personal (por defecto **portador de un solo uso, transferible**; "cliente verificado" solo si hay vínculo verificado vigente) y nunca cambia `promo_price`. `create_quote_from_offer` genera la cotización con los mismos importes.
- Costos y margen: no se agregaron. El panel muestra "Margen no disponible".

## 8. Tareas (`tareas-v1`)

`generate_customer_tasks()` aplica reglas explícitas; `dedupe_key` es único para siempre (las recurrentes incluyen el periodo), así una tarea completada, pospuesta o descartada no se regenera. Reglas: pedido pendiente, cotización aceptada o enviada hace ≥ 2 días, borrador interno, devolución reciente, postventa de primera compra, oferta enviada sin respuesta (máx. un seguimiento) y, solo con autorización promocional y sin saturación (`contact_cooldown_days`, devolución abierta), reposición, reactivación, cumpleaños y carrito verificado sin pedido tras 48 h. Las tareas cuyo hecho se resolvió se cierran solas. Contactos: `preparado` ≠ `declarado_enviado` ≠ `respuesta`.

No implementado: aviso de "producto disponible de nuevo" (requiere una solicitud explícita del cliente que hoy no existe).

## 9. Permisos

| Rol (`admins.role`) | Alcance en servidor |
|---|---|
| `propietario` | Todo (`is_admin()` conserva su significado; los administradores existentes quedan como propietarios) |
| `vendedor` | Lectura de CRM y documentos; análisis, tareas, contactos y ofertas personales de un uso. No confirma ventas, no crea cupones públicos, no ve el plan |
| `catalogo` | Escritura directa en tablas de catálogo y relaciones. Las funciones de catálogo que exigen `is_admin()` (variantes, tramos) siguen siendo del propietario |

El menú del panel se adapta al rol solo por comodidad; los permisos reales están en RLS y funciones. Toda función `SECURITY DEFINER` fija `search_path` y valida rol; ninguna queda ejecutable por `PUBLIC`.

## 10. Contratos de API

| Contrato | Quién | Devuelve |
|---|---|---|
| Historial paginado + `coverage` | staff | documentos del cliente |
| `crm_customer_ranking(cliente, desde)` | staff | posición, total, participación |
| `crm_peer_patterns(cliente, ventana, soporte)` | staff | pares de categorías con soporte ≥ 5 |
| `crm_customer_signals(cliente)` | staff | navegación agregada por producto con nivel de identidad |
| `public_trending_products(días, límite)` | público | ids con ≥ 3 compradores |
| `validate_cart_coupon(ítems, código, visitante, entrega)` | público | estado, líneas, descuento, total |
| `track_events(id, secreto, eventos)` | público, solo escritura | aceptados/rechazados |
| `create_customer_offer`, `update_customer_offer`, `generate_customer_tasks`, `set_task_status`, `record_contact_attempt` | staff | — |

Caché: el análisis se recalcula en el navegador con los datos consultados; "Actualizar datos" vuelve a consultar todo (catálogo incluido). No hay caché persistente ni snapshots de métricas en servidor todavía.

## 11. Comercialización y arquitectura

Decisión: **una instancia (proyecto Supabase + despliegue) por comercio**. El esquema es de una tienda (`site_settings.id = 1`, sin `tenant_id`) y no se mezclaron comercios. Para vender el acceso: aprovisionar un proyecto por cliente con `tools/apply-migrations.ps1`, configurar marca desde el panel y operar el plan desde el operador.

`store_plan` (una fila) solo la escribe `service_role`; el comerciante la lee con `plan_status()`. **Cobros automáticos desactivados**: no hay proveedor de pagos elegido. Para activarlos falta: proveedor, webhook verificado e idempotente que actualice `store_plan`, y conciliación. `enforcement_enabled = false`: el plan no bloquea la tienda.

## 12. Rendimiento

Antes, abrir el análisis descargaba todas las ventas de la tienda. Ahora descarga solo el historial del cliente (por páginas) y agregados. Medición disponible: prueba de interfaz con Supabase simulado (Chrome local), donde el análisis se dibuja en < 1 s; **no** representa la red real. Objetivo orientativo pendiente de medir en un entorno definido: < 2 s con caché, < 4 s sin caché.

## 13. Aceptación legal, avisos y costos (202610150001)

- `site_settings`: `terms_text/terms_version`, `shipping_policy_text`, `returns_policy_text`, `restock_consent_text`, `legal_acceptance_required` (apagado hasta publicar el sitio nuevo).
- Checkout: casilla obligatoria (no se restaura de borradores); envía `legal: { accepted, terms_version, data_policy_version }`. Servidor: `BM030` sin aceptación (si está exigida), `BM031` versión desactualizada; guarda en `orders.terms_version/data_policy_version/legal_accepted_at` y en `customer_consents` (`terms_conditions`).
- `request_restock_notice`: solicitud con autorización expresa, respuesta idéntica exista o no el cliente, límites por teléfono y global. Tarea `disponible_de_nuevo` (`tareas-v2`) cuando hay stock; completarla marca el aviso como enviado.
- `product_costs` (solo propietario, RLS). `preview_offer` devuelve margen solo al propietario y solo si todas las líneas tienen costo.
- Textos legales: plantillas en `legal/`, publicación con `tools/apply-legal-texts.mjs` (ver `docs/LEGAL_LEEME.md`).
- Supabase JS fijado en 2.117.2 (hallazgo N3).

## 14. Capacidades desactivadas o pendientes

- Captura de navegación (hasta configurarla). 
- Prueba 21 con concurrencia real: ejecutada en producción con transacciones revertidas (`tools/remote-concurrency.mjs`): la segunda transacción quedó bloqueada mientras la primera tenía la reserva. El resultado tras un COMMIT se prueba en PGlite (caso 21).
- Cobros de planes (sin proveedor de pagos), probabilidad calibrada (requiere resultados reales acumulados), snapshots de métricas en servidor y modalidad de cupón de envío.
