// Marca del sistema ("CheckFlash"): un rayo dentro de un cuadrado oscuro con
// una insignia de tick verde, más el nombre. Es la marca del PRODUCTO (no la
// de la empresa del usuario, que tiene su propio logo subible desde
// Configuración — ver company-logos / logoUrl en nav-bar.tsx). Se usa en la
// pantalla de login (logo completo con subtítulo) y al lado de la barra de
// arriba (solo el ícono).
export function CheckFlashIcon({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 280 280"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
    >
      <defs>
        <filter id="checkflash-glow" x="-60%" y="-60%" width="220%" height="220%">
          <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor="#F59E0B" floodOpacity="0.85" />
        </filter>
      </defs>
      <rect width="280" height="280" rx="62" fill="#0F1420" />
      <svg x="65" y="40" width="150" height="200" viewBox="0 0 384 512" filter="url(#checkflash-glow)">
        <path
          d="M296 160H180.6l42.6-129.8C227.2 15 215.7 0 200 0H88C74.7 0 63.6 10.4 62.1 23.6l-32 288C28.4 326.2 40 336 53.9 336H157l-40.9 156.9c-4.2 16.1 15 27.9 27.1 16.5L363.6 189c14.4-13.4 4.9-37-14.7-37z"
          fill="#F59E0B"
        />
      </svg>
      <circle cx="235" cy="227" r="45" fill="#0F1420" />
      <circle cx="235" cy="227" r="39" fill="#16A34A" />
      <svg x="215" y="207" width="40" height="40" viewBox="0 0 24 24" fill="none">
        <path
          d="M4 12.5L9.5 18L20 6"
          stroke="#0F1420"
          strokeWidth="3.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </svg>
  );
}

export function CheckFlashLogo({
  withSubtitle = true,
  iconSize = 56,
  // Tamaño del texto. Más chico en la barra de arriba (nav-bar.tsx) para
  // que entre junto con el resto de la barra en pantallas no tan anchas.
  wordmarkSize = "text-2xl",
  // "brand" = "CHECK" + "FLASH" en mayúsculas, negrita, con "FLASH" en
  // color ámbar — el logotipo grande de la pantalla de login.
  // "plain" = "CheckFlash" con mayúscula solo en cada palabra, sin negrita
  // extra ni color partido — como se ve el título en la pestaña del
  // navegador. Se usa en la barra de arriba, más chico y sobrio.
  wordmarkStyle = "brand",
  // "light" = texto oscuro, pensado para fondos claros (pantalla de login).
  // "dark" = texto blanco, pensado para fondos oscuros/de color (ej: la
  // franja de la barra de arriba, ver nav-bar.tsx).
  variant = "light",
  className,
}: {
  withSubtitle?: boolean;
  iconSize?: number;
  wordmarkSize?: string;
  wordmarkStyle?: "brand" | "plain";
  variant?: "light" | "dark";
  className?: string;
}) {
  const textColor = variant === "dark" ? "text-white" : "text-neutral-900";
  const subtitleColor = variant === "dark" ? "text-neutral-300" : "text-neutral-500";

  return (
    <div className={`flex items-center gap-2 ${className ?? ""}`}>
      <CheckFlashIcon size={iconSize} />
      <div className="flex flex-col">
        {wordmarkStyle === "plain" ? (
          <span className={`${wordmarkSize} font-semibold leading-none whitespace-nowrap ${textColor}`}>
            CheckFlash
          </span>
        ) : (
          <span className={`${wordmarkSize} font-extrabold leading-none tracking-tight whitespace-nowrap`}>
            <span className={textColor}>CHECK</span>
            <span className="text-amber-500">FLASH</span>
          </span>
        )}
        {withSubtitle && (
          <span className={`mt-1 text-[10px] font-medium uppercase tracking-widest ${subtitleColor}`}>
            Verificación de pedidos Full, Flex y Colecta
          </span>
        )}
      </div>
    </div>
  );
}
