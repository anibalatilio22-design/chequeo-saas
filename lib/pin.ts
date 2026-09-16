import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

// Hash de PIN de operario usando scrypt (nativo de Node, sin dependencias
// externas que instalar). Formato guardado: "salt:hash" en hexadecimal.
// SOLO usar del lado del servidor (Route Handlers / Server Actions),
// nunca importar esto en un componente "use client".

export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pin, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const hashBuffer = Buffer.from(hash, "hex");
  const inputBuffer = scryptSync(pin, salt, 64);
  if (hashBuffer.length !== inputBuffer.length) return false;
  return timingSafeEqual(hashBuffer, inputBuffer);
}
