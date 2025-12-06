/**
 * Typst Compiler Web Worker
 * 
 * 设计原则：
 * 1. 完全封装编译器核心，主线程零阻塞
 * 2. 使用 IncrementalServer 模式支持增量编译
 * 3. 按需加载字体，通过消息协议请求主线程获取字体数据
 * 4. 严格的生命周期管理，防止内存泄漏
 * 
 * 架构说明：
 * - Worker 持有 TypstCompiler 单例
 * - 所有编译操作在 Worker 线程执行
 * - 字体加载通过 postMessage 协议与主线程协作
 */

import {
  createTypstCompiler,
  type TypstCompiler,
} from '@myriaddreamin/typst.ts/compiler'
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  DiagnosticMessage,
  FontResponse,
  CompilerState,
  IntrospectionData,
  OutlineData,
  OutlineHeading,
  OutlineFigure,
} from './types'

// ============================================================================
// Worker State
// ============================================================================

let compiler: TypstCompiler | null = null
let compilerState: CompilerState = 'uninitialized'

/**
 * 待处理的字体请求
 * key: family name
 * value: Promise resolve 函数
 */
const pendingFontRequests = new Map<string, {
  resolve: (buffer: ArrayBuffer | null) => void
  reject: (error: Error) => void
}>()

/**
 * 已加载的字体缓存（避免重复请求）
 */
const loadedFonts = new Set<string>()

// ============================================================================
// Message Utilities
// ============================================================================

/**
 * 发送消息到主线程
 */
function postResponse(message: WorkerToMainMessage, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    // Worker context uses different postMessage signature
    (self as unknown as { postMessage: (msg: unknown, transfer: Transferable[]) => void })
      .postMessage(message, transfer)
  } else {
    self.postMessage(message)
  }
}

/**
 * 生成唯一 ID
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

// ============================================================================
// Font Loading Protocol
// ============================================================================

/**
 * 请求主线程加载字体
 * 
 * @param family - 字体家族名称
 * @returns 字体数据 ArrayBuffer，如果加载失败返回 null
 * 
 * @remarks
 * 此函数用于按需字体加载功能。当 Typst 编译器需要特定字体时，
 * 通过此函数向主线程发送请求，由 FontService 实际加载字体数据。
 * 
 * @internal 保留供未来字体回调机制使用
 */
export async function requestFont(family: string): Promise<ArrayBuffer | null> {
  // 检查是否已加载
  if (loadedFonts.has(family)) {
    return null // 已加载，无需重复加载
  }

  // 检查是否有待处理的请求
  const pending = pendingFontRequests.get(family)
  if (pending) {
    // 复用已有请求
    return new Promise((resolve, reject) => {
      const existingResolve = pending.resolve
      const existingReject = pending.reject
      pending.resolve = (buffer) => {
        existingResolve(buffer)
        resolve(buffer)
      }
      pending.reject = (error) => {
        existingReject(error)
        reject(error)
      }
    })
  }

  // 创建新请求
  return new Promise((resolve, reject) => {
    const requestId = generateId()
    
    pendingFontRequests.set(family, { resolve, reject })

    // 向主线程请求字体
    postResponse({
      type: 'font_request',
      id: requestId,
      payload: { family },
    })

    // 设置超时（30秒）
    setTimeout(() => {
      const pending = pendingFontRequests.get(family)
      if (pending) {
        pendingFontRequests.delete(family)
        pending.reject(new Error(`Font request timeout: ${family}`))
      }
    }, 30000)
  })
}

/**
 * 处理来自主线程的字体响应
 */
function handleFontResponse(response: FontResponse): void {
  const pending = pendingFontRequests.get(response.family)
  
  if (!pending) {
    console.warn(`[Worker] Unexpected font response for: ${response.family}`)
    return
  }

  pendingFontRequests.delete(response.family)

  if (response.error) {
    pending.reject(new Error(response.error))
  } else if (response.buffer) {
    loadedFonts.add(response.family)
    pending.resolve(response.buffer)
  } else {
    pending.resolve(null)
  }
}

