# Hito 0 — Auditoría reproducible del CRM (14/10/2026)

Base revisada: copia local de trabajo (rama `main`, cambios sin confirmar del propietario conservados). Los originales de los archivos que no estaban en git (`js/lib/customer-insights.js`, `customer-diagnosis.js`, `recommender.js`, `js/components/reco-panel.js`, `js/pages/admin-crm.js`, `tools/qa-*.mjs`) están en `../bodegamayorista.zip`, creado antes de estos cambios.

No se tocó ningún proyecto remoto: todas las pruebas usan PGlite (Postgres en memoria) o Chrome con Supabase simulado.

## Línea base antes de cambiar código

| Comprobación | Resultado observado |
|---|---|
| `node tools/qa-bodega.mjs` | Falla en la 2.ª comprobación (exige 3 migraciones; hay 4). Las siguientes nunca se ejecutaban: al corregirla apareció otra falla oculta (ver N4). |
| `node tools/qa-db.mjs` (PGlite) | 40/40 |
| Reproducción con datos sintéticos (script en el anexo) | Ver columna "Antes" |

## Defectos A–T

Clasificación: **R** = reproducido con datos; **I** = confirmado por inspección del código; ninguno se presenta como vulnerabilidad explotada.

| ID | Clase | Antes (evidencia) | Corrección | Prueba |
|---|---|---|---|---|
| A. Afinidad presentada como probabilidad | I | `recommender.js`: pesos fijos, sigmoide, tope 0,96; UI "% de probabilidad estimada" | Afinidad entera 0–100 sin "%", con nivel de evidencia; la palabra "probabilidad" no se usa | `qa-bodega` "análisis honesto"; `qa-metrics` S; UI "sin probabilidad" |
| B. Confianza por líneas | R | Venta sola 32,97 % → venta + su pedido 45,12 %; una venta partida en 10 líneas: 98,2 % | `evidenceLevel` (reglas `evidencia-v1`): operaciones independientes, días distintos, intervalo, actualidad y cobertura | `qa-metrics` 3 |
| C. Borradores/rechazos como interés | R | Borrador y rechazada: mismo puntaje (0,295); solo un borrador → "Prospecto caliente", intención 67 | Recorridos con reglas `intencion-v1`: borrador nunca enviado = 0 (documento interno), rechazo/cancelación = 0 con motivo desconocido | `qa-metrics` 4 |
| D. Ranking con total bruto | R | A (compra 100, devuelve 90) quedaba 1.º sobre B (50) | Mismo contrato neto en JS (`netPurchasesByCustomer`) y SQL (`crm_customer_ranking`), mismo periodo | `qa-metrics` 1; `qa-db-crm` 1 (SQL) |
| E. Devolución total desaparece | R | Venta `devuelta`: devolución reportada 0, 0 compras | Compra = confirmada alguna vez y no cancelada; neto 0 y devolución visible con su fecha | `qa-metrics` 2 |
| F. Serie mensual dependía del periodo | R | Historial 200 → con filtro 90 días 100 | Contrato: siempre 12 meses con historial completo, rotulado | `qa-metrics` 6 |
| G. Conversión documental = venta | R | Cotización convertida + venta cancelada: 0 compras y conversión 100 % | Tres indicadores (aceptada / solicitud de venta / venta confirmada vigente) con numerador, denominador y sin % si n < 3 | `qa-metrics` 5 |
| H. Compatibilidad por categoría/marca | I | Matrices por slug y "Ecosistema" por marca | Tabla `product_relationships`; `compatible_con` solo entre productos (restricción SQL) y con nota; "complemento" dice que no garantiza compatibilidad | `qa-metrics` 9; restricción en migración 0001 |
| I. Referencia de precio con borradores; perfil global | I/R | El índice incluía productos no publicados | Universo publicado y elegible; rango por categoría con mediana, P25–P75 y muestra mínima | `qa-metrics` 10 |
| J. `quoteLinesStatus` sobre lista deduplicada | I | Revisaba stock de cualquier variante | `lineAvailability` revisa cada línea, su variante y la cantidad (y el tramo del documento) | `qa-metrics` 9 |
| K. Exclusión permanente de lo comprado | I | No había reposición | Reglas `reposicion` configurables y contexto de compra declarado (reventa sin penalización) | `qa-metrics` 9 |
| L. Recomendación pública pobre | I | Ficha: misma categoría/marca; carrito: categoría del primer producto | `public-reco.js`: alternativas y complementos separados; carrito con todo su contenido y sin sustitutos; inicio con continuidad autorizada o tendencias agregadas (≥ 3 compradores) | `qa-metrics` públicas; UI ficha |
| M. `getSales().catch(() => [])` | I | Error = "sin ventas" | Eliminado; el análisis usa agregados de servidor y muestra fuentes fallidas como parciales | `qa-bodega`; UI estado de carga |
| N. Sin paginación | I | Consultas completas sin `range` | `fetchAllPages` con orden estable y marca de truncado; historial por cliente completo | `qa-metrics` 7b |
| O. Ayuda/privacidad 404 | R (web publicada) | `ayuda.html` y `help.js` ausentes | Página creada con datos reales y "pendiente" donde falta | UI `ayuda` 320/390/1440 |
| P. `qa-bodega` desactualizado | R | Exigía 3 migraciones | Huellas SHA-256 de las ya entregadas + lista de pendientes; detecta ediciones del historial | `qa-bodega` |
| Q. Dos segmentaciones | I | `segmentFor` y `segmentOf` | Una sola (`segmentos-v1`) en `customer-diagnosis.js` | `qa-bodega` |
| R. "Volver a analizar" ficticio | I | Animación fija ≈ 3,46 s sobre los mismos datos | "Actualizar datos" consulta todo de nuevo y muestra el estado real de cada fuente | UI "Actualizar datos" |
| S. Motivos previos a penalización | I | El texto se creaba antes de reducir el puntaje | Motivos = contribuciones finales positivas; penalizaciones como límites | `qa-metrics` S |
| T. CSV con fórmulas | I | Solo escapaba comillas | `csvCell` neutraliza `= + - @ \t \r | %` en texto | `qa-metrics` 29 |

