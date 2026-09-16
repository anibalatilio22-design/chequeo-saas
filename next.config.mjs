/** @type {import('next').NextConfig} */
const nextConfig = {
  // pdfjs-dist se usa solo en una Route Handler (servidor). Lo excluimos del
  // empaquetado de Next para que Node lo cargue directo con require() y no
  // haya conflictos con su archivo interno de "worker".
  serverExternalPackages: ["pdfjs-dist"],
  webpack: (config) => {
    // pdfjs-dist intenta cargar 'canvas' como polyfill opcional (solo se usa
    // para renderizar PDFs a imagen, algo que no hacemos acá). Sin esto,
    // el build falla buscando un módulo que no está instalado.
    config.resolve.alias.canvas = false;
    return config;
  },
};

export default nextConfig;
