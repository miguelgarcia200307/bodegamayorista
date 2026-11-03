import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../config.js';

const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };
// Una comprobación correcta vale para toda la sesión de navegación durante 15 minutos:
// navegar entre páginas ya no repite la consulta (antes: GraphQL + REST en cada página).
const READY_KEY = 'bm_backend_ready_v2';
const READY_TTL = 15 * 60 * 1000;
let statusPromise;

function readyRecently() {
  try { return Date.now() - Number(sessionStorage.getItem(READY_KEY) || 0) < READY_TTL; }
  catch { return false; }
}

function rememberReady() {
  try { sessionStorage.setItem(READY_KEY, String(Date.now())); } catch { /* almacenamiento no disponible */ }
}

// Una sola consulta mínima ([{"id":1}]). 404 = esquema sin instalar; 402/429/5xx = servicio
// restringido o caído: se informa sin reintentar para no sumar peticiones.
async function inspectBackend(timeoutMilliseconds) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/site_settings?select=id&limit=1`, { headers, signal: controller.signal });
    if (response.ok) return { ready: true };
    if (response.status === 401 || response.status === 403) return { ready: false, reason: 'configuration', status: response.status };
    if (response.status === 404) return { ready: false, reason: 'schema', status: 404 };
    return { ready: false, reason: 'unavailable', status: response.status };
  } catch (error) {
    return { ready: false, reason: 'network', detail: error?.name || 'FetchError' };
  } finally {
    clearTimeout(timeout);
  }
}

// Con una conexión lenta un intento corto puede fallar aunque la base responda: solo los
// fallos de red se reintentan, una vez, tras una espera y con más margen de tiempo.
async function inspectWithRetry() {
  const first = await inspectBackend(10000);
  const result = first.reason === 'network'
    ? await new Promise(resolve => setTimeout(resolve, 1500)).then(() => inspectBackend(20000))
    : first;
  if (result.ready) rememberReady();
  return result;
}

export function getBackendStatus({ refresh = false } = {}) {
  if (!refresh && !statusPromise && readyRecently()) statusPromise = Promise.resolve({ ready: true });
  if (refresh || !statusPromise) statusPromise = inspectWithRetry();
  return statusPromise;
}
