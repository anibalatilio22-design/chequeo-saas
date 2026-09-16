-- =========================================================================
-- DATOS DE PRUEBA — para probar la pantalla de armado de punta a punta.
-- Reemplazá 'TU_COMPANY_ID' por el id de tu empresa (el que usaste para
-- crear tu usuario admin, o corré: select id from public.companies limit 1;)
-- =========================================================================

-- 1) Un operario de prueba. PIN: 1234
--    (el hash ya viene calculado con el mismo algoritmo que usa el código)
insert into public.operators (company_id, full_name, pin_hash)
values (
  'TU_COMPANY_ID',
  'Juan Pérez',
  'b9d599970ea0951d41b60c03c50cbfc9:aef624d21432cea1226b0b86c4e02c01a5127df4925ddc3f39c0fa431fcc86c90dea611d659604771ca5ffb1e974a9f29e5638c40a3459ed467e0ec46fada2f8'
);

-- 2) Una receta de prueba: la etiqueta EAN "9999999999990" es un combo de
--    2 productos: 1 remera (EAN 1111111111111) + 1 gorra (EAN 2222222222222)
insert into public.recipes (company_id, label_ean, name)
values ('TU_COMPANY_ID', '9999999999990', 'Combo Remera + Gorra')
returning id;
-- copiá el id que te devuelve y usalo en el paso 3

-- 3) Los componentes de esa receta (reemplazá TU_RECIPE_ID por el id de arriba)
insert into public.recipe_components (company_id, recipe_id, product_ean, product_name, quantity)
values
  ('TU_COMPANY_ID', 'TU_RECIPE_ID', '1111111111111', 'Remera talle M', 1),
  ('TU_COMPANY_ID', 'TU_RECIPE_ID', '2222222222222', 'Gorra negra', 1);

-- 4) Un envío abierto de tipo Full
insert into public.shipments (company_id, code, type, status)
values ('TU_COMPANY_ID', 'FULL-PRUEBA-001', 'full', 'open')
returning id;
-- copiá el id que te devuelve y usalo en el paso 5

-- 5) Meter esa receta dentro del envío, pidiendo armar 3 unidades
--    (reemplazá TU_SHIPMENT_ID y TU_RECIPE_ID)
insert into public.shipment_items (company_id, shipment_id, recipe_id, quantity_required)
values ('TU_COMPANY_ID', 'TU_SHIPMENT_ID', 'TU_RECIPE_ID', 3);

-- =========================================================================
-- Con esto ya podés ir a /armado, elegir el envío "FULL-PRUEBA-001",
-- escanear la etiqueta 9999999999990, después los productos 1111111111111
-- y 2222222222222, y confirmar con "Juan Pérez" + PIN 1234.
-- =========================================================================
