// El "dueño" del sistema (vos, Anibal) — no es un rol más dentro de una
// empresa, es quien puede ver y tocar TODAS las empresas desde /dueno,
// saltándose por completo el aislamiento por company_id (por eso ese panel
// usa el cliente admin con la service_role key, ver lib/supabase/admin.ts).
// Se identifica por email a propósito, en vez de guardarlo como una columna
// más en "users": así no depende de ningún dato de ninguna empresa, y no
// hay riesgo de que se pise o se borre por accidente al tocar una cuenta.
//
// Si en algún momento hace falta que otra persona de confianza entre
// también, se agrega su email a esta lista.
const OWNER_EMAILS = ["anibalatilio22@gmail.com"];

export function isOwnerEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return OWNER_EMAILS.includes(email.toLowerCase().trim());
}
