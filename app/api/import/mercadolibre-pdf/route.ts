import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseMercadoLibrePrepPdf } from "@/lib/parse-ml-pdf";

// pdfjs-dist necesita el build "legacy" para correr en Node (sin DOM/worker
// del navegador).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pdfjsLib: any = require("pdfjs-dist/legacy/build/pdf.js");
// En Node no hay Web Worker real; le indicamos el archivo del "worker" de
// la propia librería para que lo use de forma síncrona en el servidor.
pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve("pdfjs-dist/legacy/build/pdf.worker.js");

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
    const uint8Array = new Uint8Array(arrayBuffer);

    const loadingTask = pdfjsLib.getDocument({
      data: uint8Array,
      isEvalSupported: false,
    });
    const pdf = await loadingTask.promise;

    const pageTexts: string[] = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = content.items.map((item: any) => item.str).join(" ");
      pageTexts.push(text);
    }

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