// ============================================================================
// Compiler Lifecycle
// ============================================================================

/**
 * 获取 WASM 模块 URL
 */
function getWasmModuleUrl(): string {
  // Worker 中使用 import.meta.url 获取正确的基础路径
  return new URL(
    '@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm',
    import.meta.url
  ).href
}

/**
 * 初始化编译器
 * 
 * 使用 IncrementalServer 模式：
 * - 不预加载所有字体
 * - 按需请求字体数据
 * - 支持增量更新
 */
async function initializeCompiler(): Promise<void> {
  if (compilerState === 'initializing') {
    throw new Error('Compiler is already initializing')
  }

  if (compilerState === 'ready' && compiler) {
    // 已初始化，直接返回
    return
  }

  compilerState = 'initializing'

  try {
    compiler = createTypstCompiler()

    await compiler.init({
      // 不预加载字体，使用按需加载
      beforeBuild: [],
      getModule: () => getWasmModuleUrl(),
    })

    compilerState = 'ready'
  } catch (error) {
    compilerState = 'uninitialized'
    compiler = null
    throw error
  }
}

/**
 * 重置编译器状态
 * 
 * 根据 typst.ts 文档：
 * "Resetting before using high-level compile/renderer APIs"
 * 在每次文档全量重载时调用，防止内存泄漏或状态污染
 */
async function resetCompiler(): Promise<void> {
  if (!compiler) {
    throw new Error('Compiler not initialized')
  }

  // 调用 reset() 清理内部状态
  await compiler.reset()
  
  // 清理 shadow 文件系统
  compiler.resetShadow()
}

/**
 * 销毁编译器，释放所有资源
 */
function disposeCompiler(): void {
  if (compiler) {
    // 尝试调用 dispose 方法（如果存在）
    if (typeof (compiler as unknown as { dispose?: () => void }).dispose === 'function') {
      (compiler as unknown as { dispose: () => void }).dispose()
    }
    compiler = null
  }
  
  compilerState = 'disposed'
  loadedFonts.clear()
  pendingFontRequests.clear()
}

// ============================================================================
// Introspection
// ============================================================================

/**
 * 内省功能开关
 * 
 * 当前禁用，因为 typst.ts 的 query API 在当前版本中不可直接使用。
 * query 需要在编译后的 snapshot 上调用，而不是直接在 compiler 上。
 * 
 * TODO: 待 typst.ts 提供更好的 query 支持后启用此功能
 */
const INTROSPECTION_ENABLED = false

/**
 * 内省选择器 - 用于查询文档中的追踪标记
 * 
 * 查询所有包含 kind: "pos" 的 metadata 元素
 * 这些元素由 introspection.typ 模块中的 trace-node 函数插入
 * 
 * @internal 保留供未来 query API 启用时使用
 */
// const INTROSPECTION_SELECTOR = 'metadata.where(value: (kind: "pos"))'

/**
 * 查询内省数据
 * 
 * 在编译成功后调用，查询文档中的所有追踪标记位置
 * 主动推送给主线程，减少点击时的延迟
 * 
 * @param _mainFilePath - 主文件路径（当前未使用）
 * @returns 内省数据，如果查询失败或禁用返回 null
 * 
 * @remarks
 * 当前实现已禁用，因为 typst.ts 的 query API 需要特殊处理：
 * 1. query 必须在编译后的 TypstCompileWorld/snapshot 上调用
 * 2. 当前 createTypstCompiler() 返回的 compiler 不直接暴露此功能
 * 3. 需要使用 compiler.snapshot() 获取编译结果后再 query
 * 
 * 未来实现方向：
 * - 使用 compiler.snapshot() 创建编译快照
 * - 在快照上调用 query()
 * - 或者在 Typst 源码中直接输出 JSON 格式的内省数据
 */
