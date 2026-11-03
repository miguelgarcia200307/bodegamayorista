import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../config.js';

const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };
// Una comprobación correcta vale para toda la sesión de navegación durante 15 minutos:
// navegar entre páginas ya no repite la consulta (antes: GraphQL + REST en cada página).
const READY_KEY = 'bm_backend_ready_v2';
const READY_TTL = 15 * 60 * 1000;
// Ninguna comprobación espera más de 8 s: "Intentar de nuevo" nunca queda colgado.
const REQUEST_TIMEOUT = 8000;
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
async function inspectBackend() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
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

// Al cargar la página, un fallo de red se reintenta una vez tras una breve espera. El botón
// "Intentar de nuevo" hace un único intento (máximo 8 s) y el usuario decide si repite.
async function inspectWithRetry({ retryOnNetwork }) {
  const first = await inspectBackend();
  const result = retryOnNetwork && first.reason === 'network'
    ? await new Promise(resolve => setTimeout(resolve, 1500)).then(inspectBackend)
    : first;
  if (result.ready) rememberReady();
  return result;
}

export function getBackendStatus({ refresh = false } = {}) {
  if (!refresh && !statusPromise && readyRecently()) statusPromise = Promise.resolve({ ready: true });
  if (refresh || !statusPromise) statusPromise = inspectWithRetry({ retryOnNetwork: !refresh });
  return statusPromise;
}
