import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';

async function fetchWithTimeout(input, options = {}) {
  const controller = new AbortController();
  const url = typeof input === 'string' ? input : input.url;
  const method = String(options.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
  const isStorageUpload = /\/storage\/v1\/object\//.test(url) && ['POST', 'PUT'].includes(method);
  const timeoutMilliseconds = isStorageUpload ? 120_000 : 12_000;
  const abort = () => controller.abort(options.signal?.reason);
  const timeout = setTimeout(() => controller.abort(new DOMException('La solicitud superó el tiempo de espera.', 'TimeoutError')), timeoutMilliseconds);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  try { return await fetch(input, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timeout);options.signal?.removeEventListener('abort', abort); }
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  global: { fetch: fetchWithTimeout }
});
