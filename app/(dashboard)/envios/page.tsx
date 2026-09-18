"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Product, Recipe, Shipment, ShipmentProgress, ShipmentType } from "@/types/database.types";
import type { ParsedMlRow } from "@/lib/parse-ml-pdf";

// Cada fila del PDF, más el resultado de compararla contra el catálogo de
// Productos/Recetas ya cargado: a qué receta corresponde (si se encontró),
// para que el admin la confirme o la corrija antes de importar.
type PreviewRow = ParsedMlRow & { recipeId: string | null };

export default function EnviosPage() {
  const [supabase] = useState(() => createClient());
  const [isAdmin, setIsAdmin] = useState(false);
  const [companyId, setCompanyId] = useState<string | null>(null);

  const [shipments, setShipments] = useState<(Shipment & { itemCount?: number })[]>([]);

  // Catálogo actual, para comparar cada línea del PDF contra lo ya cargado.
  const [products, setProducts] = useState<Product[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]); // solo recetas ACTIVAS (las que se pueden importar)
  const [allRecipes, setAllRecipes] = useState<Recipe[]>([]); // todas, activas o no — solo para el diagnóstico de abajo

  // Importación de PDF
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [shipmentCode, setShipmentCode] = useState("");
  const [shipmentType, setShipmentType] = useState<ShipmentType>("full");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);

  // Items de cada envío ya cargado: qué receta/producto tiene cada línea,
  // cuánto se pidió y cuánto se lleva armado. Se muestran siempre, sin
  // necesidad de tocar nada para verlos.
  const [itemsByShipment, setItemsByShipment] = useState<Record<string, ShipmentProgress[]>>({});
  const [loadingItemsFor, setLoadingItemsFor] = useState<Record<string, boolean>>({});

  async function loadShipmentItems(shipmentId: string) {
    setLoadingItemsFor((prev) => ({ ...prev, [shipmentId]: true }));
    // La vista shipment_progress trae bien el nombre de la receta y el
    // progreso armado, pero su columna "label_ean" sale de recipes.label_ean
    // (un dato fijo de la receta, muchas veces vacío). El código que hay que
    // escanear de VERDAD para este envío puntual vive en
    // shipment_items.label_ean (cambia de envío en envío, por eso no vive en
    // la receta) — lo traemos aparte y lo usamos en vez del de la vista.
    const [{ data: progressData }, { data: itemsData }] = await Promise.all([
      supabase
        .from("shipment_progress")
        .select("*")
        .eq("shipment_id", shipmentId)
        .order("recipe_name", { ascending: true }),
      supabase.from("shipment_items").select("id, label_ean").eq("shipment_id", shipmentId),
    ]);

    // El cliente tipado no infiere bien las vistas (shipment_progress no es
    // una tabla), así que acá casteamos a mano contra el tipo que ya
    // tenemos escrito para esta vista.
    const progressRows = (progressData ?? []) as ShipmentProgress[];
    // Mismo motivo de fondo que otros casteos de la app: sin este casteo,
    // TypeScript no puede inferir bien las propiedades de cada fila acá.
    const itemsRows = (itemsData ?? []) as { id: string; label_ean: string | null }[];
    const realLabelByItemId = new Map(itemsRows.map((it) => [it.id, it.label_ean]));
    const merged = progressRows.map((p) => ({
      ...p,
      label_ean: realLabelByItemId.get(p.shipment_item_id) ?? p.label_ean,
    }));

    setItemsByShipment((prev) => ({ ...prev, [shipmentId]: merged }));
    setLoadingItemsFor((prev) => ({ ...prev, [shipmentId]: false }));
  }

  async function loadShipments() {
    const { data } = await supabase
      .from("shipments")
      .select("*")
      .order("created_at", { ascending: false });
    setShipments(data ?? []);
    // Los items de cada envío se muestran siempre (no hay que tocar nada
    // para verlos), así que los traemos de una vez para todos los envíos.
    // Casteamos el resultado a mano (mismo motivo de fondo que otros
    // casteos de la app) para poder leer "id" de cada fila sin error.
    ((data ?? []) as { id: string }[]).forEach((s) => loadShipmentItems(s.id));
  }

  async function loadCatalog(): Promise<{ products: Product[]; recipes: Recipe[]; allRecipes: Recipe[] }> {
    const { data: productsData } = await supabase.from("products").select("*");
    setProducts(productsData ?? []);
    const { data: allRecipesData } = await supabase.from("recipes").select("*");
    setAllRecipes(allRecipesData ?? []);
    const activeRecipes = ((allRecipesData ?? []) as Recipe[]).filter((r) => r.active);
    setRecipes(activeRecipes);
    // Devolvemos los datos recién traídos (no solo los guardamos en el estado)
    // porque el estado de React no se actualiza al instante: si justo después
    // de llamar a esta función comparamos usando las variables de estado
    // "products"/"recipes", todavía vamos a estar mirando la versión vieja
    // que tenía la pantalla desde que se abrió, no la que acabamos de traer.
    return { products: productsData ?? [], recipes: activeRecipes, allRecipes: allRecipesData ?? [] };
  }

  useEffect(() => {
    async function init() {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      const { data: profileRaw } = await supabase
        .from("users")
        .select("company_id, role")
        .eq("id", user.id)
        .single();
      // El cliente tipado no siempre resuelve bien el tipo de este resultado
      // (mismo motivo de fondo que otros casteos de la app) — pasa incluso
      // usando "?." — así que lo casteamos a mano.
      const profile = profileRaw as { company_id: string; role: string } | null;
      setIsAdmin(profile?.role === "admin");
      setCompanyId(profile?.company_id ?? null);
      await Promise.all([loadShipments(), loadCatalog()]);
    }
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Normaliza EAN/SKU antes de comparar: mayúsculas y sin espacios de más,
  // así una diferencia de mayúsculas/minúsculas o un espacio de sobra al
  // cargar el producto no hace fallar la comparación exacta.
  function normalizeCode(v: string | null | undefined): string {
    return (v ?? "").trim().toUpperCase();
  }

  // Busca el producto del catálogo que corresponde a esta línea del PDF:
  // primero por SKU, después por EAN (si no hay SKU o no matchea ninguno).
  // Se prioriza el SKU porque es el dato fijo y confiable — el "Código
  // universal" (EAN) de Mercado Libre muchas veces viene "N/A" y, peor
  // todavía, en la práctica aparecen productos DISTINTOS que comparten el
  // mismo EAN por un error de carga del lado de ML/vendedor (nos pasó con
  // productos reales). Si se buscara por EAN primero, esa clase de error
  // externo haría que una línea matchee contra el producto equivocado.
  // Recibe el catálogo como parámetro (en vez de usar directamente el
  // estado "products") para poder pasarle una versión recién traída de la
  // base cuando hace falta — ver el comentario en loadCatalog().
  function matchProduct(row: ParsedMlRow, catalogProducts: Product[] = products): Product | null {
    const rowEan = normalizeCode(row.ean);
    const rowSku = normalizeCode(row.sku);
    let product: Product | undefined;
    if (rowSku) product = catalogProducts.find((p) => normalizeCode(p.sku) === rowSku);
    if (!product && rowEan) product = catalogProducts.find((p) => normalizeCode(p.ean) === rowEan);
    return product ?? null;
  }

  // Busca en el catálogo qué receta corresponde a esta línea del PDF. No
  // inventa nada si no encuentra nada — esa fila queda "sin receta" para
  // que el admin decida. Solo cuenta recetas ACTIVAS (no se puede importar
  // contra una receta desactivada).
  function matchRecipe(
    row: ParsedMlRow,
    catalogProducts: Product[] = products,
    catalogRecipes: Recipe[] = recipes
  ): string | null {
    const product = matchProduct(row, catalogProducts);
    if (!product) return null;

    const recipe = catalogRecipes.find((r) => r.output_product_id === product.id);
    return recipe?.id ?? null;
  }

  // Diagnóstico detallado de por qué una fila quedó "sin receta", para
  // mostrarle al admin exactamente dónde está el problema en vez de un
  // genérico "sin receta": si el EAN/SKU ni siquiera está en Productos, si
  // el producto existe pero nunca se le creó una receta, o si tiene una
  // receta pero está desactivada.
  type RowDiagnosis = "sin-producto" | "sin-receta" | "receta-desactivada";
  function diagnoseRow(
    row: ParsedMlRow,
    catalogProducts: Product[] = products,
    catalogAllRecipes: Recipe[] = allRecipes
  ): RowDiagnosis {
    const product = matchProduct(row, catalogProducts);
    if (!product) return "sin-producto";
    const anyRecipe = catalogAllRecipes.find((r) => r.output_product_id === product.id);
    if (!anyRecipe) return "sin-receta";
    return anyRecipe.active ? "sin-receta" /* no debería pasar: matchRecipe ya la habría encontrado */ : "receta-desactivada";
  }

  function recipeLabel(recipeId: string | null): string {
    if (!recipeId) return "";
    const recipe = recipes.find((r) => r.id === recipeId);
    if (!recipe) return "";
    const product = products.find((p) => p.id === recipe.output_product_id);
    return product ? `${recipe.name} (${product.sku ?? product.ean ?? ""})` : recipe.name;
  }

  async function toggleShipmentStatus(shipment: Shipment) {
    const newStatus = shipment.status === "open" ? "closed" : "open";
    // "update" necesita un casteo más fuerte que "insert" (mismo motivo de
    // fondo que otros casteos de la app): acá no alcanza con castear el
    // objeto, hay que castear toda la consulta.
    await (supabase.from("shipments") as any)
      .update({ status: newStatus, closed_at: newStatus === "closed" ? new Date().toISOString() : null })
      .eq("id", shipment.id);
    loadShipments();
  }

  async function handleDeleteShipment(shipment: Shipment) {
    const confirmed = window.confirm(
      `¿Eliminar el envío "${shipment.code}"? Esto borra también todo su progreso de armado registrado. No se puede deshacer.`
    );
    if (!confirmed) return;

    await supabase.from("shipments").delete().eq("id", shipment.id);
    loadShipments();
  }

  async function handlePdfFile(e: React.ChangeEvent<HTMLInputElement>) {
    setParseError(null);
    setImportResult(null);
    setWarnings([]);
    setRows([]);

    const file = e.target.files?.[0];
    if (!file) return;

    setParsing(true);

    // Traer el catálogo más fresco posible justo antes de comparar, por si
    // se cargó algo nuevo en Productos/Recetas hace un momento. Usamos el
    // catálogo que nos devuelve la función directamente (no el estado
    // products/recipes) para la comparación de abajo, porque el estado
    // todavía no se actualizó en este mismo instante.
    const freshCatalog = await loadCatalog();

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/import/mercadolibre-pdf", { method: "POST", body: formData });
      const data = await res.json();

      if (!data.ok) {
        setParseError(data.error ?? "No se pudo leer el PDF");
        setParsing(false);
        return;
      }

      const parsedRows: ParsedMlRow[] = data.rows;
      setRows(
        parsedRows.map((row) => ({
          ...row,
          recipeId: matchRecipe(row, freshCatalog.products, freshCatalog.recipes),
        }))
      );
      setWarnings(data.warnings ?? []);
      setShipmentCode(data.envioNumero ? `FULL-${data.envioNumero}` : "");
    } catch {
      setParseError("Error de conexión al leer el PDF");
    }

    setParsing(false);
  }

  function updateRow(index: number, field: keyof ParsedMlRow, value: string) {
    setRows((prev) =>
      prev.map((row, i) => {
        if (i !== index) return row;
        if (field === "quantity") return { ...row, quantity: parseInt(value) || 0 };
        if (field === "ean") return { ...row, ean: value || null };
        return { ...row, [field]: value };
      })
    );
  }

  function updateRowRecipe(index: number, recipeId: string) {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, recipeId: recipeId || null } : row)));
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleConfirmImport() {
    if (!companyId || rows.length === 0 || !shipmentCode.trim()) return;

    setImporting(true);
    setImportResult(null);

    const { data: shipmentDataRaw, error: shipmentError } = await supabase
      .from("shipments")
      .insert({ company_id: companyId, code: shipmentCode.trim(), type: shipmentType, status: "open" } as any)
      .select()
      .single();

    // El cliente tipado no siempre resuelve bien el tipo de este resultado
    // (mismo motivo de fondo que otros casteos de la app), así que lo
    // casteamos a mano para poder acceder a sus propiedades sin error.
    const shipmentData = shipmentDataRaw as { id: string; code: string } | null;

    if (shipmentError || !shipmentData) {
      setImporting(false);
      setImportResult(`Error al crear el envío: ${shipmentError?.message}`);
      return;
    }

    // El sistema trabaja pura y exclusivamente sobre lo que ya está cargado
    // en el catálogo — no arma ni inventa recetas por su cuenta. Cada línea
    // del envío tiene que estar encontrada en las dos listas del catálogo
    // (Productos y Recetas, con receta ACTIVA) para poder importarse. Si a
    // una línea le falta cualquiera de las dos cosas, esa línea puntual
    // queda afuera del envío y se le avisa al admin para que la cargue en
    // el catálogo antes de reintentar — el resto de las líneas que sí están
    // completas se importan igual.
    let ok = 0;
    const sinProducto: string[] = [];
    const sinReceta: string[] = [];
    const errors: string[] = [];

    for (const row of rows) {
      const recipeId = row.recipeId;

      if (!recipeId) {
        const product = matchProduct(row);
        if (!product) {
          sinProducto.push(`${row.codigo_ml} — ${row.name}`);
        } else {
          sinReceta.push(`${row.codigo_ml} — ${row.name}`);
        }
        continue;
      }

      const { error: itemError } = await supabase.from("shipment_items").insert({
        company_id: companyId,
        shipment_id: shipmentData.id,
        recipe_id: recipeId,
        quantity_required: row.quantity,
        label_ean: row.codigo_ml,
      } as any);

      if (itemError) {
        errors.push(`${row.codigo_ml}: ${itemError.message}`);
        continue;
      }

      ok += 1;
    }

    setImporting(false);
    setImportResult(
      `Envío "${shipmentData.code}" creado con ${ok} de ${rows.length} productos.` +
        (sinProducto.length > 0
          ? sinProducto.length === 1
            ? ` Este ítem no se encuentra, asegurate de haberlo cargado previamente en el catálogo antes de generar un envío (no se importó): ${sinProducto[0]}.`
            : ` Estos ítems no se encuentran, asegurate de haberlos cargado previamente en el catálogo antes de generar un envío (no se importaron): ${sinProducto.join(
                " | "
              )}.`
          : "") +
        (sinReceta.length > 0
          ? sinReceta.length === 1
            ? ` Este ítem está en Productos pero no tiene una receta activa armada en Recetas, así que tampoco se importó — andá a Recetas y armala (o reactivala) antes de reintentar: ${sinReceta[0]}.`
            : ` Estos ítems están en Productos pero no tienen una receta activa armada en Recetas, así que tampoco se importaron — andá a Recetas y armalas (o reactivalas) antes de reintentar: ${sinReceta.join(
                " | "
              )}.`
          : "") +
        (errors.length > 0 ? ` Errores: ${errors.join(" | ")}` : "")
    );
    setRows([]);
    setShipmentCode("");
    loadShipments();
  }

  const totalUnidades = rows.reduce((sum, r) => sum + (r.quantity || 0), 0);
  const sinRecetaCount = rows.filter((r) => !r.recipeId).length;
  const sinProductoCount = rows.filter((r) => !r.recipeId && diagnoseRow(r) === "sin-producto").length;
  const recetaDesactivadaCount = rows.filter((r) => !r.recipeId && diagnoseRow(r) === "receta-desactivada").length;
  const conProductoSinRecetaCount = sinRecetaCount - sinProductoCount - recetaDesactivadaCount;

  return (
    <main className="mx-auto max-w-5xl space-y-10 p-6">
      <h1 className="text-xl font-semibold">Envío</h1>

      {isAdmin && (
        <section className="space-y-4 rounded-lg border border-gray-200 p-4">
          <h2 className="text-lg font-medium">Importar desde PDF de Mercado Libre (Full)</h2>
          <p className="text-sm text-neutral-500">
            Subí el PDF de &quot;instrucciones de preparación&quot; que te da Mercado Libre para un
            envío Full. Cada línea se compara por separado contra tus dos listas del catálogo —
            Productos y Recetas — y te muestra el resultado de cada una en su propia columna. El
            sistema no arma ni inventa nada: para que una línea se pueda importar tiene que estar
            encontrada en las dos, el Producto en tu catálogo y una Receta activa ya armada para ese
            producto. Si a una línea le falta cualquiera de las dos, esa línea queda afuera del envío
            (hay que cargarla en Productos o armarle la receta en Recetas antes de reintentar) — el
            resto del envío se importa igual.
          </p>

          <input type="file" accept=".pdf" onChange={handlePdfFile} className="text-sm" />

          {parsing && <p className="text-sm text-neutral-500">Leyendo el PDF...</p>}
          {parseError && <p className="text-sm text-red-600">{parseError}</p>}

          {warnings.length > 0 && (
            <div className="rounded-md bg-yellow-50 p-3 text-sm text-yellow-800">
              {warnings.map((w, i) => (
                <p key={i}>⚠ {w}</p>
              ))}
            </div>
          )}

          {rows.length > 0 && (
            <div className="space-y-3">
              <div className="flex gap-3">
                <div className="flex-1 space-y-1">
                  <label className="text-sm text-neutral-500">Código del envío</label>
                  <input
                    value={shipmentCode}
                    onChange={(e) => setShipmentCode(e.target.value)}
                    className="w-full rounded-md border border-gray-300 px-3 py-2"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm text-neutral-500">Tipo</label>
                  <select
                    value={shipmentType}
                    onChange={(e) => setShipmentType(e.target.value as ShipmentType)}
                    className="rounded-md border border-gray-300 px-3 py-2"
                  >
                    <option value="full">Full</option>
                    <option value="flex">Flex</option>
                    <option value="colecta">Colecta</option>
                  </select>
                </div>
              </div>

              <p className="text-sm text-neutral-700">
                {rows.length} productos detectados · {totalUnidades} unidades en total.
                {sinProductoCount > 0 && (
                  <span className="ml-1 font-semibold text-red-600">
                    {sinProductoCount} no está{sinProductoCount === 1 ? "" : "n"} en tu catálogo de
                    Productos — cargalo{sinProductoCount === 1 ? "" : "s"} ahí antes de importar, no se
                    va{sinProductoCount === 1 ? "" : "n"} a incluir en este envío.
                  </span>
                )}
              </p>
              {(conProductoSinRecetaCount > 0 || recetaDesactivadaCount > 0) && (
                <p className="text-xs text-neutral-500">
                  {conProductoSinRecetaCount > 0 && (
                    <span className="mr-3 font-semibold text-amber-600">
                      {conProductoSinRecetaCount} está{conProductoSinRecetaCount === 1 ? "" : "n"} en
                      Productos pero sin receta armada en Recetas — no se van a incluir en este envío
                      hasta que se las armes.
                    </span>
                  )}
                  {recetaDesactivadaCount > 0 && (
                    <span className="font-semibold text-amber-600">
                      {recetaDesactivadaCount} tiene{recetaDesactivadaCount === 1 ? "" : "n"} una receta
                      desactivada — no se van a incluir hasta que la reactives en Recetas.
                    </span>
                  )}
                </p>
              )}

              <div className="max-h-96 overflow-y-auto rounded-lg border border-gray-200">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-50">
                    <tr className="text-left text-neutral-500">
                      <th className="px-3 py-2">Código a escanear</th>
                      <th className="px-3 py-2">SKU</th>
                      <th className="px-3 py-2">EAN</th>
                      <th className="px-3 py-2">Nombre</th>
                      <th className="px-3 py-2">Cant.</th>
                      <th className="px-3 py-2">Productos</th>
                      <th className="px-3 py-2">Recetas</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => {
                      const matchedProduct = matchProduct(row);
                      const diagnosis: RowDiagnosis | null = row.recipeId ? null : diagnoseRow(row);
                      return (
                      <tr
                        key={i}
                        className={`border-t border-gray-100 ${
                          !diagnosis ? "" : diagnosis === "sin-producto" ? "bg-red-50" : "bg-amber-50"
                        }`}
                      >
                        <td className="px-3 py-1">
                          <input
                            value={row.codigo_ml}
                            onChange={(e) => updateRow(i, "codigo_ml", e.target.value)}
                            className="w-32 rounded border border-gray-300 px-2 py-1 font-medium"
                          />
                        </td>
                        <td className="px-3 py-1">
                          <input
                            value={row.sku}
                            onChange={(e) => updateRow(i, "sku", e.target.value)}
                            className="w-28 rounded border border-gray-300 px-2 py-1 text-neutral-500"
                          />
                        </td>
                        <td className="px-3 py-1">
                          <input
                            value={row.ean ?? ""}
                            placeholder="(sin EAN)"
                            onChange={(e) => updateRow(i, "ean", e.target.value)}
                            className="w-32 rounded border border-gray-300 px-2 py-1 text-neutral-500"
                          />
                        </td>
                        <td className="px-3 py-1">
                          <input
                            value={row.name}
                            onChange={(e) => updateRow(i, "name", e.target.value)}
                            className="w-full min-w-48 rounded border border-gray-300 px-2 py-1"
                          />
                        </td>
                        <td className="px-3 py-1">
                          <input
                            value={row.quantity}
                            onChange={(e) => updateRow(i, "quantity", e.target.value)}
                            className="w-16 rounded border border-gray-300 px-2 py-1"
                          />
                        </td>
                        <td className="px-3 py-1">
                          {matchedProduct ? (
                            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">
                              ✓ Encontrado
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
                              ✗ No encontrado
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-1">
                          <div className="space-y-1">
                            {row.recipeId ? (
                              <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">
                                ✓ Encontrada
                              </span>
                            ) : diagnosis === "sin-producto" ? (
                              <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
                                ✗ No existe
                              </span>
                            ) : diagnosis === "receta-desactivada" ? (
                              <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                                ✗ Desactivada — no se importa
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                                ✗ Sin receta — no se importa
                              </span>
                            )}
                            <select
                              value={row.recipeId ?? ""}
                              onChange={(e) => updateRowRecipe(i, e.target.value)}
                              className={`block w-full min-w-48 rounded border px-2 py-1 text-xs ${
                                row.recipeId
                                  ? "border-gray-300"
                                  : diagnosis === "sin-producto"
                                  ? "border-red-400 text-red-700"
                                  : "border-amber-400 text-amber-700"
                              }`}
                            >
                              <option value="">— Elegir receta a mano —</option>
                              {recipes.map((r) => (
                                <option key={r.id} value={r.id}>
                                  {recipeLabel(r.id)}
                                </option>
                              ))}
                            </select>
                          </div>
                        </td>
                        <td className="px-3 py-1">
                          <button onClick={() => removeRow(i)} className="text-red-600">
                            ✕
                          </button>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <button
                onClick={handleConfirmImport}
                disabled={importing || !shipmentCode.trim()}
                className="rounded-md bg-yellow-400 px-4 py-2 font-semibold text-neutral-900 disabled:opacity-50"
              >
                {importing ? "Importando..." : "Confirmar e importar"}
              </button>
            </div>
          )}

          {importResult && <p className="text-sm text-green-700">{importResult}</p>}
        </section>
      )}

      {/* Listado de envíos */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Envíos ({shipments.length})</h2>
        <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200">
          {shipments.map((s) => {
            const items = itemsByShipment[s.id] ?? [];
            const loadingThis = !!loadingItemsFor[s.id];
            return (
              <li key={s.id} className="px-4 py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium">{s.code}</span>
                    <span className="ml-2 text-sm text-neutral-500">
                      {s.type} · {s.status === "open" ? "abierto" : "cerrado"}
                    </span>
                  </div>
                  {isAdmin && (
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => toggleShipmentStatus(s)}
                        className={`text-sm ${s.status === "open" ? "text-red-600" : "text-green-600"}`}
                      >
                        {s.status === "open" ? "Cerrar envío" : "Reabrir envío"}
                      </button>
                      <button
                        onClick={() => handleDeleteShipment(s)}
                        className="text-sm text-neutral-400 hover:text-red-600"
                      >
                        Eliminar
                      </button>
                    </div>
                  )}
                </div>

                {/* Items del envío: siempre a la vista, no hace falta tocar nada. */}
                <div className="mt-3 border-t border-gray-100 pt-3">
                  {loadingThis ? (
                    <p className="text-sm text-neutral-500">Cargando items...</p>
                  ) : items.length === 0 ? (
                    <p className="text-sm text-neutral-500">Este envío no tiene items cargados.</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-neutral-500">
                          <th className="py-1 pr-3">Código a escanear</th>
                          <th className="py-1 pr-3">Receta / Producto</th>
                          <th className="py-1 pr-3">Pedido</th>
                          <th className="py-1 pr-3">Armado</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((it) => {
                          const done = it.quantity_completed >= it.quantity_required;
                          return (
                            <tr key={it.shipment_item_id} className="border-t border-gray-100">
                              <td className="py-1 pr-3 font-medium">{it.label_ean}</td>
                              <td className="py-1 pr-3">{it.recipe_name}</td>
                              <td className="py-1 pr-3">{it.quantity_required}</td>
                              <td className={`py-1 pr-3 ${done ? "text-green-600" : "text-neutral-700"}`}>
                                {it.quantity_completed}
                                {done ? " ✓" : ""}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </li>
            );
          })}
          {shipments.length === 0 && (
            <li className="px-4 py-3 text-sm text-neutral-500">Todavía no hay envíos cargados.</li>
          )}
        </ul>
      </section>
    </main>
  );
}
