import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../config.js';

const REQUIRED_QUERY_FIELDS = ['siteSettingsCollection', 'productsCollection'];
const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };
let statusPromise;

function normalizedFieldName(value = '') {
  return String(value).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

// GraphQL responde 200 aunque falten tablas, así que detecta una migración pendiente
// sin generar una cascada de 404. Si GraphQL no está habilitado, devuelve null.
async function inspectWithGraphql(signal) {
  const response = await fetch(`${SUPABASE_URL}/graphql/v1`, {
    method: 'POST', signal,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ __schema { queryType { fields { name } } } }' })
  });
  if (response.status === 401 || response.status === 403) return { ready: false, reason: 'configuration', status: response.status };
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null);
  const fields = payload?.data?.__schema?.queryType?.fields;
  if (!Array.isArray(fields)) return null;
  const available = new Set(fields.map(field => normalizedFieldName(field.name)));
  const ready = REQUIRED_QUERY_FIELDS.every(field => available.has(normalizedFieldName(field)));
  return ready ? { ready: true } : { ready: false, reason: 'schema' };
}

// Respaldo: una sola consulta mínima a la tabla de configuración.
async function inspectWithRest(signal) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/site_settings?select=id&limit=1`, { headers, signal });
  if (response.ok) return { ready: true };
  if (response.status === 401 || response.status === 403) return { ready: false, reason: 'configuration', status: response.status };
  if (response.status === 404) return { ready: false, reason: 'schema', status: 404 };
  return { ready: false, reason: 'network', status: response.status };
}

async function inspectBackend(timeoutMilliseconds) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    return (await inspectWithGraphql(controller.signal).catch(() => null)) || await inspectWithRest(controller.signal);
  } catch (error) {
    return { ready: false, reason: 'network', detail: error?.name || 'FetchError' };
  } finally {
    clearTimeout(timeout);
  }
}

// Con una conexión lenta, un único intento corto marcaba la tienda como no disponible
// aunque la base respondiera: los fallos de red se reintentan una vez con más margen.
// Los de configuración o esquema se informan de inmediato.
async function inspectWithRetry() {
  const first = await inspectBackend(10000);
  if (first.ready || first.reason !== 'network') return first;
  return inspectBackend(20000);
}

export function getBackendStatus({ refresh = false } = {}) {
  if (refresh || !statusPromise) statusPromise = inspectWithRetry();
  return statusPromise;
}