function queryIntrospection(_mainFilePath: string): IntrospectionData | null {
  // 功能当前禁用
  if (!INTROSPECTION_ENABLED) {
    return null
  }

  if (!compiler) {
    return null
  }

  // TODO: 实现正确的 query 调用
  // const snapshot = compiler.snapshot(null, mainFilePath, null)
  // const queryResult = snapshot.query(0, INTROSPECTION_SELECTOR)
  
  return null
}

/**
 * 根据标记 ID 推断元素类型
 */
function inferMarkerType(id: string): 'heading' | 'paragraph' | 'block' | 'inline' {
  // ID 格式: "L{line}-C{col}" 或带前缀如 "heading-L10-C1"
  if (id.includes('heading')) return 'heading'
  if (id.includes('para')) return 'paragraph'
  if (id.includes('block')) return 'block'
  return 'inline'
}

// 保留 inferMarkerType 用于未来使用
void inferMarkerType

/**
 * 发送内省数据到主线程
 * 
 * 在编译成功后立即调用，主动推送数据以减少后续点击延迟
 * 
 * @remarks 当前功能已禁用，等待 typst.ts query API 支持
 */
function pushIntrospectionData(_requestId: string, mainFilePath: string): void {
  if (!INTROSPECTION_ENABLED) {
    return
  }

  const introspection = queryIntrospection(mainFilePath)
  
  if (introspection && introspection.markers.length > 0) {
    postResponse({
      type: 'introspection_result',
      id: _requestId,
      payload: introspection,
    })
  }
}

// ============================================================================
// Outline Extraction
// ============================================================================

/**
 * 大纲提取功能开关
 */
const OUTLINE_ENABLED = true

/**
 * 上一次发送的大纲数据哈希（用于避免重复推送）
 */
let lastOutlineHash = ''

/**
 * 从 Typst 源码中提取标题
 * 
 * 支持的标题语法：
 * - `= Title` (level 1)
 * - `== Title` (level 2)
 * - 以此类推到 level 6
 * 
 * @param source - Typst 源码
 * @returns 标题列表
 */
function extractHeadings(source: string): OutlineHeading[] {
  const headings: OutlineHeading[] = []
  const lines = source.split('\n')
  
  // 简单的页面估算：假设每 60 行是一页（粗略估计）
  const LINES_PER_PAGE = 60
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    
    const trimmed = line.trim()
    
    // 匹配标题：以 = 开头，后跟空格和标题内容
    const match = trimmed.match(/^(={1,6})\s+(.+)$/)
    if (match && match[1] && match[2]) {
      const level = match[1].length
      const body = match[2].trim()
      const page = Math.floor(i / LINES_PER_PAGE) + 1
      
      // 估算 Y 位置（基于行号）
      const y = (i % LINES_PER_PAGE) * 12 // 假设每行 12pt
      
      headings.push({
        level,
        body,
        page,
        y,
      })
    }
  }
  
  return headings
}

/**
 * 从 Typst 源码中提取图表
 * 
 * 支持的语法：
 * - `#figure(...)` 
 * - `#figure(image(...), caption: [...])`
 * - `#figure(table(...), caption: [...])`
 * 
 * @param source - Typst 源码
 * @returns 图表列表
 */
function extractFigures(source: string): OutlineFigure[] {
  const figures: OutlineFigure[] = []
  const lines = source.split('\n')
  
  // 计数器
  const counters: Record<string, number> = {
    image: 0,
    table: 0,
    figure: 0,
  }
  
  const LINES_PER_PAGE = 60
  
  // 查找每个 figure 的位置
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    
    if (line.includes('#figure')) {
      // 尝试确定 figure 类型
      let kind = 'figure'
      if (line.includes('image(') || line.includes('image (')) {
        kind = 'image'
      } else if (line.includes('table(') || line.includes('table (')) {
        kind = 'table'
      } else if (line.includes('raw(') || line.includes('raw (')) {
        kind = 'raw'
      }
      
      // 增加计数
      counters[kind] = (counters[kind] || 0) + 1
      
      // 尝试提取 caption
      let caption = ''
      const captionMatch = line.match(/caption:\s*\[(.*?)\]/)
      if (captionMatch && captionMatch[1]) {
        caption = captionMatch[1]
      } else {
        // 可能 caption 在后续行
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const nextLine = lines[j]
          if (!nextLine) continue
          
          const captionInNextLine = nextLine.match(/caption:\s*\[(.*?)\]/)
          if (captionInNextLine && captionInNextLine[1]) {
            caption = captionInNextLine[1]
            break
          }
          // 如果遇到闭合括号，停止搜索
          if (nextLine.includes(')') && !nextLine.includes('#')) {
            break
          }
        }
      }
      
      const page = Math.floor(i / LINES_PER_PAGE) + 1
      const y = (i % LINES_PER_PAGE) * 12
      
      figures.push({
        kind,
        caption,
        number: counters[kind] ?? 0,
        page,
        y,
      })
    }
  }
  
  return figures
}

