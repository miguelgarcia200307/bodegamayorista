# Manifiesto de aislamiento

- Tienda destino: Bodega Mayorista F.C.
- Project ref autorizado: `ekepygodvciqnqkrgrsv`
- URL autorizada: `https://ekepygodvciqnqkrgrsv.supabase.co`
- Proyecto heredado detectado y bloqueado: `gacqqaimdfvkmznsglpg`
- Migraciones heredadas: solo en `supabase/legacy_readonly/fuera_de_lugar_migrations/`; no forman parte de la cadena activa.
- Migraciones activas: `202609280001`, `202609280002`, `202609290001`, `202610130001` y, pendientes de aplicar, `202610140001` a `202610140003`. Solo insertan configuración técnica (`site_settings`, `document_sequences`, buckets); `tools/qa-bodega.mjs` lo verifica y guarda las huellas de las ya entregadas.
- La clave publicable es la única credencial en el código del navegador. Ninguna secret key, contraseña de base de datos ni token se guarda en el repositorio (`.env*` está en `.gitignore`).

## Comprobaciones

| Fecha (America/Bogota) | Comprobación | Resultado |
|---|---|---|
| 2026-09-28 | Configuración del frontend, `.env.example` y vínculo de CLI apuntan al ref autorizado | Correcto |
| 2026-09-28/29 | `tools/guard-supabase.ps1`: host del ref autorizado responde (`GET /auth/v1/settings`, solo lectura) | Correcto |
| 2026-09-29 | Búsqueda del ref heredado en código ejecutable (`js/`, HTML, `supabase/migrations`) | Solo aparece en listas de bloqueo (guarda y pruebas) |
| 2026-09-29 | `supabase projects list` con la sesión actual de la CLI | No incluye el ref autorizado: aplicación remota bloqueada |

Operaciones remotas realizadas en esta adaptación: ninguna escritura en ningún proyecto. Contra el proyecto nuevo solo hubo lecturas públicas (guarda y detección de esquema de la tienda). Contra el proyecto heredado no se ejecutó ningún comando. No es posible demostrar desde aquí el estado del proyecto original porque no hay acceso a él; lo verificable es que esta copia no lo referencia ni lo llamó.

Antes de aplicar migraciones usa `tools/apply-migrations.ps1`: ejecuta la guarda con `-RequireLinked`, comprueba que la cuenta de la CLI ve el ref autorizado y vuelve a leer el vínculo justo antes de `db push --dry-run` y de `db push`. Un valor distinto cancela la operación.
