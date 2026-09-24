-- Forma de chequeo de un envío Full: "unidad" (repetir todo el ciclo de
-- escaneo por cada unidad, como siempre) o "item" (escanear los componentes
-- una sola vez y confirmar de golpe todas las unidades del ítem). Antes esto
-- lo elegía el operario en la pantalla de Armado, escaneo a escaneo — ahora
-- pasa a ser una decisión del administrador, fijada UNA VEZ por envío
-- completo desde la pantalla de Envío, para que no quede en manos del
-- operario. Para Flex/Colecta no se usa (cada paquete ya es 1 unidad), pero
-- se agrega igual a toda la tabla para no tener que distinguir por tipo acá.
alter table public.shipments
  add column if not exists check_mode text not null default 'unidad'
    check (check_mode in ('unidad', 'item'));
