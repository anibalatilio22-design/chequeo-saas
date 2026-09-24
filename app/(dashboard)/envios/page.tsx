"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Product, Recipe, Shipment, ShipmentProgress, ShipmentType } from "@/types/database.types";
import type { ParsedMlRow } from "@/lib/parse-ml-pdf";
import type { ParsedFlexPack, ParsedFlexProduct } from "@/lib/parse-ml-flex-pdf";

// Cada fila del PDF, más el resultado de compararla contra el catálogo de
// Productos/Recetas ya cargado: a qué receta corresponde (si se encontró),
// para que el admin la confirme o la corrija antes de importar.
type PreviewRow = ParsedMlRow & { recipeId: string | null };

// Marca interna (en recipes.label_ean) de las recetas que arma SOLO el
// import de Flex/Colecta, una por cada paquete — no son recetas de catálogo
// de verdad (no las carga ni las edita el admin a mano), así que se
// excluyen de todos lados donde se listan recetas "de verdad": el dropdown
// de Full de acá abajo y la pantalla de Recetas.
const FLEXPACK_LABEL_PREFIX = "FLEXPACK-";

// Cada producto de un paquete de Flex/Colecta, más el resultado de
// compararlo contra el catálogo — acá se compara solo por SKU (este
// documento no trae EAN en ningún lado). "matched" es true en cuanto el
// producto EXISTE en el catálogo, tenga o no tenga EAN cargado: si le
// falta el EAN, se usa su SKU como código a escanear en Armado (mismo
// criterio que ya usa el resto de la app — Recetas, carga por Excel,
// "Terminar de cargar" — y que Armado ya sabe reconocer: ahí se matchea
// contra EAN O contra SKU). Lo único que deja a un producto afuera es que
// ni siquiera esté cargado en el catálogo.
type PreviewFlexProduct = ParsedFlexProduct & {
  productId: string | null;
  productEan: string | null;
  matched: boolean;
};

