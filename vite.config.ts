import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  server: { port: 5180 },
  resolve: { dedupe: ['three'] },
  optimizeDeps: { include: ['three', 'three/examples/jsm/loaders/GLTFLoader.js'] },
})
