/**
 * Typst Compiler Web Worker (Protocol v2.1 - Fixed)
 * 
 * Fixes applied:
 * 1. Corrected Probe Selector to '<monolith-probe>'
 * 2. Removed redundant resetShadow() calls that wiped compilation state
 * 3. Proper font loading via loadFonts API (not addSource)
 */

import {
  createTypstCompiler,
  type TypstCompiler,
} from '@myriaddreamin/typst.ts/compiler'
import { loadFonts } from '@myriaddreamin/typst.ts'

import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  DiagnosticInfo,
  Probe,
  ProbeData,
} from '../types/bridge.d'

import { postWorkerResponse } from '../types/bridge.d'

// ============================================================================
// Worker State
// ============================================================================

let compiler: TypstCompiler | null = null
let isInitializing = false

const perfStats = {
  startTime: Date.now(),
  compileCount: 0,
  lastDuration: 0,
}

// ============================================================================
// Helper Functions
// ============================================================================

function postMessage(message: WorkerToMainMessage, transfer?: Transferable[]): void {
  postWorkerResponse(message, transfer)
}

function getWasmModuleUrl(): string {
  return new URL(
    '@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm',
    import.meta.url
  ).href
}

function estimatePageCount(size: number): number {
  return Math.max(1, Math.ceil(size / (50 * 1024)))
}

// ============================================================================
// Core Logic
// ============================================================================

/**
 * Initialize the Typst compiler and load fonts
 */
async function initCompiler(): Promise<void> {
  if (compiler || isInitializing) return

  isInitializing = true
  try {
    console.log('[Worker] Initializing Typst compiler...')

    // 1. Fetch fonts first (before compiler init)
    const fontUrls = [
      '/fonts/LinLibertine_R.ttf',
      '/fonts/NotoSerifSC-Regular.ttf', // Use .ttf extension
    ]

    console.log('[Worker] Fetching fonts...')
    const fontBuffers: Uint8Array[] = []

    for (const url of fontUrls) {
      try {
        const response = await fetch(url)
        if (!response.ok) {
          console.warn(`[Worker] Font not found: ${url}`)
          continue
        }
        const buffer = await response.arrayBuffer()
        fontBuffers.push(new Uint8Array(buffer))
        console.log(`[Worker] Loaded font: ${url} (${(buffer.byteLength / 1024).toFixed(1)}KB)`)
      } catch (e) {
        console.warn(`[Worker] Failed to load font ${url}:`, e)
      }
    }

    // 2. Create compiler with fonts loaded via beforeBuild
    compiler = createTypstCompiler()

    await compiler.init({
      beforeBuild: [
        // Load local fonts + text assets from CDN (includes math fonts)
        loadFonts(fontBuffers, {
          assets: ['text'], // Load LibertinusSerif + NewCM math from CDN
        }),
      ],
      getModule: () => ({ module_or_path: getWasmModuleUrl() } as any),
    })

    isInitializing = false
    console.log('[Worker] Ready with fonts!')
    postMessage({ kind: 'READY' })

  } catch (e) {
    isInitializing = false
    console.error('[Worker] Init failed', e)
    // Report panic to main thread
    postMessage({
      kind: 'PANIC',
      reason: e instanceof Error ? e.message : String(e),
    })
    throw e
  }
}

// Note: Probe extraction is now done inline within the runWithWorld callback
// in runCompile() to ensure we query from the same compiled world context.


/**
 * Compile Typst source code
 */