type PreviewFlexPack = Omit<ParsedFlexPack, "products"> & {
  products: PreviewFlexProduct[];
  allMatched: boolean;
};

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

  // Importación de PDF de Flex/Colecta — estructura muy distinta a Full:
  // acá cada "venta" (Identificación) es un paquete independiente que puede
  // traer más de un producto, así que se maneja con su propio estado en vez
  // de reutilizar el de arriba.
  const [flexParsing, setFlexParsing] = useState(false);
  const [flexParseError, setFlexParseError] = useState<string | null>(null);
  const [flexWarnings, setFlexWarnings] = useState<string[]>([]);
  const [flexPacks, setFlexPacks] = useState<PreviewFlexPack[]>([]);
  // Diagnóstico técnico TEMPORAL: el texto crudo de cada columna tal cual lo
  // extrae el servidor real (no una simulación aparte), para investigar por
  // qué a veces el import empareja mal una venta con el producto de otra.
  // Se descarga como archivo de texto con el botón de abajo — no se usa para
  // nada del import en sí, es solo para mandarlo cuando algo no cierra.
  type FlexDebugLine = { text: string; order: number };
  const [flexDebugColumns, setFlexDebugColumns] = useState<{
    identificacion: FlexDebugLine[];
    productos: FlexDebugLine[];
  } | null>(null);
  const [flexShipmentCode, setFlexShipmentCode] = useState("");
  // Ya no se elige (Flex y Colecta se unificaron, ver más abajo) — queda
  // fijo en "flex" para toda importación de este tipo de documento.
  const [flexShipmentType] = useState<ShipmentType>("flex");
  const [flexImporting, setFlexImporting] = useState(false);
  const [flexImportResult, setFlexImportResult] = useState<string | null>(null);

  // Items de cada envío ya cargado: qué receta/producto tiene cada línea,
  // cuánto se pidió y cuánto se lleva armado. Se muestran siempre, sin
  // necesidad de tocar nada para verlos.
  const [itemsByShipment, setItemsByShipment] = useState<Record<string, ShipmentProgress[]>>({});
  const [loadingItemsFor, setLoadingItemsFor] = useState<Record<string, boolean>>({});

  // Listado de envíos de más abajo: separado por Full / Flex-Colecta (mismo
  // patrón que Progreso y Armado) con un buscador de pedidos puntuales.
  const [listShipmentType, setListShipmentType] = useState<ShipmentType>("full");
  const [listSearchQuery, setListSearchQuery] = useState("");

  // SKU de cada producto de cada receta, para poder buscar en Full por el
  // SKU real del producto (no solo por el "Código ML", que es un número
  // aparte que le pone Mercado Libre a la publicación). Se completa de a
  // poco a medida que van llegando items nuevos en itemsByShipment.
  const [skusByRecipe, setSkusByRecipe] = useState<Record<string, string[]>>({});
  const requestedSkuRecipeIds = useRef<Set<string>>(new Set());

  async function loadSkusForRecipes(recipeIds: string[]) {
    if (recipeIds.length === 0) return;
    const { data } = await supabase
      .from("recipe_components")
      .select("recipe_id, product_sku")
      .in("recipe_id", recipeIds);

    const grouped: Record<string, string[]> = {};
    ((data ?? []) as { recipe_id: string; product_sku: string | null }[]).forEach((row) => {
      if (!row.product_sku) return;
      (grouped[row.recipe_id] ??= []).push(row.product_sku);
    });
    setSkusByRecipe((prev) => ({ ...prev, ...grouped }));
  }

  useEffect(() => {
    const allRecipeIds = Object.values(itemsByShipment)
      .flat()
      .map((it) => it.recipe_id);
    const missing = Array.from(new Set(allRecipeIds)).filter(
      (id) => !requestedSkuRecipeIds.current.has(id)
    );
    if (missing.length === 0) return;
    missing.forEach((id) => requestedSkuRecipeIds.current.add(id));
    loadSkusForRecipes(missing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsByShipment]);

  // Un item matchea la búsqueda si no hay texto cargado (se ven todos), o si
  // el texto aparece en el "Código a escanear" (código ML / número de venta,
  // sirve para los dos tipos) — y además, según el tipo: en Full, en el SKU
  // real de algún producto de esa receta; en Flex/Colecta, en el nombre del
  // cliente (que ya forma parte del nombre de la receta armada, ver import).
  function itemMatchesSearch(it: ShipmentProgress): boolean {
    const q = listSearchQuery.trim().toLowerCase();
    if (!q) return true;
    if (it.label_ean?.toLowerCase().includes(q)) return true;
    if (listShipmentType === "full") {
      return (skusByRecipe[it.recipe_id] ?? []).some((sku) => sku.toLowerCase().includes(q));
    }
    return (it.recipe_name ?? "").toLowerCase().includes(q);
  }

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
    // Se excluyen las recetas automáticas de paquetes de Flex/Colecta (ver
    // FLEXPACK_LABEL_PREFIX más arriba) — acá abajo son ruido, no sirven
    // para comparar contra un PDF de Full.
    const { data: allRecipesData } = await supabase
      .from("recipes")
      .select("*")
      .or(`label_ean.is.null,label_ean.not.ilike.${FLEXPACK_LABEL_PREFIX}%`);
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

  // Refresco automático del resumen de pedidos (Pendientes/Armados/Total):
  // mientras alguien tiene esta pantalla abierta, otra persona puede estar
  // armando pedidos en Armado al mismo tiempo — sin esto, los números
  // quedarían congelados con los de cuando se entró a la página. Solo
  // vuelve a traer envíos e items, no toca nada de lo que se esté
  // completando en los formularios de import de acá abajo.
  useEffect(() => {
    const interval = setInterval(() => {
      loadShipments();
    }, 20000);
    return () => clearInterval(interval);
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

  // Igual que matchProduct, pero solo por SKU: el documento de Flex/Colecta
  // no trae EAN en ningún lado.
  function matchProductBySku(sku: string | null, catalogProducts: Product[] = products): Product | null {
    const normalized = normalizeCode(sku);
    if (!normalized) return null;
    return catalogProducts.find((p) => normalizeCode(p.sku) === normalized) ?? null;
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

  async function handleFlexPdfFile(e: React.ChangeEvent<HTMLInputElement>) {
    setFlexParseError(null);
    setFlexImportResult(null);
    setFlexWarnings([]);
    setFlexPacks([]);
    setFlexDebugColumns(null);

    const file = e.target.files?.[0];
    if (!file) return;

    setFlexParsing(true);

    // Mismo motivo que en el de Full: traer el catálogo más fresco posible
    // justo antes de comparar.
    const freshCatalog = await loadCatalog();

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/import/mercadolibre-flex-pdf", { method: "POST", body: formData });
      const data = await res.json();

      setFlexDebugColumns(data.debugColumns ?? null);

      if (!data.ok) {
        setFlexParseError(data.error ?? "No se pudo leer el PDF");
        setFlexParsing(false);
        return;
      }

      const parsedPacks: ParsedFlexPack[] = data.packs;
      setFlexPacks(
        parsedPacks.map((pack) => {
          const products: PreviewFlexProduct[] = pack.products.map((prod) => {
            const product = matchProductBySku(prod.sku, freshCatalog.products);
            // Si el producto no tiene EAN cargado, usamos su SKU como
            // código de todos modos (ver el comentario del tipo de arriba)
            // en vez de dejarlo sin código y bloquear el paquete entero.
            return {
              ...prod,
              productId: product?.id ?? null,
              productEan: product ? product.ean || product.sku || null : null,
              matched: !!product,
            };
          });
          return {
            ...pack,
            products,
            allMatched: products.length > 0 && products.every((p) => p.matched),
          };
        })
      );
      setFlexWarnings(data.warnings ?? []);
      const today = new Date().toISOString().slice(0, 10);
      setFlexShipmentCode(`${flexShipmentType.toUpperCase()}-${today}`);
    } catch {
      setFlexParseError("Error de conexión al leer el PDF");
    }

    setFlexParsing(false);
  }

  // Diagnóstico técnico TEMPORAL (ver comentario del estado más arriba):
  // arma un archivo de texto simple con las dos columnas tal cual las leyó
  // el servidor real, para poder mandarlo cuando algo no cierra en el
  // emparejamiento de una venta con su producto.
  function downloadFlexDebugColumns() {
    if (!flexDebugColumns) return;
    const lines: string[] = [];
    lines.push("=== Columna IDENTIFICACIÓN (tal cual la leyó el servidor) ===");
    flexDebugColumns.identificacion.forEach((l, i) => lines.push(`${i} [order=${l.order}]: ${l.text}`));
    lines.push("");
    lines.push("=== Columna PRODUCTOS (tal cual la leyó el servidor) ===");
    flexDebugColumns.productos.forEach((l, i) => lines.push(`${i} [order=${l.order}]: ${l.text}`));

    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `diagnostico-flex-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function handleConfirmFlexImport() {
    if (!companyId || flexPacks.length === 0 || !flexShipmentCode.trim()) return;

    setFlexImporting(true);
    setFlexImportResult(null);

    const { data: shipmentDataRaw, error: shipmentError } = await supabase
      .from("shipments")
      .insert({ company_id: companyId, code: flexShipmentCode.trim(), type: flexShipmentType, status: "open" } as any)
      .select()
      .single();

    const shipmentData = shipmentDataRaw as { id: string; code: string } | null;

    if (shipmentError || !shipmentData) {
      setFlexImporting(false);
      setFlexImportResult(`Error al crear el envío: ${shipmentError?.message}`);
      return;
    }

    // Cada paquete (cada "Identificación" del PDF) se importa como un ítem
    // propio del envío, con su propia receta armada sola con los productos
    // de ESE paquete puntual — así se arma y se verifica cada paquete por
    // separado, no como una bolsa común de unidades sueltas: a diferencia
    // de Full, acá cada paquete termina siendo una caja distinta para un
    // comprador distinto. "quantity_required" queda en 1 siempre (el
    // paquete se arma una sola vez); lo que puede pedir más de una unidad
    // es cada PRODUCTO adentro del paquete, y eso vive en su receta
    // (recipe_components.quantity), igual que un combo de Full.
    //
    // Si a un paquete le falta algún producto en el catálogo (ni EAN ni
    // SKU cargado), ese paquete entero queda afuera — el resto se importa
    // igual. Si el producto está pero le falta el EAN, se usa el SKU como
    // código a escanear en Armado, así que eso ya no bloquea nada.
    let ok = 0;
    const sinProducto: string[] = [];
    const errors: string[] = [];

    for (const pack of flexPacks) {
      if (!pack.allMatched) {
        const faltantes = pack.products
          .filter((p) => !p.matched)
          .map((p) => p.sku ?? p.name)
          .join(", ");
        sinProducto.push(`${pack.itemId} (${pack.buyerName || "sin nombre"}) — falta: ${faltantes}`);
        continue;
      }

      const { data: recipeDataRaw, error: recipeError } = await supabase
        .from("recipes")
        .insert({
          company_id: companyId,
          label_ean: `${FLEXPACK_LABEL_PREFIX}${pack.itemId}`,
          name: `Flex/Colecta — ${pack.buyerName || pack.itemId}`,
          active: true,
          output_product_id: null,
        } as any)
        .select()
        .single();

      const recipeData = recipeDataRaw as { id: string } | null;

      if (recipeError || !recipeData) {
        errors.push(`${pack.itemId}: no se pudo crear la receta automática (${recipeError?.message})`);
        continue;
      }

      const { error: componentsError } = await supabase.from("recipe_components").insert(
        pack.products.map((p) => ({
          company_id: companyId,
          recipe_id: recipeData.id,
          product_ean: p.productEan!,
          product_sku: p.sku,
          product_name: p.name,
          quantity: p.quantity,
        })) as any
      );

      if (componentsError) {
        errors.push(`${pack.itemId}: no se pudieron cargar sus productos (${componentsError.message})`);
        continue;
      }

      // El "código a escanear" de este ítem es el número de la venta/envío
      // individual (el mismo que se ve impreso en la etiqueta de envío con
      // su código QR) — no un EAN de producto.
      const { error: itemError } = await supabase.from("shipment_items").insert({
        company_id: companyId,
        shipment_id: shipmentData.id,
        recipe_id: recipeData.id,
        quantity_required: 1,
        label_ean: pack.itemId,
      } as any);

      if (itemError) {
        errors.push(`${pack.itemId}: ${itemError.message}`);
        continue;
      }

      ok += 1;
    }

    setFlexImporting(false);
    setFlexImportResult(
      `Envío "${shipmentData.code}" creado con ${ok} de ${flexPacks.length} paquetes.` +
        (sinProducto.length > 0
          ? ` Estos paquetes quedaron afuera porque les falta algún producto en el catálogo (cargalos en Productos antes de reintentar): ${sinProducto.join(
              " | "
            )}.`
          : "") +
        (errors.length > 0 ? ` Errores: ${errors.join(" | ")}` : "")
    );
    setFlexPacks([]);
    setFlexShipmentCode("");
    loadShipments();
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
                    <option value="flex">Flex / Colecta</option>
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

      {isAdmin && (
        <section className="space-y-4 rounded-lg border border-gray-200 p-4">
          <h2 className="text-lg font-medium">Importar desde PDF de Mercado Libre (Flex / Colecta)</h2>
          <p className="text-sm text-neutral-500">
            Subí el PDF de &quot;Identificación / Productos&quot; que arma Mercado Libre para un lote de
            envíos Flex o Colecta. Acá cada venta (cada &quot;Identificación&quot;) se importa como un
            paquete propio, con su propia receta armada sola con los productos de esa venta puntual —
            las unidades no se mezclan entre paquetes distintos, porque cada uno termina siendo una
            caja separada para un comprador distinto. El emparejamiento es por SKU (este documento no
            trae EAN). Si a un paquete le falta algún producto en el catálogo (ni EAN ni SKU cargado),
            ese paquete entero queda afuera — el resto del lote se importa igual.
          </p>

          {/* Flex y Colecta se unificaron en un solo tipo ("flex") — el
              remito y la etiqueta son prácticamente iguales (la única
              diferencia es QR vs. código de barras, y el mismo lector lee
              los dos), así que no hace falta que el admin elija entre las
              dos cada vez que importa un lote. */}
          <input type="file" accept=".pdf" onChange={handleFlexPdfFile} className="text-sm" />

          {flexParsing && <p className="text-sm text-neutral-500">Leyendo el PDF...</p>}
          {flexParseError && <p className="text-sm text-red-600">{flexParseError}</p>}

          {/* Botón temporal de diagnóstico técnico — ver comentario en el
              estado flexDebugColumns más arriba en el archivo. Sacar cuando
              se termine de investigar el emparejamiento venta/producto. */}
          {flexDebugColumns && (
            <button
              type="button"
              onClick={downloadFlexDebugColumns}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-neutral-600 hover:bg-gray-50"
            >
              Descargar diagnóstico técnico (para soporte)
            </button>
          )}

          {flexWarnings.length > 0 && (
            <div className="rounded-md bg-yellow-50 p-3 text-sm text-yellow-800">
              {flexWarnings.map((w, i) => (
                <p key={i}>⚠ {w}</p>
              ))}
            </div>
          )}

          {flexPacks.length > 0 && (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-sm text-neutral-500">Código del envío (del lote completo)</label>
                <input
                  value={flexShipmentCode}
                  onChange={(e) => setFlexShipmentCode(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2"
                />
              </div>

              <p className="text-sm text-neutral-700">
                {flexPacks.length} paquetes detectados.
                {flexPacks.some((p) => !p.allMatched) && (
                  <span className="ml-1 font-semibold text-red-600">
                    {flexPacks.filter((p) => !p.allMatched).length} van a quedar afuera por productos
                    que no están en el catálogo.
                  </span>
                )}
              </p>

              <div className="max-h-96 space-y-2 overflow-y-auto rounded-lg border border-gray-200 p-2">
                {flexPacks.map((pack, i) => (
                  <div
                    key={i}
                    className={`rounded-md border p-3 ${
                      pack.allMatched ? "border-gray-200" : "border-red-300 bg-red-50"
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-sm">
                        <span className="font-semibold">{pack.itemId}</span>
                        {pack.packId && <span className="ml-2 text-neutral-500">Pack: {pack.packId}</span>}
                        <span className="ml-2 text-neutral-500">{pack.buyerName || "(sin nombre)"}</span>
                      </div>
                      {pack.allMatched ? (
                        <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">
                          ✓ Listo para importar
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
                          ✗ No se va a importar
                        </span>
                      )}
                    </div>
                    <ul className="mt-2 space-y-1">
                      {pack.products.map((p, j) => (
                        <li key={j} className="flex flex-wrap items-center gap-2 text-xs text-neutral-600">
                          <span className={p.matched ? "text-neutral-700" : "font-semibold text-red-600"}>
                            {p.matched ? "✓" : "✗"} {p.name}
                          </span>
                          <span className="text-neutral-400">SKU: {p.sku ?? "—"}</span>
                          <span className="text-neutral-400">Cant: {p.quantity}</span>
                          {!p.matched && <span className="text-red-600">no está en el catálogo</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>

              <button
                onClick={handleConfirmFlexImport}
                disabled={flexImporting || !flexShipmentCode.trim()}
                className="rounded-md bg-yellow-400 px-4 py-2 font-semibold text-neutral-900 disabled:opacity-50"
              >
                {flexImporting ? "Importando..." : "Confirmar e importar"}
              </button>
            </div>
          )}

          {flexImportResult && <p className="text-sm text-green-700">{flexImportResult}</p>}
        </section>
      )}

      {/* Listado de envíos, separado por tipo con buscador de pedidos */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Envíos</h2>

        <div className="flex gap-2">
          {(["full", "flex"] as ShipmentType[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setListShipmentType(t);
                setListSearchQuery("");
              }}
              className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium ${
                listShipmentType === t
                  ? "border-yellow-500 bg-yellow-100 text-neutral-900"
                  : "border-gray-300 bg-white text-neutral-600"
              }`}
            >
              {t === "flex" ? "Flex / Colecta" : "Full"}
            </button>
          ))}
        </div>

        <input
          value={listSearchQuery}
          onChange={(e) => setListSearchQuery(e.target.value)}
          placeholder={
            listShipmentType === "full"
              ? "Buscar pedido por Código ML o SKU del producto..."
              : "Buscar pedido por número de envío o nombre del cliente..."
          }
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />

        {(() => {
          const visibleShipments = shipments.filter((s) =>
            listShipmentType === "full" ? s.type === "full" : s.type !== "full"
          );
          const searching = listSearchQuery.trim().length > 0;
          return (
            <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200">
              {visibleShipments.map((s) => {
                const items = (itemsByShipment[s.id] ?? []).filter(itemMatchesSearch);
                const loadingThis = !!loadingItemsFor[s.id];
                return (
                  <li key={s.id} className="px-4 py-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-medium">{s.code}</span>
                        <span className="ml-2 text-sm text-neutral-500">
                          {s.status === "open" ? "abierto" : "cerrado"}
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
                        <p className="text-sm text-neutral-500">
                          {searching
                            ? "Sin resultados para esa búsqueda en este envío."
                            : "Este envío no tiene items cargados."}
                        </p>
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
              {visibleShipments.length === 0 && (
                <li className="px-4 py-3 text-sm text-neutral-500">
                  Todavía no hay envíos de tipo {listShipmentType === "full" ? "Full" : "Flex / Colecta"}.
                </li>
              )}
            </ul>
          );
        })()}
      </section>
    </main>
  );
}
