-- Foto de referencia y link a la publicación de Mercado Libre para cada
-- producto del catálogo (tanto el ítem final de una receta como cualquiera
-- de sus componentes) — para que el operario pueda verificar un producto
-- por imagen o abriendo la publicación si tiene dudas al escanear, sin
-- salir de la pantalla de Armado.
alter table public.products
  add column if not exists image_url text,
  add column if not exists ml_link text;

-- Bucket de Storage para las fotos de producto, con el mismo criterio que
-- ya se usa para el logo de la empresa ("company-logos"): un bucket público
-- (para poder mostrar la imagen directo con una URL pública, sin firmar
-- cada acceso) donde cualquier usuario autenticado de la empresa puede
-- subir/reemplazar/borrar sus propias fotos. Se crea acá por migración
-- (en vez de pedir que se configure a mano en el panel de Supabase) para
-- que quede reproducible.
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

drop policy if exists "product_images_read" on storage.objects;
create policy "product_images_read" on storage.objects
  for select using (bucket_id = 'product-images');

drop policy if exists "product_images_write" on storage.objects;
create policy "product_images_write" on storage.objects
  for insert to authenticated with check (bucket_id = 'product-images');

drop policy if exists "product_images_update" on storage.objects;
create policy "product_images_update" on storage.objects
  for update to authenticated using (bucket_id = 'product-images');

drop policy if exists "product_images_delete" on storage.objects;
create policy "product_images_delete" on storage.objects
  for delete to authenticated using (bucket_id = 'product-images');
