/**
 * Typst Compiler Web Worker (Protocol 80 - Standardized)
 * * 架构说明：
 * - 严格遵循 Actor Model，仅通过 Bridge Protocol 通信
 * - 实现 Zero-Copy 传输
 * - 具备自我健康检查与汇报机制
 */

import {
  createTypstCompiler,
  type TypstCompiler,
} from '@myriaddreamin/typst.ts/compiler'
import type {
  WorkerToMainMessage,
  MainToWorkerMessage,
  DiagnosticInfo,
  WorkerHealthMetrics,
} from '../types/bridge.d'

// ============================================================================
// Worker State & Constants
// ============================================================================

let compiler: TypstCompiler | null = null
let isInitializing = false

/** 性能监控 */
const perfStats = {
  startTime: Date.now(),
  compileCount: 0,
  lastDuration: 0,
}

// ============================================================================
// Helper Functions
// ============================================================================

/** * 统一消息发送网关 
 * 自动处理 Zero-Copy 逻辑
 */
function postBridgeMessage(message: WorkerToMainMessage, transfer?: Transferable[]) {
  if (transfer && transfer.length > 0) {
    (self as any).postMessage(message, transfer)
  } else {
    self.postMessage(message)
  }
}

/** 获取 WASM 路径 */
function getWasmModuleUrl(): string {
  return new URL(
    '@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm',
    import.meta.url
  ).href
}

/** 简单的页数估算 */
function estimatePageCount(size: number): number {
  return Math.max(1, Math.ceil(size / (50 * 1024)))
}

// ============================================================================
// Core Logic
// ============================================================================

async function initCompiler() {
  if (compiler || isInitializing) return

  isInitializing = true
  try {
    compiler = createTypstCompiler()
    await compiler.init({
      beforeBuild: [],
      getModule: () => getWasmModuleUrl(),
    })
    isInitializing = false
    postBridgeMessage({ kind: 'READY' })
  } catch (e) {
    isInitializing = false
    console.error('[Worker] Init failed', e)
    // 初始化失败通常是致命的，直接 Panic 让 Supervisor 重启
    throw e
  }
}

/**
 * Extract outline data (headings + figures) and send to main thread
 * Uses legacy protocol for OutlinePanel compatibility
 */
async function extractAndSendOutline(requestId: string, mainFilePath: string) {
  if (!compiler) return

  try {
    // Query headings
    const headingsRaw = await compiler.query({ selector: 'heading', mainFilePath }) as unknown[]
    const headings = (headingsRaw || []).map((h: any) => ({
      level: h.level ?? 1,
      body: extractTextContent(h.body),
      page: h.location?.page ?? 1,
      y: h.location?.position?.y ?? 0,
    }))

    // Query figures
    const figuresRaw = await compiler.query({ selector: 'figure', mainFilePath }) as unknown[]
    const figures = (figuresRaw || []).map((f: any, idx: number) => ({
      kind: f.kind ?? 'image',
      caption: extractTextContent(f.caption?.body),
      number: idx + 1,
      page: f.location?.page ?? 1,
      y: f.location?.position?.y ?? 0,
    }))

    // Estimate page count from max page in headings/figures
    const maxPage = Math.max(
      1,
      ...headings.map((h: { page: number }) => h.page),
      ...figures.map((f: { page: number }) => f.page)
    )

    // Send outline_result using legacy protocol (type instead of kind)
    self.postMessage({
      type: 'outline_result',
      id: requestId,
      payload: {
        headings,
        figures,
        pageCount: maxPage,
      }
    })
  } catch (err) {
    console.warn('[Worker] Outline query failed:', err)
  }
}

/**
 * Extract plain text from Typst content
 */
function extractTextContent(content: unknown): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (typeof content === 'object' && content !== null) {
    // Handle content objects with text property
    if ('text' in content) return String((content as { text: unknown }).text)
    // Handle arrays of content
    if (Array.isArray(content)) {
      return content.map(extractTextContent).join('')
    }
  }
  return String(content)
}

