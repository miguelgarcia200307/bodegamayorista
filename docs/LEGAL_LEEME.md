# Textos legales publicados (15/10/2026)

## Qué está publicado en la base de datos

| Texto | Versión | Dónde se ve |
|---|---|---|
| Términos y condiciones de uso y venta | `tyc-2026-10-15-6860cb` | Checkout (casilla obligatoria y ventana), Ayuda |
| Política de tratamiento de datos personales | `pd-2026-10-15-260dda` | Checkout (casilla obligatoria y ventana), Ayuda |
| Autorización promocional (opcional) | `mk-2026-10-15-689cb9` | Checkout |
| Analítica y personalización (opcionales) | `an-2026-10-15-17c807` | Aviso de privacidad y Preferencias |
| Envíos; cambios, devoluciones, retracto y garantía | — | Ayuda |
| Garantía, condiciones del comprobante y de la cotización | — | PDF de comprobantes y cotizaciones |
| Autorización del aviso "Avísame cuando llegue" | — | Ficha de producto agotado |

Copias exactas de lo publicado: `legal/publicado/`. Plantillas editables: `legal/*.txt`. Para volver a publicar después de editar o completar datos: `node tools/apply-legal-texts.mjs` (simulación) y `--apply`. Cada cambio genera una versión nueva y los clientes aceptan la nueva.

## Cómo funciona la aceptación

- El cliente **no puede enviar el pedido** sin marcar: "He leído y acepto los Términos y condiciones y autorizo el tratamiento de mis datos personales para gestionar mi pedido…". La casilla nunca viene marcada ni se recupera de una visita anterior.
- Cada pedido guarda la versión de los Términos y de la Política aceptadas y la fecha y hora. En la ficha del cliente queda además el registro de autorización. En el detalle del pedido verás "Aceptación legal".
- El servidor también puede exigirlo (`legal_acceptance_required`). **Está apagado** porque el sitio publicado hoy es la versión anterior, que no envía la aceptación; encenderlo ahora rechazaría todos los pedidos. Enciéndelo en Configuración → Textos legales en cuanto publiques el sitio nuevo (`deploy/`).

## Lo que protege al negocio (dentro de la ley)

- La venta solo se perfecciona cuando la tienda confirma disponibilidad, precio y pago: antes puede no aceptar pedidos (sin stock, datos falsos, fraude o error evidente de precio).
- No responde por pagos a cuentas no informadas por la tienda; pedidos sin pagar en 48 h pueden cancelarse.
- Retracto con los costos de devolución a cargo del cliente (como lo permite la ley) y sin retracto en compras para reventa.
- Compras al por mayor: régimen del Código de Comercio, devoluciones solo por defecto de fábrica o error de despacho reportado en 3 días hábiles.
- Exclusiones de garantía del artículo 16 de la Ley 1480, revisión obligatoria al recibir (24 h para daños visibles), reprogramaciones con costo.
- Códigos de descuento: uno por pedido, no canjeables por dinero, anulables si hay fraude.
- Prueba de aceptación versionada de Términos y Política.

## Lo que NO se incluyó a propósito

- **No se obliga a aceptar publicidad para comprar.** La Ley 1581 exige una autorización libre para cada finalidad. Condicionar la compra a recibir promociones expone a sanciones de la SIC. Por eso la autorización promocional es opcional y separada; los Términos y la Política sí son obligatorios.
- No hay cláusulas que renuncien a la garantía legal o al retracto: serían ineficaces (artículos 42 y 43 de la Ley 1480) y podrían ser sancionadas.

## Datos que debes completar (la ley los exige)

En Configuración: **correo electrónico, dirección del establecimiento, teléfono y número de identificación (cédula o NIT)** del responsable. El Decreto 1377 de 2013 (artículo 13) pide en la política el nombre, el domicilio, la dirección, el correo y el teléfono del responsable. Mientras falten, esas líneas no aparecen en los textos. Luego ejecuta `node tools/apply-legal-texts.mjs --apply` (o `--identificacion "C.C. …"`).

Se tomó como responsable a "Francisney Castaño, propietario del establecimiento de comercio Bodega Mayorista F.C." (del sitio). Si el negocio es una sociedad o tiene otro titular, cámbialo con `--responsable` y vuelve a publicar.

## Revisión profesional

Los textos siguen la Ley 1480 de 2011, el Decreto 735 de 2013, la Ley 1581 de 2012, el Decreto 1377 de 2013 y la Ley 527 de 1999. Ningún texto garantiza por sí solo la ausencia de reclamaciones. Antes de depender de ellos, pide a un abogado que los revise frente a tu operación real (facturación electrónica, régimen tributario y Registro Nacional de Bases de Datos si te aplica).
