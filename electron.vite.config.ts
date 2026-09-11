import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    // node-pty 为原生模块必须外置（运行时 require），include 限定只外置它一个，
    // 不影响其余依赖的打包行为
    plugins: [externalizeDepsPlugin({ include: ['node-pty'] })],
    build: {
      lib: { entry: resolve(__dirname, 'electron/main.ts') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ include: ['node-pty'] })],
    build: {
      lib: { entry: resolve(__dirname, 'electron/preload.ts') }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/index.html') }
    },
    resolve: {
      alias: { '@': resolve(__dirname, 'src') }
    },
    plugins: [react()]
  }
})
