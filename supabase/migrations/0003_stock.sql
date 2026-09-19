-- =========================================================================
-- Stock / Inventario — primer paso
-- =========================================================================
-- Base para el futuro módulo de Stock/Reserva/Disponible: por ahora solo
-- guarda "cuánto tenés de cada producto, en cada sucursal/depósito" y
-- cuándo fue el último ingreso. El día que se sumen reservas (por envíos
-- abiertos) y ventas de mostrador, "Disponible" se va a poder calcular
-- solo (Stock menos lo reservado) sin tener que tocar esto de nuevo.
--
-- El stock se guarda por SUCURSAL desde el día uno (no como un solo número
-- en "products") porque el usuario ya avisó que a futuro quiere manejar
-- varias sucursales/depósitos — así, cuando llegue ese día, alcanza con
-- agregar una fila nueva en "locations", sin migrar nada de esto.

create table public.locations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now(),
  unique (company_id, name)
);

create index locations_company_id_idx on public.locations(company_id);

create table public.product_stock (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  product_id        uuid not null references public.products(id) on delete cascade,
  location_id       uuid not null references public.locations(id) on delete cascade,
  quantity          integer not null default 0 check (quantity >= 0),
  -- Fecha del último INGRESO (cuando quantity sube) — la pone el propio
  -- sistema con la hora del servidor, nunca se escribe a mano desde el
  -- cliente. Si en algún momento se corrige el número para abajo (un
  -- ajuste, no un ingreso real), esta fecha no se toca.
  last_received_at  timestamptz,
  updated_at        timestamptz not null default now(),
  unique (product_id, location_id)
);

create index product_stock_company_id_idx on public.product_stock(company_id);
create index product_stock_product_id_idx on public.product_stock(product_id);
create index product_stock_location_id_idx on public.product_stock(location_id);

create trigger product_stock_set_updated_at
  before update on public.product_stock
  for each row execute function public.set_updated_at();

-- Una sucursal/depósito por defecto para cada empresa que ya exista, así
-- no queda ninguna sin dónde guardar su stock. Se puede renombrar después
-- desde la app sin problema.
insert into public.locations (company_id, name)
select id, 'Depósito principal'
from public.companies
on conflict (company_id, name) do nothing;

alter table public.locations enable row level security;
alter table public.product_stock enable row level security;

create policy "locations_select"
  on public.locations for select
  using (company_id = public.current_company_id());

create policy "locations_admin_write"
  on public.locations for insert
  with check (company_id = public.current_company_id() and public.current_user_role() = 'admin');

create policy "locations_admin_update"
  on public.locations for update
  using (company_id = public.current_company_id() and public.current_user_role() = 'admin');

create policy "locations_admin_delete"
  on public.locations for delete
  using (company_id = public.current_company_id() and public.current_user_role() = 'admin');

create policy "product_stock_select"
  on public.product_stock for select
  using (company_id = public.current_company_id());

create policy "product_stock_admin_write"
  on public.product_stock for insert
  with check (company_id = public.current_company_id() and public.current_user_role() = 'admin');

create policy "product_stock_admin_update"
  on public.product_stock for update
  using (company_id = public.current_company_id() and public.current_user_role() = 'admin');

create policy "product_stock_admin_delete"
  on public.product_stock for delete
  using (company_id = public.current_company_id() and public.current_user_role() = 'admin');
