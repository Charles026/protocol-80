/**
 * Typst Compiler Web Worker (Protocol v2.0 - Unified)
 * 
 * Architecture:
 * - Strict Actor Model: communicates only via Bridge Protocol
 * - Zero-Copy transfer for binary artifacts
 * - Self-health monitoring with panic recovery
 * - Type-safe exhaustiveness checking
 * 
 * @module typst.worker
 */

import {
  createTypstCompiler,
  type TypstCompiler,
} from '@myriaddreamin/typst.ts/compiler'

import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  DiagnosticInfo,
  OutlineHeading,
  OutlineFigure,
  WorkerHealthMetrics,
} from '../types/bridge.d'

import { assertNever, postWorkerResponse } from '../types/bridge.d'

import type {
  TypstHeadingQueryResult,
  TypstFigureQueryResult,
} from './types'

// ============================================================================
// Worker State & Constants
// ============================================================================

let compiler: TypstCompiler | null = null
let isInitializing = false

/** Performance monitoring stats */
const perfStats = {
  startTime: Date.now(),
  compileCount: 0,
  lastDuration: 0,
}

// ============================================================================
// Type-Safe Message Posting
// ============================================================================

/**
 * Post a message to the main thread with optional transferables
 * Uses the unified protocol from bridge.d.ts
 */
function postMessage(message: WorkerToMainMessage, transfer?: Transferable[]): void {
  postWorkerResponse(message, transfer)
}

// ============================================================================
// Helper Functions
// ============================================================================

/** Get WASM module URL */
function getWasmModuleUrl(): string {
  return new URL(
    '@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm',
    import.meta.url
  ).href
}

/** Estimate page count from artifact size */
function estimatePageCount(size: number): number {
  return Math.max(1, Math.ceil(size / (50 * 1024)))
}

/**
 * Extract plain text from Typst content (recursive)
 */
function extractTextContent(content: unknown): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (typeof content === 'object' && content !== null) {
    if ('text' in content) return String((content as { text: unknown }).text)
    if (Array.isArray(content)) {
      return content.map(extractTextContent).join('')
    }
  }
  return String(content)
}

// ============================================================================
// Core Logic
// ============================================================================

/**
 * Initialize the Typst compiler
 */
async function initCompiler(): Promise<void> {
  if (compiler || isInitializing) return

  isInitializing = true
  try {
    compiler = createTypstCompiler()
    await compiler.init({
      beforeBuild: [],
      getModule: () => getWasmModuleUrl(),
    })
    isInitializing = false
    postMessage({ kind: 'READY' })
  } catch (e) {
    isInitializing = false
    console.error('[Worker] Init failed', e)
    // Fatal error - report panic and let Supervisor restart
    throw e
  }
}

/**
 * Extract outline data and send to main thread using unified protocol
 */
