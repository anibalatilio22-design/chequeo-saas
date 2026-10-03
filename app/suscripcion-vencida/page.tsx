"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { CheckFlashLogo } from "@/components/checkflash-logo";

// A la que llega una empresa si el dueño del sistema la marcó como
// "suspended" desde /dueno — ver el chequeo en app/(dashboard)/layout.tsx.
// No tiene NavBar (está fuera del grupo (dashboard)) a propósito: no tiene
// sentido mostrar las pestañas de un sistema al que no puede entrar.
export default function SuscripcionVencidaPage() {
  const router = useRouter();
  const supabase = createClient();

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-white px-4">
      <CheckFlashLogo />
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-gray-200 bg-white p-6 text-center">
        <h1 className="text-lg font-semibold text-neutral-900">Suscripción no al día</h1>
        <p className="text-sm text-neutral-500">
          El acceso de tu empresa está pausado por el momento. Contactá a quien te dio de alta
          en el sistema para reactivarlo.
        </p>
        <button
          type="button"
          onClick={handleLogout}
          className="w-full rounded-md border border-gray-300 py-2 text-sm font-medium text-neutral-700"
        >
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}
