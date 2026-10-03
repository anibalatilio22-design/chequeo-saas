"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { CheckFlashLogo } from "@/components/checkflash-logo";

const TABS = [
  { href: "/armado", label: "Packing", adminOnly: false },
  { href: "/recetas", label: "Catálogo", adminOnly: false },
  { href: "/envios", label: "Envío", adminOnly: false },
  { href: "/progreso", label: "Progreso", adminOnly: false },
  { href: "/config", label: "Configuración", adminOnly: true },
];

export default function NavBar({
  userName,
  role,
  companyName,
  logoUrl,
  isOwner,
}: {
  userName: string | null;
  role: "admin" | "operario";
  companyName?: string | null;
  logoUrl?: string | null;
  // Solo vos (el dueño del sistema, ver lib/owner.ts) ves el link a
  // /dueno — ni siquiera el admin de otra empresa sabe que existe.
  isOwner?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();

  // Desplegable de usuario (nombre + "Cerrar sesión"), en vez de un botón
  // suelto de "Salir". Se cierra solo al hacer clic afuera.
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="bg-yellow-400 shadow-sm">
      <div className="flex h-24 items-stretch justify-between">
        {/* Izquierda: logo de la empresa (el que se sube desde Configuración)
            junto con su nombre, en su propio espacio con fondo blanco (para
            que no quede flotando directo sobre el amarillo), pegado al borde
            y ocupando el alto de la barra. */}
        {(logoUrl || companyName) && (
          <div className="my-auto flex h-16 shrink-0 items-center gap-2.5 self-center rounded-xl bg-white px-3.5 shadow-sm">
            {logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl}
                alt={companyName ? `Logo de ${companyName}` : "Logo de la empresa"}
                className="h-full max-w-[170px] object-contain"
              />
            )}
            {companyName && (
              <span className="max-w-[160px] truncate text-base font-bold leading-tight text-neutral-900">
                {companyName}
              </span>
            )}
          </div>
        )}

        <nav className="flex flex-1 items-center justify-center gap-3 px-1 sm:gap-5">
          {TABS.filter((tab) => !tab.adminOnly || role === "admin").map((tab) => {
            const active = pathname?.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={`whitespace-nowrap border-b-2 py-4 text-sm font-semibold transition-colors ${
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

        {/* Derecha: nombre del usuario (con desplegable para cerrar sesión) y,
            en la punta, la marca CheckFlash — pegada al borde y ocupando el
            alto de la barra, sobre un panel oscuro para que se lea bien
            sobre el amarillo. */}
        <div className="flex shrink-0 items-stretch">
          <div ref={userMenuRef} className="relative flex items-center pr-3">
            <button
              type="button"
              onClick={() => setUserMenuOpen((v) => !v)}
              className="flex items-center gap-1.5 whitespace-nowrap text-sm font-medium text-neutral-800 hover:text-neutral-900"
            >
              {userName ?? "Cuenta"}
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                className={`transition-transform ${userMenuOpen ? "rotate-180" : ""}`}
              >
                <path
                  d="M6 9l6 6 6-6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>

            {userMenuOpen && (
              <div className="absolute right-0 top-full z-20 mt-2 w-44 overflow-hidden rounded-md border border-gray-200 bg-white py-1 shadow-lg">
                {isOwner && (
                  <Link
                    href="/dueno"
                    className="block w-full px-4 py-2 text-left text-sm font-medium text-neutral-700 hover:bg-gray-50"
                  >
                    Panel general
                  </Link>
                )}
                <button
                  type="button"
                  onClick={handleLogout}
                  className="block w-full px-4 py-2 text-left text-sm font-medium text-red-600 hover:bg-red-50"
                >
                  Cerrar sesión
                </button>
              </div>
            )}
          </div>

          <Link
            href="/"
            className="my-1.5 flex shrink-0 items-center rounded-xl bg-[#0F1420] px-4 shadow-sm"
            title="CheckFlash"
          >
            <CheckFlashLogo
              iconSize={42}
              wordmarkSize="text-xl"
              wordmarkStyle="brand"
              withSubtitle={false}
              variant="dark"
            />
          </Link>
        </div>
      </div>
    </header>
  );
}
