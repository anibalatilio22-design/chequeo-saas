# Chequeo Full / Flex / Colecta — SaaS

Migración del prototipo HTML/JS a producto real: Next.js + Supabase (Postgres + Auth + Realtime), desplegado en Vercel.

## 1. Modelo de datos

Ver `supabase/migrations/0001_initial_schema.sql` — es la migración completa, lista para correr.

```
companies
 └─ users              (cuentas Supabase Auth: admin | operario, login al panel)
 └─ workstations        ("puesto de trabajo" por PC)
 └─ operators           (padrón de armadores de piso, firman con nombre + PIN, NO son auth.users)
 └─ recipes             (EAN de etiqueta ML → nombre)
     └─ recipe_components  (EAN real, nombre, cantidad)
 └─ shipments           (envío activo: full | flex | colecta)
     └─ shipment_items      (qué receta y cuánta cantidad hay que armar)
         └─ completions          (cada unidad armada: operario, workstation, detalle de escaneo)
```

**Por qué `users` y `operators` están separados:** en tu flujo actual, el operario de piso no "inicia sesión" en cada PC — firma cada armado con nombre + contraseña corta, sin salir de la sesión de la PC. Forzarlo a loguearse con Supabase Auth cada vez rompería el flujo real. Entonces:

- `users` = quién tiene acceso al **panel** (una PC ya logueada con un usuario admin u operario de Supabase Auth).
- `operators` = **quién firma cada unidad armada**, verificado con PIN propio, independiente de la sesión del navegador.

Si en algún depósito el operario de piso SÍ va a loguearse individualmente en el futuro, se puede fusionar `operators` en `users` sin romper el resto del esquema (`completions.operator_id` seguiría apuntando a la misma tabla).

**Vista `shipment_progress`:** resuelve el "tabla con avance por receta" sin que el frontend tenga que hacer `count()` a mano — Realtime puede suscribirse a `completions` y refrescar esta vista.

## 2. Multi-tenant y seguridad

- Todas las tablas tienen `company_id` y RLS habilitado.
- `current_company_id()` es una función `security definer` que resuelve la empresa del usuario logueado (vía `public.users`), y todas las policies filtran por ella. Esto evita repetir subqueries y hace imposible que una empresa vea filas de otra, incluso si hay un bug en el frontend.
- Escritura de configuración (recetas, envíos, operadores, workstations, altas de usuarios) restringida a `role = 'admin'`.
- `completions` (el evento de "armé una unidad") se puede insertar desde cualquier usuario logueado de la empresa, pero **no tiene policy de update/delete** → con RLS habilitado eso las bloquea por defecto. La trazabilidad no se edita.
- Alta de una **empresa nueva** (onboarding de un cliente del SaaS) no tiene policy de insert para el cliente: se hace desde un Server Action con `SUPABASE_SERVICE_ROLE_KEY`, que crea `companies` + el primer `users` con `role = 'admin'` en una transacción. Así evitamos que cualquiera se autoasigne una empresa.

## 3. Estructura del proyecto

```
app/
  login/page.tsx          → login con Supabase Auth (reemplaza la contraseña única)
  (dashboard)/
    armado/                → pantalla principal: escaneo de etiqueta + componentes
    envios/                → alta/consulta de envíos y su progreso
    recetas/                → alta/edición de recetas + carga masiva CSV
    config/                → operadores, workstations, usuarios
lib/supabase/
  client.ts                → cliente para Client Components (necesario para Realtime)
  server.ts                → cliente para Server Components / Server Actions
  middleware.ts             → refresco de sesión
middleware.ts              → intercepta requests, protege rutas privadas
types/database.types.ts    → tipos a mano (reemplazar con `npm run db:types`)
supabase/migrations/       → esquema versionado
```

Falta crear en esta primera pasada (a propósito, para no bloquear la revisión del esquema): las páginas de `envios`, `recetas` y `config`, y el layout del dashboard. La pantalla de **armado** es la más sensible al feedback sonoro/visual inmediato del prototipo, así que conviene portarla primero manteniendo esa lógica intacta, solo cambiando `localStorage` por `supabase.from(...)` + una suscripción Realtime a `completions` para que el contador de avance se actualice en todas las PCs a la vez, no solo en la que escaneó.

## 4. Cómo levantar el proyecto

```bash
npx create-next-app@latest . --typescript --tailwind --app --src-dir=false --import-alias "@/*"
# (o clonar esta estructura sobre un proyecto nuevo)

npm install

cp .env.local.example .env.local
# completar con los datos de Project Settings > API de tu proyecto Supabase

npx supabase login
npx supabase link --project-ref <tu-project-ref>
npx supabase db push   # aplica supabase/migrations/0001_initial_schema.sql

npm run dev
```

## 5. Próximos pasos sugeridos (en orden)

1. **Server Action de onboarding**: `crear empresa + primer admin` usando service role — es el único punto de entrada para nuevas empresas del SaaS.
2. **Portar la pantalla de armado** con Realtime, manteniendo el feedback sonoro/visual del prototipo.
3. **CSV masivo de recetas y envíos** con `papaparse`, validando con `zod` antes de insertar (mismo formato que ya usás, pero validado servidor-side).
4. **Panel de config**: alta/baja de operadores y workstations, gestión de usuarios (solo admin).
5. Más adelante: integración API de Mercado Libre para traer pedidos Full/Flex/Colecta automáticamente (reemplazaría la carga manual de `shipments`/`shipment_items`).

## 6. Notas de seguridad para el PIN de operarios

`operators.pin_hash` debe guardarse hasheado (bcrypt vía `bcryptjs`, corrido en un Server Action o Route Handler, nunca en el cliente) — aunque sea un PIN corto de 4-6 dígitos, es lo que autentica quién arma cada unidad y puede tener implicancias legales/laborales si hay reclamos de productividad o errores.
