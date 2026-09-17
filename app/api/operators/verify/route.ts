import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { verifyPin } from "@/lib/pin";

// El cliente nunca ve pin_hash. Manda operator_id + pin en texto plano por
// HTTPS, este endpoint lo compara del lado del servidor y responde ok/no.
export async function POST(request: Request) {
  const { operator_id, pin } = await request.json();

  if (!operator_id || !pin) {
    return NextResponse.json({ ok: false, error: "Faltan datos" }, { status: 400 });
  }

  const supabase = await createClient();

  // RLS ya filtra por company_id del usuario logueado, así que esta consulta
  // solo puede traer operarios de la propia empresa.
  const { data: operatorRaw, error } = await supabase
    .from("operators")
    .select("id, full_name, pin_hash, active")
    .eq("id", operator_id)
    .single();

  // El cliente tipado no siempre resuelve bien el tipo de este resultado
  // (mismo motivo de fondo que otros casteos de la app), así que lo
  // casteamos a mano para poder acceder a sus propiedades sin error.
  const operator = operatorRaw as { id: string; full_name: string; pin_hash: string; active: boolean } | null;

  if (error || !operator || !operator.active) {
    return NextResponse.json({ ok: false, error: "Operario no encontrado" }, { status: 404 });
  }

  const valid = verifyPin(pin, operator.pin_hash);

  if (!valid) {
    return NextResponse.json({ ok: false, error: "PIN incorrecto" }, { status: 401 });
  }

  return NextResponse.json({ ok: true, operator_name: operator.full_name });
}
