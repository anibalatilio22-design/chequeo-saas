"use client";

import { useEffect, useState } from "react";
import * as XLSX from "xlsx";
import { createClient } from "@/lib/supabase/client";
import type { Product, Recipe, RecipeComponent } from "@/types/database.types";

type ComponentDraft = { ean: string; sku: string; name: string; quantity: string };

// Ya no hay dos listas separadas (Productos / Recetas). Todo lo que se carga
// acá es, por dentro, una "receta": si tiene un solo componente (él mismo)
// es un producto suelto y no hace falta pedirle nada más aparte; si tiene
// dos o más, es un combo, y ahí sí hace falta un SKU y un nombre propios
// para el combo — el identificador que Mercado Libre le da A ESE combo,
// distinto del SKU de cada producto que lo compone. El sistema siempre
// busca primero por SKU (es el dato fijo, único e intransferible, que nunca
// cambia de envío en envío) y recién si no hay SKU prueba por EAN.
type ItemDraft = {
  comboSku: string;
  comboName: string;
  components: ComponentDraft[];
};

type CatalogImportComponentRow = {
  ean: string;
  sku: string;
  name: string;
  quantity: number;
  productStatus: "existe" | "se creará" | "error";
};

type CatalogImportGroup = {
  key: string;
  outputEan: string;
  outputSku: string;
  outputName: string;
  outputStatus: "existe" | "se creará" | "error";
  recipeStatus: "nuevo" | "ya existe";
  components: CatalogImportComponentRow[];
  error?: string;
};

