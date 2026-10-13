// Datos del negocio: única fuente para toda la tienda pública.
//
// 1. `siteConfig` guarda los datos que NO existen en la base de datos. Todo campo en
//    null o vacío hace que su bloque no se muestre. Nunca escribas aquí datos de ejemplo.
// 2. Lo que sí existe en el panel (WhatsApp, dirección, horario, redes, políticas,
//    métodos de pago y entrega) se lee de Supabase y se combina en `getSiteData()`.
// 3. Los valores de demostración que siguen en la base se ignoran automáticamente
//    (ver `isPlaceholder`), así nunca llegan al público.
import { getDeliveryMethods, getPaymentMethods, getSettings } from './lib/api.js';

export const siteConfig = {
  businessName: 'Bodega Mayorista F.C.',
  byline: 'By Francisney Castaño',
  tagline: 'Tecnología, calidad y confianza',
  // Confirmado por el propietario: tienda física en Barranquilla con envíos nacionales.
  city: 'Barranquilla',
  hasPhysicalStore: true,
  shipsNationwide: true,
  // Tiempos estimados por ciudad, p. ej. [{ city: 'Barranquilla', time: '24 a 48 horas' }].
  shippingEstimates: [],
  // Meses de garantía (número). Si es null se usa el texto de garantía del panel.
  warrantyMonths: null,
  // Políticas en texto plano; cada una crea su sección en ayuda.html y su enlace en el footer.
  policies: {
    shipping: null,
    returns: null,
    terms: null
  },
  // Preguntas frecuentes: [{ question: '', answer: '' }].
  faq: [],
  // Razón social que acompaña al NIT (el NIT se toma del panel: site_settings.tax_id).
  legalName: null,
  // Prueba social: solo datos reales y verificables.
  socialProof: { ordersServed: null, reviews: [] },
  // Mensajes de respaldo para la barra superior si el panel no tiene mensajes reales.
  announcements: [
    'Tienda física en Barranquilla · Envíos a todo el país',
    'Arma tu pedido y confírmalo por WhatsApp'
  ],
  announcementSeconds: 5,
  whatsappGreeting: 'Hola, quiero información sobre los productos de Bodega Mayorista F.C.'
};

