import { defineConfig } from 'vite'
export default defineConfig({
  preview: { port: 4174, strictPort: true, proxy: { '/api': 'http://localhost:3790', '/collab': { target: 'ws://localhost:3790', ws: true } } },
})
