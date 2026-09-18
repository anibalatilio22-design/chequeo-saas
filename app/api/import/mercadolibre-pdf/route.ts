import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseMercadoLibrePrepPdf } from "@/lib/parse-ml-pdf";

// Usamos "pdf-parse" en vez de "pdfjs-dist" directo para leer el texto del
// PDF en el servidor. pdfjs-dist necesita configurar un archivo de "worker"
// (pensado para el navegador) y, empaquetado dentro de una Route Handler de
// Next.js, esa configuración se rompe en producción con el error
// "Setting up fake worker failed: e.endsWith is not a function". pdf-parse
// resuelve todo internamente sin necesitar ningún worker, así que evitamos
// ese problema de raíz.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pdfParse: any = require("pdf-parse");

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ ok: false, error: "No se recibió ningún archivo" }, { status: 400 });
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // pdf-parse recorre las páginas en orden y nos permite "engancharnos" al
    // render de cada una para armar nuestro propio texto por página (igual
    // que antes hacíamos a mano con pdfjs-dist), en vez de quedarnos solo
    // con el texto completo del documento pegado en un solo bloque.
    const pageTexts: string[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function pagerender(pageData: any) {
      const content = await pageData.getTextContent();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = content.items.map((item: any) => item.str).join(" ");
      pageTexts.push(text);
      return text;
    }

    await pdfParse(buffer, { pagerender });

    const parsed = parseMercadoLibrePrepPdf(pageTexts);

    if (parsed.rows.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "No se pudo reconocer ningún producto en el PDF. ¿Es el archivo de 'instrucciones de preparación' de un envío Full?",
        },
        { status: 422 }
      );
    }

    return NextResponse.json({ ok: true, ...parsed });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Error al leer el PDF" },
      { status: 500 }
    );
  }
}
