import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

export default defineConfig({
    plugins: [
        wasm(),
        topLevelAwait(),
        react()
    ],

    build: {
        target: 'esnext',
    },

    optimizeDeps: {
        exclude: [
            '@myriaddreamin/typst.ts',
            '@myriaddreamin/typst-ts-web-compiler',
            '@myriaddreamin/typst-ts-renderer'
        ]
    },

    worker: {
        format: 'es',
        plugins: () => [
            wasm(),
            topLevelAwait(),
        ],
    },

    server: {
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp'
        }
    },

    preview: {
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp'
        }
    }
})
