-- Agrega la razón social de la empresa (nombre legal/registrado), separada
-- del "name" que ya existía (nombre comercial, el que se usa en la barra de
-- arriba). Se muestra en el encabezado del remito de despacho junto con el
-- nombre, dirección y teléfono.
alter table public.companies
  add column if not exists legal_name text;
