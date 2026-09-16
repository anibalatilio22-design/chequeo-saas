// Parser específico para el PDF "Listado de productos e instrucciones de
// preparación" que Mercado Libre genera para envíos Full de reposición
// (Inbound-XXXXXXXX-preparation-instructions.pdf).
//
// Cada producto en el documento tiene el formato:
//   "Código ML: <codigo> Código universal: <ean o N/A> SKU: <sku>
//    <nombre del producto...> ... Etiquetado obligatorio"
// y la cantidad ("UNIDADES") aparece en una columna aparte que, según cómo
// el extractor de texto recorre la página, puede terminar como una lista
// de números sueltos después del bloque de productos de esa misma página.
// Por eso el parseo se hace página por página: se identifican los N
// bloques de producto de la página, y los N números sueltos que quedan
// (fuera de esos bloques) se asignan en el mismo orden.

export type ParsedMlRow = {
  codigo_ml: string;
  ean: string | null;
  sku: string;
  name: string;
  quantity: number;
};

export type ParsedMlPdf = {
  envioNumero: string | null;
  rows: ParsedMlRow[];
  warnings: string[];
};

const BLOCK_REGEX =
  /C[oó]digo ML:\s*(\S+)\s*C[oó]digo universal:\s*(\S+)\s*SKU:\s*(\S+)\s*([\s\S]*?)Etiquetado\s*obligatorio/gi;

export function parseMercadoLibrePrepPdf(pageTexts: string[]): ParsedMlPdf {
  const warnings: string[] = [];
  const rows: ParsedMlRow[] = [];

  // El número de envío suele aparecer como "Envío #12345678" en la primera página.
  const fullText = pageTexts.join("\n");
  const envioMatch = fullText.match(/Env[ií]o\s*#\s*(\d+)/i);
  const envioNumero = envioMatch ? envioMatch[1] : null;

  pageTexts.forEach((pageText, pageIndex) => {
    const blocks: { codigo_ml: string; ean: string | null; sku: string; name: string }[] = [];

    let match: RegExpExecArray | null;
    const regex = new RegExp(BLOCK_REGEX);

    while ((match = regex.exec(pageText)) !== null) {
      const [, codigo_ml, codigoUniversal, sku, rawName] = match;
      const name = rawName.replace(/\s+/g, " ").trim();
      blocks.push({
        codigo_ml,
        ean: codigoUniversal.toUpperCase() === "N/A" ? null : codigoUniversal,
        sku,
        name,
      });
    }

    if (blocks.length === 0) return; // página sin productos (portada, notas, etc.)

    // Todo lo que queda de la página después de quitar los bloques de
    // producto matcheados es, en la práctica, la columna de "unidades"
    // (más encabezados de tabla y del documento, que filtramos aparte para
    // que sus números sueltos —como "73 productos" o "1440 unidades"— no
    // se confundan con cantidades reales).
    const withoutBlocks = pageText
      .replace(BLOCK_REGEX, " ")
      .replace(/Env[ií]o\s*#\s*\d+/gi, " ")
      .replace(/Productos del env[ií]o:\s*\d+/gi, " ")
      .replace(/Total de unidades:\s*\d+/gi, " ");
    const quantities = (withoutBlocks.match(/\b\d{1,4}\b/g) ?? []).map(Number);

    if (quantities.length !== blocks.length) {
      warnings.push(
        `Página ${pageIndex + 1}: se detectaron ${blocks.length} productos pero ${quantities.length} cantidades. Revisá esa página con cuidado en la vista previa.`
      );
    }

    blocks.forEach((block, i) => {
      rows.push({
        ...block,
        quantity: quantities[i] ?? 1,
      });
    });
  });

  return { envioNumero, rows, warnings };
}
