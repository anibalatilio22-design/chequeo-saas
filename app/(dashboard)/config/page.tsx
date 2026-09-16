"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Company, Operator } from "@/types/database.types";

// El "puesto de trabajo" es solo una etiqueta local de esta computadora
// (no se guarda en la base de datos) — sirve para identificar rápido en
// qué PC del depósito se está trabajando.
const WORKSTATION_STORAGE_KEY = "chequeo_puesto_trabajo";

export default function ConfigPage() {
  const [supabase] = useState(() => createClient());
  const router = useRouter();
  const [companyId, setCompanyId] = useState<string | null>(null);

  // Perfil de la empresa
  const [company, setCompany] = useState<Company | null>(null);
  const [companyName, setCompanyName] = useState("");
  const [companyAddress, setCompanyAddress] = useState("");
  const [companyPhone, setCompanyPhone] = useState("");
  const [companyError, setCompanyError] = useState<string | null>(null);
  const [companySaved, setCompanySaved] = useState(false);
  const [savingCompany, setSavingCompany] = useState(false);

  // Logo de la empresa
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  // Puesto de trabajo (esta computadora)
  const [workstationName, setWorkstationName] = useState("");
  const [workstationSaved, setWorkstationSaved] = useState(false);

  // Contraseña general de la app (la del login del admin en esta empresa)
  const [newPassword, setNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  // Operarios
  const [operators, setOperators] = useState<Operator[]>([]);
  const [newOperatorName, setNewOperatorName] = useState("");
  const [newOperatorPin, setNewOperatorPin] = useState("");
  const [operatorError, setOperatorError] = useState<string | null>(null);
  const [savingOperator, setSavingOperator] = useState(false);

  async function loadCompany() {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const { data: profile } = await supabase
      .from("users")
      .select("company_id")
      .eq("id", user.id)
      .single();

    if (!profile) return;
    setCompanyId(profile.company_id);

    const { data: companyData } = await supabase
      .from("companies")
      .select("*")
      .eq("id", profile.company_id)
      .single();

    if (companyData) {
      setCompany(companyData);
      setCompanyName(companyData.name ?? "");
      setCompanyAddress(companyData.address ?? "");
      setCompanyPhone(companyData.phone ?? "");
    }
  }

  async function loadOperators() {
    const { data } = await supabase.from("operators").select("*").order("full_name");
    setOperators(data ?? []);
  }

  useEffect(() => {
    loadCompany();
    loadOperators();
    setWorkstationName(localStorage.getItem(WORKSTATION_STORAGE_KEY) ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSaveCompany(e: React.FormEvent) {
    e.preventDefault();
    setCompanyError(null);
    setCompanySaved(false);

    if (!companyName.trim()) {
      setCompanyError("Completá el nombre de la empresa");
      return;
    }
    if (!companyId) return;

    setSavingCompany(true);

    const { error } = await supabase
      .from("companies")
      .update({
        name: companyName.trim(),
        address: companyAddress.trim() || null,
        phone: companyPhone.trim() || null,
      })
      .eq("id", companyId);

    setSavingCompany(false);

    if (error) {
      setCompanyError(error.message);
      return;
    }

    setCompanySaved(true);
    setTimeout(() => setCompanySaved(false), 2000);
    router.refresh();
  }

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !companyId) return;

    setLogoError(null);

    if (!file.type.startsWith("image/")) {
      setLogoError("El archivo tiene que ser una imagen (PNG, JPG, etc).");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setLogoError("La imagen no puede pesar más de 2 MB.");
      return;
    }

    setUploadingLogo(true);

    const ext = file.name.split(".").pop()?.toLowerCase() || "png";
    const path = `${companyId}/logo.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from("company-logos")
      .upload(path, file, { upsert: true, cacheControl: "3600" });

    if (uploadError) {
      setUploadingLogo(false);
      setLogoError(
        uploadError.message.includes("not found") || uploadError.message.includes("Bucket")
          ? "Todavía no está creado el espacio de almacenamiento para logos (falta correr la migración de Storage)."
          : uploadError.message
      );
      return;
    }

    const { data: publicUrlData } = supabase.storage.from("company-logos").getPublicUrl(path);
    const logoUrl = `${publicUrlData.publicUrl}?v=${Date.now()}`;

    const { error: updateError } = await supabase
      .from("companies")
      .update({ logo_url: logoUrl })
      .eq("id", companyId);

    setUploadingLogo(false);

    if (updateError) {
      setLogoError(updateError.message);
      return;
    }

    setCompany((prev) => (prev ? { ...prev, logo_url: logoUrl } : prev));
    router.refresh();
  }

  async function handleRemoveLogo() {
    if (!companyId) return;
    const confirmed = window.confirm("¿Quitar el logo de la empresa?");
    if (!confirmed) return;

    setLogoError(null);
    const { error } = await supabase.from("companies").update({ logo_url: null }).eq("id", companyId);

    if (error) {
      setLogoError(error.message);
      return;
    }

    setCompany((prev) => (prev ? { ...prev, logo_url: null } : prev));
    router.refresh();
  }

  function handleSaveWorkstation(e: React.FormEvent) {
    e.preventDefault();
    localStorage.setItem(WORKSTATION_STORAGE_KEY, workstationName.trim());
    setWorkstationSaved(true);
    setTimeout(() => setWorkstationSaved(false), 2000);
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSaved(false);

    if (!newPassword.trim() || newPassword.trim().length < 6) {
      setPasswordError("La contraseña debe tener al menos 6 caracteres");
      return;
    }

    setSavingPassword(true);

    const { error } = await supabase.auth.updateUser({ password: newPassword.trim() });

    setSavingPassword(false);

    if (error) {
      setPasswordError(error.message);
      return;
    }

    setNewPassword("");
    setPasswordSaved(true);
    setTimeout(() => setPasswordSaved(false), 2000);
  }

  async function handleAddOperator(e: React.FormEvent) {
    e.preventDefault();
    setOperatorError(null);

    if (!newOperatorName.trim() || !newOperatorPin.trim()) {
      setOperatorError("Completá nombre y PIN");
      return;
    }

    setSavingOperator(true);

    const res = await fetch("/api/operators", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full_name: newOperatorName.trim(), pin: newOperatorPin.trim() }),
    });
    const data = await res.json();

    setSavingOperator(false);

    if (!data.ok) {
      setOperatorError(data.error ?? "Error al crear el operario");
      return;
    }

    setNewOperatorName("");
    setNewOperatorPin("");
    loadOperators();
  }

  async function deleteOperator(operator: Operator) {
    const confirmed = window.confirm(
      `¿Eliminar al operario "${operator.full_name}"? Esta acción no se puede deshacer.`
    );
    if (!confirmed) return;

    setOperatorError(null);
    const { error } = await supabase.from("operators").delete().eq("id", operator.id);

    if (error) {
      setOperatorError(
        error.message.includes("foreign key")
          ? `No se puede eliminar a "${operator.full_name}" porque tiene armados registrados.`
          : error.message
      );
      return;
    }

    loadOperators();
  }

  return (
    <main className="mx-auto max-w-3xl space-y-8 p-6">
      <h1 className="text-xl font-semibold">Configuración</h1>

      {/* Perfil de la empresa */}
      <section className="space-y-4 rounded-lg border border-gray-200 p-4">
        <div>
          <h2 className="text-lg font-medium">Perfil de la empresa</h2>
          <p className="text-sm text-neutral-500">
            Nombre, dirección, teléfono y logo de tu empresa. El logo aparece al lado del nombre en la
            barra de arriba.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex h-28 w-28 items-center justify-center overflow-hidden rounded-md border border-gray-200 bg-neutral-50">
            {company?.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={company.logo_url} alt="Logo actual" className="h-full w-full object-contain" />
            ) : (
              <span className="text-xs text-neutral-400">Sin logo</span>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <label className="cursor-pointer self-start rounded-md border border-gray-300 px-4 py-2 text-sm font-semibold text-neutral-700">
              {uploadingLogo ? "Subiendo..." : company?.logo_url ? "Cambiar logo" : "Subir logo"}
              <input
                type="file"
                accept="image/*"
                onChange={handleLogoUpload}
                disabled={uploadingLogo}
                className="hidden"
              />
            </label>
            {company?.logo_url && (
              <button
                type="button"
                onClick={handleRemoveLogo}
                className="self-start text-sm text-red-600"
              >
                Quitar logo
              </button>
            )}
            <p className="text-xs text-neutral-400">PNG o JPG, hasta 2 MB.</p>
          </div>
        </div>
        {logoError && <p className="text-sm text-red-600">{logoError}</p>}

        <form onSubmit={handleSaveCompany} className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm text-neutral-500">Nombre de la empresa</label>
            <input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm text-neutral-500">Dirección</label>
            <input
              value={companyAddress}
              onChange={(e) => setCompanyAddress(e.target.value)}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm text-neutral-500">Teléfono</label>
            <input
              value={companyPhone}
              onChange={(e) => setCompanyPhone(e.target.value)}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2"
            />
          </div>

          {companyError && <p className="text-sm text-red-600">{companyError}</p>}
          {companySaved && <p className="text-sm text-green-700">Guardado.</p>}

          <button
            disabled={savingCompany || !company}
            className="rounded-md bg-yellow-400 px-4 py-2 font-semibold text-neutral-900 disabled:opacity-50"
          >
            {savingCompany ? "Guardando..." : "Guardar"}
          </button>
        </form>
      </section>

      {/* Puesto de trabajo (esta computadora) */}
      <section className="space-y-4 rounded-lg border border-gray-200 p-4">
        <div>
          <h2 className="text-lg font-medium">Puesto de trabajo</h2>
          <p className="text-sm text-neutral-500">
            Se guarda en esta computadora — no hace falta configurarlo de nuevo salvo que quieras
            cambiarlo.
          </p>
        </div>

        <form onSubmit={handleSaveWorkstation} className="flex flex-wrap items-end gap-3">
          <div className="flex-1 space-y-1">
            <input
              value={workstationName}
              onChange={(e) => setWorkstationName(e.target.value)}
              placeholder="Ej: Puesto 1"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2"
            />
          </div>
          <button className="rounded-md bg-yellow-400 px-4 py-2 font-semibold text-neutral-900">
            Guardar
          </button>
        </form>
        {workstationSaved && <p className="text-sm text-green-700">Guardado en esta computadora.</p>}
      </section>

      {/* Contraseña general de la app */}
      <section className="space-y-4 rounded-lg border border-gray-200 p-4">
        <div>
          <h2 className="text-lg font-medium">Contraseña general de la app</h2>
          <p className="text-sm text-neutral-500">
            La que se pide para entrar a la aplicación. Se comparte entre todas las computadoras
            (es la contraseña de tu cuenta de acceso).
          </p>
        </div>

        <form onSubmit={handleChangePassword} className="flex flex-wrap items-end gap-3">
          <div className="flex-1 space-y-1">
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Nueva contraseña"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2"
            />
          </div>
          <button
            disabled={savingPassword}
            className="rounded-md bg-yellow-400 px-4 py-2 font-semibold text-neutral-900 disabled:opacity-50"
          >
            {savingPassword ? "Cambiando..." : "Cambiar"}
          </button>
        </form>
        {passwordError && <p className="text-sm text-red-600">{passwordError}</p>}
        {passwordSaved && <p className="text-sm text-green-700">Contraseña actualizada.</p>}
      </section>

      {/* Operarios */}
      <section className="space-y-4 rounded-lg border border-gray-200 p-4">
        <div>
          <h2 className="text-lg font-medium">Operarios</h2>
          <p className="text-sm text-neutral-500">
            Cada operario confirma con su nombre y PIN cuando termina de armar un combo.
          </p>
        </div>

        <form onSubmit={handleAddOperator} className="flex flex-wrap items-end gap-3">
          <div className="flex-1 space-y-1">
            <label className="text-sm text-neutral-500">Nombre completo</label>
            <input
              value={newOperatorName}
              onChange={(e) => setNewOperatorName(e.target.value)}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2"
            />
          </div>
          <div className="w-32 space-y-1">
            <label className="text-sm text-neutral-500">PIN (4-6 dígitos)</label>
            <input
              value={newOperatorPin}
              onChange={(e) => setNewOperatorPin(e.target.value)}
              inputMode="numeric"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2"
            />
          </div>
          <button
            disabled={savingOperator}
            className="rounded-md bg-yellow-400 px-4 py-2 font-semibold text-neutral-900 disabled:opacity-50"
          >
            {savingOperator ? "Agregando..." : "Agregar"}
          </button>
        </form>
        {operatorError && <p className="text-sm text-red-600">{operatorError}</p>}

        <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200">
          {operators.map((op) => (
            <li key={op.id} className="flex items-center justify-between px-4 py-3">
              <span className={op.active ? "" : "text-neutral-500 line-through"}>
                {op.full_name}
              </span>
              <button
                onClick={() => deleteOperator(op)}
                className="text-sm text-red-600"
              >
                Eliminar
              </button>
            </li>
          ))}
          {operators.length === 0 && (
            <li className="px-4 py-3 text-sm text-neutral-500">Todavía no hay operarios.</li>
          )}
        </ul>
      </section>
    </main>
  );
}
