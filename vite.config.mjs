import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(['/api', '/v1', '/oauth', '/mcp'].map(prefix => [prefix, 'http://127.0.0.1:4317'])),
  },
  build: { outDir: 'dist' },
});
