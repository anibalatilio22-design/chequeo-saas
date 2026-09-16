import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

// Cliente con la service_role key: se salta RLS por completo. USAR SOLO EN
// CÓDIGO DE SERVIDOR (Route Handlers), nunca en el navegador — por eso la
// key vive en SUPABASE_SERVICE_ROLE_KEY (sin el prefijo NEXT_PUBLIC_, que es
// lo que hace que Next.js NO la mande nunca al cliente).
//
// Se usa solo para el alta de una empresa nueva (signup): hay que crear la
// fila de company y el primer usuario admin ANTES de que exista ningún
// company_id con el que las políticas de RLS puedan autorizar algo — con el
// cliente normal (anon key) esas dos inserciones quedarían bloqueadas.
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Falta configurar SUPABASE_SERVICE_ROLE_KEY en las variables de entorno del servidor (.env.local en local, o las env vars del hosting en producción)."
    );
  }

  return createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
