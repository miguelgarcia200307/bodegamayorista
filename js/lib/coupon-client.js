// Código de descuento en carrito y checkout. El navegador solo guarda el código que el
// cliente escribió; importes, elegibilidad y vigencia los calcula el servidor en cada
// validación (validate_cart_coupon) y de nuevo al crear el pedido.
import { validateCartCoupon } from './api.js';
import { formatMoney } from './helpers.js';
import { track, visitorCredentials } from './privacy.js';

const KEY = 'bm_coupon_code_v1';
export const getStoredCoupon = () => { try { return sessionStorage.getItem(KEY) || ''; } catch { return ''; } };
export const setStoredCoupon = code => { try { sessionStorage.setItem(KEY, String(code || '').trim().toUpperCase()); } catch { /* sin almacenamiento */ } };
export const clearStoredCoupon = () => { try { sessionStorage.removeItem(KEY); } catch { /* sin almacenamiento */ } };

const MESSAGES = {
  vacio: 'Escribe un código.',
  valido: 'Código aplicado.',
  no_valido: 'Este código no es válido.',
  no_iniciado: 'Este código todavía no está vigente.',
  vencido: 'Este código ya venció.',
  sin_usos: 'Este código ya no tiene usos disponibles.',
  limite_cliente: 'Ya usaste este código el máximo de veces permitido.',
  minimo_no_alcanzado: 'Aún no alcanzas el mínimo de compra para este código.',
  sin_productos_elegibles: 'Ningún producto del carrito aplica para este código.',
  requiere_verificacion: 'Este código es personal: verifica tu número con la tienda para usarlo (Preferencias de privacidad).',
  demasiados_intentos: 'Hiciste varios intentos seguidos. Espera unos minutos.',
  carrito_no_valido: 'Revisa el carrito antes de aplicar el código.',
  servicio_no_disponible: 'No pudimos comprobar el código en este momento. Tu carrito sigue igual; intenta de nuevo.'
};
export function couponMessage(result) {
  if (!result) return '';
  if (result.status === 'minimo_no_alcanzado' && Number(result.missing_for_minimum) > 0) return `Te faltan ${formatMoney(result.missing_for_minimum)} en productos elegibles para usar este código.`;
  if (result.status === 'valido') {
    const excluded = (result.lines || []).filter(line => !line.eligible).length;
    return `Ahorras ${formatMoney(result.discount_total)}${excluded ? ` · ${excluded} producto${excluded === 1 ? '' : 's'} no aplica${excluded === 1 ? '' : 'n'}` : ''}${result.ends_at ? ` · vence el ${new Date(result.ends_at).toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short' })}` : ''}.`;
  }
  return MESSAGES[result.status] || MESSAGES.no_valido;
}

// Valida el código guardado (o el indicado) contra el carrito actual.
export async function checkCoupon(cart, code = getStoredCoupon(), deliveryMethodId = null) {
  if (!code) return null;
  try {
    const result = await validateCartCoupon(cart, code, visitorCredentials(), deliveryMethodId);
    track(result.status === 'valido' ? 'coupon_validated' : 'coupon_rejected', { properties: { reason: result.status } });
    return result;
  } catch (error) {
    console.warn('Validación de cupón no disponible:', error);
    return { status: 'servicio_no_disponible' };
  }
}