async function runCompile(
  requestId: string,
  payload: {
    source: string
    mainFilePath: string
    format?: 'vector' | 'pdf'
  }
): Promise<void> {
  if (!compiler) throw new Error('Compiler not initialized')

  const start = performance.now()

  try {
    // 1. Update Virtual File System
    compiler.addSource(payload.mainFilePath, payload.source)

    // [FIX] Use runWithWorld to compile AND query in the same world context.
    // This ensures the compiled document is available for probe querying.
    const result = await compiler.runWithWorld({ mainFilePath: payload.mainFilePath }, async (world) => {
      // 1. Compile the document in this world
      const compileResult = await world.compile({ diagnostics: 'full' })

      if (compileResult.hasError) {
        return {
          success: false,
          diagnostics: compileResult.diagnostics ?? [],
          artifact: null,
          probes: [],
        }
      }

      // 2. Query probes from the SAME compiled world
      let probes: Probe[] = []
      try {
        const rawResults = await world.query({ selector: '<monolith-probe>' }) as Array<{ value?: unknown }>
        for (const r of rawResults) {
          if (r && typeof r === 'object' && 'value' in r) {
            const value = r.value as Probe
            if (value && typeof value === 'object' && 'kind' in value) {
              probes.push(value)
            }
          }
        }
        console.log(`[Worker] Extracted ${probes.length} probes from compiled world`)
      } catch (e) {
        console.warn('[Worker] Probe query failed:', e)
      }

      // 3. Export artifact from the compiled world
      const vectorResult = await world.vector({ diagnostics: 'full' })

      return {
        success: true,
        diagnostics: vectorResult.diagnostics ?? [],
        artifact: vectorResult.result as Uint8Array | null,
        probes,
      }
    })

    const duration = performance.now() - start
    perfStats.compileCount++
    perfStats.lastDuration = duration

    if (result.success && result.artifact) {
      const pageCount = estimatePageCount(result.artifact.byteLength)

      // Send Success Response (Zero-Copy for artifact)
      postMessage(
        {
          kind: 'COMPILE_SUCCESS',
          requestId,
          artifact: result.artifact,
          timing: duration,
          diagnostics: result.diagnostics as DiagnosticInfo[],
        },
        [result.artifact.buffer]
      )

      // Send Probe Data
      postMessage({
        kind: 'PROBE_RESULT',
        requestId,
        payload: {
          version: '1.0.0',
          count: result.probes.length,
          probes: result.probes,
          pageCount,
        } satisfies ProbeData,
      })

    } else {
      postMessage({
        kind: 'COMPILE_ERROR',
        requestId,
        error: 'Compilation produced no output',
        diagnostics: result.diagnostics as DiagnosticInfo[],
      })
    }
  } catch (err) {
    console.error('[Worker] Compile Exception:', err)
    postMessage({
      kind: 'COMPILE_ERROR',
      requestId,
      error: err instanceof Error ? err.message : String(err),
      diagnostics: [],
    })
  }
}

// ============================================================================
// Message Loop
// ============================================================================

function reportPanic(err: unknown): void {
  console.error('[Worker PANIC]', err)
  postMessage({
    kind: 'PANIC',
    reason: err instanceof Error ? err.message : String(err),
  })
}

self.onmessage = (event: MessageEvent<MainToWorkerMessage>) => {
  const msg = event.data

  switch (msg.kind) {
    case 'INIT':
      initCompiler().catch(reportPanic)
      return

    case 'COMPILE':
      runCompile(msg.requestId, {
        source: msg.source,
        mainFilePath: msg.mainFilePath ?? '/main.typ',
        format: msg.format,
      }).catch(reportPanic)
      return

    case 'HEARTBEAT':
      postMessage({ kind: 'HEARTBEAT_ACK', timestamp: msg.timestamp })
      return

    case 'RESET':
      if (compiler) compiler.resetShadow()
      postMessage({ kind: 'RESET_SUCCESS', requestId: msg.requestId })
      return

    case 'DISPOSE':
      if (compiler) {
        try { (compiler as unknown as { dispose?: () => void }).dispose?.() } catch { /* ignore */ }
      }
      compiler = null
      return

    default:
      console.warn('[Worker] Unknown message kind:', (msg as { kind: string }).kind)
      break
  }
}

// ============================================================================
// Global Error Handlers
// ============================================================================

self.onerror = (e) => {
  reportPanic(e)
  return true
}

self.onunhandledrejection = (e: PromiseRejectionEvent) => {
  reportPanic(e.reason)
}