import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import NavBar from "./nav-bar";

// Layout compartido por todas las pestañas internas (Armado, Recetas,
// Envío, Progreso, Configuración) — igual estructura que el prototipo.
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profileRaw } = await supabase
    .from("users")
    .select("full_name, role, company_id")
    .eq("id", user.id)
    .single();

  // El cliente tipado no siempre resuelve bien el tipo de este resultado
  // (mismo motivo de fondo que otros casteos de la app), así que lo
  // casteamos a mano para poder acceder a sus propiedades sin error.
  const profile = profileRaw as { full_name: string | null; role: string; company_id: string | null } | null;

  let companyName: string | null = null;
  let logoUrl: string | null = null;

  if (profile?.company_id) {
    const { data: companyData } = await supabase
      .from("companies")
      .select("name, logo_url")
      .eq("id", profile.company_id)
      .single();
    companyName = companyData?.name ?? null;
    logoUrl = companyData?.logo_url ?? null;
  }

  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <NavBar
        userName={profile?.full_name ?? null}
        role={profile?.role ?? "operario"}
        companyName={companyName}
        logoUrl={logoUrl}
      />
      {children}
    </div>
  );
}
