"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Alta de una empresa nueva, sin intervención manual de nadie: cualquiera
// que entre acá crea su propio depósito, separado del de las demás
// empresas (RLS filtra todo por company_id). Queda como admin de su propia
// empresa desde el primer momento.
export default function SignupPage() {
  const router = useRouter();
  const supabase = createClient();

  const [companyName, setCompanyName] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const res = await fetch("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyName, fullName, email, password }),
    });

    let data: { ok: boolean; error?: string };
    try {
      data = await res.json();
    } catch {
      setLoading(false);
      setError("No se pudo crear la cuenta (error de conexión).");
      return;
    }

    if (!data.ok) {
      setLoading(false);
      setError(data.error ?? "No se pudo crear la cuenta.");
      return;
    }

    // La cuenta ya quedó creada del lado del servidor — ahora iniciamos
    // sesión en el navegador con las mismas credenciales.
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);

    if (signInError) {
      router.push("/login");
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-gray-200 bg-white p-6"
      >
        <div>
          <h1 className="text-lg font-semibold text-neutral-900">Crear cuenta</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Se crea tu depósito como una empresa nueva, separada de las demás. Vos quedás como
            administrador.
          </p>
        </div>

        <div className="space-y-1">
          <label className="text-sm text-neutral-500">Nombre de tu empresa / depósito</label>
          <input
            required
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            className="w-full rounded-md border border-gray-300 bg-gray-100 px-3 py-2 text-neutral-900"
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm text-neutral-500">Tu nombre</label>
          <input
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="w-full rounded-md border border-gray-300 bg-gray-100 px-3 py-2 text-neutral-900"
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm text-neutral-500">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-gray-300 bg-gray-100 px-3 py-2 text-neutral-900"
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm text-neutral-500">Contraseña</label>
          <input
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-gray-300 bg-gray-100 px-3 py-2 text-neutral-900"
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-yellow-400 py-2 font-semibold text-neutral-900 disabled:opacity-50"
        >
          {loading ? "Creando cuenta..." : "Crear cuenta"}
        </button>

        <p className="text-center text-sm text-neutral-500">
          ¿Ya tenés cuenta?{" "}
          <a href="/login" className="font-medium text-neutral-900 underline">
            Ingresá acá
          </a>
        </p>
      </form>
    </div>
  );
}
