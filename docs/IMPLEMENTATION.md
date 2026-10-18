# Bodega Mayorista F.C. — entrega local

## Estado

La copia local apunta exclusivamente al proyecto `ekepygodvciqnqkrgrsv`. La cadena heredada está fuera de `supabase/migrations` (en `supabase/legacy_readonly/`), la CLI no está vinculada al proyecto viejo y `tools/guard-supabase.ps1` verifica host y ref antes de cualquier operación.

**Estado (15/10/2026):** las 8 migraciones están aplicadas en el proyecto remoto (`node tools/remote-check.mjs`). El sitio publicado aún es la versión anterior; el nuevo está en `deploy/` (ver `docs/LEGAL_LEEME.md` y `docs/APLICAR_MIGRACIONES_CRM.md`). La sesión actual de Supabase CLI pertenece a otra cuenta y no ve `ekepygodvciqnqkrgrsv`; una secret key de Data API no permite migraciones DDL.

## Migraciones activas

| Archivo | Contenido |
|---|---|
| `202609280001_bodega_mayorista_clean_base.sql` | Catálogo, configuración, CRM, pedidos, cotizaciones, ventas, RLS, buckets. Sin datos comerciales. |
| `202609280002_crm_sales_inventory.sql` | Checkout endurecido (límites, abuso, snapshots, dedupe sin sobrescribir), apertura de WhatsApp, pedidos manuales, cotizaciones multilínea y editables, conversión con revisión de precios (error `BM001`), ventas manuales, estados pagada/entregada, devoluciones con decisión de reintegro, cancelación sin doble restauración, variantes con id estable, ajustes de stock trazables, fusión de clientes, edad/cumpleaños en `America/Bogota`, snapshots de cliente y negocio, privilegios mínimos (`anon` sin acceso a tablas privadas ni funciones internas; importes y estados solo vía funciones). |
| `202609290001_price_tiers.sql` | Precios por volumen (tramos por producto). |
| `202610130001_delete_admin_quote.sql` | Eliminar cotizaciones nunca convertidas. |
| `202610140001_crm_privacy_events_identity.sql` | Roles del personal, privacidad por finalidad, colector de eventos (desactivado por defecto), identidad declarada/verificada, relaciones de productos y agregados privados del CRM. Aplicada (15/10/2026). |
| `202610140002_coupons_offers.sql` | Cupones validados en servidor (reserva, consumo y liberación), ofertas privadas, contactos y checkout con descuento por línea. Aplicada (15/10/2026). |
| `202610150001_legal_restock_costs.sql` | Aceptación obligatoria y versionada de Términos y Política, avisos de disponibilidad, costos privados y margen. Aplicada (15/10/2026). |
| `202610140003_tasks_roles_plan.sql` | Tareas "A quién atender hoy", permisos de vendedor y de catálogo, modelo de plan (cobro desactivado). Aplicada (15/10/2026). |

CRM, recomendaciones, ofertas y cupones: `docs/TECNICO_CRM.md`, `docs/GUIA_COMERCIANTE.md`, `docs/AUDITORIA_HITO0.md` y `docs/APLICAR_MIGRACIONES_CRM.md`.

Reglas definidas:

- **29 de febrero**: en años no bisiestos se celebra el 28 de febrero y la edad cambia ese día (`birthday_in_year`, `customer_age`, `js/lib/crm-dates.js`).
- **Teléfono**: `3xx…`, `03xx…`, `57 3xx…` y `+57 3xx…` se normalizan a `+573xx…`; otros números internacionales de 8–15 dígitos se guardan con `+`. Un cliente existente nunca se sobrescribe desde el checkout: las diferencias quedan en `orders.customer_conflicts` para que el administrador las aplique.
- **Ventas**: `solicitud → confirmada` (descuenta stock una vez) `→ pagada/entregada`; `cancelada` restaura una vez; `devuelta` cuando se devuelve todo. Con devoluciones registradas no se permite cancelar.
- **Consecutivos**: `PED-AAAA-000001`, `COT-AAAA-000001`, `CV-AAAA-000001` por `UPDATE … RETURNING` bloqueante (nunca `count + 1`).
- **Análisis de cliente**: contrato en `js/lib/metrics.js` (compra = venta confirmada alguna vez y no cancelada; neto de devoluciones; conversión con numerador y denominador; afinidad 0–100, no probabilidad). Detalle en `docs/TECNICO_CRM.md`.

