// Parser para el documento "Identificación | Productos" que Mercado Libre
// genera para envíos Flex y Colecta: una tabla de DOS COLUMNAS por página —
// "Identificación" (quién compró, en qué pack) a la izquierda y "Productos"
// (qué hay que preparar para esa venta) a la derecha — que se repite fila
// tras fila, con varias filas por página y varias páginas por lote.
//
// Es bastante distinto del PDF de Full (ver parse-ml-pdf.ts):
//   - No trae EAN en ningún lado, solo SKU.
//   - Una misma "Identificación" (una venta/pack) puede traer más de un
//     producto (no es uno a uno).
//   - El "Pack ID" a veces no está (hay ventas sueltas sin pack).
//   - Un producto puede cortarse justo en el salto de página: el nombre
//     queda al final de una hoja y sus atributos (SKU, Cantidad, etc.)
//     siguen al principio de la próxima.
//
// Por ser una tabla de DOS columnas, no alcanza con leer el texto "plano"
// como en el de Full (ahí alcanzaba porque es una sola columna corrida). Acá
// hace falta la POSICIÓN (x, y) de cada fragmento de texto en la página para
// separar qué es de la columna "Identificación" y qué es de la columna
// "Productos", y para saber qué productos le corresponden a cada venta (los
// que caen, en altura, entre esa venta y la siguiente). Por eso este parser
// no recibe el texto ya extraído como un array de strings (como el de Full)
// sino el documento de pdf.js entero (el que devuelve getDocumentProxy de
// "unpdf"), y arma él mismo esa lectura posicional con getTextContent().
//
// IMPORTANTE — esto es una primera versión sin poder probarla contra un PDF
// real: la única muestra que tenemos es una FOTO escaneada (sin texto
// seleccionable), así que sirvió para entender la estructura visual pero no
// para confirmar en qué orden entrega pdf.js el texto de un PDF digital de
// verdad. Es muy probable que haga falta un ajuste (como pasó con el de
// Full) apenas se pruebe con el primer PDF real — por eso se expone también
// `debugFlexPdfColumns`, para poder ver rápido el texto tal cual se extrajo
// columna por columna si algo no entra bien.

export type ParsedFlexProduct = {
  name: string;
  sku: string | null;
  quantity: number;
  // Líneas tipo "Color: Negro" / "Voltaje: 220V" — son solo para mostrar en
  // la vista previa, no se usan para emparejar contra el catálogo.
  attributes: string[];
};

export type ParsedFlexPack = {
  itemId: string; // el número en negrita que identifica esta venta/paquete puntual
  packId: string | null; // ausente en ventas sueltas
  venta: string | null;
  buyerName: string;
  products: ParsedFlexProduct[];
};

export type ParsedFlexPdf = {
  packs: ParsedFlexPack[];
  warnings: string[];
};

type ColumnLine = { text: string; order: number };

const Y_TOLERANCE = 3; // puntos de PDF: fragmentos con esta diferencia de alto o menos se consideran la misma línea
const PAGE_ORDER_SPAN = 1_000_000; // hueco amplio de sobra por página para poder ordenar todo el documento de corrido

const ID_LINE = /^(\d{8,13})$/;
const PACK_ID_LINE = /^Pack ID:\s*(\d+)/i;
const VENTA_LINE = /^Venta:\s*(\d+)/i;
const SKU_LINE = /^SKU:\s*(.+)/i;
const CANTIDAD_LINE = /^Cantidad:\s*(\d+)/i;
// Cualquier línea con forma "Etiqueta: valor" (Color, Voltaje, Amperaje,
// etc. varían de producto en producto, así que no los listamos uno por uno:
// alcanza con reconocer la FORMA de la línea).
const LABEL_LINE = /^[A-Za-zÁÉÍÓÚÑáéíóúñ][\wÁÉÍÓÚÑáéíóúñ .]*:\s*.+/;

function isFurnitureLine(text: string): boolean {
  return (
    /^identificaci[oó]n$/i.test(text) ||
    /^productos$/i.test(text) ||
    /despacha tus productos/i.test(text) ||
    // El cartel "¡No te relajes! Tu comprador los está esperando." se repite
    // arriba de cada página y, como cae justo en el límite entre las dos
    // columnas, a veces se corta a la mitad — por eso se reconoce por
    // "está esperando" solo, sin exigir que la palabra "te" esté pegada
    // adelante (si no, algún pedazo suelto como "los está esperando."
    // se cuela como si fuera un producto más).
    /est[aá] esperando/i.test(text) ||
    /mercado\s*libre/i.test(text) ||
    /^\d{1,3}$/.test(text) // número de página suelto u otro resto corto sin sentido acá
  );
}