## Hallazgos nuevos

| ID | Clase | Hallazgo | Acción |
|---|---|---|---|
| N1 | R (PGlite) | `alter default privileges in schema public revoke execute ... from public` (migración 202609280002) **no tiene efecto**: en PostgreSQL los privilegios por esquema solo pueden añadir. Toda función creada después queda ejecutable por `PUBLIC` (incluido `anon`) salvo revocación explícita. Las funciones existentes estaban bien porque la misma migración hizo `revoke ... on all functions`. | Cada migración nueva revoca explícitamente `EXECUTE` de `PUBLIC`; prueba "Ninguna función pública queda ejecutable por PUBLIC". Recomendación para el proyecto remoto: ejecutar `alter default privileges for role postgres revoke execute on functions from public;` (sin `in schema`) tras evaluarlo. |
| N2 | R | `node --check archivo.js` no detecta todos los errores de módulos ES (no hay `"type": "module"`); un paréntesis sobrante pasó la suite. | La suite compila cada módulo con `--input-type=module` y valida importaciones/exportaciones (`tools/check-imports.mjs`). |
| N3 | I | Supabase JS se carga como `@2` sin versión exacta. | Pendiente: fijar versión exacta tras probarla (no se cambió para no alterar la autenticación sin verificación). |
| N4 | R | Con P corregido apareció que la comprobación de "datos heredados" rechazaba `Valledupar`, que es la ciudad confirmada por el propietario. | El guardia de frontend ya no la incluye; el de migraciones sí (no se siembran datos del negocio). |

## Anexo: reproducción

El script usado está descrito en `tools/qa-metrics.mjs` (casos 1–10) con valores esperados calculados a mano; los valores "Antes" se obtuvieron ejecutando esos mismos escenarios con los módulos originales del ZIP.
