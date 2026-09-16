import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/types/database.types";

// Usar dentro de "use client" components — por ejemplo la pantalla de
// armado, que necesita Realtime para ver el progreso actualizarse solo.
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
