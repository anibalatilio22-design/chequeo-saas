-- =========================================================================
-- Chequeo Full/Flex/Colecta — esquema inicial
-- Multi-tenant vía RLS por company_id
-- =========================================================================

create extension if not exists "pgcrypto"; -- para gen_random_uuid()

-- -------------------------------------------------------------------------
-- ENUMS
-- -------------------------------------------------------------------------
create type user_role as enum ('admin', 'operario');
create type shipment_type as enum ('full', 'flex', 'colecta');
create type shipment_status as enum ('open', 'closed', 'archived');

-- -------------------------------------------------------------------------
-- COMPANIES
-- Cada depósito/cliente del SaaS
-- -------------------------------------------------------------------------
create table public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  created_at  timestamptz not null default now()
);

-- -------------------------------------------------------------------------
-- USERS
-- Perfil de app 1:1 con auth.users. Quien entra al panel web.
-- role = admin (config, recetas, envíos) | operario (solo pantalla de armado)
-- -------------------------------------------------------------------------
create table public.users (
  id          uuid primary key references auth.users(id) on delete cascade,
  company_id  uuid not null references public.companies(id) on delete cascade,
  full_name   text not null,
  role        user_role not null default 'operario',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create index users_company_id_idx on public.users(company_id);

-- -------------------------------------------------------------------------
-- WORKSTATIONS
-- "Puesto de trabajo" — una PC/terminal de escaneo dentro del depósito
-- -------------------------------------------------------------------------
create table public.workstations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  name        text not null,
  device_key  text,              -- identificador guardado en localStorage del navegador
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (company_id, name)
);

create index workstations_company_id_idx on public.workstations(company_id);

-- -------------------------------------------------------------------------
-- OPERATORS
-- Padrón de armadores de piso. NO son cuentas de Supabase Auth: firman cada
-- unidad con nombre + PIN corto (hasheado), tal como en el prototipo actual.
-- -------------------------------------------------------------------------
create table public.operators (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  full_name   text not null,
  pin_hash    text not null,      -- hash del PIN/contraseña de operario (bcrypt, nunca texto plano)
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (company_id, full_name)
);

create index operators_company_id_idx on public.operators(company_id);

-- -------------------------------------------------------------------------
-- RECIPES ("recetas")
-- Un EAN de etiqueta de ML mapea a 1+ productos reales
-- -------------------------------------------------------------------------
create table public.recipes (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  label_ean   text not null,     -- EAN de la etiqueta de Mercado Libre
  name        text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, label_ean)
);

create index recipes_company_id_idx on public.recipes(company_id);

create table public.recipe_components (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade, -- desnormalizado a propósito, simplifica RLS e índices
  recipe_id     uuid not null references public.recipes(id) on delete cascade,
  product_ean   text not null,
  product_name  text not null,
  quantity      integer not null default 1 check (quantity > 0),
  created_at    timestamptz not null default now()
);

create index recipe_components_recipe_id_idx on public.recipe_components(recipe_id);
create index recipe_components_company_id_idx on public.recipe_components(company_id);

-- -------------------------------------------------------------------------
-- SHIPMENTS ("envío activo")
-- -------------------------------------------------------------------------
create table public.shipments (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  code        text not null,     -- identificador interno del envío (ej: "FULL-2026-09-06")
  type        shipment_type not null,
  status      shipment_status not null default 'open',
  created_at  timestamptz not null default now(),
  closed_at   timestamptz
);

create index shipments_company_id_idx on public.shipments(company_id);
create index shipments_status_idx on public.shipments(company_id, status);

create table public.shipment_items (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id) on delete cascade,
  shipment_id         uuid not null references public.shipments(id) on delete cascade,
  recipe_id           uuid not null references public.recipes(id),
  quantity_required   integer not null check (quantity_required > 0),
  created_at          timestamptz not null default now(),
  unique (shipment_id, recipe_id)
);

create index shipment_items_shipment_id_idx on public.shipment_items(shipment_id);
create index shipment_items_company_id_idx on public.shipment_items(company_id);

-- -------------------------------------------------------------------------
-- COMPLETIONS
-- Cada vez que se termina de armar UNA unidad de una receta.
-- Sumar completions con mismo shipment_item_id = avance de esa receta.
-- -------------------------------------------------------------------------
create table public.completions (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id) on delete cascade,
  shipment_item_id    uuid not null references public.shipment_items(id) on delete cascade,
  recipe_id           uuid not null references public.recipes(id),
  operator_id         uuid not null references public.operators(id),
  workstation_id      uuid references public.workstations(id),
  user_id             uuid references public.users(id),   -- usuario logueado en esa PC (auditoría)
  scanned_components  jsonb,     -- [{ean, product_name, ok, scanned_at}, ...] detalle del armado
  completed_at        timestamptz not null default now()
);

create index completions_shipment_item_id_idx on public.completions(shipment_item_id);
create index completions_company_id_idx on public.completions(company_id);
create index completions_operator_id_idx on public.completions(operator_id);

-- -------------------------------------------------------------------------
-- Vista de progreso por receta dentro de un envío (evita recalcular en el front)
-- -------------------------------------------------------------------------
create view public.shipment_progress as
select
  si.id as shipment_item_id,
  si.shipment_id,
  si.company_id,
  si.recipe_id,
  r.name as recipe_name,
  r.label_ean,
  si.quantity_required,
  count(c.id) as quantity_completed
from public.shipment_items si
join public.recipes r on r.id = si.recipe_id
left join public.completions c on c.shipment_item_id = si.id
group by si.id, si.shipment_id, si.company_id, si.recipe_id, r.name, r.label_ean, si.quantity_required;

