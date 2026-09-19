/** @type {import('next').NextConfig} */
const nextConfig = {
  // Antes usamos pdfjs-dist y después pdf-parse para leer el PDF en el
  // servidor — las dos rompían en Vercel con el error de "fake worker",
  // porque ambas por debajo intentan usar un Web Worker (algo pensado para
  // el navegador) y esa configuración se rompe al quedar empaquetada dentro
  // de una Route Handler. "unpdf" está hecho a propósito para entornos
  // serverless (Vercel, Lambda, etc.) y no necesita worker ni configuración
  // especial acá — por eso no hace falta declarar nada en
  // serverExternalPackages para esta librería.
  webpack: (config) => {
    // Por las dudas: si alguna librería de PDF intenta cargar 'canvas' como
    // polyfill opcional (solo sirve para renderizar PDFs a imagen, algo que
    // no hacemos acá), esto evita que el build falle buscando un módulo que
    // no está instalado.
    config.resolve.alias.canvas = false;
    return config;
  },
};

export default nextConfig;
