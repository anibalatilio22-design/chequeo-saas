"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const TABS = [
  { href: "/armado", label: "Chequeo", adminOnly: false },
  { href: "/recetas", label: "Stock", adminOnly: false },
  { href: "/envios", label: "Envío", adminOnly: false },
  { href: "/progreso", label: "Progreso", adminOnly: false },
  { href: "/config", label: "Configuración", adminOnly: true },
];

export default function NavBar({
  userName,
  role,
  companyName,
  logoUrl,
}: {
  userName: string | null;
  role: "admin" | "operario";
  companyName?: string | null;
  logoUrl?: string | null;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="bg-yellow-400 shadow-sm">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-2">
        {(logoUrl || companyName) && (
          <div className="flex shrink-0 items-center gap-3">
            {logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl}
                alt={companyName ? `Logo de ${companyName}` : "Logo de la empresa"}
                className="h-16 w-16 rounded-md bg-white/60 object-contain p-1"
              />
            )}
            {companyName && (
              <span className="hidden text-base font-semibold text-neutral-900 sm:inline">
                {companyName}
              </span>
            )}
          </div>
        )}

        <nav className="flex gap-6">
          {TABS.filter((tab) => !tab.adminOnly || role === "admin").map((tab) => {
            const active = pathname?.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={`border-b-2 py-4 text-sm font-semibold transition-colors ${
                  active
                    ? "border-neutral-900 text-neutral-900"
                    : "border-transparent text-neutral-700 hover:text-neutral-900"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-4 text-sm font-medium text-neutral-700">
          {userName && <span>{userName}</span>}
          <button onClick={handleLogout} className="hover:text-neutral-900">
            Salir
          </button>
        </div>
      </div>
    </header>
  );
}