// Agrupa los fragmentos de texto de UNA columna (ya filtrados por x) en
// líneas, usando la altura (y). pdf.js a veces divide una misma línea visual
// en varios fragmentos (por ejemplo por un cambio de negrita a normal
// dentro de "Pack ID: 123..."), por eso se agrupan por cercanía en "y" en
// vez de asumir un fragmento = una línea.
function groupIntoLines(
  items: { text: string; x: number; y: number }[],
  pageIndex: number
): ColumnLine[] {
  const sorted = [...items].sort((a, b) => b.y - a.y); // de arriba hacia abajo de la página
  const lines: { y: number; parts: { text: string; x: number }[] }[] = [];

  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= Y_TOLERANCE) {
      last.parts.push({ text: it.text, x: it.x });
    } else {
      lines.push({ y: it.y, parts: [{ text: it.text, x: it.x }] });
    }
  }

  return lines
    .map((line) => ({
      text: line.parts
        .sort((a, b) => a.x - b.x)
        .map((p) => p.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
      order: pageIndex * PAGE_ORDER_SPAN - line.y,
    }))
    .filter((l) => l.text.length > 0);
}

// Lee todo el documento y devuelve las líneas de cada columna, ya ordenadas
// de principio a fin (todas las páginas seguidas). "pdf" es el objeto que
// devuelve getDocumentProxy() de "unpdf" — es, por debajo, un documento de
// pdf.js normal, así que tiene .numPages y .getPage().
async function extractColumns(pdf: any): Promise<{ left: ColumnLine[]; right: ColumnLine[] }> {
  const left: ColumnLine[] = [];
  const right: ColumnLine[] = [];

  for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex++) {
    const page = await pdf.getPage(pageIndex + 1);
    const content = await page.getTextContent();

    const items = (content.items as any[])
      .map((it) => ({
        text: (it.str ?? "").trim(),
        x: it.transform?.[4] ?? 0,
        y: it.transform?.[5] ?? 0,
      }))
      .filter((it) => it.text.length > 0);

    if (items.length === 0) continue;

    // El límite entre columnas se saca de dónde está el encabezado
    // "Productos" en ESTA página (se repite en todas). OJO: cada página
    // también trae, más arriba, el cartel "Despacha tus productos cuanto
    // antes..." — que contiene la palabra "productos" en minúscula pegada
    // al margen izquierdo. Si se la buscara sin importar mayúsculas y con
    // el primer resultado que aparezca, ESA es la que se encuentra primero
    // (aparece antes en la página), y el límite entre columnas queda
    // clavado casi en el margen izquierdo — rompiendo la lectura de casi
    // toda la página. Por eso acá se busca la palabra "Productos" tal cual
    // (con mayúscula, como título de columna) y, si aun así aparece
    // más de una vez, nos quedamos con la que está más a la derecha.
    const productosHeaders = items.filter((it) => it.text === "Productos");
    let splitX: number;
    if (productosHeaders.length > 0) {
      const rightmost = productosHeaders.reduce((a, b) => (b.x > a.x ? b : a));
      splitX = rightmost.x - 5;
    } else {
      const viewport = page.getViewport({ scale: 1 });
      splitX = viewport.width / 2;
    }

    const leftItems = items.filter((it) => it.x < splitX);
    const rightItems = items.filter((it) => it.x >= splitX);

    left.push(...groupIntoLines(leftItems, pageIndex));
    right.push(...groupIntoLines(rightItems, pageIndex));
  }

  left.sort((a, b) => a.order - b.order);
  right.sort((a, b) => a.order - b.order);

  return { left, right };
}

type IdentificacionEntry = {
  itemId: string;
  packId: string | null;
  venta: string | null;
  buyerName: string;
  order: number;
};

function parseIdentificaciones(lines: ColumnLine[]): IdentificacionEntry[] {
  const out: IdentificacionEntry[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].text;

    if (isFurnitureLine(line)) {
      i++;
      continue;
    }

    const idMatch = line.match(ID_LINE);
    if (!idMatch) {
      // Línea que no reconocemos en esta columna (no debería pasar mucho) —
      // la salteamos en vez de cortar todo el parseo.
      i++;
      continue;
    }

    const itemId = idMatch[1];
    const order = lines[i].order;
    i++;

    let packId: string | null = null;
    if (lines[i] && PACK_ID_LINE.test(lines[i].text)) {
      packId = lines[i].text.match(PACK_ID_LINE)![1];
      i++;
    }

    let venta: string | null = null;
    if (lines[i] && VENTA_LINE.test(lines[i].text)) {
      venta = lines[i].text.match(VENTA_LINE)![1];
      i++;
    }

    // El nombre del comprador a veces no entra en una sola línea (nombre y
    // apellido largos) y sigue en la línea de abajo — se junta todo lo que
    // venga hasta la próxima "Identificación" (un número) o hasta el
    // próximo cartel de relleno.
    const buyerParts: string[] = [];
    while (lines[i] && !ID_LINE.test(lines[i].text) && !isFurnitureLine(lines[i].text)) {
      buyerParts.push(lines[i].text);
      i++;
    }
    const buyerName = buyerParts.join(" ");

    out.push({ itemId, packId, venta, buyerName, order });
  }

  return out;
}