async function extractAndSendOutline(requestId: string, mainFilePath: string): Promise<void> {
  if (!compiler) return

  try {
    // Query headings with type-safe casting
    const headingsRaw = await compiler.query({ 
      selector: 'heading', 
      mainFilePath 
    }) as TypstHeadingQueryResult[]

    const headings: OutlineHeading[] = (headingsRaw ?? []).map((h) => ({
      level: h.level ?? 1,
      body: extractTextContent(h.body),
      page: h.location?.page ?? 1,
      y: h.location?.position?.y ?? 0,
    }))

    // Query figures with type-safe casting
    const figuresRaw = await compiler.query({ 
      selector: 'figure', 
      mainFilePath 
    }) as TypstFigureQueryResult[]

    const figures: OutlineFigure[] = (figuresRaw ?? []).map((f, idx) => ({
      kind: f.kind ?? 'image',
      caption: extractTextContent(f.caption?.body),
      number: idx + 1,
      page: f.location?.page ?? 1,
      y: f.location?.position?.y ?? 0,
    }))

    // Estimate page count from max page in headings/figures
    const maxPage = Math.max(
      1,
      ...headings.map((h) => h.page),
      ...figures.map((f) => f.page)
    )

    // Send outline using unified protocol (kind discriminator)
    postMessage({
      kind: 'OUTLINE_RESULT',
      requestId,
      payload: {
        headings,
        figures,
        pageCount: maxPage,
      },
    })
  } catch (err) {
    console.warn('[Worker] Outline query failed:', err)
  }
}

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
  if (!compiler) {
    throw new Error('Compiler not initialized')
  }

  const start = performance.now()

  try {
    compiler.resetShadow()
    compiler.addSource(payload.mainFilePath, payload.source)
    
    const result = await compiler.compile({
      mainFilePath: payload.mainFilePath,
      format: payload.format === 'pdf' ? 1 : 0,
      diagnostics: 'full',
    })

    const duration = performance.now() - start
    perfStats.compileCount++
    perfStats.lastDuration = duration

    const diagnostics = (result.diagnostics ?? []) as DiagnosticInfo[]
    const artifact = result.result as Uint8Array | null

    if (artifact) {
      // ✅ Happy Path: Zero-Copy Transfer
      postMessage(
        {
          kind: 'COMPILE_SUCCESS',
          requestId,
          artifact,
          timing: duration,
          diagnostics,
        },
        [artifact.buffer] // Transfer ownership for zero-copy
      )

      // Async health report (non-blocking)
      reportHealth(artifact.byteLength)

      // Extract and send outline data
      try {
        await extractAndSendOutline(requestId, payload.mainFilePath)
      } catch (outlineErr) {
        console.warn('[Worker] Failed to extract outline:', outlineErr)
      }
    } else {
      // Compilation logic error (e.g., syntax error), not a Worker crash
      postMessage({
        kind: 'COMPILE_ERROR',
        requestId,
        error: 'Compilation produced no output',
        diagnostics,
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

/**
 * Reset compiler state
 */
function handleReset(requestId: string): void {
  if (compiler) {
    compiler.resetShadow()
  }
  postMessage({
    kind: 'RESET_SUCCESS',
    requestId,
  })
}

/**
 * Report health metrics (for future use)
 */
function reportHealth(lastArtifactSize: number): void {
  const metrics: WorkerHealthMetrics = {
    memoryUsage: getMemoryUsage(),
    uptime: Date.now() - perfStats.startTime,
    compileCount: perfStats.compileCount,
    averageCompileTime: perfStats.lastDuration,
    lastArtifactSize,
    estimatedPages: estimatePageCount(lastArtifactSize),
  }

  // TODO: Send via 'HEALTH_REPORT' message when protocol supports it
  void metrics
}

/**
 * Get memory usage (Chrome-specific API)
 */
function getMemoryUsage(): number {
  // Chrome-specific API
  const perf = performance as Performance & { 
    memory?: { usedJSHeapSize?: number } 
  }
  return perf.memory?.usedJSHeapSize ?? 0
}

/**
 * Dispose compiler and free WASM memory
 */
function dispose(): void {
  if (compiler) {
    // Type-safe dispose check
    const disposableCompiler = compiler as TypstCompiler & { 
      dispose?: () => void 
    }
    if (typeof disposableCompiler.dispose === 'function') {
      disposableCompiler.dispose()
    }
  }
  compiler = null
}

// ============================================================================
// Message Loop with Exhaustiveness Checking
// ============================================================================

self.onmessage = (event: MessageEvent<MainToWorkerMessage>) => {
  const msg = event.data

  // Strict switch with exhaustiveness check
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
      postMessage({
        kind: 'HEARTBEAT_ACK',
        timestamp: msg.timestamp,
      })
      return

    case 'RESET':
      handleReset(msg.requestId)
      return

    case 'DISPOSE':
      dispose()
      return

    default:
      // Exhaustiveness check - TypeScript will error if we miss a case
      assertNever(msg, `[Worker] Unknown message kind: ${(msg as { kind: string }).kind}`)
  }
}

// ============================================================================
// Safety Nets
// ============================================================================

/**
 * Report panic to main thread
 */
function reportPanic(err: unknown): void {
  console.error('[Worker PANIC]', err)
  postMessage({
    kind: 'PANIC',
    reason: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  })
}

self.onerror = (e) => {
  reportPanic(e)
  return true // Prevent default handling
}

self.onunhandledrejection = (e: PromiseRejectionEvent) => {
  reportPanic(e.reason)
}

// Worker is silent until explicit INIT message from main thread
