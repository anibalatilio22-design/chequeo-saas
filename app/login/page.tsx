"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Reemplaza a la "contraseña general de la app" del prototipo.
// Cada persona de cada empresa entra con su propio email + contraseña
// (Supabase Auth); RLS se encarga de que solo vea los datos de su company_id.
export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // "¿Olvidaste tu contraseña?" — antes esto solo se podía hacer a mano
  // desde Supabase Studio. Ahora cualquiera puede pedirlo solo, y el link
  // que le llega por mail usa SIEMPRE el dominio desde el que se pidió
  // (window.location.origin), así que no depende de que la config de
  // Supabase tenga el dominio correcto cargado.
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSent, setForgotSent] = useState(false);
  const [forgotSending, setForgotSending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    setLoading(false);

    if (error) {
      setError("Email o contraseña incorrectos.");
      return;
    }

    router.push("/");
    router.refresh();
  }

  async function handleForgotSubmit(e: React.FormEvent) {
    e.preventDefault();
    setForgotSending(true);
    await supabase.auth.resetPasswordForEmail(forgotEmail, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setForgotSending(false);
    setForgotSent(true);
  }

  if (showForgot) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white px-4">
        <div className="w-full max-w-sm space-y-4 rounded-xl border border-gray-200 bg-white p-6">
          <h1 className="text-lg font-semibold text-neutral-900">Recuperar contraseña</h1>

          {forgotSent ? (
            <p className="text-sm text-green-700">
              Listo, te mandamos un mail a {forgotEmail} con un link para elegir una
              contraseña nueva. Revisá tu bandeja de entrada (y Spam).
            </p>
          ) : (
            <form onSubmit={handleForgotSubmit} className="space-y-4">
              <div className="space-y-1">
                <label className="text-sm text-neutral-500">Tu email</label>
                <input
                  type="email"
                  required
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  className="w-full rounded-md border border-gray-300 bg-gray-100 px-3 py-2 text-neutral-900"
                />
              </div>
              <button
                type="submit"
                disabled={forgotSending}
                className="w-full rounded-md bg-yellow-400 py-2 font-semibold text-neutral-900 disabled:opacity-50"
              >
                {forgotSending ? "Enviando..." : "Mandarme el link"}
              </button>
            </form>
          )}

          <p className="text-center text-sm text-neutral-500">
            <button
              type="button"
              onClick={() => setShowForgot(false)}
              className="font-medium text-neutral-900 underline"
            >
              Volver a iniciar sesión
            </button>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-gray-200 bg-white p-6"
      >
        <h1 className="text-lg font-semibold text-neutral-900">
          Chequeo Full / Flex / Colecta
        </h1>

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
          {loading ? "Ingresando..." : "Ingresar"}
        </button>

        <p className="text-center text-sm text-neutral-500">
          <button
            type="button"
            onClick={() => setShowForgot(true)}
            className="font-medium text-neutral-900 underline"
          >
            ¿Olvidaste tu contraseña?
          </button>
        </p>

        <p className="text-center text-sm text-neutral-500">
          ¿No tenés cuenta?{" "}
          <a href="/signup" className="font-medium text-neutral-900 underline">
            Creá una acá
          </a>
        </p>
      </form>
    </div>
  );
}
