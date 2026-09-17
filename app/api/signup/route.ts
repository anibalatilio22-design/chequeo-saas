import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Alta de una empresa nueva (self-signup, sin intervención manual): crea la
// company, el usuario de Supabase Auth y su perfil en public.users con
// role "admin" — con la service_role key, porque hasta que no existe ese
// perfil no hay ningún company_id con el que RLS pueda autorizar nada.
export async function POST(req: Request) {
  let body: { companyName?: string; fullName?: string; email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Pedido inválido" }, { status: 400 });
  }

  const companyName = (body.companyName ?? "").trim();
  const fullName = (body.fullName ?? "").trim();
  const email = (body.email ?? "").trim();
  const password = body.password ?? "";

  if (!companyName || !fullName || !email || password.length < 6) {
    return NextResponse.json(
      { ok: false, error: "Completá todos los campos (la contraseña necesita al menos 6 caracteres)." },
      { status: 400 }
    );
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "Error de configuración del servidor" },
      { status: 500 }
    );
  }

  // Slug único a partir del nombre de la empresa (columna unique en la
  // tabla, no se le pide al usuario que lo piense).
  const base =
    companyName
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "empresa";
  const slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;

  const { data: companyRaw, error: companyError } = await admin
    .from("companies")
    .insert({ name: companyName, slug } as any)
    .select()
    .single();

  // El cliente tipado no siempre resuelve bien el tipo de este resultado
  // (mismo motivo de fondo que otros casteos de la app), así que lo
  // casteamos a mano para poder acceder a sus propiedades sin error.
  const company = companyRaw as { id: string } | null;

  if (companyError || !company) {
    return NextResponse.json(
      { ok: false, error: companyError?.message ?? "No se pudo crear la empresa" },
      { status: 500 }
    );
  }

  // email_confirm: true evita depender de que llegue el mail de confirmación
  // de Supabase (que en el free tier puede tardar o no estar configurado) —
  // el usuario queda listo para entrar apenas termina el alta.
  const { data: authUser, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (authError || !authUser?.user) {
    // Rollback: no dejamos una empresa húerfana sin usuario.
    await admin.from("companies").delete().eq("id", company.id);
    return NextResponse.json(
      {
        ok: false,
        error: authError?.message?.toLowerCase().includes("registered")
          ? "Ese email ya tiene una cuenta creada."
          : authError?.message ?? "No se pudo crear el usuario",
      },
      { status: 500 }
    );
  }

  const { error: profileError } = await admin.from("users").insert({
    id: authUser.user.id,
    company_id: company.id,
    full_name: fullName,
    role: "admin",
    active: true,
  } as any);

  if (profileError) {
    // Rollback best-effort de lo que ya se creó.
    await admin.auth.admin.deleteUser(authUser.user.id);
    await admin.from("companies").delete().eq("id", company.id);
    return NextResponse.json({ ok: false, error: profileError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
