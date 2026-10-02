import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
    // Faltaba esta carpeta: por eso las clases usadas SOLO en un componente
    // de components/ (como el botón del ojito de password-input.tsx) no se
    // generaban y no tenían ningún efecto visual.
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
