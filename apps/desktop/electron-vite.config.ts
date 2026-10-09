import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { readFileSync } from 'fs'

export default defineConfig({
  main: {
    // Inline the 26 KB local font because notification windows use data URLs and
    // the package deliberately excludes node_modules.
    define: {
      __FLASH_ANTONIO_DATA__: JSON.stringify('data:font/woff2;base64,' + readFileSync(
        resolve(__dirname, 'node_modules/@fontsource-variable/antonio/files/antonio-latin-wght-normal.woff2')).toString('base64')),
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/main.ts'),
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/preload.ts'),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    // The design hook rewrites .impeccable/hook.cache.json on every run, and
    // the watcher was treating that as a source change and reloading the whole
    // window mid-use. It is a cache, not source.
    server: {
      watch: {
        ignored: ['**/.impeccable/**', '**/release/**', '**/out/**'],
      },
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer'),
      },
    },
  },
})
