"use client";

import { useState } from "react";
import type { Company, SubscriptionStatus } from "@/types/database.types";

const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  trial: "En prueba",
  active: "Al día",
  suspended: "Suspendida",
};

const STATUS_COLOR: Record<SubscriptionStatus, string> = {
  trial: "bg-blue-50 text-blue-700 border-blue-200",
  active: "bg-green-50 text-green-700 border-green-200",
  suspended: "bg-red-50 text-red-700 border-red-200",
};

// Fila por empresa, con su propio estado "en vuelo" (guardando / error) para
// no tener que recargar toda la lista por cada cambio.
function CompanyRow({ company, onDeleted }: { company: Company; onDeleted: (id: string) => void }) {
  const [status, setStatus] = useState<SubscriptionStatus>(company.subscription_status);
  const [paidUntil, setPaidUntil] = useState(company.paid_until ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    const confirmed = window.confirm(
      `¿Eliminar "${company.name}" para siempre? Esto borra TODO lo suyo — productos, recetas, envíos, armados y los usuarios de esa empresa. No se puede deshacer.`
    );
    if (!confirmed) return;

    setDeleting(true);
    setError(null);

    const res = await fetch(`/api/dueno/companies?id=${company.id}`, { method: "DELETE" });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      setDeleting(false);
      setError(data.error ?? "No se pudo eliminar.");
      return;
    }

    onDeleted(company.id);
  }

  async function save(nextStatus: SubscriptionStatus) {
    setSaving(true);
    setError(null);
    setSaved(false);

    const res = await fetch("/api/dueno/companies", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: company.id,
        subscription_status: nextStatus,
        paid_until: paidUntil || null,
      }),
    });
    const data = await res.json();

    setSaving(false);
    if (!res.ok || !data.ok) {
      setError(data.error ?? "No se pudo guardar.");
      return;
    }
    setStatus(nextStatus);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <tr className="border-b border-gray-100 last:border-0">
      <td className="py-3 pr-3">
        <div className="font-medium text-neutral-900">{company.name}</div>
        {company.legal_name && (
          <div className="text-xs text-neutral-400">{company.legal_name}</div>
        )}
      </td>
      <td className="py-3 pr-3">
        <span
          className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[status]}`}
        >
          {STATUS_LABEL[status]}
        </span>
      </td>
      <td className="py-3 pr-3">
        <input
          type="date"
          value={paidUntil}
          onChange={(e) => setPaidUntil(e.target.value)}
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
          title="Cubierto hasta (opcional, solo para recordarte)"
        />
      </td>
      <td className="py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={() => save("active")}
            className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            Marcar al día
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => save("suspended")}
            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            Suspender
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => save("trial")}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-semibold text-neutral-700 disabled:opacity-50"
          >
            En prueba
          </button>
          <button
            type="button"
            disabled={saving || deleting}
            onClick={handleDelete}
            className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            {deleting ? "Eliminando..." : "Eliminar"}
          </button>
          {saved && <span className="text-xs font-medium text-green-600">Guardado</span>}
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      </td>
    </tr>
  );
}

export default function OwnerPanelClient({ companies: initialCompanies }: { companies: Company[] }) {
  const [companies, setCompanies] = useState(initialCompanies);

  function handleDeleted(id: string) {
    setCompanies((prev) => prev.filter((c) => c.id !== id));
  }

  if (companies.length === 0) {
    return <p className="text-sm text-neutral-500">Todavía no hay ninguna empresa registrada.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="w-full text-left text-sm">
        <thead className="bg-gray-50 text-xs uppercase text-neutral-500">
          <tr>
            <th className="px-3 py-2 font-medium">Empresa</th>
            <th className="px-3 py-2 font-medium">Estado</th>
            <th className="px-3 py-2 font-medium">Cubierto hasta</th>
            <th className="px-3 py-2 font-medium">Acciones</th>
          </tr>
        </thead>
        <tbody className="px-3">
          {companies.map((c) => (
            <CompanyRow key={c.id} company={c} onDeleted={handleDeleted} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
