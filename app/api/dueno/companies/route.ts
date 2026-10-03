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
