import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseMercadoLibreFlexPdf, debugFlexPdfColumns } from "@/lib/parse-ml-flex-pdf";
import { getDocumentProxy } from "unpdf";

// Mismo motivo que la ruta de Full para usar "unpdf" (ver ese archivo): es
// la única librería de lectura de PDF que no rompe en Vercel con el error
// de "fake worker".
//
// A diferencia de Full, acá no alcanza con el texto plano de cada página
// (extractText) porque este documento es una tabla de DOS columnas — el
// parser (lib/parse-ml-flex-pdf.ts) necesita el documento de pdf.js entero
// para poder leer la POSICIÓN de cada fragmento de texto. Por eso se le pasa
// "pdf" directo, en vez de un array de strings.
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

  try {
    const parsed = await parseMercadoLibreFlexPdf(pdf);

    if (parsed.packs.length === 0) {
      // No se reconoció nada: en vez de un genérico "no se pudo leer",
      // devolvemos también el texto crudo de cada columna tal cual lo vio
      // el parser, para poder ver rápido en la pantalla por qué no entró
      // nada (sin tener que andar mirando logs de Vercel) — la misma idea
      // que terminó funcionando para destrabar el de Full.
      let debugColumns: Awaited<ReturnType<typeof debugFlexPdfColumns>> | null = null;
      try {
        debugColumns = await debugFlexPdfColumns(pdf);
      } catch {
        // si ni el diagnóstico se puede sacar, seguimos sin él
      }

      return NextResponse.json(
        {
          ok: false,
          error:
            "No se pudo reconocer ninguna venta en el PDF. ¿Es el archivo de 'Identificación / Productos' de Mercado Libre para Flex o Colecta?",
          debugColumns,
        },
        { status: 422 }
      );
    }

    // Diagnóstico temporal: mandamos también el texto crudo de cada columna
    // tal cual lo vio el parser en ESTE servidor (no una simulación aparte),
    // incluso cuando el import salió bien — así se puede comparar lo que de
    // verdad extrae la librería de PDF en producción contra lo esperado,
    // en vez de adivinar. No se usa para nada del import en sí.
    let debugColumns: Awaited<ReturnType<typeof debugFlexPdfColumns>> | null = null;
    try {
      debugColumns = await debugFlexPdfColumns(pdf);
    } catch {
      // si no se puede sacar el diagnóstico, seguimos sin él
    }

    return NextResponse.json({ ok: true, ...parsed, debugColumns });
  } catch (err) {
    return NextResponse.json({ ok: false, error: debugInfo("parseMercadoLibreFlexPdf", err) }, { status: 500 });
  }
}
