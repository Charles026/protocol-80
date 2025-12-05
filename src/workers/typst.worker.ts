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
  SourceMarker,
  TypstRect,
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
 * 内省选择器 - 用于查询文档中的追踪标记
 * 
 * 查询所有包含 kind: "pos" 的 metadata 元素
 * 这些元素由 introspection.typ 模块中的 trace-node 函数插入
 */
const INTROSPECTION_SELECTOR = 'metadata.where(value: (kind: "pos"))'

/**
 * 查询内省数据
 * 
 * 在编译成功后调用，查询文档中的所有追踪标记位置
 * 主动推送给主线程，减少点击时的延迟
 * 
 * @param mainFilePath - 主文件路径
 * @returns 内省数据，如果查询失败返回 null
 */
function queryIntrospection(mainFilePath: string): IntrospectionData | null {
  if (!compiler) {
    console.warn('[Worker] Cannot query introspection: compiler not initialized')
    return null
  }

  try {
    // 使用 Typst 的 query API 查询所有追踪标记
    // TypstCompiler.query 签名: query(mainFilePath: string, inputs: array[][] | null, selector: string, field?: string)
    // 使用类型断言绕过严格类型检查，因为 typst.ts 的类型定义可能不完整
    const compilerAny = compiler as unknown as {
      query: (mainFilePath: string, inputs: null, selector: string, field?: string | null) => string
    }

    let queryResult: string
    try {
      queryResult = compilerAny.query(mainFilePath, null, INTROSPECTION_SELECTOR, null)
    } catch (queryError) {
      // query 方法可能不存在或调用失败
      console.warn('[Worker] Query API not available or failed:', queryError)
      return null
    }

    // 解析查询结果
    let positions: Array<{
      value: {
        kind: string
        id: string
        page: number
        x: { pt: number } | number
        y: { pt: number } | number
      }
    }> = []

    try {
      positions = JSON.parse(queryResult)
    } catch {
      // 查询结果可能为空或格式异常
      console.warn('[Worker] Failed to parse introspection query result')
      return null
    }

    if (!Array.isArray(positions)) {
      return null
    }

    // 转换为 SourceMarker 格式
    const markers: SourceMarker[] = []
    const markerMap = new Map<string, SourceMarker>()

    for (const item of positions) {
      const value = item?.value
      if (!value || value.kind !== 'pos') continue

      const id = value.id
      const page = typeof value.page === 'number' ? value.page : 1
      const x = typeof value.x === 'object' ? value.x.pt : (value.x as number)
      const y = typeof value.y === 'object' ? value.y.pt : (value.y as number)

      // 查询元素尺寸（如果可用）
      // 注：Typst query 返回的 position 不包含尺寸，需要额外查询 layout()
      // 这里先使用默认尺寸，后续可以通过 layout 查询获取精确尺寸
      const defaultWidth = 100 // pt
      const defaultHeight = 20 // pt

      const marker: SourceMarker = {
        id,
        rect: [x, y, defaultWidth, defaultHeight] as TypstRect,
        page,
        type: inferMarkerType(id),
      }

      markerMap.set(id, marker)
    }

    markers.push(...markerMap.values())

    // 获取页面信息
    // 注：目前 typst.ts 不直接暴露页面信息 API，使用默认值
    // 后续可以通过解析 artifact 获取精确页面尺寸
    const pageSizes: Array<[number, number]> = [[595.28, 841.89]] // A4 默认
    const totalPages = markers.length > 0 
      ? Math.max(1, ...markers.map(m => m.page))
      : 1

    // 填充页面尺寸数组
    while (pageSizes.length < totalPages) {
      pageSizes.push([595.28, 841.89])
    }

    return {
      markers,
      totalPages,
      pageSizes,
    }
  } catch (error) {
    console.warn('[Worker] Introspection query failed:', error)
    return null
  }
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

/**
 * 发送内省数据到主线程
 * 
 * 在编译成功后立即调用，主动推送数据以减少后续点击延迟
 */
function pushIntrospectionData(requestId: string, mainFilePath: string): void {
  const introspection = queryIntrospection(mainFilePath)
  
  if (introspection && introspection.markers.length > 0) {
    postResponse({
      type: 'introspection_result',
      id: requestId,
      payload: introspection,
    })
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

          // 编译成功后立即推送内省数据（异步，不阻塞响应）
          // 减少后续点击操作时的延迟
          setTimeout(() => {
            pushIntrospectionData(message.id, mainFilePath)
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

          // 增量编译成功后也推送内省数据
          setTimeout(() => {
            pushIntrospectionData(message.id, path)
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

