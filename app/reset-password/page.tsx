"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Página a la que te lleva el link del mail de "recuperar contraseña" (tanto
// el que manda Supabase Studio a mano como el que en el futuro mande el link
// de "¿Olvidaste tu contraseña?" del login). Antes esta pantalla no existía,
// por eso el link te tiraba a una página que no estaba armada.
//
// Supabase, al procesar el link, deja la sesión de "recuperación" armada
// sola (o, si el link venció/ya se usó, deja el error en la URL) — achá solo
// hace falta esperar a que esa sesión quede lista y mostrar el formulario
// para elegir la contraseña nueva.
export default function ResetPasswordPage() {
  const router = useRouter();
  const supabase = createClient();

  const [status, setStatus] = useState<"loading" | "ready" | "expired">("loading");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  // Para reenviar un link nuevo si este venció.
  const [resendEmail, setResendEmail] = useState("");
  const [resendSent, setResendSent] = useState(false);
  const [resending, setResending] = useState(false);

  useEffect(() => {
    // Los datos del link vienen después del "#" en la URL (no llegan al
    // servidor, solo los ve el navegador), así que los leemos acá.
    const hash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    const params = new URLSearchParams(hash);

    if (params.get("error")) {
      setStatus("expired");
      return;
    }

    // Si el link es válido, el cliente de Supabase arma la sesión de
    // recuperación solo. Escuchamos el evento y, por las dudas, también
    // chequeamos si ya había una sesión al cargar la página.
    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
        setStatus("ready");
      }
    });

    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        setStatus("ready");
      } else if (!params.get("access_token") && !params.get("code")) {
        // No hay ni sesión ni datos de recuperación en la URL: no se llegó
        // acá a través de un link de recuperación válido.
        setStatus("expired");
      }
    });

    return () => {
      listener.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 6) {
      setError("La contraseña tiene que tener al menos 6 caracteres.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Las dos contraseñas no coinciden.");
      return;
    }

    setSaving(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setSaving(false);

    if (updateError) {
      setError("No se pudo guardar la contraseña: " + updateError.message);
      return;
    }

    setDone(true);
    setTimeout(() => {
      router.push("/");
      router.refresh();
    }, 1500);
  }

  async function handleResend(e: React.FormEvent) {
    e.preventDefault();
    setResending(true);
    await supabase.auth.resetPasswordForEmail(resendEmail, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setResending(false);
    setResendSent(true);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-4">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-gray-200 bg-white p-6">
        <h1 className="text-lg font-semibold text-neutral-900">Nueva contraseña</h1>

        {status === "loading" && (
          <p className="text-sm text-neutral-500">Comprobando el link...</p>
        )}

        {status === "expired" && (
          <div className="space-y-4">
            <p className="text-sm text-red-600">
              Este link venció o ya se usó. Pedí uno nuevo escribiendo tu email:
            </p>
            {resendSent ? (
              <p className="text-sm text-green-700">
                Listo, te mandamos un mail nuevo. Revisá tu bandeja de entrada (y Spam).
              </p>
            ) : (
              <form onSubmit={handleResend} className="space-y-3">
                <input
                  type="email"
                  required
                  placeholder="tu@email.com"
                  value={resendEmail}
                  onChange={(e) => setResendEmail(e.target.value)}
                  className="w-full rounded-md border border-gray-300 bg-gray-100 px-3 py-2 text-neutral-900"
                />
                <button
                  type="submit"
                  disabled={resending}
                  className="w-full rounded-md bg-yellow-400 py-2 font-semibold text-neutral-900 disabled:opacity-50"
                >
                  {resending ? "Enviando..." : "Mandarme un link nuevo"}
                </button>
              </form>
            )}
          </div>
        )}

        {status === "ready" && !done && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1">
              <label className="text-sm text-neutral-500">Contraseña nueva</label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-gray-300 bg-gray-100 px-3 py-2 text-neutral-900"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm text-neutral-500">Repetí la contraseña</label>
              <input
                type="password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full rounded-md border border-gray-300 bg-gray-100 px-3 py-2 text-neutral-900"
              />
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <button
              type="submit"
              disabled={saving}
              className="w-full rounded-md bg-yellow-400 py-2 font-semibold text-neutral-900 disabled:opacity-50"
            >
              {saving ? "Guardando..." : "Guardar contraseña"}
            </button>
          </form>
        )}

        {done && (
          <p className="text-sm text-green-700">
            Contraseña actualizada. Entrando...
          </p>
        )}
      </div>
    </div>
  );
}
