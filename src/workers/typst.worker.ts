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
 * 
 * Typst query results can have various structures:
 * - Direct string: "Hello"
 * - Text object: { text: "Hello" }
 * - Body wrapper: { body: ... }
 * - Children array: { children: [...] }
 * - Sequence: { func: "sequence", children: [...] }
 * - Content array: [...]
 */
function extractTextContent(content: unknown): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (typeof content === 'number') return String(content)

  if (typeof content === 'object' && content !== null) {
    const obj = content as Record<string, unknown>

    // Try common text fields
    if ('text' in obj && typeof obj.text === 'string') {
      return obj.text
    }

    // Try body field (common in heading results)
    if ('body' in obj) {
      return extractTextContent(obj.body)
    }

    // Try children array (Typst sequence)
    if ('children' in obj && Array.isArray(obj.children)) {
      return obj.children.map(extractTextContent).join('')
    }

    // Try content field
    if ('content' in obj) {
      return extractTextContent(obj.content)
    }

    // Try value field
    if ('value' in obj) {
      return extractTextContent(obj.value)
    }

    // Handle arrays
    if (Array.isArray(content)) {
      return content.map(extractTextContent).join('')
    }

    // Last resort: try to get any string-like property
    const stringValue = Object.values(obj).find(v => typeof v === 'string')
    if (stringValue) return stringValue as string

    // If nothing worked, try to extract from nested objects
    for (const value of Object.values(obj)) {
      if (typeof value === 'object' && value !== null) {
        const extracted = extractTextContent(value)
        if (extracted) return extracted
      }
    }
  }

  // Fallback - don't return [object Object]
  return ''
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

// Note: Outline extraction temporarily disabled to fix stability issues

/**
 * Compile Typst source code
 * 
 * STABILITY FIX: Using direct compile() API instead of runWithWorld
 * which was causing crashes on large documents (50+ pages).
 * 
 * Outline extraction is temporarily disabled and will send empty data.
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

    // Use direct compile() API for stability
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

      // Send empty outline for now (query disabled for stability)
      // TODO: Re-enable outline extraction in Phase 2 with proper memory management
      postMessage({
        kind: 'OUTLINE_RESULT',
        requestId,
        payload: {
          headings: [],
          figures: [],
          pageCount: estimatePageCount(artifact.byteLength),
        },
      })
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