-- -------------------------------------------------------------------------
-- Trigger: updated_at automático en recipes
-- -------------------------------------------------------------------------
create function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger recipes_set_updated_at
  before update on public.recipes
  for each row execute function public.set_updated_at();

-- =========================================================================
-- ROW LEVEL SECURITY
-- =========================================================================

-- Función helper: empresa del usuario logueado (security definer para poder
-- leer public.users sin recursión de RLS sobre sí misma)
create function public.current_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select company_id from public.users where id = auth.uid();
$$;

create function public.current_user_role()
returns user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.users where id = auth.uid();
$$;

alter table public.companies enable row level security;
alter table public.users enable row level security;
alter table public.workstations enable row level security;
alter table public.operators enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_components enable row level security;
alter table public.shipments enable row level security;
alter table public.shipment_items enable row level security;
alter table public.completions enable row level security;

-- companies: cualquier usuario ve solo la suya. Alta de empresas se hace
-- con service role desde el flujo de onboarding (server action), no desde el cliente.
create policy "companies_select_own"
  on public.companies for select
  using (id = public.current_company_id());

-- users: ver compañeros de la misma empresa; solo admin gestiona altas/bajas
create policy "users_select_same_company"
  on public.users for select
  using (company_id = public.current_company_id());

create policy "users_admin_manage"
  on public.users for all
  using (company_id = public.current_company_id() and public.current_user_role() = 'admin')
  with check (company_id = public.current_company_id() and public.current_user_role() = 'admin');

-- workstations: lectura para toda la empresa, escritura solo admin
create policy "workstations_select"
  on public.workstations for select
  using (company_id = public.current_company_id());

create policy "workstations_admin_write"
  on public.workstations for insert
  with check (company_id = public.current_company_id() and public.current_user_role() = 'admin');

create policy "workstations_admin_update"
  on public.workstations for update
  using (company_id = public.current_company_id() and public.current_user_role() = 'admin');

create policy "workstations_admin_delete"
  on public.workstations for delete
  using (company_id = public.current_company_id() and public.current_user_role() = 'admin');

-- operators: lectura para toda la empresa (se necesita para el picker de armado),
-- alta/baja solo admin
create policy "operators_select"
  on public.operators for select
  using (company_id = public.current_company_id());

create policy "operators_admin_write"
  on public.operators for insert
  with check (company_id = public.current_company_id() and public.current_user_role() = 'admin');

create policy "operators_admin_update"
  on public.operators for update
  using (company_id = public.current_company_id() and public.current_user_role() = 'admin');

create policy "operators_admin_delete"
  on public.operators for delete
  using (company_id = public.current_company_id() and public.current_user_role() = 'admin');

-- recipes / recipe_components: lectura para toda la empresa, escritura solo admin
create policy "recipes_select"
  on public.recipes for select
  using (company_id = public.current_company_id());

create policy "recipes_admin_write"
  on public.recipes for insert
  with check (company_id = public.current_company_id() and public.current_user_role() = 'admin');

create policy "recipes_admin_update"
  on public.recipes for update
  using (company_id = public.current_company_id() and public.current_user_role() = 'admin');

create policy "recipes_admin_delete"
  on public.recipes for delete
  using (company_id = public.current_company_id() and public.current_user_role() = 'admin');

create policy "recipe_components_select"
  on public.recipe_components for select
  using (company_id = public.current_company_id());

create policy "recipe_components_admin_write"
  on public.recipe_components for insert
  with check (company_id = public.current_company_id() and public.current_user_role() = 'admin');

create policy "recipe_components_admin_update"
  on public.recipe_components for update
  using (company_id = public.current_company_id() and public.current_user_role() = 'admin');

create policy "recipe_components_admin_delete"
  on public.recipe_components for delete
  using (company_id = public.current_company_id() and public.current_user_role() = 'admin');

-- shipments / shipment_items: lectura para toda la empresa, escritura solo admin
create policy "shipments_select"
  on public.shipments for select
  using (company_id = public.current_company_id());

create policy "shipments_admin_write"
  on public.shipments for insert
  with check (company_id = public.current_company_id() and public.current_user_role() = 'admin');

create policy "shipments_admin_update"
  on public.shipments for update
  using (company_id = public.current_company_id() and public.current_user_role() = 'admin');

create policy "shipment_items_select"
  on public.shipment_items for select
  using (company_id = public.current_company_id());

create policy "shipment_items_admin_write"
  on public.shipment_items for insert
  with check (company_id = public.current_company_id() and public.current_user_role() = 'admin');

create policy "shipment_items_admin_update"
  on public.shipment_items for update
  using (company_id = public.current_company_id() and public.current_user_role() = 'admin');

create policy "shipment_items_admin_delete"
  on public.shipment_items for delete
  using (company_id = public.current_company_id() and public.current_user_role() = 'admin');

-- completions: lectura para toda la empresa (tabla de progreso).
-- Inserción para CUALQUIER usuario logueado de la empresa (admin u operario),
-- porque el armado en piso lo dispara cualquiera de los dos roles.
-- No se permite update/delete desde el cliente: la trazabilidad no se edita,
-- se corrige con un registro nuevo o desde el backend con service role.
create policy "completions_select"
  on public.completions for select
  using (company_id = public.current_company_id());

create policy "completions_insert"
  on public.completions for insert
  with check (company_id = public.current_company_id());

-- Nota: no se crea policy de update/delete para completions => quedan bloqueados
-- por RLS por defecto (deny-by-default una vez que RLS está habilitado).
