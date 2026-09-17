import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hashPin } from "@/lib/pin";

// El PIN en texto plano llega acá por HTTPS, se hashea en el servidor y
// se inserta ya hasheado. El navegador nunca ve ni maneja pin_hash.
export async function POST(request: Request) {
  const { full_name, pin } = await request.json();

  if (!full_name || !pin) {
    return NextResponse.json({ ok: false, error: "Faltan datos" }, { status: 400 });
  }

  if (!/^\d{4,6}$/.test(pin)) {
    return NextResponse.json(
      { ok: false, error: "El PIN debe tener entre 4 y 6 números" },
      { status: 400 }
    );
  }

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
  }

  const { data: profileRaw } = await supabase
    .from("users")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  // El cliente tipado no siempre resuelve bien el tipo de este resultado
  // (mismo motivo de fondo que otros casteos de la app), así que lo
  // casteamos a mano para poder acceder a sus propiedades sin error.
  const profile = profileRaw as { company_id: string; role: string } | null;

  if (!profile || profile.role !== "admin") {
    return NextResponse.json({ ok: false, error: "Solo un admin puede crear operarios" }, { status: 403 });
  }

  const pin_hash = hashPin(pin);

  const { error } = await supabase.from("operators").insert({
    company_id: profile.company_id,
    full_name,
    pin_hash,
  } as any);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
