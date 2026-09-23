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

type OperarioGroup = {
  operator_name: string;
  workstation_name: string;
  count: number;
  minAt: string;
  maxAt: string;
};

// Agrupa los armados de un mismo producto por operario+puesto, para no
// imprimir una línea por cada unidad en el remito cuando son muchas (ej: un
// combo de 20 unidades armado por la misma persona).
function groupCompletionsByOperario(rows: CompletionRow[]): OperarioGroup[] {
  const map = new Map<string, OperarioGroup>();
  for (const r of rows) {
    const key = `${r.operator_name}__${r.workstation_name}`;
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      if (r.completed_at < existing.minAt) existing.minAt = r.completed_at;
      if (r.completed_at > existing.maxAt) existing.maxAt = r.completed_at;
    } else {
      map.set(key, {
        operator_name: r.operator_name,
        workstation_name: r.workstation_name,
        count: 1,
        minAt: r.completed_at,
        maxAt: r.completed_at,
      });
    }
  }
  return Array.from(map.values());
}

function formatShortDateTime(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Línea que va en la columna "Armado por": quién, en qué puesto, cuántas
// unidades y en qué rango horario — así, si hay un error, se puede buscar
// ese rango por las cámaras de seguridad.
function formatOperarioGroupLine(g: OperarioGroup): string {
  const from = formatShortDateTime(g.minAt);
  const to = formatShortDateTime(g.maxAt);
  const when = from === to ? from : `${from} a ${to}`;
  return `${g.operator_name} — puesto: ${g.workstation_name} — ${g.count} un. — ${when}`;
}

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

  // Items de TODOS los envíos (no solo el elegido arriba) — hace falta para
  // poder armar el resumen de "Pendientes/Armados/Total" de Full y de
  // Flex/Colecta juntos, sin importar cuál esté seleccionado en este momento.
  const [itemsByShipment, setItemsByShipment] = useState<Record<string, ShipmentProgress[]>>({});

  async function loadShipmentItems(id: string) {
    const { data } = await supabase.from("shipment_progress").select("*").eq("shipment_id", id);
    setItemsByShipment((prev) => ({ ...prev, [id]: (data ?? []) as ShipmentProgress[] }));
  }

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
    // Para el resumen de Pendientes/Armados/Total de Full y Flex/Colecta,
    // que se muestra siempre arriba de todo, sin importar el envío elegido.
    ((data ?? []) as { id: string }[]).forEach((s) => loadShipmentItems(s.id));
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

  // Refresco automático del resumen de pedidos (Pendientes/Armados/Total):
  // mientras alguien tiene esta pantalla abierta, en Armado puede estar
  // completándose otro pedido al mismo tiempo — sin esto, los números
  // quedarían congelados con los de cuando se entró a la página.
  useEffect(() => {
    const interval = setInterval(() => {
      loadShipments();
    }, 20000);
    return () => clearInterval(interval);
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

      // Tabla del remito: Producto | Cantidad armada | Quién lo armó.
      // La columna "Armado por" va agrupada por operario+puesto (no una
      // línea por cada unidad), para que un combo de 10/20/40 unidades no
      // haga el remito interminable, tal como en el remito de Mercado Libre.
      const col1X = marginX;
      const col1W = 70;
      const col2X = col1X + col1W;
      const col2W = 20;
      const col3X = col2X + col2W;
      const col3W = pageWidth - marginX - col3X;
      const lineH = 4.5;

      function drawTableHeader() {
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        doc.setTextColor(0);
        doc.text("Producto", col1X + 1, y);
        doc.text("Cant.", col2X + 1, y);
        doc.text("Armado por", col3X + 1, y);
        y += 2;
        doc.setDrawColor(120);
        doc.line(marginX, y, pageWidth - marginX, y);
        y += 5;
      }

      // Devuelve true si tuvo que saltar de página (para poder repetir el
      // encabezado de la tabla arriba de cada página nueva).
      function ensureSpace(rowHeight: number): boolean {
        if (y + rowHeight > pageHeight - 25) {
          doc.addPage();
          y = 20;
          return true;
        }
        return false;
      }

      drawTableHeader();

      for (const p of progress) {
        const productLines = doc.splitTextToSize(p.recipe_name, col1W - 2);
        const detail = completionsByItemId.get(p.shipment_item_id) ?? [];
        const groups = groupCompletionsByOperario(detail);
        const armadoLines: string[] =
          groups.length > 0
            ? groups.flatMap((g) => doc.splitTextToSize(formatOperarioGroupLine(g), col3W - 2))
            : ["Todavía no se registró ningún armado."];

        const rowLines = Math.max(productLines.length, armadoLines.length, 1);
        const rowHeight = rowLines * lineH + 3;

        if (ensureSpace(rowHeight)) drawTableHeader();
        const rowTop = y;

        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.setTextColor(0);
        doc.text(productLines, col1X + 1, y + lineH - 1);
        doc.text(`${p.quantity_completed}/${p.quantity_required}`, col2X + 1, y + lineH - 1);
        doc.setTextColor(90);
        doc.text(armadoLines, col3X + 1, y + lineH - 1);
        doc.setTextColor(0);

        y = rowTop + rowHeight;
        doc.setDrawColor(225);
        doc.line(col2X, rowTop, col2X, y);
        doc.line(col3X, rowTop, col3X, y);
        doc.line(marginX, y, pageWidth - marginX, y);
        y += 1;
      }

      ensureSpace(30);
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

  // Resumen de pedidos a preparar, separado por Full y Flex/Colecta — cuenta
  // los items (cada línea/paquete a armar) de los envíos ABIERTOS nada más,
  // sin importar cuál esté elegido arriba en el selector.
  function pedidosStatsFor(types: Array<(typeof shipments)[number]["type"]>) {
    const items = shipments
      .filter((s) => s.status === "open" && types.includes(s.type))
      .flatMap((s) => itemsByShipment[s.id] ?? []);
    const armados = items.filter((it) => it.quantity_completed >= it.quantity_required).length;
    const total = items.length;
    return { pendientes: total - armados, armados, total };
  }
  const pedidosFull = pedidosStatsFor(["full"]);
  const pedidosFlexColecta = pedidosStatsFor(["flex", "colecta"]);
  // El resumen que se muestra depende de qué tipo está elegido arriba, para
  // que quede adentro de esa misma sección en vez de mostrar los dos juntos.
  const pedidosDelTipoElegido = shipmentType === "full" ? pedidosFull : pedidosFlexColecta;

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

        {/* Resumen de pedidos a preparar de ESTE tipo, adentro de esta misma
            sección — cambia junto con el botón de arriba. */}
        <div className="grid grid-cols-3 gap-3 pt-1">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-center">
            <p className="text-2xl font-semibold text-amber-700">{pedidosDelTipoElegido.pendientes}</p>
            <p className="text-sm text-amber-700">Pendientes</p>
          </div>
          <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-center">
            <p className="text-2xl font-semibold text-green-700">{pedidosDelTipoElegido.armados}</p>
            <p className="text-sm text-green-700">Armados</p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-center">
            <p className="text-2xl font-semibold text-neutral-700">{pedidosDelTipoElegido.total}</p>
            <p className="text-sm text-neutral-600">Total pedidos</p>
          </div>
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
