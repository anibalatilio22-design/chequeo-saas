import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwnerEmail } from "@/lib/owner";
import type { SubscriptionStatus } from "@/types/database.types";

const VALID_STATUSES: SubscriptionStatus[] = ["trial", "active", "suspended"];

// Cambia el estado de pago de UNA empresa (no necesariamente la del que hace
// el pedido) — por eso, aunque la pantalla de /dueno ya filtra quién puede
// entrar, este endpoint vuelve a chequear el email acá, en el servidor, con
// la sesión real de la cookie. Nunca confiar en que el botón de la pantalla
// ya filtró bien: cualquiera podría mandar este pedido a mano.
export async function PATCH(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !isOwnerEmail(user.email)) {
    return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 403 });
  }

  let body: { id?: string; subscription_status?: string; paid_until?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Pedido inválido" }, { status: 400 });
  }

  const { id, subscription_status, paid_until } = body;

  if (!id || !subscription_status || !VALID_STATUSES.includes(subscription_status as SubscriptionStatus)) {
    return NextResponse.json({ ok: false, error: "Faltan datos o el estado no es válido" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await (admin.from("companies") as any)
    .update({ subscription_status, paid_until: paid_until || null })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

// Borra una empresa y TODO lo suyo (productos, recetas, envíos, armados,
// usuarios) a pedido explícito — "para que no nos robe espacio" una empresa
// que no vuelve más. Es irreversible, por eso: (1) el botón del panel pide
// confirmación antes de llamar acá, y (2) acá se vuelve a chequear el email
// igual que en PATCH, nunca confiar en el filtro de la pantalla.
//
// El orden de borrado importa: primero las tablas "hijas" (completions,
// shipment_items, etc.) y recién al final products y la propia company —
// así no choca con las relaciones que, para productos, no se borran en
// cascada solas (mismo motivo por el que existe forceDeleteProduct en
// recetas/page.tsx). Los usuarios de Supabase Auth de esta empresa se
// borran uno por uno con admin.auth.admin.deleteUser: borrar solo la fila
// de public.users dejaría la cuenta de login dando vueltas para siempre.
export async function DELETE(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !isOwnerEmail(user.email)) {
    return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ ok: false, error: "Falta el id de la empresa" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: usersRaw } = await admin.from("users").select("id").eq("company_id", id);
  const userIds = ((usersRaw ?? []) as { id: string }[]).map((u) => u.id);

  await admin.from("completions").delete().eq("company_id", id);
  await admin.from("shipment_items").delete().eq("company_id", id);
  await admin.from("shipments").delete().eq("company_id", id);
  await admin.from("recipe_components").delete().eq("company_id", id);
  await admin.from("recipes").delete().eq("company_id", id);
  await admin.from("product_stock").delete().eq("company_id", id);
  await admin.from("products").delete().eq("company_id", id);
  await admin.from("operators").delete().eq("company_id", id);
  await admin.from("workstations").delete().eq("company_id", id);

  for (const userId of userIds) {
    await admin.auth.admin.deleteUser(userId);
  }

  const { error } = await admin.from("companies").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