export default function RecetasPage() {
  const [supabase] = useState(() => createClient());
  const [isAdmin, setIsAdmin] = useState(false);
  const [companyId, setCompanyId] = useState<string | null>(null);

  const [products, setProducts] = useState<Product[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [componentsByRecipe, setComponentsByRecipe] = useState<Record<string, RecipeComponent[]>>({});

  async function loadData() {
    const { data: productsData } = await supabase
      .from("products")
      .select("*")
      .order("name", { ascending: true });
    setProducts(productsData ?? []);

    const { data: recipesData } = await supabase
      .from("recipes")
      .select("*")
      .order("created_at", { ascending: false });
    setRecipes(recipesData ?? []);

    const { data: componentsData } = await supabase.from("recipe_components").select("*");
    const grouped: Record<string, RecipeComponent[]> = {};
    (componentsData ?? []).forEach((c) => {
      if (!grouped[c.recipe_id]) grouped[c.recipe_id] = [];
      grouped[c.recipe_id].push(c);
    });
    setComponentsByRecipe(grouped);
  }

  useEffect(() => {
    async function init() {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      const { data: profile } = await supabase
        .from("users")
        .select("company_id, role")
        .eq("id", user.id)
        .single();

      setIsAdmin(profile?.role === "admin");
      setCompanyId(profile?.company_id ?? null);
      await loadData();
    }
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function productById(id: string | null) {
    return products.find((p) => p.id === id) ?? null;
  }

  // Productos que quedaron cargados de cuando Productos y Recetas todavía
  // eran dos listas separadas, y a los que nunca se les terminó de armar su
  // ficha de catálogo (ninguna receta los tiene como producto final). No se
  // muestran como una lista aparte — son un aviso de "esto quedó a mitad de
  // camino", con un botón para terminarlos de cargar de una sola vez.
  const orphanProducts = products.filter((p) => !recipes.some((r) => r.output_product_id === p.id));

  const [migratingOrphans, setMigratingOrphans] = useState(false);
  const [migrateOrphansResult, setMigrateOrphansResult] = useState<string | null>(null);

  async function migrateOrphans() {
    if (orphanProducts.length === 0 || !companyId) return;
    const confirmed = window.confirm(
      `¿Terminar de cargar ${orphanProducts.length} producto(s) al catálogo? Cada uno queda listo para escanear, usándose a sí mismo como único componente. Si alguno en realidad es un combo, después lo editás y le agregás los demás componentes.`
    );
    if (!confirmed) return;

    setMigratingOrphans(true);
    setMigrateOrphansResult(null);
    let ok = 0;
    const failed: string[] = [];

    for (const product of orphanProducts) {
      const { data: recipeDataRaw, error } = await supabase
        .from("recipes")
        .insert({
          company_id: companyId,
          output_product_id: product.id,
          name: product.name,
          label_ean: null,
        } as any)
        .select()
        .single();

      // El cliente tipado no siempre resuelve bien el tipo de este resultado
      // (mismo motivo de fondo que otros casteos de la app), así que lo
      // casteamos a mano para poder acceder a sus propiedades sin error.
      const recipeData = recipeDataRaw as { id: string } | null;

      if (error || !recipeData) {
        failed.push(`${product.name} (${error?.message ?? "error"})`);
        continue;
      }

      const { error: compError } = await supabase.from("recipe_components").insert({
        company_id: companyId,
        recipe_id: recipeData.id,
        product_id: product.id,
        product_ean: product.ean || product.sku || "",
        product_sku: product.sku,
        product_name: product.name,
        quantity: 1,
      } as any);

      if (compError) {
        failed.push(`${product.name} (creado, pero sin componente: ${compError.message})`);
        continue;
      }

      ok += 1;
    }

    setMigratingOrphans(false);
    setMigrateOrphansResult(
      `Se terminaron de cargar ${ok} de ${orphanProducts.length}.` +
        (failed.length > 0 ? ` No se pudieron: ${failed.join(", ")}.` : "")
    );
    await loadData();
  }

  // ---------------------------------------------------------------------
  // CATÁLOGO — una sola lista (antes "Recetas" y "Productos" por separado)
  // ---------------------------------------------------------------------
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const emptyItemDraft: ItemDraft = {
    comboSku: "",
    comboName: "",
    components: [{ ean: "", sku: "", name: "", quantity: "1" }],
  };
  const [newItem, setNewItem] = useState<ItemDraft>(emptyItemDraft);
  const [createError, setCreateError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ItemDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const query = search.trim().toLowerCase();
  const filteredRecipes = query
    ? recipes.filter((r) => {
        const output = productById(r.output_product_id);
        if (output && (output.ean ?? "").toLowerCase().includes(query)) return true;
        if (output && (output.sku ?? "").toLowerCase().includes(query)) return true;
        if (r.name.toLowerCase().includes(query)) return true;
        const comps = componentsByRecipe[r.id] ?? [];
        return comps.some(
          (c) => c.product_ean.toLowerCase().includes(query) || (c.product_sku ?? "").toLowerCase().includes(query)
        );
      })
    : recipes;

  function toggleExpanded(recipeId: string) {
    setExpanded((prev) => ({ ...prev, [recipeId]: !prev[recipeId] }));
  }

  async function toggleActive(recipe: Recipe) {
    await supabase.from("recipes").update({ active: !recipe.active } as any).eq("id", recipe.id);
    loadData();
  }

  function updateDraftComponent(
    draft: ItemDraft,
    setDraft: (d: ItemDraft) => void,
    index: number,
    field: keyof ComponentDraft,
    value: string
  ) {
    setDraft({
      ...draft,
      components: draft.components.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    });
  }

  function addDraftRow(draft: ItemDraft, setDraft: (d: ItemDraft) => void) {
    setDraft({ ...draft, components: [...draft.components, { ean: "", sku: "", name: "", quantity: "1" }] });
  }

  function removeDraftRow(draft: ItemDraft, setDraft: (d: ItemDraft) => void, index: number) {
    setDraft({ ...draft, components: draft.components.filter((_, i) => i !== index) });
  }

  // Busca un producto por SKU (primero) o EAN en el catálogo; si no existe y
  // se dio un nombre, lo crea al vuelo. Así se puede escanear/tipear
  // EAN/SKU/Nombre directo en el formulario sin tener que cargar el
  // producto aparte antes. El SKU se prioriza porque es el dato fijo, único
  // e intransferible que no cambia de envío en envío — el EAN muchas veces
  // ni siquiera lo trae la etiqueta real de Mercado Libre.
  async function resolveOrCreateProduct(
    ean: string,
    sku: string,
    name: string
  ): Promise<{ product: Product | null; error?: string }> {
    const eanTrim = ean.trim();
    const skuTrim = sku.trim();
    const nameTrim = name.trim();

    if (!eanTrim && !skuTrim && !nameTrim) {
      return { product: null, error: "Completá al menos el EAN, el SKU o el nombre" };
    }

    const existing = products.find((p) => (skuTrim && p.sku === skuTrim) || (eanTrim && p.ean === eanTrim));
    if (existing) return { product: existing };

    if (!nameTrim) {
      return { product: null, error: "Ese EAN/SKU no está en el catálogo — completá el nombre para crearlo" };
    }
    if (!companyId) return { product: null, error: "No se encontró la empresa" };

    const { data: createdRaw, error } = await supabase
      .from("products")
      .insert({ company_id: companyId, ean: eanTrim || null, sku: skuTrim || null, name: nameTrim } as any)
      .select()
      .single();

    // El cliente tipado no siempre resuelve bien el tipo de este resultado
    // (mismo motivo de fondo que otros casteos de la app), así que lo
    // casteamos a mano para poder acceder a sus propiedades sin error.
    const created = createdRaw as Product | null;

    if (error || !created) {
      return { product: null, error: error?.message ?? "Error al crear el producto" };
    }

    products.push(created);
    return { product: created };
  }

  function validateDraft(draft: ItemDraft): { validRows: ComponentDraft[]; error: string | null; isCombo: boolean } {
    const validRows = draft.components.filter((c) => c.ean.trim() || c.sku.trim() || c.name.trim());
    if (validRows.length === 0) {
      return { validRows, error: "Agregá al menos un producto", isCombo: false };
    }
    const incompleteRow = validRows.find((c) => !c.ean.trim() && !c.sku.trim());
    if (incompleteRow) {
      return {
        validRows,
        error: `Falta el EAN o el SKU de "${
          incompleteRow.name.trim() || "uno de los productos"
        }" — sin uno de los dos no se va a poder validar ese producto por escaneo. Completalo o quitá la fila.`,
        isCombo: false,
      };
    }
    const isCombo = validRows.length > 1;
    if (isCombo && !draft.comboName.trim()) {
      return { validRows, error: "Completá el nombre del combo", isCombo };
    }
    if (isCombo && !draft.comboSku.trim()) {
      return {
        validRows,
        error:
          "Completá el SKU real del combo — es lo único que le permite al sistema reconocerlo solo cuando importás un envío Full.",
        isCombo,
      };
    }
    return { validRows, error: null, isCombo };
  }

  async function handleCreateItem(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);

    const { validRows, error, isCombo } = validateDraft(newItem);
    if (error) {
      setCreateError(error);
      return;
    }
    if (!companyId) return;

    setSaving(true);

    const resolvedComponents: { product: Product; quantity: number }[] = [];
    for (const row of validRows) {
      const { product, error: rowError } = await resolveOrCreateProduct(row.ean, row.sku, row.name);
      if (!product) {
        setSaving(false);
        setCreateError(rowError ?? "No se pudo identificar un producto");
        return;
      }
      resolvedComponents.push({ product, quantity: parseInt(row.quantity) || 1 });
    }

    let outputProduct: Product;
    let recipeName: string;
    if (isCombo) {
      const { product, error: outputError } = await resolveOrCreateProduct("", newItem.comboSku, newItem.comboName);
      if (!product) {
        setSaving(false);
        setCreateError(outputError ?? "No se pudo identificar el producto del combo");
        return;
      }
      outputProduct = product;
      recipeName = newItem.comboName.trim();
    } else {
      outputProduct = resolvedComponents[0].product;
      recipeName = outputProduct.name;
    }

    const { data: recipeDataRaw, error: recipeError } = await supabase
      .from("recipes")
      .insert({ company_id: companyId, output_product_id: outputProduct.id, name: recipeName, label_ean: null } as any)
      .select()
      .single();

    // El cliente tipado no siempre resuelve bien el tipo de este resultado
    // (mismo motivo de fondo que otros casteos de la app), así que lo
    // casteamos a mano para poder acceder a sus propiedades sin error.
    const recipeData = recipeDataRaw as { id: string } | null;

    if (recipeError || !recipeData) {
      setSaving(false);
      setCreateError(
        recipeError?.message.includes("duplicate")
          ? "Ese producto ya está cargado en el catálogo — editalo en vez de crear otro."
          : recipeError?.message ?? "Error al crear el ítem"
      );
      return;
    }

    const { error: componentsError } = await supabase.from("recipe_components").insert(
      resolvedComponents.map((c) => ({
        company_id: companyId,
        recipe_id: recipeData.id,
        product_id: c.product.id,
        product_ean: c.product.ean || c.product.sku || "",
        product_sku: c.product.sku,
        product_name: c.product.name,
        quantity: c.quantity,
      })) as any
    );

    setSaving(false);

    if (componentsError) {
      setCreateError("Se creó el ítem pero hubo un error con los componentes: " + componentsError.message);
      return;
    }

    setNewItem(emptyItemDraft);
    loadData();
  }

  function startEdit(recipe: Recipe) {
    const comps = componentsByRecipe[recipe.id] ?? [];
    const outputProduct = productById(recipe.output_product_id);
    const isCombo = comps.length > 1;
    setEditingId(recipe.id);
    setEditError(null);
    setEditDraft({
      comboSku: isCombo ? outputProduct?.sku ?? "" : "",
      comboName: isCombo ? outputProduct?.name ?? recipe.name : "",
      components:
        comps.length > 0
          ? comps.map((c) => ({
              ean: c.product_ean ?? "",
              sku: c.product_sku ?? "",
              name: c.product_name ?? "",
              quantity: String(c.quantity),
            }))
          : [{ ean: "", sku: "", name: "", quantity: "1" }],
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft(null);
    setEditError(null);
  }

  async function saveEdit(recipeId: string) {
    if (!editDraft || !companyId) return;
    setEditError(null);

    const { validRows, error, isCombo } = validateDraft(editDraft);
    if (error) {
      setEditError(error);
      return;
    }

    setSavingEdit(true);

    const resolvedComponents: { product: Product; quantity: number }[] = [];
    for (const row of validRows) {
      const { product, error: rowError } = await resolveOrCreateProduct(row.ean, row.sku, row.name);
      if (!product) {
        setSavingEdit(false);
        setEditError(rowError ?? "No se pudo identificar un producto");
        return;
      }
      resolvedComponents.push({ product, quantity: parseInt(row.quantity) || 1 });
    }

    let outputProduct: Product;
    let recipeName: string;
    if (isCombo) {
      const { product, error: outputError } = await resolveOrCreateProduct("", editDraft.comboSku, editDraft.comboName);
      if (!product) {
        setSavingEdit(false);
        setEditError(outputError ?? "No se pudo identificar el producto del combo");
        return;
      }
      outputProduct = product;
      recipeName = editDraft.comboName.trim();
    } else {
      outputProduct = resolvedComponents[0].product;
      recipeName = outputProduct.name;
    }

    const { error: updateError } = await supabase
      .from("recipes")
      .update({ name: recipeName, output_product_id: outputProduct.id } as any)
      .eq("id", recipeId);

    if (updateError) {
      setSavingEdit(false);
      setEditError(
        updateError.message.includes("duplicate") ? "Ya existe otro ítem con ese producto/SKU." : updateError.message
      );
      return;
    }

    await supabase.from("recipe_components").delete().eq("recipe_id", recipeId);

    const { error: componentsError } = await supabase.from("recipe_components").insert(
      resolvedComponents.map((c) => ({
        company_id: companyId,
        recipe_id: recipeId,
        product_id: c.product.id,
        product_ean: c.product.ean || c.product.sku || "",
        product_sku: c.product.sku,
        product_name: c.product.name,
        quantity: c.quantity,
      })) as any
    );

    setSavingEdit(false);

    if (componentsError) {
      setEditError("Se guardó pero hubo un error con los componentes: " + componentsError.message);
      return;
    }

    setEditingId(null);
    setEditDraft(null);
    loadData();
  }

  async function deleteRecipe(recipe: Recipe) {
    const confirmed = window.confirm(`¿Eliminar "${recipe.name}" del catálogo? Esta acción no se puede deshacer.`);
    if (!confirmed) return;

    setDeleteError(null);
    const { error } = await supabase.from("recipes").delete().eq("id", recipe.id);

    if (error) {
      setDeleteError(
        error.message.includes("foreign key")
          ? `No se puede eliminar "${recipe.name}": está siendo usado en un envío. Eliminá o cerrá ese envío primero.`
          : error.message
      );
      return;
    }

    loadData();
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds((prev) =>
      prev.size === filteredRecipes.length ? new Set() : new Set(filteredRecipes.map((r) => r.id))
    );
  }

  async function handleBulkDelete() {
    if (selectedIds.size === 0) return;
    const confirmed = window.confirm(
      `¿Eliminar ${selectedIds.size} ítem(s) seleccionado(s) del catálogo? Esta acción no se puede deshacer.`
    );
    if (!confirmed) return;

    setBulkDeleting(true);
    setBulkResult(null);
    let ok = 0;
    const blocked: string[] = [];
    const ids = Array.from(selectedIds);

    for (const id of ids) {
      const r = recipes.find((x) => x.id === id);
      const { error } = await supabase.from("recipes").delete().eq("id", id);
      if (error) blocked.push(r?.name ?? id);
      else ok += 1;
    }

    setBulkDeleting(false);
    setSelectedIds(new Set());
    setBulkResult(
      `Se eliminaron ${ok} de ${ids.length}.` +
        (blocked.length > 0 ? ` No se pudieron eliminar (están en uso en algún envío): ${blocked.join(", ")}.` : "")
    );
    loadData();
  }

  // -- Carga masiva por Excel ----------------------------------------------
  const [importGroups, setImportGroups] = useState<CatalogImportGroup[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [importFileError, setImportFileError] = useState<string | null>(null);

  function downloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([
      ["SKU Final", "EAN Final", "Nombre Final", "SKU Componente", "EAN Componente", "Nombre Componente", "Cantidad"],
      ["ABC-123", "7791234567890", "Remera Azul Talle M", "ABC-123", "7791234567890", "Remera Azul Talle M", "1"],
      ["COMBO-1", "7790000000001", "Combo Ejemplo x2", "DEF-456", "7791234567891", "Remera Azul Talle L", "1"],
      ["COMBO-1", "7790000000001", "Combo Ejemplo x2", "GHI-789", "7791234567892", "Gorra Negra", "1"],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Catalogo");
    XLSX.writeFile(wb, "plantilla_catalogo.xlsx");
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImportFileError(null);
    setImportResult(null);

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = new Uint8Array(evt.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });

        const groupsMap = new Map<string, CatalogImportGroup>();

        rows.forEach((row) => {
          const outputSku = String(row["SKU Final"] ?? row["sku final"] ?? "").trim();
          const outputEan = String(row["EAN Final"] ?? row["ean final"] ?? "").trim();
          const outputName = String(row["Nombre Final"] ?? row["nombre final"] ?? "").trim();
          const compSku = String(row["SKU Componente"] ?? row["sku componente"] ?? "").trim();
          const compEan = String(row["EAN Componente"] ?? row["ean componente"] ?? "").trim();
          const compName = String(row["Nombre Componente"] ?? row["nombre componente"] ?? "").trim();
          const quantity = parseInt(String(row["Cantidad"] ?? row["cantidad"] ?? "1")) || 1;

          const key = outputSku || outputEan;
          if (!key) return;

          if (!groupsMap.has(key)) {
            const existingOutput = products.find(
              (p) => (outputSku && p.sku === outputSku) || (outputEan && p.ean === outputEan)
            );
            const existingRecipe = existingOutput
              ? recipes.find((r) => r.output_product_id === existingOutput.id)
              : undefined;

            groupsMap.set(key, {
              key,
              outputEan,
              outputSku,
              outputName,
              outputStatus: existingOutput ? "existe" : outputName ? "se creará" : "error",
              recipeStatus: existingRecipe ? "ya existe" : "nuevo",
              components: [],
              error: !existingOutput && !outputName ? "Falta el nombre del producto final" : undefined,
            });
          }

          if (!compSku && !compEan) return;
          const existingComp = products.find((p) => (compSku && p.sku === compSku) || (compEan && p.ean === compEan));
          groupsMap.get(key)!.components.push({
            ean: compEan,
            sku: compSku,
            name: compName,
            quantity,
            productStatus: existingComp ? "existe" : compName ? "se creará" : "error",
          });
        });

        setImportGroups(Array.from(groupsMap.values()));
      } catch (err: any) {
        setImportFileError("No se pudo leer el archivo: " + (err?.message ?? "error desconocido"));
      }
    };
    reader.readAsArrayBuffer(file);
  }

  async function handleConfirmImport() {
    if (!importGroups || !companyId) return;
    setImporting(true);
    let ok = 0;
    const skipped: string[] = [];
    const errors: string[] = [];

    for (const group of importGroups) {
      const label = group.outputName || group.outputSku || group.outputEan;

      if (group.error || group.components.some((c) => c.productStatus === "error")) {
        skipped.push(`${label} (faltan datos)`);
        continue;
      }
      if (group.recipeStatus === "ya existe") {
        skipped.push(`${label} (ya está cargado en el catálogo)`);
        continue;
      }
      if (group.components.length === 0) {
        skipped.push(`${label} (sin componentes)`);
        continue;
      }

      let outputProduct = products.find(
        (p) => (group.outputSku && p.sku === group.outputSku) || (group.outputEan && p.ean === group.outputEan)
      );
      if (!outputProduct) {
        const { data: createdProductRaw, error: createProductError } = await supabase
          .from("products")
          .insert({
            company_id: companyId,
            ean: group.outputEan || null,
            sku: group.outputSku || null,
            name: group.outputName,
          } as any)
          .select()
          .single();
        // El cliente tipado no siempre resuelve bien el tipo de este resultado
        // (mismo motivo de fondo que otros casteos de la app), así que lo
        // casteamos a mano para poder acceder a sus propiedades sin error.
        const createdProduct = createdProductRaw as Product | null;
        if (createProductError || !createdProduct) {
          errors.push(`${label}: no se pudo crear el producto final (${createProductError?.message ?? "error"})`);
          continue;
        }
        outputProduct = createdProduct;
        products.push(createdProduct);
      }

      const resolvedComponents: { product: Product; quantity: number }[] = [];
      let componentError = "";
      for (const comp of group.components) {
        let compProduct = products.find((p) => (comp.sku && p.sku === comp.sku) || (comp.ean && p.ean === comp.ean));
        if (!compProduct) {
          const { data: createdCompRaw, error: createCompError } = await supabase
            .from("products")
            .insert({ company_id: companyId, ean: comp.ean || null, sku: comp.sku || null, name: comp.name } as any)
            .select()
            .single();
          // El cliente tipado no siempre resuelve bien el tipo de este resultado
          // (mismo motivo de fondo que otros casteos de la app), así que lo
          // casteamos a mano para poder acceder a sus propiedades sin error.
          const createdComp = createdCompRaw as Product | null;
          if (createCompError || !createdComp) {
            componentError = `no se pudo crear "${comp.name}" (${createCompError?.message ?? "error"})`;
            break;
          }
          compProduct = createdComp;
          products.push(createdComp);
        }
        resolvedComponents.push({ product: compProduct, quantity: comp.quantity });
      }

      if (componentError) {
        errors.push(`${label}: ${componentError}`);
        continue;
      }

      const { data: recipeDataRaw, error: recipeError } = await supabase
        .from("recipes")
        .insert({
          company_id: companyId,
          output_product_id: outputProduct.id,
          name: group.outputName || outputProduct.name,
          label_ean: null,
        } as any)
        .select()
        .single();

      // El cliente tipado no siempre resuelve bien el tipo de este resultado
      // (mismo motivo de fondo que otros casteos de la app), así que lo
      // casteamos a mano para poder acceder a sus propiedades sin error.
      const recipeData = recipeDataRaw as { id: string } | null;

      if (recipeError || !recipeData) {
        errors.push(`${label}: no se pudo cargar (${recipeError?.message ?? "error"})`);
        continue;
      }

      const { error: componentsError } = await supabase.from("recipe_components").insert(
        resolvedComponents.map((c) => ({
          company_id: companyId,
          recipe_id: recipeData.id,
          product_id: c.product.id,
          product_ean: c.product.ean || c.product.sku || "",
          product_sku: c.product.sku,
          product_name: c.product.name,
          quantity: c.quantity,
        })) as any
      );

      if (componentsError) {
        errors.push(`${label}: cargado pero con error en componentes (${componentsError.message})`);
        continue;
      }

      ok += 1;
    }

    setImporting(false);
    setImportGroups(null);
    setImportResult(
      `Se cargaron ${ok} de ${importGroups.length} ítems al catálogo.` +
        (skipped.length > 0 ? ` Omitidos: ${skipped.join(" | ")}.` : "") +
        (errors.length > 0 ? ` Errores: ${errors.join(" | ")}` : "")
    );
    loadData();
  }

  const draftIsCombo = newItem.components.filter((c) => c.ean.trim() || c.sku.trim() || c.name.trim()).length > 1;

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <h1 className="text-xl font-semibold">Catálogo</h1>

      {isAdmin && orphanProducts.length > 0 && (
        <section className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm text-amber-800">
            Tenés {orphanProducts.length} producto(s) cargado(s) que todavía no tienen su ficha completa en el
            catálogo (quedaron de antes de unificar las listas). Tocá para terminar de cargarlos — cada uno queda
            listo para escanear usándose a sí mismo como único componente; si alguno en realidad es un combo,
            después lo editás y le agregás los demás componentes.
          </p>
          <button
            onClick={migrateOrphans}
            disabled={migratingOrphans}
            className="rounded-md bg-amber-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {migratingOrphans ? "Cargando..." : `Terminar de cargar (${orphanProducts.length})`}
          </button>
          {migrateOrphansResult && <p className="text-sm text-neutral-700">{migrateOrphansResult}</p>}
        </section>
      )}

      {isAdmin && (
        <section className="space-y-3 rounded-lg border border-gray-200 p-4">
          <h2 className="text-lg font-medium">Carga masiva por Excel</h2>
          <p className="text-sm text-neutral-500">
            Subí un Excel con una fila por cada producto que compone cada ítem del catálogo. Si es un producto
            suelto (sin combo), repetí el mismo EAN/SKU/Nombre en las columnas "Final" y "Componente" de una sola
            fila. Si es un combo, una fila por cada producto que lo compone, todas con el mismo "SKU Final". Si el
            producto final o algún componente todavía no está cargado, se va a crear automáticamente con el
            nombre que pongas en el Excel.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={downloadTemplate}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm text-neutral-700"
            >
              Descargar plantilla
            </button>
            <label className="cursor-pointer rounded-md bg-neutral-800 px-4 py-2 text-sm font-semibold text-white">
              Elegir archivo Excel
              <input type="file" accept=".xlsx,.xls" onChange={handleFile} className="hidden" />
            </label>
          </div>
          {importFileError && <p className="text-sm text-red-600">{importFileError}</p>}
          {importResult && <p className="text-sm text-neutral-700">{importResult}</p>}

          {importGroups && (
            <div className="space-y-3 rounded-md border border-gray-200 p-3">
              <p className="text-sm font-medium">Vista previa: {importGroups.length} ítem(s)</p>
              <div className="max-h-80 space-y-3 overflow-y-auto">
                {importGroups.map((group, i) => (
                  <div
                    key={i}
                    className={`rounded-md border p-3 ${
                      group.error || group.recipeStatus === "ya existe" ? "border-red-200 bg-red-50" : "border-gray-200"
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">
                        {group.outputName || "(sin nombre)"}{" "}
                        <span className="text-sm font-normal text-neutral-500">
                          {group.outputSku ? `SKU: ${group.outputSku}` : ""}
                          {group.outputSku && group.outputEan ? " · " : ""}
                          {group.outputEan ? `EAN: ${group.outputEan}` : ""}
                        </span>
                      </span>
                      <span className="text-sm">
                        {group.error && <span className="text-red-600">{group.error}</span>}
                        {!group.error && group.recipeStatus === "ya existe" && (
                          <span className="text-red-600">Ya está cargado — se omite</span>
                        )}
                        {!group.error && group.recipeStatus === "nuevo" && (
                          <span className="text-green-700">
                            {group.outputStatus === "se creará" ? "Producto e ítem nuevos" : "Ítem nuevo"}
                          </span>
                        )}
                      </span>
                    </div>
                    <ul className="mt-2 space-y-0.5 text-sm text-neutral-600">
                      {group.components.map((c, j) => (
                        <li key={j} className="flex justify-between gap-2">
                          <span>
                            {c.name || "(sin nombre)"}{" "}
                            <span className="text-neutral-400">({c.sku ? `SKU: ${c.sku}` : `EAN: ${c.ean}`})</span>
                          </span>
                          <span>
                            x{c.quantity} ·{" "}
                            {c.productStatus === "existe" && "existente"}
                            {c.productStatus === "se creará" && "se creará"}
                            {c.productStatus === "error" && <span className="text-red-600">falta nombre</span>}
                          </span>
                        </li>
                      ))}
                      {group.components.length === 0 && (
                        <li className="text-neutral-400">Sin componentes en el archivo.</li>
                      )}
                    </ul>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setImportGroups(null)}
                  className="rounded-md border border-gray-300 px-4 py-2 text-sm text-neutral-700"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleConfirmImport}
                  disabled={importing}
                  className="rounded-md bg-yellow-400 px-4 py-2 text-sm font-semibold text-neutral-900 disabled:opacity-50"
                >
                  {importing ? "Cargando..." : "Confirmar carga"}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {isAdmin && (
        <section className="space-y-3 rounded-lg border border-gray-200 p-4">
          <h2 className="text-lg font-medium">Nuevo ítem</h2>
          <p className="text-sm text-neutral-500">
            Cargá los productos que hay que verificar. Si es un solo producto (sin combo), con esa única fila
            alcanza. Si agregás un segundo producto, es porque es un combo — ahí te va a pedir además el SKU y el
            nombre propios del combo (el identificador que Mercado Libre le da a ese combo, distinto del SKU de
            cada producto que lo compone).
          </p>
          <form onSubmit={handleCreateItem} className="space-y-3">
            <div className="space-y-2">
              {newItem.components.map((c, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border border-gray-200 p-2">
                  <input
                    value={c.ean}
                    onChange={(e) => updateDraftComponent(newItem, setNewItem, i, "ean", e.target.value)}
                    placeholder="EAN real (opcional)"
                    className="w-36 rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                  <input
                    value={c.sku}
                    onChange={(e) => updateDraftComponent(newItem, setNewItem, i, "sku", e.target.value)}
                    placeholder="SKU / Código (opcional)"
                    className="w-36 rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                  <input
                    value={c.name}
                    onChange={(e) => updateDraftComponent(newItem, setNewItem, i, "name", e.target.value)}
                    placeholder="Nombre del producto"
                    className="flex-1 min-w-40 rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                  <input
                    type="number"
                    min={1}
                    value={c.quantity}
                    onChange={(e) => updateDraftComponent(newItem, setNewItem, i, "quantity", e.target.value)}
                    className="w-20 rounded-md border border-gray-300 px-3 py-2 text-center text-sm"
                  />
                  {newItem.components.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeDraftRow(newItem, setNewItem, i)}
                      className="text-sm text-red-600"
                    >
                      Quitar
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={() => addDraftRow(newItem, setNewItem)}
                className="text-sm text-neutral-600 underline"
              >
                + Agregar producto (es un combo)
              </button>
            </div>

            {draftIsCombo && (
              <div className="flex flex-wrap gap-3 rounded-md border border-gray-200 bg-neutral-50 p-3">
                <div className="w-48 space-y-1">
                  <label className="text-sm text-neutral-500">SKU real del combo</label>
                  <input
                    value={newItem.comboSku}
                    onChange={(e) => setNewItem({ ...newItem, comboSku: e.target.value })}
                    placeholder="Ej: PACKILUM603"
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div className="flex-1 min-w-52 space-y-1">
                  <label className="text-sm text-neutral-500">Nombre del combo</label>
                  <input
                    value={newItem.comboName}
                    onChange={(e) => setNewItem({ ...newItem, comboName: e.target.value })}
                    placeholder="Ej: Combo Instalación Térmica Bipolar 16A + Disyuntor 40A"
                    className="w-full rounded-md border border-gray-300 px-3 py-2"
                  />
                </div>
              </div>
            )}

            {createError && <p className="text-sm text-red-600">{createError}</p>}

            <button
              disabled={saving}
              className="rounded-md bg-yellow-400 px-4 py-2 font-semibold text-neutral-900 disabled:opacity-50"
            >
              {saving ? "Guardando..." : "Agregar al catálogo"}
            </button>
          </form>
        </section>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-medium">
              Catálogo cargado ({filteredRecipes.length}
              {query ? ` de ${recipes.length}` : ""})
            </h2>
          </div>
          {isAdmin && filteredRecipes.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-neutral-600">
                <input
                  type="checkbox"
                  checked={selectedIds.size === filteredRecipes.length && filteredRecipes.length > 0}
                  onChange={toggleSelectAll}
                />
                Seleccionar todos
              </label>
              <button
                onClick={handleBulkDelete}
                disabled={selectedIds.size === 0 || bulkDeleting}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
              >
                {bulkDeleting ? "Eliminando..." : `Eliminar seleccionados (${selectedIds.size})`}
              </button>
            </div>
          )}
        </div>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por EAN, SKU o nombre..."
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
        />
        {query && filteredRecipes.length === 0 && (
          <p className="text-sm text-neutral-500">No se encontró nada con eso.</p>
        )}
        {deleteError && <p className="text-sm text-red-600">{deleteError}</p>}
        {bulkResult && <p className="text-sm text-neutral-700">{bulkResult}</p>}

        <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200">
          {filteredRecipes.map((recipe) => {
            const components = componentsByRecipe[recipe.id] ?? [];
            const isExpanded = expanded[recipe.id];
            const isEditing = editingId === recipe.id;
            const outputProduct = productById(recipe.output_product_id);
            const editDraftIsCombo =
              isEditing && editDraft
                ? editDraft.components.filter((c) => c.ean.trim() || c.sku.trim() || c.name.trim()).length > 1
                : false;

            if (isEditing && editDraft) {
              return (
                <li key={recipe.id} className="space-y-3 px-4 py-3">
                  <div className="space-y-2">
                    {editDraft.components.map((c, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border border-gray-200 p-2">
                        <input
                          value={c.ean}
                          onChange={(e) => updateDraftComponent(editDraft, setEditDraft, i, "ean", e.target.value)}
                          placeholder="EAN real (opcional)"
                          className="w-36 rounded-md border border-gray-300 px-3 py-2 text-sm"
                        />
                        <input
                          value={c.sku}
                          onChange={(e) => updateDraftComponent(editDraft, setEditDraft, i, "sku", e.target.value)}
                          placeholder="SKU / Código (opcional)"
                          className="w-36 rounded-md border border-gray-300 px-3 py-2 text-sm"
                        />
                        <input
                          value={c.name}
                          onChange={(e) => updateDraftComponent(editDraft, setEditDraft, i, "name", e.target.value)}
                          placeholder="Nombre del producto"
                          className="flex-1 min-w-40 rounded-md border border-gray-300 px-3 py-2 text-sm"
                        />
                        <input
                          type="number"
                          min={1}
                          value={c.quantity}
                          onChange={(e) => updateDraftComponent(editDraft, setEditDraft, i, "quantity", e.target.value)}
                          className="w-20 rounded-md border border-gray-300 px-3 py-2 text-center text-sm"
                        />
                        {editDraft.components.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeDraftRow(editDraft, setEditDraft, i)}
                            className="text-sm text-red-600"
                          >
                            Quitar
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => addDraftRow(editDraft, setEditDraft)}
                      className="text-sm text-neutral-600 underline"
                    >
                      + Agregar producto (es un combo)
                    </button>
                  </div>

                  {editDraftIsCombo && (
                    <div className="flex flex-wrap gap-3 rounded-md border border-gray-200 bg-neutral-50 p-3">
                      <div className="w-48 space-y-1">
                        <label className="text-sm text-neutral-500">SKU real del combo</label>
                        <input
                          value={editDraft.comboSku}
                          onChange={(e) => setEditDraft({ ...editDraft, comboSku: e.target.value })}
                          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                        />
                      </div>
                      <div className="flex-1 min-w-52 space-y-1">
                        <label className="text-sm text-neutral-500">Nombre del combo</label>
                        <input
                          value={editDraft.comboName}
                          onChange={(e) => setEditDraft({ ...editDraft, comboName: e.target.value })}
                          className="w-full rounded-md border border-gray-300 px-3 py-2"
                        />
                      </div>
                    </div>
                  )}

                  {editError && <p className="text-sm text-red-600">{editError}</p>}

                  <div className="flex gap-2">
                    <button onClick={cancelEdit} className="rounded-md border border-gray-300 px-4 py-2 text-sm text-neutral-700">
                      Cancelar
                    </button>
                    <button
                      onClick={() => saveEdit(recipe.id)}
                      disabled={savingEdit}
                      className="rounded-md bg-yellow-400 px-4 py-2 text-sm font-semibold text-neutral-900 disabled:opacity-50"
                    >
                      {savingEdit ? "Guardando..." : "Guardar cambios"}
                    </button>
                  </div>
                </li>
              );
            }

            return (
              <li key={recipe.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  {isAdmin && (
                    <input
                      type="checkbox"
                      checked={selectedIds.has(recipe.id)}
                      onChange={() => toggleSelected(recipe.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="shrink-0"
                    />
                  )}
                  <button onClick={() => toggleExpanded(recipe.id)} className="flex-1 text-left">
                    <span className={recipe.active ? "" : "text-neutral-400 line-through"}>{recipe.name}</span>
                    <span className="ml-2 text-sm text-neutral-500">
                      {outputProduct
                        ? `${outputProduct.ean ? `EAN: ${outputProduct.ean}` : ""}${
                            outputProduct.sku ? ` · SKU: ${outputProduct.sku}` : ""
                          }`
                        : "sin producto final"}{" "}
                      · {components.length} producto{components.length === 1 ? "" : "s"}
                    </span>
                  </button>
                  {isAdmin && (
                    <div className="flex shrink-0 items-center gap-3">
                      <button onClick={() => startEdit(recipe)} className="text-sm text-neutral-600">
                        Editar
                      </button>
                      <button
                        onClick={() => toggleActive(recipe)}
                        className={`text-sm ${recipe.active ? "text-red-600" : "text-green-600"}`}
                      >
                        {recipe.active ? "Desactivar" : "Reactivar"}
                      </button>
                      <button onClick={() => deleteRecipe(recipe)} className="text-sm text-red-600">
                        Eliminar
                      </button>
                    </div>
                  )}
                </div>

                {isExpanded && (
                  <ul className="mt-2 space-y-1 border-t border-gray-100 pt-2">
                    {components.map((c) => (
                      <li key={c.id} className="flex justify-between text-sm text-neutral-600">
                        <span>
                          {c.product_name}{" "}
                          <span className="text-neutral-400">
                            (EAN: {c.product_ean}
                            {c.product_sku ? ` · SKU: ${c.product_sku}` : ""})
                          </span>
                        </span>
                        <span>x{c.quantity}</span>
                      </li>
                    ))}
                    {components.length === 0 && <li className="text-sm text-neutral-400">Sin componentes cargados.</li>}
                  </ul>
                )}
              </li>
            );
          })}
          {filteredRecipes.length === 0 && !query && (
            <li className="px-4 py-3 text-sm text-neutral-500">Todavía no hay nada cargado en el catálogo.</li>
          )}
        </ul>
      </section>
    </main>
  );
}
