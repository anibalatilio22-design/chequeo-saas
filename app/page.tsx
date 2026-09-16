import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Página raíz ("/"): no tiene contenido propio, solo redirige.
// Si está logueado, va directo a Armado (pantalla principal).
// Si no, al login.
export default async function Home() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  redirect("/armado");
}