/**
 * 计算简单哈希
 */
function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return hash.toString(36)
}

/**
 * 从源码中提取大纲数据
 * 
 * @param source - Typst 源码
 * @returns 大纲数据
 */
function extractOutline(source: string): OutlineData {
  const headings = extractHeadings(source)
  const figures = extractFigures(source)
  
  // 估算页数（基于内容量）
  const lines = source.split('\n').length
  const pageCount = Math.max(1, Math.ceil(lines / 60))
  
  return {
    headings,
    figures,
    pageCount,
  }
}

/**
 * 发送大纲数据到主线程
 * 
 * @param requestId - 请求 ID
 * @param source - Typst 源码
 */
function pushOutlineData(requestId: string, source: string): void {
  if (!OUTLINE_ENABLED) {
    return
  }
  
  try {
    const outline = extractOutline(source)
    
    // 检查是否有变化（避免重复推送）
    const hash = simpleHash(JSON.stringify(outline))
    if (hash === lastOutlineHash) {
      return
    }
    lastOutlineHash = hash
    
    postResponse({
      type: 'outline_result',
      id: requestId,
      payload: outline,
    })
  } catch (error) {
    console.warn('[Worker] Failed to extract outline:', error)
  }
}

// ============================================================================
// Compilation
// ============================================================================

/**
 * 编译 Typst 源码
 * 
 * @param source - 源码内容
 * @param mainFilePath - 主文件路径
 * @param format - 输出格式（'vector' 用于 VectorAccess）
 */
async function compile(
  source: string,
  mainFilePath: string,
  format: 'vector' | 'pdf'
): Promise<{
  artifact: Uint8Array | null
  diagnostics: DiagnosticMessage[]
}> {
  if (!compiler || compilerState !== 'ready') {
    throw new Error('Compiler not ready')
  }

  compilerState = 'compiling'

  try {
    // 重置 shadow 文件系统，确保干净的编译环境
    compiler.resetShadow()

    // 添加源文件
    compiler.addSource(mainFilePath, source)

    // 编译选项 - 使用 VectorAccess 格式
    const compileFormat = format === 'pdf' ? 1 : 0 // 0 = vector, 1 = pdf

    const result = await compiler.compile({
      mainFilePath,
      format: compileFormat,
      diagnostics: 'full',
    })

    compilerState = 'ready'

    const diagnostics = (result.diagnostics ?? []) as DiagnosticMessage[]

    return {
      artifact: result.result ?? null,
      diagnostics,
    }
  } catch (error) {
    compilerState = 'ready'
    throw error
  }
}

/**
 * 增量更新文档
 * 
 * 使用 addSource 进行增量更新，避免全量重编译
 */
async function incrementalUpdate(
  path: string,
  content: string
): Promise<{
  artifact: Uint8Array | null
  diagnostics: DiagnosticMessage[]
}> {
  if (!compiler || compilerState !== 'ready') {
    throw new Error('Compiler not ready')
  }

  compilerState = 'compiling'

  try {
    // 增量更新：只更新指定文件
    compiler.addSource(path, content)

    // 重新编译
    const result = await compiler.compile({
      mainFilePath: path,
      format: 0, // vector
      diagnostics: 'full',
    })

    compilerState = 'ready'

    return {
      artifact: result.result ?? null,
      diagnostics: (result.diagnostics ?? []) as DiagnosticMessage[],
    }
  } catch (error) {
    compilerState = 'ready'
    throw error
  }
}

