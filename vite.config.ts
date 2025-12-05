import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // WASM 支持必须在 React 插件之前注册
    wasm(),
    topLevelAwait(),
    react()
  ],

  build: {
    // ESNext 目标以支持 WASM ES 模块和 top-level await
    target: 'esnext',
  },

  optimizeDeps: {
    // 排除 Typst WASM 相关包，防止 Vite 预构建导致路径错误
    exclude: [
      '@myriaddreamin/typst.ts',
      '@myriaddreamin/typst.react',
      '@myriaddreamin/typst-ts-web-compiler',
      '@myriaddreamin/typst-ts-renderer'
    ]
  },

  worker: {
    // Worker 构建配置
    format: 'es',
    plugins: () => [
      wasm(),
      topLevelAwait(),
    ],
  },

  server: {
    // 开发服务器配置
    headers: {
      // WASM 需要正确的 MIME 类型
      // SharedArrayBuffer 需要跨域隔离（Web Workers 通信）
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  },

  preview: {
    // 预览服务器也需要相同的 CORS 头
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  }
})
