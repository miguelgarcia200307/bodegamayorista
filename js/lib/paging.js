// --- Paginación explícita ------------------------------------------------------------
// PostgREST limita cada respuesta (por defecto 1000 filas). Se recorre por páginas con
// orden estable hasta recibir una página incompleta. Si se alcanza el tope de seguridad
// el resultado se marca como truncado: nunca se confunde con el final del historial.
export const PAGE_SIZE = 500;
export async function fetchAllPages(build, { pageSize = PAGE_SIZE, maxRows = 20000 } = {}) {
  const rows = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return Object.assign(rows, { complete: true, truncated: false });
  }
  return Object.assign(rows, { complete: false, truncated: true });
}
