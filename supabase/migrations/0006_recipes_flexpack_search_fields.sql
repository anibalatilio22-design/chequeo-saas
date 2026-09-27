-- El import de Flex/Colecta arma una "receta" automática por cada paquete
-- (ver FLEXPACK_LABEL_PREFIX en app/(dashboard)/envios/page.tsx). El parser
-- ya lee el Pack ID, la Venta y el nombre del cliente de cada paquete, pero
-- hasta ahora esos datos se descartaban después de la importación (solo
-- quedaba guardado el nombre del cliente, mezclado dentro del título de la
-- receta). Se agregan como columnas propias para poder buscarlos en Chequeo.
alter table public.recipes
  add column if not exists pack_id text,
  add column if not exists venta text,
  add column if not exists buyer_name text;