## Datos iniciales tras migrar

- Técnicos: 1 fila en `site_settings` (contactos vacíos), 3 en `document_sequences`, 6 buckets (`private-documents` privado).
- Vacíos: productos, categorías, marcas, variantes, imágenes, banners, métodos de pago/entrega, clientes, consentimientos, pedidos, cotizaciones, ventas, movimientos, usuarios y administradores.

## Activación remota pendiente

1. Iniciar sesión en la CLI con la cuenta dueña del proyecto (`supabase login`) o definir `SUPABASE_ACCESS_TOKEN` en la sesión.
2. `supabase link --project-ref ekepygodvciqnqkrgrsv` (pedirá la contraseña de la base de datos).
3. `powershell -File tools/apply-migrations.ps1` (simulación) y, tras revisarla, `powershell -File tools/apply-migrations.ps1 -Apply`.
4. Crear el único usuario administrador en Auth y registrar su UUID en `public.admins` desde el SQL Editor del proyecto nuevo.
5. En Auth: mantener registros públicos desactivados y configurar Site URL y redirecciones del dominio final.
6. Rotar la secret key que se compartió en el chat.

## Ejecución local

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\serve.ps1 -Port 8080
```

## Pruebas

```powershell
node .\tools\qa-bodega.mjs                      # estáticas, huellas de migraciones, sintaxis ESM e importaciones (13)
node .\tools\qa-metrics.mjs                     # contrato de métricas y recomendadores (17)
npm install --no-save --prefix $env:TEMP\pglite @electric-sql/pglite
$env:PGLITE_DIR="$env:TEMP\pglite"; node .\tools\qa-db.mjs   # Postgres local en memoria (40)
node .\tools\qa-db-crm.mjs                      # cupones, eventos, identidad, tareas, permisos (20)
node .\tools\rollback-crm.mjs --verify; node .\tools\demo-crm.mjs
node .\tools\qa-ui-mock.mjs                     # Chrome headless con Supabase simulado (211)
```

- `qa-db.mjs` aplica ambas migraciones en PGlite (Postgres compilado a WASM) con un entorno que imita Supabase (roles, `auth.uid()`, Storage y privilegios por defecto) y prueba RLS anónima y de un usuario autenticado que no es admin, precio manipulado, teléfonos equivalentes (1 cliente, 2 pedidos), idempotencia, stock insuficiente, confirmación única, cancelación única, devoluciones, transiciones, cotizaciones y cumpleaños.
- `qa-ui-mock.mjs` intercepta **todas** las peticiones a `*.supabase.co` y responde con datos en memoria: no toca el proyecto remoto. Revisa vitrina, carrito, checkout, las 11 secciones del panel a 390 y 1440 px, desbordamiento horizontal a 320/375/768/1024/1440 px, cierre protegido de formularios y un comprobante de 60 líneas (4 páginas A4).

Limitaciones conocidas: PGlite tiene una sola conexión, así que la concurrencia real (dos confirmaciones simultáneas) se garantiza por diseño (`UPDATE … WHERE stock >= cantidad` con bloqueo de fila y orden estable) pero debe observarse en el proyecto remoto. El flujo real de Auth, Storage y WhatsApp solo puede probarse tras aplicar el esquema.

## Datos del negocio pendientes

Logo oficial (no hay archivo en la carpeta; se usa el wordmark), WhatsApp, teléfono, correo, dirección, ciudad, horario, redes, Google Maps, NIT (solo si aplica), métodos de pago y entrega, textos de tratamiento de datos y autorización promocional (con versión), condiciones de cotización y de venta, política de garantía, cuenta administradora y dominio final.

Mientras falten: el checkout y el botón de WhatsApp permanecen bloqueados sin WhatsApp; sin métodos de entrega/pago no se puede enviar un pedido; los documentos muestran “Pendiente de configuración” en los datos ausentes; el Resumen del panel lista lo pendiente.
