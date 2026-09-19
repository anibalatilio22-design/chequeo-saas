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

  const arrayBuffer = await file.arrayBuffer();

  // NOTA TEMPORAL DE DIAGNÓSTICO: separamos "cargar el PDF" de "sacarle el
  // texto" en dos try/catch distintos, y devolvemos nombre + mensaje + las
  // primeras líneas del stack de cualquier error, para poder ver en la
  // propia pantalla en qué paso exacto se rompe y con qué error real —
  // sin tener que andar buscando en los logs de Vercel. Una vez que
  // encontremos la causa real, esto se puede volver a simplificar.
  function debugInfo(step: string, err: unknown) {
    if (err instanceof Error) {
      const stackLines = (err.stack ?? "").split("\n").slice(0, 4).join(" | ");
      return `[${step}] ${err.name}: ${err.message} — ${stackLines}`;
    }
    return `[${step}] ${String(err)}`;
  }

  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(arrayBuffer));
  } catch (err) {
    return NextResponse.json({ ok: false, error: debugInfo("getDocumentProxy", err) }, { status: 500 });
  }

  let pageTexts: string[];
  try {
    // mergePages: false (el valor por defecto) nos devuelve un array con el
    // texto de cada página por separado — lo necesitamos así porque el
    // parseo de las cantidades ("UNIDADES") se hace página por página.
    const { text } = await extractText(pdf, { mergePages: false });
    pageTexts = Array.isArray(text) ? text : [text];
  } catch (err) {
    return NextResponse.json({ ok: false, error: debugInfo("extractText", err) }, { status: 500 });
  }

  try {
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
    return NextResponse.json({ ok: false, error: debugInfo("parseMercadoLibrePrepPdf", err) }, { status: 500 });
  }
}