// Valores sembrados por tools/seed-demo.mjs que no llevan la palabra "demo".
const KNOWN_DEMO_VALUES = new Set(['lun a sáb 8:00 a. m. – 6:00 p. m.']);
const PLACEHOLDER_PATTERNS = [/\[demo\]/i, /\(demo\)/i, /\bdemo\b/i, /\b00\s*#\s*00-00\b/, /@[\w.-]+\.test\b/i, /\bexample\.(com|org|net)\b/i, /lorem ipsum/i, /pendiente de configuraci/i, /^x{3,}$/i];

export function isPlaceholder(value) {
  const text = String(value ?? '').trim();
  if (!text) return true;
  if (KNOWN_DEMO_VALUES.has(text.toLowerCase())) return true;
  if (PLACEHOLDER_PATTERNS.some(pattern => pattern.test(text))) return true;
  const digits = text.replace(/\D/g, '');
  // Teléfonos de relleno: +57 300 000 0000, 3000000000…
  return digits.length >= 7 && /(\d)\1{6,}/.test(digits) && digits.replace(/^57/, '').replace(/^3\d{2}/, '').split('').every(digit => digit === '0');
}

export const realValue = value => (isPlaceholder(value) ? '' : String(value).trim());

// Quita marcas "(demo)" / "[DEMO]" de etiquetas que deben seguir funcionando (checkout).
export function cleanLabel(value = '') {
  return String(value).replace(/\s*[[(]\s*demo\s*[\])]\s*/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function whatsappLink(number, message = siteConfig.whatsappGreeting) {
  const digits = String(number || '').replace(/\D/g, '');
  if (!digits) return '';
  return `https://wa.me/${digits}${message ? `?text=${encodeURIComponent(message)}` : ''}`;
}

function safeUrl(value) {
  try {
    const url = new URL(String(value).trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function instagramInfo(value) {
  const raw = realValue(value);
  if (!raw) return null;
  const handle = raw.replace(/^https?:\/\/(www\.)?instagram\.com\/?/i, '').replace(/^@/, '').split(/[/?#]/)[0].trim();
  if (!/^[\w.]{2,30}$/.test(handle)) return null;
  return { handle: `@${handle}`, url: `https://www.instagram.com/${encodeURIComponent(handle)}/` };
}

function tiktokInfo(value) {
  const raw = realValue(value);
  if (!raw) return null;
  const handle = raw.replace(/^https?:\/\/(www\.|m\.)?tiktok\.com\/?/i, '').replace(/^@/, '').split(/[/?#]/)[0].trim();
  if (!/^[\w.]{2,24}$/.test(handle)) return null;
  return { handle: `@${handle}`, url: `https://www.tiktok.com/@${encodeURIComponent(handle)}` };
}

function facebookUrl(value) {
  const url = safeUrl(realValue(value));
  return url && !/facebook\.com\/?$/i.test(url) ? url : '';
}

const FALLBACK_SETTINGS = { business_name: siteConfig.businessName, tagline: siteConfig.tagline, announcement_enabled: true, announcement_mode: 'static', announcement_static_text: '', announcement_messages: [] };
let settingsPromise;
let commercePromise;

// Configuración cruda del panel, con tiempo límite para no bloquear la tienda.
export function loadSettings() {
  settingsPromise ??= Promise.race([
    getSettings(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Settings timeout')), 2500))
  ]).catch(() => ({ ...FALLBACK_SETTINGS }));
  return settingsPromise;
}

export function loadCommerceMethods() {
  commercePromise ??= Promise.all([
    getPaymentMethods().catch(() => []),
    getDeliveryMethods().catch(() => [])
  ]).then(([payments, deliveries]) => ({ payments, deliveries }));
  return commercePromise;
}

function announcementTexts(settings) {
  if (settings.announcement_enabled === false) return [];
  const fromPanel = settings.announcement_mode === 'carousel'
    ? (Array.isArray(settings.announcement_messages) ? settings.announcement_messages : [])
      .filter(message => message?.enabled !== false && !String(message?.id || '').startsWith('demo-'))
      .map(message => realValue(message.text)).filter(Boolean)
    : [realValue(settings.announcement_static_text)].filter(Boolean);
  const isDefaultStatic = /^bodega mayorista f\.?c\.?\s*·\s*tecnolog/i.test(fromPanel[0] || '') && fromPanel.length === 1;
  return (fromPanel.length && !isDefaultStatic ? fromPanel : siteConfig.announcements).slice(0, 3);
}

export function buildSiteData(settings = {}, { payments = [], deliveries = [] } = {}) {
  const city = realValue(settings.city) || siteConfig.city || '';
  const address = realValue(settings.address);
  const phone = realValue(settings.phone);
  const whatsappNumber = realValue(settings.whatsapp).replace(/[^\d+]/g, '');
  const mapsUrl = safeUrl(realValue(settings.maps_url))
    || (address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([address, city, 'Colombia'].filter(Boolean).join(', '))}` : '');
  const realPayments = payments.filter(method => !isPlaceholder(method.name) && method.active !== false);
  const realDeliveries = deliveries.filter(method => !isPlaceholder(method.name) && method.active !== false);
  const warrantyText = siteConfig.warrantyMonths ? `Garantía de ${siteConfig.warrantyMonths} ${siteConfig.warrantyMonths === 1 ? 'mes' : 'meses'}` : realValue(settings.warranty_text);
  const data = {
    raw: settings,
    businessName: realValue(settings.business_name) || siteConfig.businessName,
    tagline: realValue(settings.tagline) || siteConfig.tagline,
    city,
    address,
    schedule: realValue(settings.schedule),
    mapsUrl,
    phone: phone ? { display: phone, href: `tel:${phone.replace(/[^+\d]/g, '')}` } : null,
    email: realValue(settings.email),
    whatsapp: whatsappNumber ? { number: whatsappNumber, url: whatsappLink(whatsappNumber) } : null,
    instagram: instagramInfo(settings.instagram),
    facebook: facebookUrl(settings.facebook),
    tiktok: tiktokInfo(settings.tiktok),
    taxId: realValue(settings.tax_id),
    legalName: siteConfig.legalName || '',
    warrantyText,
    dataPolicyText: realValue(settings.data_policy_text),
    termsText: siteConfig.policies.terms || realValue(settings.sale_terms),
    shippingPolicy: siteConfig.policies.shipping || '',
    returnsPolicy: siteConfig.policies.returns || '',
    faq: siteConfig.faq.filter(item => item?.question && item?.answer),
    shipsNationwide: Boolean(siteConfig.shipsNationwide),
    hasPhysicalStore: Boolean(siteConfig.hasPhysicalStore && city),
    shippingEstimates: siteConfig.shippingEstimates.filter(item => item?.city && item?.time),
    payments: realPayments.map(method => ({ name: cleanLabel(method.name), instructions: realValue(method.instructions), logo: method.logo_url || '' })),
    deliveries: realDeliveries.map(method => ({ name: cleanLabel(method.name), instructions: realValue(method.instructions), cost: Number(method.base_cost || 0) })),
    announcements: announcementTexts(settings),
    announcementSeconds: Number(settings.announcement_interval_seconds) || siteConfig.announcementSeconds,
    socialProof: siteConfig.socialProof
  };
  data.locationLine = [data.hasPhysicalStore ? `Tienda física en ${city}` : '', data.shipsNationwide ? 'Envíos a todo el país' : ''].filter(Boolean).join(' · ');
  data.helpTopics = helpTopics(data);
  return data;
}

function helpTopics(data) {
  const topics = [];
  const shippingBody = [data.shippingPolicy, ...data.deliveries.map(item => `${item.name}${item.instructions ? `: ${item.instructions}` : ''}`), ...data.shippingEstimates.map(item => `${item.city}: ${item.time}`)].filter(Boolean);
  if (shippingBody.length) topics.push({ slug: 'envios', title: 'Envíos y entregas', body: shippingBody });
  if (data.warrantyText) topics.push({ slug: 'garantia', title: 'Garantía', body: [data.warrantyText] });
  if (data.returnsPolicy) topics.push({ slug: 'cambios', title: 'Cambios y devoluciones', body: [data.returnsPolicy] });
  if (data.payments.length) topics.push({ slug: 'pagos', title: 'Formas de pago', body: data.payments.map(item => `${item.name}${item.instructions ? `: ${item.instructions}` : ''}`) });
  if (data.faq.length) topics.push({ slug: 'preguntas', title: 'Preguntas frecuentes', faq: data.faq });
  if (data.termsText) topics.push({ slug: 'terminos', title: 'Términos y condiciones', body: [data.termsText] });
  if (data.dataPolicyText) topics.push({ slug: 'privacidad', title: 'Privacidad y Habeas Data', subtitle: 'Tratamiento de datos personales conforme a la Ley 1581 de 2012.', body: [data.dataPolicyText] });
  return topics;
}

let siteDataPromise;
export function getSiteData({ withCommerce = true } = {}) {
  if (!withCommerce) return loadSettings().then(settings => buildSiteData(settings));
  siteDataPromise ??= Promise.all([loadSettings(), loadCommerceMethods()]).then(([settings, methods]) => buildSiteData(settings, methods));
  return siteDataPromise;
}
