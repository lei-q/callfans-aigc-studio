import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.AIGC_SERVER || 'http://127.0.0.1:5780';
const proxy = Object.fromEntries(['/api', '/files', '/openapi'].map((p) => [p, { target, changeOrigin: false }]));

export default defineConfig({
  plugins: [react()],
  base: '/',
  server: { port: 5173, strictPort: false, proxy },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1200 },
});
