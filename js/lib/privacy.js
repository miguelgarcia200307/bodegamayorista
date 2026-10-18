// Privacidad de la tienda: autorizaciones por finalidad y colector de eventos propios.
//   · La gestión del pedido no depende de nada de esto: rechazar o fallar no bloquea comprar.
//   · Sin autorización de analítica no se crea visitante ni se envía ningún evento.
//   · Personalización (separada): permite usar la navegación para recomendaciones y,
//     con verificación, en la ficha del cliente.
//   · Retirar la autorización borra en el servidor los eventos del visitante y vacía la
//     cola local; un borrador local antiguo no la reactiva (el servidor ya revocó el id).
// Nunca se envían nombres, teléfonos, direcciones, notas ni contenido de formularios.
import { supabase } from './supabase.js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../config.js';

const STATE_KEY = 'bm_privacy_v1';
const QUEUE_KEY = 'bm_events_queue_v1';
const SESSION_KEY = 'bm_session_v1';
const SESSION_IDLE_MS = 30 * 60 * 1000;
const QUEUE_MAX = 50;
const QUEUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const VIEW_THRESHOLD_MS = 8000;
export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign'];

let config = null; // { enabled, version, analyticsText, personalizationText }
const safe = fn => { try { return fn(); } catch { return null; } };
const readJson = (storage, key) => safe(() => JSON.parse(storage.getItem(key) || 'null'));
const writeJson = (storage, key, value) => safe(() => storage.setItem(key, JSON.stringify(value)));

export function configurePrivacy(settings = {}) {
  config = {
    enabled: settings.tracking_enabled === true && Boolean(settings.analytics_consent_version) && Boolean(settings.analytics_consent_text),
    version: settings.analytics_consent_version || '',
    analyticsText: settings.analytics_consent_text || '',
    personalizationText: settings.personalization_consent_text || '',
    controller: settings.privacy_controller_name || settings.business_name || '',
    requests: settings.privacy_requests_channel || ''
  };
  return config;
}
export const privacyConfig = () => config || { enabled: false };

export function getConsent() {
  const state = readJson(localStorage, STATE_KEY);
  if (!state || !config?.enabled || state.version !== config.version) return { decided: false, analytics: false, personalization: false };
  return { decided: true, analytics: Boolean(state.analytics && state.visitorId), personalization: Boolean(state.analytics && state.personalization && state.visitorId), decidedAt: state.decidedAt, version: state.version };
}
export const needsDecision = () => Boolean(config?.enabled) && !getConsent().decided;
// Personalización local (vistos recientemente): permitida si la captura está apagada
// (nada sale del navegador) o si el visitante la autorizó.
export const localPersonalizationAllowed = () => !config?.enabled || getConsent().personalization;

function credentials() {
  const state = readJson(localStorage, STATE_KEY);
  return state?.analytics && state.visitorId && state.visitorSecret && state.version === config?.version ? { id: state.visitorId, secret: state.visitorSecret } : null;
}
// Para el checkout y el cupón: credenciales seudónimas + sesión actual (o null).
export function visitorCredentials() {
  const creds = credentials();
  return creds ? { ...creds, session_id: currentSession() } : null;
}

// Evento que avisa a la página (ayuda, banner…) que la decisión cambió, sin recargar.
export const CONSENT_EVENT = 'privacy:change';
export async function decideConsent(choice) {
  const consent = await saveConsent(choice);
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: consent }));
  return consent;
}

async function saveConsent({ analytics, personalization }) {
  const previous = readJson(localStorage, STATE_KEY);
  const now = new Date().toISOString();
  if (!analytics) {
    // Rechazo o retiro: si había visitante, el servidor borra sus eventos y vínculos.
    if (previous?.visitorId && previous?.visitorSecret) {
      // La consulta de Supabase solo implementa `then` (no `.catch`): se envuelve en try.
      // Un fallo de red no impide registrar el retiro en este navegador.
      try { await supabase.rpc('set_visitor_consent', { target: previous.visitorId, secret: previous.visitorSecret, consent: { analytics: false } }); } catch { /* sin red: se respeta igual */ }
    }
    safe(() => sessionStorage.removeItem(QUEUE_KEY));
    writeJson(localStorage, STATE_KEY, { version: config?.version, analytics: false, personalization: false, decidedAt: now });
    return getConsent();
  }
  if (previous?.analytics && previous.visitorId && previous.version === config.version) {
    const { data } = await supabase.rpc('set_visitor_consent', { target: previous.visitorId, secret: previous.visitorSecret, consent: { analytics: true, personalization: Boolean(personalization), version: config.version } });
    if (data) { writeJson(localStorage, STATE_KEY, { ...previous, personalization: Boolean(personalization), decidedAt: now }); return getConsent(); }
  }
  const { data, error } = await supabase.rpc('register_visitor', { consent: { analytics: true, personalization: Boolean(personalization), version: config.version } });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row?.visitor_id) throw error || new Error('No fue posible registrar la autorización.');
  writeJson(localStorage, STATE_KEY, { version: config.version, analytics: true, personalization: Boolean(personalization), decidedAt: now, visitorId: row.visitor_id, visitorSecret: row.visitor_secret });
  captureCampaign();
  return getConsent();
}

// --- Sesión ---------------------------------------------------------------------------
function currentSession() {
  const now = Date.now();
  let session = readJson(sessionStorage, SESSION_KEY);
  if (!session || now - session.last > SESSION_IDLE_MS) session = { id: crypto.randomUUID(), last: now };
  session.last = now;
  writeJson(sessionStorage, SESSION_KEY, session);
  return session.id;
}

