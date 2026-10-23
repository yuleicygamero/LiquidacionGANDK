import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base`: en local se sirve en la raíz; en el servidor cuelga de una subruta
// (gandkcontrol.com/liquidacion/), que se indica al construir:
//   BASE_PATH=/liquidacion/ npm run build
// Vite la inyecta en index.html y en import.meta.env.BASE_URL, de donde la lee
// api.js para que las llamadas no se escapen a la raíz del dominio — donde
// vive otra aplicación con su propio /api.
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3001' },
  },
});
