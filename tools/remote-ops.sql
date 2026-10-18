-- Operación del proyecto remoto (no es una migración: usa extensiones de Supabase que
-- PGlite no tiene). Idempotente. Ejecutar con: node tools/remote-ops.mjs
-- 1) Depuración diaria de navegación (03:15 hora de Bogotá = 08:15 UTC).
create extension if not exists pg_cron with schema pg_catalog;
select cron.unschedule(jobid) from cron.job where jobname = 'bodega-purga-navegacion';
select cron.schedule('bodega-purga-navegacion', '15 8 * * *', $$select public.purge_behavior_data()$$);
-- 2) Hallazgo N1: las funciones futuras creadas por postgres no quedan ejecutables por
--    PUBLIC (anon). Las funciones públicas necesarias se conceden explícitamente.
alter default privileges for role postgres revoke execute on functions from public;
select jobname, schedule, active from cron.job where jobname = 'bodega-purga-navegacion';