// --- Cola y envío -----------------------------------------------------------------------
let flushTimer = null; let flushing = false;
function queue() {
  const items = readJson(sessionStorage, QUEUE_KEY) || [];
  const fresh = items.filter(item => Date.now() - Date.parse(item.event.occurred_at) < QUEUE_MAX_AGE_MS && item.attempts < 3);
  return fresh.slice(-QUEUE_MAX);
}
export function track(type, { productId = null, variantId = null, properties = {} } = {}) {
  if (!config?.enabled || !credentials()) return false;
  const event = { event_id: crypto.randomUUID(), type, session_id: currentSession(), occurred_at: new Date().toISOString(), product_id: productId, variant_id: variantId, properties };
  writeJson(sessionStorage, QUEUE_KEY, [...queue(), { event, attempts: 0 }]);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 4000);
  return true;
}
export async function flush({ keepalive = false } = {}) {
  const creds = credentials();
  if (!creds || flushing) return;
  const pending = queue(); if (!pending.length) return;
  const batch = pending.slice(0, 20);
  flushing = true;
  try {
    // fetch con keepalive para no perder el lote al cerrar la página; mismo endpoint RPC.
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/track_events`, {
      method: 'POST', keepalive, headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: creds.id, secret: creds.secret, events: batch.map(item => item.event) })
    });
    const sentIds = new Set(batch.map(item => item.event.event_id));
    // Éxito (aceptados o rechazados por validación): se retiran. Error de red/servidor:
    // reintento limitado con el mismo event_id (idempotente en el servidor).
    const rest = queue().filter(item => !sentIds.has(item.event.event_id) || !response.ok).map(item => sentIds.has(item.event.event_id) ? { ...item, attempts: item.attempts + 1 } : item);
    writeJson(sessionStorage, QUEUE_KEY, rest);
  } catch {
    writeJson(sessionStorage, QUEUE_KEY, queue().map(item => batch.some(sent => sent.event.event_id === item.event.event_id) ? { ...item, attempts: item.attempts + 1 } : item));
  } finally { flushing = false; }
}
addEventListener('pagehide', () => flush({ keepalive: true }));

// Campaña: solo parámetros UTM permitidos y saneados (nunca la URL completa).
export function captureCampaign() {
  const params = new URLSearchParams(location.search);
  const properties = Object.fromEntries(UTM_KEYS.map(key => [key, String(params.get(key) || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40)]).filter(([, value]) => value));
  if (Object.keys(properties).length) track('campaign_landing', { properties });
}

// Visita cualificada: solo cuenta tiempo con la pestaña visible y la ventana activa.
// Recargar no suma: el servidor además limita 5 visitas por producto y día.
export function observeProductView(productId, { threshold = VIEW_THRESHOLD_MS } = {}) {
  if (!config?.enabled || !credentials()) return () => {};
  let active = 0; let since = document.visibilityState === 'visible' && document.hasFocus() ? performance.now() : null; let sent = false;
  const pause = () => { if (since != null) { active += performance.now() - since; since = null; } };
  const resume = () => { if (since == null && document.visibilityState === 'visible') since = performance.now(); };
  const check = () => { pause(); resume(); if (!sent && active >= threshold) { sent = true; track('view_product', { productId, properties: { active_ms: Math.round(active) } }); stop(); } };
  const onVisibility = () => (document.visibilityState === 'visible' ? resume() : pause());
  addEventListener('blur', pause); addEventListener('focus', resume); document.addEventListener('visibilitychange', onVisibility);
  const timer = setInterval(check, 1000);
  function stop() { clearInterval(timer); removeEventListener('blur', pause); removeEventListener('focus', resume); document.removeEventListener('visibilitychange', onVisibility); }
  return stop;
}

// Impresión de recomendación: solo cuando el elemento estuvo ≥ 50 % visible durante 1 s.
export function observeImpressions(root, placement, version = 'publica-v1') {
  if (!config?.enabled || !credentials() || !('IntersectionObserver' in window)) return;
  const seen = new Set(); const timers = new Map();
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    const element = entry.target; const id = element.dataset.recoProduct;
    if (!id || seen.has(id)) return;
    if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
      timers.set(id, setTimeout(() => { seen.add(id); observer.unobserve(element); track('recommendation_impression', { productId: id, properties: { placement, position: Number(element.dataset.recoPosition) || 0, reco_version: version } }); }, 1000));
    } else { clearTimeout(timers.get(id)); timers.delete(id); }
  }), { threshold: [0, 0.5, 1] });
  root.querySelectorAll('[data-reco-product]').forEach(element => observer.observe(element));
  root.addEventListener('click', event => {
    const element = event.target.closest('[data-reco-product]');
    if (element) track('recommendation_clicked', { productId: element.dataset.recoProduct, properties: { placement, position: Number(element.dataset.recoPosition) || 0, reco_version: version } });
  });
}

// Verificación del número por WhatsApp entrante (posesión del canal, sin cuenta).
export async function requestIdentityVerification(phone) {
  const creds = credentials();
  if (!creds || !getConsent().personalization) throw new Error('Activa la personalización para vincular tus compras.');
  const { data, error } = await supabase.rpc('request_identity_verification', { target: creds.id, secret: creds.secret, phone, session_ref: currentSession() });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}