async function runCompile(
  requestId: string,
  action: 'full' | 'incremental',
  payload: { source: string; mainFilePath: string; path?: string; content?: string; format?: 'vector' | 'pdf' }
) {
  if (!compiler) {
    throw new Error('Compiler not initialized')
  }

  const start = performance.now()
  let result: any

  try {
    if (action === 'full') {
      compiler.resetShadow()
      compiler.addSource(payload.mainFilePath, payload.source)
      result = await compiler.compile({
        mainFilePath: payload.mainFilePath,
        format: payload.format === 'pdf' ? 1 : 0,
        diagnostics: 'full',
      })
    } else {
      // 增量更新
      if (payload.path && payload.content) {
        compiler.addSource(payload.path, payload.content)
      }
      result = await compiler.compile({
        mainFilePath: payload.mainFilePath, // 增量编译也需要指定入口
        format: 0, // 增量通常只用于预览(vector)
        diagnostics: 'full',
      })
    }

    const duration = performance.now() - start
    perfStats.compileCount++
    perfStats.lastDuration = duration

    const diagnostics = (result.diagnostics ?? []) as DiagnosticInfo[]
    const artifact = result.result as Uint8Array | null

    if (artifact) {
      // ✅ Happy Path: Zero-Copy Transfer
      postBridgeMessage({
        kind: 'COMPILE_SUCCESS',
        requestId,
        artifact,
        timing: duration,
        diagnostics
      }, [artifact.buffer])

      // 异步上报健康数据，不阻塞主流程
      reportHealth(artifact.byteLength)

      // 🔍 Extract and send outline data (legacy protocol for OutlinePanel compatibility)
      try {
        await extractAndSendOutline(requestId, payload.mainFilePath)
      } catch (outlineErr) {
        console.warn('[Worker] Failed to extract outline:', outlineErr)
      }
    } else {
      // 编译逻辑错误（如语法错误），非 Worker 崩溃
      postBridgeMessage({
        kind: 'COMPILE_ERROR',
        requestId,
        error: 'Compilation produced no output',
        diagnostics
      })
    }

  } catch (err) {
    console.error('[Worker] Compile Exception:', err)
    postBridgeMessage({
      kind: 'COMPILE_ERROR',
      requestId,
      error: err instanceof Error ? err.message : String(err),
      diagnostics: []
    })
  }
}

function reportHealth(lastArtifactSize: number) {
  const metrics: WorkerHealthMetrics = {
    memoryUsage: (performance as any).memory?.usedJSHeapSize ?? 0,
    uptime: Date.now() - perfStats.startTime,
    compileCount: perfStats.compileCount,
    averageCompileTime: perfStats.lastDuration, // 简化处理
    lastArtifactSize,
    estimatedPages: estimatePageCount(lastArtifactSize)
  }

  // TODO: 通过 'HEALTH_REPORT' 消息发送到主线程
  // 目前 Protocol 80 尚未定义该消息，保留数据供未来使用
  void metrics
}

function dispose() {
  if (compiler && (compiler as any).dispose) {
    (compiler as any).dispose()
  }
  compiler = null
}

// ============================================================================
// Message Loop
// ============================================================================

self.onmessage = (event: MessageEvent<MainToWorkerMessage>) => {
  const msg = event.data

  // 严格根据 kind 分发
  // 注意：这里假设 MainToWorkerMessage 已经统一为 { kind: ... } 格式
  // 如果你的类型定义还没更新，这里需要做适配

  // 兼容层：将旧协议映射到新逻辑 (Deep Clean 过渡期保险措施)
  const type = (msg as any).type
  const kind = (msg as any).kind

  if (kind === 'HEARTBEAT') {
    postBridgeMessage({
      kind: 'HEARTBEAT_ACK',
      timestamp: (msg as any).timestamp
    })
    return
  }

  if (type === 'init' || kind === 'INIT') {
    initCompiler().catch(reportPanic)
    return
  }

  if (type === 'compile' || kind === 'COMPILE') {
    const payload = (msg as any).payload || msg
    runCompile((msg as any).id || (msg as any).requestId, 'full', payload).catch(reportPanic)
    return
  }

  // 暂时不支持 incremental_update 的旧协议映射，强制要求新代码使用标准调用

  if (kind === 'DISPOSE') {
    dispose()
    return
  }
}

// ============================================================================
// Safety Nets
// ============================================================================

function reportPanic(err: any) {
  console.error('[Worker PANIC]', err)
  postBridgeMessage({
    kind: 'PANIC',
    reason: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined
  })
}

self.onerror = (e) => {
  reportPanic(e)
  return true // Prevent default handling
}

self.onunhandledrejection = (e) => {
  reportPanic(e.reason)
}

// 启动时发送 Ready (如果不需要显式 Init)
// 但我们的协议要求显式 Init，所以这里保持静默，等待主线程握手