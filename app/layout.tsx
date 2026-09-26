import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CheckFlash — Chequeo Full / Flex / Colecta",
  description: "Verificación de armado de combos por escaneo de código de barras",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