// ============================================================================
// Message Handler
// ============================================================================

/**
 * 处理来自主线程的消息
 */
async function handleMessage(event: MessageEvent<MainToWorkerMessage>): Promise<void> {
  const message = event.data

  switch (message.type) {
    case 'init': {
      try {
        await initializeCompiler()
        postResponse({
          type: 'init_success',
          id: message.id,
        })
      } catch (error) {
        postResponse({
          type: 'init_error',
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      break
    }

    case 'compile': {
      try {
        const { source, mainFilePath, format } = message.payload
        const result = await compile(source, mainFilePath, format)

        if (result.artifact) {
          // 使用 Transferable 传输 Uint8Array，避免拷贝
          postResponse(
            {
              type: 'compile_success',
              id: message.id,
              payload: {
                artifact: result.artifact,
                diagnostics: result.diagnostics,
              },
            },
            [result.artifact.buffer]
          )

          // 编译成功后立即推送数据（异步，不阻塞响应）
          // 减少后续点击操作时的延迟
          setTimeout(() => {
            pushIntrospectionData(message.id, mainFilePath)
            pushOutlineData(message.id, source)
          }, 0)
        } else {
          const errorMsg = result.diagnostics.find(d => d.severity === 'error')?.message
            ?? 'Compilation failed with no output'
          
          postResponse({
            type: 'compile_error',
            id: message.id,
            payload: {
              error: errorMsg,
              diagnostics: result.diagnostics,
            },
          })
        }
      } catch (error) {
        postResponse({
          type: 'compile_error',
          id: message.id,
          payload: {
            error: error instanceof Error ? error.message : String(error),
            diagnostics: [],
          },
        })
      }
      break
    }

    case 'incremental_update': {
      try {
        const { path, content } = message.payload
        const result = await incrementalUpdate(path, content)

        if (result.artifact) {
          postResponse(
            {
              type: 'compile_success',
              id: message.id,
              payload: {
                artifact: result.artifact,
                diagnostics: result.diagnostics,
              },
            },
            [result.artifact.buffer]
          )

          // 增量编译成功后也推送数据
          setTimeout(() => {
            pushIntrospectionData(message.id, path)
            pushOutlineData(message.id, content)
          }, 0)
        } else {
          const errorMsg = result.diagnostics.find(d => d.severity === 'error')?.message
            ?? 'Incremental compilation failed'
          
          postResponse({
            type: 'compile_error',
            id: message.id,
            payload: {
              error: errorMsg,
              diagnostics: result.diagnostics,
            },
          })
        }
      } catch (error) {
        postResponse({
          type: 'compile_error',
          id: message.id,
          payload: {
            error: error instanceof Error ? error.message : String(error),
            diagnostics: [],
          },
        })
      }
      break
    }

    case 'reset': {
      try {
        await resetCompiler()
        postResponse({
          type: 'reset_success',
          id: message.id,
        })
      } catch (error) {
        // 重置失败通常意味着需要重新初始化
        postResponse({
          type: 'init_error',
          id: message.id,
          error: `Reset failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
      break
    }

    case 'dispose': {
      disposeCompiler()
      // 不发送响应，Worker 即将终止
      break
    }

    case 'add_font': {
      handleFontResponse(message.payload)
      break
    }

    default: {
      console.warn('[Worker] Unknown message type:', (message as { type: string }).type)
    }
  }
}

// ============================================================================
// Worker Entry Point
// ============================================================================

// 注册消息处理器
self.addEventListener('message', (event: MessageEvent<MainToWorkerMessage>) => {
  handleMessage(event).catch((error) => {
    console.error('[Worker] Unhandled error:', error)
  })
})

// 通知主线程 Worker 已就绪
postResponse({ type: 'ready' })

