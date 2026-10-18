# Aplicar y revertir las migraciones CRM (202610140001–202610150001)

**Estado al 15/10/2026:** las 8 migraciones están aplicadas en el proyecto `ekepygodvciqnqkrgrsv` y son idénticas a las locales (`node tools/remote-check.mjs`). Se ejecutaron además `tools/remote-ops.sql` (pg_cron para depuración diaria a las 03:15 de Bogotá y cierre global de privilegios por defecto) y `tools/apply-legal-texts.mjs --apply`. Prueba de humo y prueba de concurrencia en producción hechas dentro de transacciones revertidas, sin rastro (`tools/remote-smoke.mjs`, `tools/remote-concurrency.mjs`).

**Pendiente:** publicar el sitio nuevo (`node tools/build-deploy.mjs` genera `deploy/sitio` y `deploy/bodegamayorista-sitio.zip`) en el repositorio de GitHub Pages que sirve `bodegamayoristafc.shop` y, después, activar en Configuración la exigencia de aceptación en el servidor.

Procedimiento de referencia:

## Antes

1. Confirmar que el proyecto remoto ya tiene las 4 migraciones anteriores (`supabase migration list`). La documentación antigua dice que el esquema no estaba aplicado, pero la tienda publicada muestra catálogo: verifícalo, no lo supongas.
2. Respaldo: `supabase db dump -f respaldo_previo_crm.sql` (o un punto de restauración PITR si el plan lo incluye).
3. Correr las pruebas locales:

```powershell
node .\tools\qa-bodega.mjs                       # estáticas, sintaxis ESM e importaciones
node .\tools\qa-metrics.mjs                      # contrato de métricas y recomendador
$env:PGLITE_DIR="$env:TEMP\pglite"
node .\tools\qa-db.mjs                           # suite original (40)
node .\tools\qa-db-crm.mjs                       # cupones, eventos, identidad, tareas, permisos (20)
node .\tools\rollback-crm.mjs --verify           # la reversión deja el checkout operativo
node .\tools\demo-crm.mjs                        # recorrido completo con datos ficticios
node .\tools\qa-ui-mock.mjs                      # Chrome con Supabase simulado
```

4. Opcional (recomendado): prueba 21 de concurrencia real contra un Postgres desechable (`supabase start` local):

```powershell
npm install --no-save --prefix $env:TEMP\pg pg
$env:PG_DIR="$env:TEMP\pg"; $env:DATABASE_URL="postgres://postgres:postgres@127.0.0.1:54322/postgres"
node .\tools\qa-concurrency.mjs
```

## Aplicar

```powershell
powershell -File tools\apply-migrations.ps1          # simulación (dry run)
powershell -File tools\apply-migrations.ps1 -Apply   # tras revisar
```

## Después

1. Configuración → Privacidad y analítica: responsable, canal, textos y versión. Activar la captura solo después.
2. Programar la depuración (ver `docs/TECNICO_CRM.md` §6).
3. Crear relaciones de productos (menú Catálogo → Relaciones).
4. Evaluar `alter default privileges for role postgres revoke execute on functions from public;` (hallazgo N1).
5. Publicar `ayuda.html` junto con el resto de archivos.

## Revertir

```powershell
node .\tools\rollback-crm.mjs > rollback_crm.sql
```

Revisa el archivo y ejecútalo en el SQL Editor. Restaura las versiones anteriores de las funciones de checkout y ventas (extraídas de las migraciones ya entregadas) y elimina tablas y columnas nuevas. **Se pierde** la información de cupones, ofertas, tareas, vínculos y navegación; los pedidos con cupón conservan su total, pero no el desglose del descuento. Si ya hubo uso real, prefiere restaurar el respaldo.