type ProductoEntry = ParsedFlexProduct & { order: number };

function parseProductos(lines: ColumnLine[]): ProductoEntry[] {
  const out: ProductoEntry[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].text;

    if (isFurnitureLine(line) || LABEL_LINE.test(line)) {
      // Una línea con forma de atributo suelta, sin nombre de producto
      // antes (no debería pasar en un documento bien formado) — la
      // salteamos para no romper el parseo entero.
      i++;
      continue;
    }

    // El nombre del producto a veces es tan largo que no entra en una sola
    // línea de la columna y sigue en la de abajo — se junta todo lo que
    // venga hasta encontrar la línea de SKU/Cantidad/algún atributo, o un
    // cartel de relleno.
    const nameParts = [line];
    const order = lines[i].order;
    i++;
    while (
      lines[i] &&
      !SKU_LINE.test(lines[i].text) &&
      !CANTIDAD_LINE.test(lines[i].text) &&
      !LABEL_LINE.test(lines[i].text) &&
      !isFurnitureLine(lines[i].text)
    ) {
      nameParts.push(lines[i].text);
      i++;
    }
    const name = nameParts.join(" ");

    let sku: string | null = null;
    if (lines[i] && SKU_LINE.test(lines[i].text)) {
      sku = lines[i].text.match(SKU_LINE)![1].trim();
      i++;
    }

    let quantity = 1;
    if (lines[i] && CANTIDAD_LINE.test(lines[i].text)) {
      quantity = parseInt(lines[i].text.match(CANTIDAD_LINE)![1], 10);
      i++;
    }

    const attributes: string[] = [];
    while (lines[i] && LABEL_LINE.test(lines[i].text) && !SKU_LINE.test(lines[i].text) && !CANTIDAD_LINE.test(lines[i].text)) {
      attributes.push(lines[i].text);
      i++;
    }

    out.push({ name, sku, quantity, attributes, order });
  }

  return out;
}

export async function parseMercadoLibreFlexPdf(pdf: any): Promise<ParsedFlexPdf> {
  const { left, right } = await extractColumns(pdf);

  const identificaciones = parseIdentificaciones(left);
  const productos = parseProductos(right);

  const warnings: string[] = [];

  if (identificaciones.length === 0) {
    warnings.push(
      "No se reconoció ninguna 'Identificación' en el PDF. Puede que el diseño del documento sea distinto al esperado."
    );
  }

  const packs: ParsedFlexPack[] = identificaciones.map((id) => ({
    itemId: id.itemId,
    packId: id.packId,
    venta: id.venta,
    buyerName: id.buyerName,
    products: [],
  }));

  // A cada producto le buscamos la Identificación más reciente (la última
  // cuyo orden en el documento sea menor o igual al de este producto) — es
  // decir, la venta bajo la cual apareció este producto al leer de arriba
  // hacia abajo. Así se banca que una misma venta traiga más de un
  // producto: todos los productos que caen antes de la SIGUIENTE
  // identificación quedan agrupados en la anterior.
  for (const prod of productos) {
    let targetIndex = -1;
    for (let i = identificaciones.length - 1; i >= 0; i--) {
      if (identificaciones[i].order <= prod.order) {
        targetIndex = i;
        break;
      }
    }

    if (targetIndex === -1) {
      warnings.push(
        `No se pudo asignar el producto "${prod.name}"${prod.sku ? ` (SKU ${prod.sku})` : ""} a ninguna venta — quedó afuera.`
      );
      continue;
    }

    packs[targetIndex].products.push({
      name: prod.name,
      sku: prod.sku,
      quantity: prod.quantity,
      attributes: prod.attributes,
    });
  }

  packs.forEach((pack) => {
    if (pack.products.length === 0) {
      warnings.push(`La venta ${pack.itemId} (${pack.buyerName || "sin nombre"}) quedó sin productos asignados.`);
    }
    pack.products.forEach((p) => {
      if (!p.sku) {
        warnings.push(`"${p.name}" en la venta ${pack.itemId} no tiene SKU reconocido.`);
      }
    });
  });

  return { packs, warnings };
}

// Para diagnóstico: devuelve el texto de cada columna, ya agrupado en
// líneas y en orden de lectura, tal cual lo ve el parser antes de aplicarle
// cualquier regla. Sirve para mandarlo cuando algo no entra bien con un PDF
// real, en vez de adivinar a ciegas (la misma estrategia que terminó
// funcionando con el de Full).
export async function debugFlexPdfColumns(pdf: any): Promise<{ identificacion: string[]; productos: string[] }> {
  const { left, right } = await extractColumns(pdf);
  return {
    identificacion: left.map((l) => l.text),
    productos: right.map((l) => l.text),
  };
}
