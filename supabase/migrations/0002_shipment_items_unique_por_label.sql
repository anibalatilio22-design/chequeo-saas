-- Un mismo envío de Mercado Libre puede traer el MISMO producto/receta en
-- más de una línea del PDF: ML genera un "Código ML" (label) distinto por
-- cada publicación, aunque el producto de atrás sea el mismo (por ejemplo,
-- un combo vendido en dos publicaciones distintas dentro del mismo envío).
--
-- El unique original (shipment_id, recipe_id) no dejaba cargar la segunda
-- línea: apenas encontraba la misma receta dos veces en el mismo envío,
-- la segunda fallaba con "duplicate key value violates unique constraint
-- shipment_items_shipment_id_recipe_id_key".
--
-- Lo correcto es que cada línea sea única por su propio código de escaneo
-- (label_ean, que es el "Código ML" de esa línea puntual), no por receta:
-- dos líneas con la misma receta pero distinto label_ean son dos cajas /
-- lotes físicos distintos que hay que armar y escanear por separado.
alter table public.shipment_items add column if not exists label_ean text;

alter table public.shipment_items
  drop constraint if exists shipment_items_shipment_id_recipe_id_key;

alter table public.shipment_items
  add constraint shipment_items_shipment_id_label_ean_key unique (shipment_id, label_ean);
