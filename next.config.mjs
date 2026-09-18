/** @type {import('next').NextConfig} */
const nextConfig = {
  // pdf-parse se usa solo en una Route Handler (servidor). Lo excluimos del
  // empaquetado de Next para que Node lo cargue directo con require() — así
  // evitamos que Webpack reescriba sus rutas internas y rompa el parseo
  // (esto es justamente lo que causaba el error de "fake worker" antes,
  // cuando usábamos pdfjs-dist directamente).
  serverExternalPackages: ["pdf-parse"],
  webpack: (config) => {
    // La librería de PDF que usamos por debajo intenta cargar 'canvas' como
    // polyfill opcional (solo se usa para renderizar PDFs a imagen, algo que
    // no hacemos acá). Sin esto, el build falla buscando un módulo que no
    // está instalado.
    config.resolve.alias.canvas = false;
    return config;
  },
};

export default nextConfig;
