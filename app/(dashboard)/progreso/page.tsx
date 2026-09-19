"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Shipment, ShipmentType, ShipmentProgress } from "@/types/database.types";

type CompletionRow = {
  id: string;
  completed_at: string;
  operator_name: string;
};

export default function ProgresoPage() {
  const [supabase] = useState(() => createClient());

  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [shipmentType, setShipmentType] = useState<ShipmentType>("full");
  const [matchingShipments, setMatchingShipments] = useState<Shipment[]>([]);
  const [shipmentId, setShipmentId] = useState("");

  const [progress, setProgress] = useState<ShipmentProgress[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [completionsByItem, setCompletionsByItem] = useState<Record<string, CompletionRow[]>>({});

  // Referencia siempre actualizada de "expanded", para poder usarla dentro
  // del callback de Realtime sin tener que re-suscribirse cada vez que cambia.
  const expandedRef = useRef(expanded);
  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

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

  async function loadCompletionsForItem(itemId: string) {
    const { data } = await supabase
      .from("completions")
      .select("id, completed_at, operators(full_name)")
      .eq("shipment_item_id", itemId)
      .order("completed_at", { ascending: false });

    const rows: CompletionRow[] = (data ?? []).map((c: any) => ({
      id: c.id,
      completed_at: c.completed_at,
      operator_name: c.operators?.full_name ?? "Desconocido",
    }));

    setCompletionsByItem((prev) => ({ ...prev, [itemId]: rows }));
  }

  useEffect(() => {
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
                      <li key={c.id} className="flex items-center justify-between">
                        <span>{c.operator_name}</span>
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
