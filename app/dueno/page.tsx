import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwnerEmail } from "@/lib/owner";
import type { Company } from "@/types/database.types";
import OwnerPanelClient from "./owner-panel-client";

// Panel del dueño del sistema: lista TODAS las empresas registradas (no solo
// la tuya) para marcar a mano cuál está al día y cuál no, mientras no haya
// cobro automático con Mercado Pago. Nadie más que vos puede entrar acá —
// el chequeo es por email (ver lib/owner.ts) y se hace en el servidor, no
// solo escondiendo el link, porque esta página usa el cliente admin para
// saltarse el aislamiento por empresa a propósito.
export default async function DuenoPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !isOwnerEmail(user.email)) {
    redirect("/");
  }

  const admin = createAdminClient();
  const { data: companiesRaw, error } = await admin
    .from("companies")
    .select("id, name, legal_name, subscription_status, paid_until, created_at")
    .order("created_at", { ascending: false });

  const companies = (companiesRaw ?? []) as Company[];

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Panel del dueño</h1>
        <p className="text-sm text-neutral-500">
          Todas las empresas que usan el sistema. Marcá a mano quién está al día con el pago —
          esto no cobra nada solo, es un control manual hasta que se conecte Mercado Pago.
        </p>
      </div>

      {error && (
        <p className="text-sm text-red-600">No se pudo cargar la lista: {error.message}</p>
      )}

      <OwnerPanelClient companies={companies} />
    </main>
  );
}
