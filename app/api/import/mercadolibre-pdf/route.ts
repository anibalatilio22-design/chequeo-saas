import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseMercadoLibrePrepPdf } from "@/lib/parse-ml-pdf";
import { getDocumentProxy, extractText } from "unpdf";

// Ya probamos "pdfjs-dist" y después "pdf-parse" para leer el texto del PDF
// en el servidor, y las dos rompían en producción (Vercel) con el error
// "Setting up fake worker failed: e.endsWith is not a function", porque las
// dos usan por debajo el mismo motor (pdf.js) que intenta configurar un Web
// Worker — algo pensado para el navegador — y esa configuración se rompe
// cuando queda empaquetada dentro de una Route Handler serverless.
//
// "unpdf" está armado a propósito para entornos serverless (Vercel, Lambda,
// Cloudflare Workers, etc.): no usa ningún Worker, así que este problema no
// debería volver a aparecer.
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
    const pdf = await getDocumentProxy(new Uint8Array(arrayBuffer));

    // mergePages: false (el valor por defecto) nos devuelve un array con el
    // texto de cada página por separado — lo necesitamos así porque el
    // parseo de las cantidades ("UNIDADES") se hace página por página.
    const { text } = await extractText(pdf, { mergePages: false });
    const pageTexts: string[] = Array.isArray(text) ? text : [text];

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
