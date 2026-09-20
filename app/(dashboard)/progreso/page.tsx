"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { jsPDF } from "jspdf";
import type { Company, Shipment, ShipmentType, ShipmentProgress } from "@/types/database.types";

type CompletionRow = {
  id: string;
  completed_at: string;
  operator_name: string;
  workstation_name: string;
};

export default function ProgresoPage() {
  const [supabase] = useState(() => createClient());

  const [company, setCompany] = useState<Company | null>(null);

  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [shipmentType, setShipmentType] = useState<ShipmentType>("full");
  const [matchingShipments, setMatchingShipments] = useState<Shipment[]>([]);
  const [shipmentId, setShipmentId] = useState("");

  const [progress, setProgress] = useState<ShipmentProgress[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [completionsByItem, setCompletionsByItem] = useState<Record<string, CompletionRow[]>>({});

  const [generatingRemito, setGeneratingRemito] = useState(false);
  const [remitoError, setRemitoError] = useState<string | null>(null);

  // Referencia siempre actualizada de "expanded", para poder usarla dentro
  // del callback de Realtime sin tener que re-suscribirse cada vez que cambia.
  const expandedRef = useRef(expanded);
  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  // Datos de la empresa (nombre, logo, dirección, teléfono) para el
  // encabezado del remito de despacho.
  async function loadCompany() {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const { data: profileRaw } = await supabase
      .from("users")
      .select("company_id")
      .eq("id", user.id)
      .single();

    // El cliente tipado no siempre resuelve bien el tipo de este resultado
    // (mismo motivo de fondo que otros casteos de la app), así que lo
    // casteamos a mano.
    const profile = profileRaw as { company_id: string } | null;
    if (!profile) return;

    const { data: companyDataRaw } = await supabase
      .from("companies")
      .select("*")
      .eq("id", profile.company_id)
      .single();
    setCompany((companyDataRaw as Company | null) ?? null);
  }

  async function loadShipments() {
    const { data } = await supabase
      .from("shipments")
      .select("*")
      .order("created_at", { ascending: false });
    setShipments(data ?? []);
  }

  async function loadProgress(id: string) {
    const { data } = await supabase
      .from("shipment_progress")
      .select("*")
      .eq("shipment_id", id)
      .order("recipe_name", { ascending: true });
    setProgress(data ?? []);
  }

  // Trae los armados (completions) de UN ítem, con quién lo armó y en qué
  // puesto de trabajo — así, si hay un error, se puede buscar por las
  // cámaras de seguridad quién y en qué PC lo armó, y a qué hora.
  async function loadCompletionsForItem(itemId: string) {
    const { data } = await supabase
      .from("completions")
      .select("id, completed_at, operators(full_name), workstations(name)")
      .eq("shipment_item_id", itemId)
      .order("completed_at", { ascending: false });

    // El cliente tipado no resuelve bien estos joins (mismo motivo de fondo
    // que otros casteos de la app), así que casteamos a mano cada fila.
    const rows: CompletionRow[] = (data ?? []).map((c: any) => ({
      id: c.id,
      completed_at: c.completed_at,
      operator_name: c.operators?.full_name ?? "Desconocido",
      workstation_name: c.workstations?.name ?? "Sin puesto asignado",
    }));

    setCompletionsByItem((prev) => ({ ...prev, [itemId]: rows }));
  }

  useEffect(() => {
    loadCompany();
    loadShipments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolver a qué envío corresponde el tipo elegido, igual que en Armado:
  // si hay uno solo de ese tipo, se usa directo; si hay más de uno, se pide
  // elegir entre esos pocos.
  useEffect(() => {
    const matches = shipments.filter((s) => s.type === shipmentType);
    setMatchingShipments(matches);
    setShipmentId(matches.length === 1 ? matches[0].id : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shipmentType, shipments]);

  useEffect(() => {
    setExpanded({});
    setCompletionsByItem({});
    setRemitoError(null);
    if (shipmentId) {
      loadProgress(shipmentId);
    } else {
      setProgress([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shipmentId]);

  // Tiempo real: cualquier armado nuevo (completion) actualiza el progreso
  // del envío elegido y, si estaba expandida, la lista de detalle.
  useEffect(() => {
    const channel = supabase
      .channel("progreso-completions")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "completions" },
        () => {
          if (shipmentId) loadProgress(shipmentId);
          Object.entries(expandedRef.current).forEach(([itemId, isOpen]) => {
            if (isOpen) loadCompletionsForItem(itemId);
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shipmentId]);

  function toggleExpanded(itemId: string) {
    const willOpen = !expanded[itemId];
    setExpanded((prev) => ({ ...prev, [itemId]: willOpen }));
    if (willOpen && !completionsByItem[itemId]) {
      loadCompletionsForItem(itemId);
    }
  }

  // El remito solo se puede generar cuando el envío está armado del todo —
  // así lo pidió el usuario, para no despachar algo a medio chequear.
  const allComplete =
    progress.length > 0 && progress.every((p) => p.quantity_completed >= p.quantity_required);

  // Arma y descarga el PDF del remito de despacho, entero en el navegador
  // (no hace falta ningún servidor nuevo para esto). Por cada producto/combo
  // trae la cantidad armada, y por cada armado individual quién lo hizo, en
  // qué puesto y a qué hora — para poder rastrear un error por las cámaras.
  //
  // El objeto del PDF (jsPDF) se castea a "any": es una librería nueva que
  // no se puede instalar/probar en este entorno antes de subir el código,
  // así que se evita cualquier fricción de tipos estrictos que pueda hacer
  // fallar la compilación real en Vercel (mismo motivo por el que se
  // castean las consultas de Supabase en el resto de la app).
  async function generateRemito() {
    if (!shipmentId || !allComplete) return;
    const shipment = shipments.find((s) => s.id === shipmentId);
    if (!shipment) return;

    setGeneratingRemito(true);
    setRemitoError(null);

    try {
      const itemIds = progress.map((p) => p.shipment_item_id);
      const { data: completionsData, error: completionsError } = await supabase
        .from("completions")
        .select("id, shipment_item_id, completed_at, operators(full_name), workstations(name)")
        .in("shipment_item_id", itemIds)
        .order("completed_at", { ascending: true });

      if (completionsError) {
        setRemitoError(`No se pudieron traer los armados: ${completionsError.message}`);
        setGeneratingRemito(false);
        return;
      }

      const completionsByItemId = new Map<string, CompletionRow[]>();
      (completionsData ?? []).forEach((c: any) => {
        const row: CompletionRow = {
          id: c.id,
          completed_at: c.completed_at,
          operator_name: c.operators?.full_name ?? "Desconocido",
          workstation_name: c.workstations?.name ?? "Sin puesto asignado",
        };
        const list = completionsByItemId.get(c.shipment_item_id) ?? [];
        list.push(row);
        completionsByItemId.set(c.shipment_item_id, list);
      });

      // El logo es opcional: si no se puede traer o convertir por cualquier
      // motivo (por ejemplo, restricciones del servidor donde está
      // guardado), el remito se arma igual, solo que con el nombre de la
      // empresa en texto grande en vez del logo.
      let logoDataUrl: string | null = null;
      let logoFormat: string | null = null;
      if (company?.logo_url) {
        try {
          const resp = await fetch(company.logo_url);
          const blob = await resp.blob();
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error("No se pudo leer el logo"));
            reader.readAsDataURL(blob);
          });
          if (dataUrl.includes("image/png")) logoFormat = "PNG";
          else if (dataUrl.includes("image/webp")) logoFormat = "WEBP";
          else logoFormat = "JPEG";
          logoDataUrl = dataUrl;
        } catch {
          logoDataUrl = null;
          logoFormat = null;
        }
      }

      const doc = new jsPDF({ unit: "mm", format: "a4" }) as any;
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const marginX = 15;
      let y = 20;

      if (logoDataUrl && logoFormat) {
        try {
          doc.addImage(logoDataUrl, logoFormat, marginX, y - 8, 22, 22);
        } catch {
          // Si la imagen no se puede insertar, seguimos sin logo.
        }
      }

      const textX = logoDataUrl ? marginX + 28 : marginX;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(14);
      doc.text(company?.name ?? "Remito de despacho", textX, y);
      y += 6;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      if (company?.address) {
        doc.text(company.address, textX, y);
        y += 5;
      }
      if (company?.phone) {
        doc.text(company.phone, textX, y);
        y += 5;
      }

      y = Math.max(y, 32) + 4;
      doc.setDrawColor(200);
      doc.line(marginX, y, pageWidth - marginX, y);
      y += 8;

      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.text("Remito de despacho", marginX, y);
      y += 7;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.text(`Envío: ${shipment.code}`, marginX, y);
      doc.text(`Tipo: ${shipment.type === "flex" ? "Flex / Colecta" : "Full"}`, pageWidth - marginX, y, {
        align: "right",
      });
      y += 6;
      doc.text(`Generado: ${new Date().toLocaleString("es-AR")}`, marginX, y);
      y += 10;

      function ensureSpace(lines: number) {
        if (y + lines * 6 > pageHeight - 25) {
          doc.addPage();
          y = 20;
        }
      }

      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      ensureSpace(1);
      doc.text("Producto", marginX, y);
      doc.text("Cant.", pageWidth - marginX - 15, y);
      y += 2;
      doc.setDrawColor(220);
      doc.line(marginX, y, pageWidth - marginX, y);
      y += 5;

      for (const p of progress) {
        ensureSpace(2);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
        doc.setTextColor(0);
        const productLines = doc.splitTextToSize(p.recipe_name, pageWidth - marginX * 2 - 20);
        doc.text(productLines, marginX, y);
        doc.text(`${p.quantity_completed}/${p.quantity_required}`, pageWidth - marginX - 15, y);
        y += productLines.length * 5;

        // Detalle de quién armó cada unidad, en qué puesto y cuándo — para
        // poder rastrear un error por las cámaras de seguridad.
        const detail = completionsByItemId.get(p.shipment_item_id) ?? [];
        doc.setFontSize(8);
        doc.setTextColor(110);
        for (const c of detail) {
          ensureSpace(1);
          const line = `  · ${c.operator_name} — puesto: ${c.workstation_name} — ${new Date(
            c.completed_at
          ).toLocaleString("es-AR")}`;
          doc.text(line, marginX, y);
          y += 4;
        }
        doc.setTextColor(0);
        y += 3;
      }

      ensureSpace(6);
      y += 10;
      doc.setDrawColor(180);
      doc.line(marginX, y, marginX + 70, y);
      y += 5;
      doc.setFontSize(9);
      doc.text("Firma", marginX, y);

      doc.save(`remito-${shipment.code}.pdf`);
    } catch (err: any) {
      setRemitoError(`No se pudo generar el remito: ${err?.message ?? "error desconocido"}`);
    }

    setGeneratingRemito(false);
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <h1 className="text-xl font-semibold">Progreso</h1>

      <div className="space-y-1">
        <label className="text-sm text-neutral-500">Tipo de envío</label>
        <div className="flex gap-2">
          {/* Flex y Colecta se unificaron en un solo botón (mismo motivo que
              en Armado): el remito y la etiqueta son prácticamente iguales,
              la única diferencia es QR vs. código de barras. */}
          {(["full", "flex"] as ShipmentType[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setShipmentType(t)}
              className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium ${
                shipmentType === t
                  ? "border-yellow-500 bg-yellow-100 text-neutral-900"
                  : "border-gray-300 bg-white text-neutral-600"
              }`}
            >
              {t === "flex" ? "Flex / Colecta" : "Full"}
            </button>
          ))}
        </div>

        {matchingShipments.length === 0 && (
          <p className="text-sm text-red-600">No hay ningún envío de tipo {shipmentType} todavía.</p>
        )}
        {matchingShipments.length === 1 && (
          <p className="text-sm text-neutral-500">
            Envío: {matchingShipments[0].code} ({matchingShipments[0].status})
          </p>
        )}
        {matchingShipments.length > 1 && (
          <div className="space-y-1">
            <label className="text-sm text-neutral-500">
              Hay más de un envío de este tipo, elegí cuál:
            </label>
            <select
              value={shipmentId}
              onChange={(e) => setShipmentId(e.target.value)}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2"
            >
              <option value="">Elegí un envío...</option>
              {matchingShipments.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} ({s.status})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {shipmentId && allComplete && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-green-300 bg-green-50 p-4">
          <p className="text-sm text-green-800">
            Este envío está completo — ya se puede generar el remito de despacho.
          </p>
          <button
            onClick={generateRemito}
            disabled={generatingRemito}
            className="shrink-0 rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {generatingRemito ? "Generando..." : "Generar remito de despacho"}
          </button>
        </div>
      )}
      {remitoError && <p className="text-sm text-red-600">{remitoError}</p>}

      {shipmentId && (
        <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200">
          {progress.map((p) => {
            const pct =
              p.quantity_required > 0
                ? Math.min(100, Math.round((p.quantity_completed / p.quantity_required) * 100))
                : 0;
            const done = p.quantity_completed >= p.quantity_required;
            const isExpanded = expanded[p.shipment_item_id];
            const detail = completionsByItem[p.shipment_item_id] ?? [];

            return (
              <li key={p.shipment_item_id} className="px-4 py-3">
                <button onClick={() => toggleExpanded(p.shipment_item_id)} className="w-full text-left">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{p.recipe_name}</span>
                    <span className="text-sm text-neutral-500">
                      {p.quantity_completed}/{p.quantity_required}
                    </span>
                  </div>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-200">
                    <div
                      className={`h-2 rounded-full transition-all ${done ? "bg-green-500" : "bg-yellow-400"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </button>

                {isExpanded && (
                  <ul className="mt-3 space-y-1 border-t border-gray-100 pt-2 text-sm text-neutral-600">
                    {detail.map((c) => (
                      <li key={c.id} className="flex flex-wrap items-center justify-between gap-x-3">
                        <span>
                          {c.operator_name}{" "}
                          <span className="text-neutral-400">· puesto: {c.workstation_name}</span>
                        </span>
                        <span className="text-neutral-400">
                          {new Date(c.completed_at).toLocaleString("es-AR")}
                        </span>
                      </li>
                    ))}
                    {detail.length === 0 && (
                      <li className="text-neutral-400">Todavía no se armó ninguna unidad.</li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
          {progress.length === 0 && (
            <li className="px-4 py-3 text-sm text-neutral-500">Este envío no tiene recetas cargadas.</li>
          )}
        </ul>
      )}
    </main>
  );
}
