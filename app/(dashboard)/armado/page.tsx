"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { playOkSound, playErrorSound, playCompleteSound } from "@/lib/audio";
import type {
  Recipe,
  RecipeComponent,
  Shipment,
  ShipmentType,
  Operator,
  ScannedComponent,
  ShipmentProgress,
} from "@/types/database.types";

type Feedback = { type: "ok" | "error"; message: string } | null;

type ComponentProgress = RecipeComponent & { scannedCount: number };

export default function ArmadoPage() {
  const [supabase] = useState(() => createClient());

  // Envío activo: en vez de elegir el código puntual, se elige el tipo
  // (Full / Flex / Colecta) y el sistema busca solo entre los envíos
  // abiertos de ese tipo — se asume que normalmente hay uno solo abierto
  // por tipo a la vez.
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [shipmentType, setShipmentType] = useState<ShipmentType>("full");
  const [matchingShipments, setMatchingShipments] = useState<Shipment[]>([]);
  const [shipmentId, setShipmentId] = useState<string>("");

  // Receta en armado
  const [shipmentItemId, setShipmentItemId] = useState<string | null>(null);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [components, setComponents] = useState<ComponentProgress[]>([]);
  const [scannedLog, setScannedLog] = useState<ScannedComponent[]>([]);

  // Progreso de la receta actual (requerido / completado)
  const [required, setRequired] = useState(0);
  const [completed, setCompleted] = useState(0);

  const [feedback, setFeedback] = useState<Feedback>(null);
  const [scanValue, setScanValue] = useState("");
  const [loading, setLoading] = useState(false);

  // Cantidad a confirmar con el próximo escaneo de un componente — sirve para
  // cargar de una vez varias unidades iguales (ej: "50" y un solo escaneo)
  // en vez de escanear una por una.
  const [bulkQuantity, setBulkQuantity] = useState("1");

  // Forma de chequeo para Full: "unidad" (como siempre, hay que repetir todo
  // el ciclo por cada unidad) o "item" (se escanean los componentes una sola
  // vez y al confirmar se completan de golpe todas las unidades que falten
  // de ese ítem). Se elige por etiqueta escaneada, no queda guardado en
  // ningún lado — por eso se resetea junto con el resto de la receta.
  const [checkMode, setCheckMode] = useState<"unidad" | "item">("unidad");

  // Último código leído por el lector (etiqueta o componente), para
  // mostrarlo fijo justo abajo del campo de escaneo — a diferencia de
  // "feedback" (el cartel grande de arriba), que se borra solo a los pocos
  // segundos, este queda a la vista hasta el próximo escaneo.
  const [lastScan, setLastScan] = useState<{ code: string; ok: boolean } | null>(null);

  // Modal de confirmación
  const [showConfirm, setShowConfirm] = useState(false);
  const [operators, setOperators] = useState<Operator[]>([]);
  const [operatorId, setOperatorId] = useState("");
  const [pin, setPin] = useState("");
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // Copiar EAN/SKU de un componente con un toque, para cuando el lector no
  // lo lee y hay que validarlo escribiéndolo/pegándolo a mano.
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  function copyCode(code: string) {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).catch(() => {});
    }
    setCopiedCode(code);
    window.setTimeout(() => {
      setCopiedCode((current) => (current === code ? null : current));
    }, 1500);
  }

  const scanInputRef = useRef<HTMLInputElement>(null);

  // Mantener el foco siempre en el input de escaneo — el lector de código
  // de barras "escribe" ahí como si fuera un teclado.
  const focusScanInput = useCallback(() => {
    scanInputRef.current?.focus();
  }, []);

  useEffect(() => {
    focusScanInput();
  }, [focusScanInput, shipmentItemId, showConfirm]);

  // Cargar envíos abiertos de la empresa
  useEffect(() => {
    supabase
      .from("shipments")
      .select("*")
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .then(({ data }) => setShipments(data ?? []));
  }, [supabase]);

  // Resolver a qué envío corresponde el tipo elegido: si hay uno solo
  // abierto de ese tipo, se usa directo; si hay más de uno, se pide elegir
  // entre esos pocos; si no hay ninguno, queda sin envío.
  useEffect(() => {
    const matches = shipments.filter((s) => s.type === shipmentType);
    setMatchingShipments(matches);
    setShipmentId(matches.length === 1 ? matches[0].id : "");
    resetRecipeState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shipmentType, shipments]);

  // Cargar operarios activos de la empresa (para el modal de confirmación)
  useEffect(() => {
    supabase
      .from("operators")
      .select("*")
      .eq("active", true)
      .order("full_name")
      .then(({ data }) => setOperators(data ?? []));
  }, [supabase]);

  function resetRecipeState() {
    setShipmentItemId(null);
    setRecipe(null);
    setComponents([]);
    setScannedLog([]);
    setRequired(0);
    setCompleted(0);
    setCheckMode("unidad");
  }

  async function loadProgress(itemId: string) {
    const { data } = await supabase
      .from("shipment_progress")
      .select("*")
      .eq("shipment_item_id", itemId)
      .single();

    // El cliente tipado no infiere bien las vistas (shipment_progress no es
    // una tabla), así que acá casteamos a mano contra el tipo que ya
    // tenemos escrito para esta vista.
    const progress = data as ShipmentProgress | null;

    if (progress) {
      setRequired(progress.quantity_required);
      setCompleted(progress.quantity_completed);
    }
  }

  function showFeedback(type: "ok" | "error", message: string) {
    setFeedback({ type, message });
    if (type === "ok") playOkSound();
    else playErrorSound();
    setTimeout(() => setFeedback(null), type === "error" ? 2500 : 2000);
  }

  // Escaneo de la ETIQUETA (arranca una receta nueva). El Código ML de la
  // etiqueta es un dato de ESTE envío puntual (shipment_items.label_ean),
  // no de la receta — así no importa que el código cambie de envío en
  // envío: cada envío guarda el suyo propio al importarse.
  async function handleLabelScan(ean: string) {
    if (!shipmentId) {
      showFeedback("error", "Elegí un envío primero");
      scanInputRef.current?.select();
      return;
    }

    setLoading(true);

    // El cliente tipado no infiere bien los selects con relaciones
    // embebidas ("*, recipes(*)"), así que trabajamos con el resultado
    // como "any" acá adentro.
    const { data: rawItemData } = await supabase
      .from("shipment_items")
      .select("*, recipes(*)")
      .eq("shipment_id", shipmentId)
      .eq("label_ean", ean)
      .maybeSingle();

    const itemData = rawItemData as any;
    const recipeData = itemData?.recipes ?? null;

    if (!itemData || !recipeData || !recipeData.active) {
      setLoading(false);
      setLastScan({ code: ean, ok: false });
      showFeedback("error", `Etiqueta ${ean} no corresponde a ningún producto de este envío`);
      scanInputRef.current?.select();
      return;
    }

    const { data: componentsData } = await supabase
      .from("recipe_components")
      .select("*")
      .eq("recipe_id", recipeData.id);

    // Mismo motivo que arriba: como "recipeData.id" viene de un resultado
    // "any", TypeScript deja de poder inferir el tipo de esta consulta
    // también, así que lo casteamos a mano.
    const components = (componentsData ?? []) as RecipeComponent[];

    setRecipe(recipeData);
    setShipmentItemId(itemData.id);
    setComponents(components.map((c) => ({ ...c, scannedCount: 0 })));
    setScannedLog([]);
    await loadProgress(itemData.id);

    setLoading(false);
    setScanValue("");
    setLastScan({ code: ean, ok: true });
    showFeedback("ok", `Receta: ${recipeData.name}`);
  }

  // Escaneo de un PRODUCTO componente. Valida tanto por EAN como por SKU
  // (Mercado Libre a veces imprime uno u otro según el producto).
  function handleComponentScan(code: string) {
    const idx = components.findIndex(
      (c) => c.product_ean === code || (c.product_sku && c.product_sku === code)
    );

    if (idx === -1) {
      setLastScan({ code, ok: false });
      showFeedback("error", `Producto ${code} no pertenece a esta receta`);
      setScannedLog((log) => [
        ...log,
        { ean: code, product_name: "DESCONOCIDO", ok: false, scanned_at: new Date().toISOString() },
      ]);
      setBulkQuantity("1");
      scanInputRef.current?.select();
      return;
    }

    const comp = components[idx];

    if (comp.scannedCount >= comp.quantity) {
      setLastScan({ code, ok: false });
      showFeedback("error", `Ya escaneaste todas las unidades de ${comp.product_name}`);
      setBulkQuantity("1");
      scanInputRef.current?.select();
      return;
    }

    // Cuántas unidades confirma este escaneo: lo que se puso en "Cantidad".
    // Si pide más de lo que falta para este componente, se rechaza el
    // escaneo entero (no se acepta una cantidad parcial) para que el
    // operario se dé cuenta del error y lo corrija.
    const requested = Math.max(1, parseInt(bulkQuantity) || 1);
    const remaining = comp.quantity - comp.scannedCount;

    if (requested > remaining) {
      setLastScan({ code, ok: false });
      showFeedback(
        "error",
        `Pusiste ${requested} pero solo falta${remaining === 1 ? "" : "n"} ${remaining} de ${comp.product_name}. Corregí la cantidad.`
      );
      scanInputRef.current?.select();
      return;
    }

    const updated = [...components];
    updated[idx] = { ...comp, scannedCount: comp.scannedCount + requested };
    setComponents(updated);
    setScannedLog((log) => [
      ...log,
      {
        ean: code,
        product_name: comp.product_name,
        ok: true,
        scanned_at: new Date().toISOString(),
        quantity: requested,
      },
    ]);

    const newCount = comp.scannedCount + requested;
    setLastScan({ code, ok: true });
    showFeedback("ok", `${comp.product_name} (${newCount}/${comp.quantity})`);
    setBulkQuantity("1");
    setScanValue("");

    const allComplete = updated.every((c) => c.scannedCount >= c.quantity);
    if (allComplete) {
      setTimeout(() => {
        playCompleteSound();
        setShowConfirm(true);
      }, 300);
    }
  }

  // Lógica de confirmar el escaneo actual — separada del evento del <form>
  // para poder dispararla también con Enter parado en el campo de Cantidad
  // (a veces se pasa de la etiqueta al campo de Cantidad sin volver a hacer
  // clic en el campo de escaneo, y el Enter tiene que funcionar igual).
  // El campo de escaneo NO se limpia acá: cada función lo limpia solo si el
  // escaneo se aceptó, así si se rechaza el operario puede corregir la
  // cantidad y reintentar sin tener que volver a escanear el código.
  // El QR que Mercado Libre imprime en la etiqueta de un paquete Flex/
  // Colecta no trae solo el número de "Identificación": el lector devuelve
  // un texto más largo con esta forma:
  //   LA,{"id":"47605501166","sender_id":221909209,"hash_code":"...","security_digit":"0"}
  // El "hash_code" cambia en cada impresión, así que nunca se puede guardar
  // tal cual en el catálogo — lo único estable es el "id" de adentro, que
  // es el mismo número que se guarda en shipment_items.label_ean al
  // importar el envío. Si el escaneo tiene esta forma, se usa ese "id" en
  // vez del texto completo; si no (por ejemplo, un EAN de un producto de
  // Full), se usa tal cual vino.
  function extractLabelCode(rawScan: string): string {
    const match = rawScan.match(/"id"\s*:\s*"(\d+)"/);
    return match ? match[1] : rawScan;
  }

  function submitScan() {
    const value = scanValue.trim();
    if (!value) return;

    if (!shipmentItemId) {
      handleLabelScan(extractLabelCode(value));
    } else {
      handleComponentScan(value);
    }
  }

  function handleScanSubmit(e: React.FormEvent) {
    e.preventDefault();
    submitScan();
  }

  function handleQuantityKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      submitScan();
    }
  }

  async function handleConfirm() {
    setConfirmError(null);

    if (!operatorId || !pin) {
      setConfirmError("Elegí un operario e ingresá el PIN");
      return;
    }

    setLoading(true);

    const verifyRes = await fetch("/api/operators/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operator_id: operatorId, pin }),
    });
    const verifyData = await verifyRes.json();

    if (!verifyData.ok) {
      setLoading(false);
      setConfirmError(verifyData.error ?? "PIN incorrecto");
      return;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();

    // Modo "por ítem" (solo Full): en vez de anotar 1 sola unidad completada,
    // se anotan de golpe todas las que le falten a este ítem para llegar
    // justo a la cantidad requerida (si ya tenía algo cargado antes en modo
    // "por unidad", completa nada más lo que falta — nunca se pasa del
    // total). La vista "shipment_progress" solo cuenta filas de esta tabla,
    // así que no hace falta ninguna migración: alcanza con insertar varias.
    const isItemMode = shipmentType === "full" && checkMode === "item";
    const unitsToConfirm = isItemMode ? Math.max(required - completed, 1) : 1;

    // El cliente tipado a veces no logra resolver el tipo de "insert" para
    // esta tabla (mismo motivo de fondo que los otros casteos de este
    // archivo), así que forzamos el tipo del objeto a mano acá.
    const baseCompletion = {
      company_id: recipe!.company_id,
      shipment_item_id: shipmentItemId!,
      recipe_id: recipe!.id,
      operator_id: operatorId,
      user_id: user?.id ?? null,
      workstation_id: null, // TODO: configurar puesto de trabajo por PC
      scanned_components: scannedLog,
    };
    const rowsToInsert = Array.from({ length: unitsToConfirm }, () => ({ ...baseCompletion }));

    const { error: insertError } = await supabase.from("completions").insert(rowsToInsert as any);

    setLoading(false);

    if (insertError) {
      setConfirmError("Error al guardar. Probá de nuevo.");
      return;
    }

    // Éxito: cerrar modal, resetear para la próxima unidad
    setShowConfirm(false);
    setPin("");
    setOperatorId("");
    resetRecipeState();
    focusScanInput();
  }

  function handleCancelConfirm() {
    setShowConfirm(false);
    setPin("");
    setConfirmError(null);
    // No se resetea la receta: el operario puede haber tocado mal el botón,
    // los productos ya escaneados siguen contando.
  }

  return (
    <main className="min-h-screen bg-white p-6 text-neutral-900">
      <div className="mx-auto max-w-2xl space-y-6">
        <h1 className="text-xl font-semibold">Chequeo de armado</h1>

        {/* Selector de tipo de envío (Full / Flex / Colecta) */}
        <div className="space-y-1">
          <label className="text-sm text-neutral-500">Tipo de envío</label>
          <div className="flex gap-2">
            {/* Flex y Colecta se unificaron en un solo botón: el remito y la
                etiqueta son prácticamente iguales (la única diferencia es
                QR vs. código de barras, y el mismo lector lee los dos), así
                que no tiene sentido manejarlos como envíos separados. */}
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
            <p className="text-sm text-red-600">
              No hay ningún envío abierto de tipo {shipmentType}.
            </p>
          )}
          {matchingShipments.length === 1 && (
            <p className="text-sm text-neutral-500">Envío activo: {matchingShipments[0].code}</p>
          )}
          {matchingShipments.length > 1 && (
            <div className="space-y-1">
              <label className="text-sm text-neutral-500">
                Hay más de un envío abierto de este tipo, elegí cuál:
              </label>
              <select
                value={shipmentId}
                onChange={(e) => {
                  setShipmentId(e.target.value);
                  resetRecipeState();
                }}
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-2"
              >
                <option value="">Elegí un envío...</option>
                {matchingShipments.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Input de escaneo, siempre enfocado. Va solo dentro del <form> (un
            único campo) para que el Enter del lector de código de barras
            siga disparando el envío como antes — el de Cantidad queda afuera
            del form, como control aparte, para no romper eso. */}
        <div className="flex gap-3">
          <form onSubmit={handleScanSubmit} className="flex-1">
            <input
              ref={scanInputRef}
              autoFocus
              value={scanValue}
              onChange={(e) => setScanValue(e.target.value)}
              disabled={loading || showConfirm}
              placeholder={
                shipmentItemId ? "Escaneá un producto componente..." : "Escaneá la etiqueta..."
              }
              className="w-full rounded-md border border-gray-300 bg-white px-4 py-3 text-lg outline-none focus:border-yellow-500"
            />
          </form>
          {shipmentItemId && (
            <input
              type="number"
              min={1}
              value={bulkQuantity}
              onChange={(e) => setBulkQuantity(e.target.value)}
              onKeyDown={handleQuantityKeyDown}
              disabled={loading || showConfirm}
              inputMode="numeric"
              title="Cantidad a confirmar con el próximo escaneo (para cargar varias unidades iguales de una vez)"
              placeholder="Cant."
              className="w-28 rounded-md border border-gray-300 bg-white px-3 py-3 text-center text-lg outline-none focus:border-yellow-500"
            />
          )}
        </div>
        {shipmentItemId && (
          <p className="text-xs text-neutral-400">
            Si varias unidades son del mismo producto, poné la cantidad ahí al lado y escaneá una
            sola vez.
          </p>
        )}

        {/* Último código leído, fijo hasta el próximo escaneo (a diferencia
            del feedback grande de abajo, que se borra solo). */}
        {lastScan && (
          <p
            className={`text-sm font-medium ${lastScan.ok ? "text-green-700" : "text-red-600"}`}
          >
            Último leído: <span className="font-mono">{lastScan.code}</span>{" "}
            {lastScan.ok ? "✓ aprobado" : "✗ rechazado"}
          </p>
        )}

        {/* Feedback visual grande */}
        {feedback && (
          <div
            className={`rounded-md p-4 text-center text-lg font-semibold ${
              feedback.type === "ok"
                ? "bg-green-100 text-green-800"
                : "bg-red-100 text-red-700"
            }`}
          >
            {feedback.type === "ok" ? "✓ " : "✗ "}
            {feedback.message}
          </div>
        )}

        {/* Receta en curso */}
        {recipe && (
          <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-medium">{recipe.name}</h2>
              <span className="text-sm text-neutral-500">
                Avance: {completed}/{required}
              </span>
            </div>

            {/* Forma de chequeo — solo tiene sentido para Full: en Flex/Colecta
                cada paquete es 1 unidad, no hay "etiqueta de 100" que armar. */}
            {shipmentType === "full" && (
              <div className="space-y-1 rounded-md border border-gray-200 bg-gray-50 p-3">
                <label className="text-sm text-neutral-500">Forma de chequeo</label>
                <div className="flex gap-2">
                  {(
                    [
                      { value: "unidad", label: "Por unidad" },
                      { value: "item", label: "Por ítem" },
                    ] as { value: "unidad" | "item"; label: string }[]
                  ).map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setCheckMode(opt.value)}
                      className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium ${
                        checkMode === opt.value
                          ? "border-yellow-500 bg-yellow-100 text-neutral-900"
                          : "border-gray-300 bg-white text-neutral-600"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-neutral-400">
                  {checkMode === "item"
                    ? "Escaneás los componentes una sola vez y al confirmar se completan de golpe todas las unidades que le falten a este ítem."
                    : "Repetís el escaneo completo por cada unidad, como siempre."}
                </p>
              </div>
            )}

            <ul className="space-y-1">
              {components.map((c) => (
                <li
                  key={c.id}
                  className={`flex items-center justify-between rounded px-3 py-2 text-sm ${
                    c.scannedCount >= c.quantity
                      ? "bg-green-50 text-green-700"
                      : "bg-gray-100 text-neutral-700"
                  }`}
                >
                  <span className="flex flex-wrap items-center gap-1">
                    {c.product_name}
                    <span className="text-neutral-400">(EAN:</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        copyCode(c.product_ean);
                      }}
                      title="Tocá para copiar el EAN"
                      className="rounded border border-neutral-300 bg-white px-1.5 py-0.5 font-mono text-xs text-neutral-700 hover:border-neutral-500 hover:bg-neutral-50"
                    >
                      {c.product_ean}
                    </button>
                    {c.product_sku && (
                      <>
                        <span className="text-neutral-400">· SKU:</span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            copyCode(c.product_sku!);
                          }}
                          title="Tocá para copiar el SKU"
                          className="rounded border border-neutral-300 bg-white px-1.5 py-0.5 font-mono text-xs text-neutral-700 hover:border-neutral-500 hover:bg-neutral-50"
                        >
                          {c.product_sku}
                        </button>
                      </>
                    )}
                    <span className="text-neutral-400">)</span>
                    {(copiedCode === c.product_ean || (c.product_sku && copiedCode === c.product_sku)) && (
                      <span className="font-semibold text-green-600">¡Copiado!</span>
                    )}
                  </span>
                  <span>
                    {c.scannedCount}/{c.quantity}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Modal de confirmación: nombre + PIN de operario */}
      {showConfirm && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-sm space-y-4 rounded-lg border border-gray-200 bg-white p-6">
            <h3 className="text-lg font-semibold">Confirmar armado</h3>
            <p className="text-sm text-neutral-500">
              Se completaron todos los componentes de &quot;{recipe?.name}&quot;.
            </p>

            {shipmentType === "full" && checkMode === "item" && (
              <p className="rounded-md bg-amber-50 p-2 text-sm font-medium text-amber-700">
                Se van a confirmar {Math.max(required - completed, 1)} unidades de este ítem de
                una sola vez.
              </p>
            )}

            <div className="space-y-1">
              <label className="text-sm text-neutral-500">Operario</label>
              <select
                value={operatorId}
                onChange={(e) => setOperatorId(e.target.value)}
                className="w-full rounded-md border border-gray-300 bg-gray-100 px-3 py-2"
              >
                <option value="">Elegí tu nombre...</option>
                {operators.map((op) => (
                  <option key={op.id} value={op.id}>
                    {op.full_name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-sm text-neutral-500">PIN</label>
              <input
                type="password"
                inputMode="numeric"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                className="w-full rounded-md border border-gray-300 bg-gray-100 px-3 py-2"
                autoFocus
              />
            </div>

            {confirmError && <p className="text-sm text-red-600">{confirmError}</p>}

            <div className="flex gap-2">
              <button
                onClick={handleCancelConfirm}
                className="flex-1 rounded-md border border-gray-300 py-2 text-neutral-700"
              >
                Cancelar
              </button>
              <button
                onClick={handleConfirm}
                disabled={loading}
                className="flex-1 rounded-md bg-yellow-400 py-2 font-semibold text-neutral-900 disabled:opacity-50"
              >
                {loading ? "Guardando..." : "Confirmar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
