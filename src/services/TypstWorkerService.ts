/**
 * TypstWorkerService - 主线程 Worker 管理服务
 * 
 * 设计原则：
 * 1. 单例模式：整个应用共享一个 Worker 实例
 * 2. Promise 化 API：所有 Worker 通信转换为 Promise
 * 3. 错误恢复：Worker 崩溃时自动重启
 * 4. 类型安全：严格的消息类型检查
 */

import type {
  WorkerToMainMessage,
  DiagnosticMessage,
  PendingRequest,
  CompilerState,
  IntrospectionData,
  SourceMarker,
  OutlineData,
  OutlineHeading,
} from '../workers/types'
import { FontService } from './FontService'

// ============================================================================
// Types
// ============================================================================

export interface CompileOptions {
  /** 主文件路径 */
  mainFilePath?: string
  /** 输出格式 */
  format?: 'vector' | 'pdf'
}

export interface CompileResult {
  /** 编译成功时的 artifact 数据 */
  artifact: Uint8Array | null
  /** 编译诊断信息 */
  diagnostics: DiagnosticMessage[]
  /** 是否存在错误 */
  hasError: boolean
}

export type WorkerStatus = CompilerState | 'worker_error'

export interface WorkerStatusEvent {
  status: WorkerStatus
  error?: string
}

export type StatusListener = (event: WorkerStatusEvent) => void

/**
 * 内省数据监听器
 */
export type IntrospectionListener = (data: IntrospectionData) => void

/**
 * 大纲数据监听器
 */
export type OutlineListener = (data: OutlineData) => void

// ============================================================================
// Constants
// ============================================================================

const REQUEST_TIMEOUT = 60000 // 60 seconds
const MAX_RESTART_ATTEMPTS = 3
const RESTART_DELAY = 1000 // 1 second

// ============================================================================
// Worker Service Implementation
// ============================================================================

class TypstWorkerServiceImpl {
  private worker: Worker | null = null
  private workerReady = false
  private status: WorkerStatus = 'uninitialized'
  private restartAttempts = 0

  /** 待处理的请求 */
  private pendingRequests = new Map<string, PendingRequest<unknown>>()

  /** 状态变化监听器 */
  private statusListeners = new Set<StatusListener>()

  /** 内省数据监听器 */
  private introspectionListeners = new Set<IntrospectionListener>()

  /** 最新的内省数据缓存 */
  private latestIntrospection: IntrospectionData | null = null

  /** 大纲数据监听器 */
  private outlineListeners = new Set<OutlineListener>()

  /** 最新的大纲数据缓存 */
  private latestOutline: OutlineData | null = null

  /** Worker 就绪 Promise */
  private workerReadyPromise: Promise<void> | null = null
  private workerReadyResolve: (() => void) | null = null

  constructor() {
    // 自动创建 Worker
    this.createWorker()
  }

  // --------------------------------------------------------------------------
  // Worker Lifecycle
  // --------------------------------------------------------------------------

  /**
   * 创建 Worker 实例
   */
  private createWorker(): void {
    if (this.worker) {
      this.worker.terminate()
    }

    this.workerReady = false
    this.workerReadyPromise = new Promise((resolve) => {
      this.workerReadyResolve = resolve
    })

    // 使用 Vite 的 Worker 导入语法
    this.worker = new Worker(
      new URL('../workers/typst.worker.ts', import.meta.url),
      { type: 'module' }
    )

    this.worker.addEventListener('message', this.handleWorkerMessage)
    this.worker.addEventListener('error', this.handleWorkerError)
  }

  /**
   * 处理 Worker 消息
   */
  private handleWorkerMessage = (event: MessageEvent<WorkerToMainMessage>): void => {
    const message = event.data

    switch (message.type) {
      case 'ready':
        this.workerReady = true
        this.restartAttempts = 0
        this.workerReadyResolve?.()
        break

      case 'init_success':
        this.status = 'ready'
        this.notifyStatusChange({ status: 'ready' })
        this.resolvePendingRequest(message.id, undefined)
        break

      case 'init_error':
        this.status = 'uninitialized'
        this.notifyStatusChange({ status: 'uninitialized', error: message.error })
        this.rejectPendingRequest(message.id, new Error(message.error))
        break

      case 'compile_success':
        this.status = 'ready'
        this.resolvePendingRequest<CompileResult>(message.id, {
          artifact: message.payload.artifact,
          diagnostics: message.payload.diagnostics,
          hasError: false,
        })
        break

      case 'compile_error':
        this.status = 'ready'
        this.resolvePendingRequest<CompileResult>(message.id, {
          artifact: null,
          diagnostics: message.payload.diagnostics,
          hasError: true,
        })
        break

      case 'reset_success':
        this.status = 'ready'
        this.resolvePendingRequest(message.id, undefined)
        break

      case 'font_request':
        // Worker 请求加载字体
        this.handleFontRequest(message.id, message.payload.family)
        break

      case 'introspection_result':
        // Worker 主动推送的内省数据
        this.handleIntrospectionResult(message.payload)
        break

      case 'outline_result':
        // Worker 主动推送的大纲数据
        this.handleOutlineResult(message.payload)
        break
    }
  }

  /**
   * 处理内省数据
   * Worker 在编译成功后主动推送，无需等待请求
   */
  private handleIntrospectionResult(data: IntrospectionData): void {
    // 缓存最新数据
    this.latestIntrospection = data

    // 通知所有监听器
    for (const listener of this.introspectionListeners) {
      try {
        listener(data)
      } catch (error) {
        console.error('[TypstWorkerService] Introspection listener error:', error)
      }
    }
  }

  /**
   * 处理大纲数据
   * Worker 在编译成功后主动推送，用于生成交互式大纲面板
   */
  private handleOutlineResult(data: OutlineData): void {
    // 缓存最新数据
    this.latestOutline = data

    // 通知所有监听器
    for (const listener of this.outlineListeners) {
      try {
        listener(data)
      } catch (error) {
        console.error('[TypstWorkerService] Outline listener error:', error)
      }
    }
  }

  /**
   * 处理 Worker 错误
   */
  private handleWorkerError = (event: ErrorEvent): void => {
    console.error('[TypstWorkerService] Worker error:', event.message)
    
    this.status = 'worker_error'
    this.notifyStatusChange({ status: 'worker_error', error: event.message })

    // 拒绝所有待处理的请求
    for (const [, request] of this.pendingRequests) {
      request.reject(new Error(`Worker error: ${event.message}`))
      if (request.timeout) clearTimeout(request.timeout)
    }
    this.pendingRequests.clear()

    // 尝试重启 Worker
    this.attemptRestart()
  }

  /**
   * 尝试重启 Worker
   */
  private async attemptRestart(): Promise<void> {
    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      console.error('[TypstWorkerService] Max restart attempts reached')
      return
    }

    this.restartAttempts++
    console.log(`[TypstWorkerService] Attempting restart (${this.restartAttempts}/${MAX_RESTART_ATTEMPTS})`)

    await new Promise(resolve => setTimeout(resolve, RESTART_DELAY))
    
    this.createWorker()
  }

  // --------------------------------------------------------------------------
  // Request Management
  // --------------------------------------------------------------------------

  /**
   * 生成请求 ID
   */
  private generateRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
  }

  /**
   * 发送请求并等待响应
   * 
   * @param message - 消息对象（不含 id，将自动生成）
   * @param timeout - 超时时间（毫秒）
   */
  private async sendRequest<T>(
    message: Record<string, unknown>,
    timeout = REQUEST_TIMEOUT
  ): Promise<T> {
    // 等待 Worker 就绪
    if (!this.workerReady) {
      await this.workerReadyPromise
    }

    if (!this.worker) {
      throw new Error('Worker not available')
    }

    const id = this.generateRequestId()
    const fullMessage = { ...message, id }

    return new Promise((resolve, reject) => {
      // 设置超时
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Request timeout after ${timeout}ms`))
      }, timeout)

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout: timeoutId,
      })

      this.worker!.postMessage(fullMessage)
    })
  }

  /**
   * 解析待处理的请求
   */
  private resolvePendingRequest<T>(id: string, value: T): void {
    const request = this.pendingRequests.get(id)
    if (request) {
      if (request.timeout) clearTimeout(request.timeout)
      this.pendingRequests.delete(id)
      request.resolve(value)
    }
  }

  /**
   * 拒绝待处理的请求
   */
  private rejectPendingRequest(id: string, error: Error): void {
    const request = this.pendingRequests.get(id)
    if (request) {
      if (request.timeout) clearTimeout(request.timeout)
      this.pendingRequests.delete(id)
      request.reject(error)
    }
  }

  // --------------------------------------------------------------------------
  // Font Loading
  // --------------------------------------------------------------------------

  /**
   * 处理 Worker 的字体请求
   */
  private async handleFontRequest(requestId: string, family: string): Promise<void> {
    try {
      const result = await FontService.loadFont(family)
      
      this.worker?.postMessage({
        type: 'add_font',
        id: requestId,
        payload: {
          family,
          buffer: result.buffer,
          error: result.error,
        },
      })
    } catch (error) {
      this.worker?.postMessage({
        type: 'add_font',
        id: requestId,
        payload: {
          family,
          buffer: null,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  // --------------------------------------------------------------------------
  // Status Management
  // --------------------------------------------------------------------------

  /**
   * 通知状态变化
   */
  private notifyStatusChange(event: WorkerStatusEvent): void {
    for (const listener of this.statusListeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[TypstWorkerService] Status listener error:', error)
      }
    }
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * 初始化编译器
   */
  async init(): Promise<void> {
    if (this.status === 'ready') {
      return // 已初始化
    }

    if (this.status === 'initializing') {
      // 等待现有初始化完成
      return new Promise((resolve, reject) => {
        const unsubscribe = this.onStatusChange((event) => {
          if (event.status === 'ready') {
            unsubscribe()
            resolve()
          } else if (event.status === 'worker_error' || event.status === 'uninitialized') {
            unsubscribe()
            reject(new Error(event.error ?? 'Initialization failed'))
          }
        })
      })
    }

    this.status = 'initializing'
    this.notifyStatusChange({ status: 'initializing' })

    await this.sendRequest<void>({ type: 'init' })
  }

  /**
   * 编译 Typst 源码
   */
  async compile(source: string, options?: CompileOptions): Promise<CompileResult> {
    // 确保已初始化
    if (this.status !== 'ready' && this.status !== 'compiling') {
      await this.init()
    }

    this.status = 'compiling'
    this.notifyStatusChange({ status: 'compiling' })

    try {
      const result = await this.sendRequest<CompileResult>({
        type: 'compile',
        payload: {
          source,
          mainFilePath: options?.mainFilePath ?? '/main.typ',
          format: options?.format ?? 'vector',
        },
      })

      return result
    } finally {
      this.status = 'ready'
      this.notifyStatusChange({ status: 'ready' })
    }
  }

  /**
   * 增量更新并编译
   */
  async incrementalUpdate(path: string, content: string): Promise<CompileResult> {
    if (this.status !== 'ready' && this.status !== 'compiling') {
      await this.init()
    }

    this.status = 'compiling'
    this.notifyStatusChange({ status: 'compiling' })

    try {
      return await this.sendRequest<CompileResult>({
        type: 'incremental_update',
        payload: { path, content },
      })
    } finally {
      this.status = 'ready'
      this.notifyStatusChange({ status: 'ready' })
    }
  }

  /**
   * 重置编译器状态
   * 
   * 在文档全量重载时调用，防止内存泄漏
   */
  async reset(): Promise<void> {
    if (this.status === 'uninitialized' || this.status === 'worker_error') {
      return
    }

    await this.sendRequest<void>({ type: 'reset' })
  }

  /**
   * 销毁 Worker
   */
  dispose(): void {
    if (this.worker) {
      // 发送销毁消息
      this.worker.postMessage({ type: 'dispose', id: 'dispose' })
      
      // 移除事件监听
      this.worker.removeEventListener('message', this.handleWorkerMessage)
      this.worker.removeEventListener('error', this.handleWorkerError)
      
      // 终止 Worker
      this.worker.terminate()
      this.worker = null
    }

    // 清理状态
    this.status = 'disposed'
    this.pendingRequests.clear()
    this.statusListeners.clear()
  }

  /**
   * 获取当前状态
   */
  getStatus(): WorkerStatus {
    return this.status
  }

  /**
   * 监听状态变化
   */
  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  /**
   * 检查是否就绪
   */
  isReady(): boolean {
    return this.status === 'ready'
  }

  // --------------------------------------------------------------------------
  // Introspection API
  // --------------------------------------------------------------------------

  /**
   * 订阅内省数据更新
   * 
   * Worker 在每次编译成功后会主动推送内省数据，
   * 通过此方法注册的监听器会收到更新通知。
   * 
   * @param listener - 数据更新回调
   * @returns 取消订阅函数
   */
  onIntrospectionUpdate(listener: IntrospectionListener): () => void {
    this.introspectionListeners.add(listener)
    
    // 如果已有缓存数据，立即通知
    if (this.latestIntrospection) {
      try {
        listener(this.latestIntrospection)
      } catch (error) {
        console.error('[TypstWorkerService] Introspection listener error:', error)
      }
    }
    
    return () => {
      this.introspectionListeners.delete(listener)
    }
  }

  /**
   * 获取最新的内省数据
   * 
   * @returns 最新的内省数据，如果尚未编译成功则返回 null
   */
  getLatestIntrospection(): IntrospectionData | null {
    return this.latestIntrospection
  }

  /**
   * 根据 ID 查找标记
   * 
   * @param id - 标记 ID（格式如 "L10-C1"）
   * @returns 匹配的标记，如果未找到返回 null
   */
  findMarkerById(id: string): SourceMarker | null {
    if (!this.latestIntrospection) return null
    return this.latestIntrospection.markers.find(m => m.id === id) ?? null
  }

  /**
   * 查找指定页面上的所有标记
   * 
   * @param page - 页码（从 1 开始）
   * @returns 该页面上的所有标记
   */
  findMarkersOnPage(page: number): SourceMarker[] {
    if (!this.latestIntrospection) return []
    return this.latestIntrospection.markers.filter(m => m.page === page)
  }

  // --------------------------------------------------------------------------
  // Outline API
  // --------------------------------------------------------------------------

  /**
   * 订阅大纲数据更新
   * 
   * Worker 在每次编译成功后会主动推送大纲数据（标题、图表），
   * 通过此方法注册的监听器会收到更新通知。
   * 
   * @param listener - 数据更新回调
   * @returns 取消订阅函数
   */
  onOutlineUpdate(listener: OutlineListener): () => void {
    this.outlineListeners.add(listener)
    
    // 如果已有缓存数据，立即通知
    if (this.latestOutline) {
      try {
        listener(this.latestOutline)
      } catch (error) {
        console.error('[TypstWorkerService] Outline listener error:', error)
      }
    }
    
    return () => {
      this.outlineListeners.delete(listener)
    }
  }

  /**
   * 获取最新的大纲数据
   * 
   * @returns 最新的大纲数据，如果尚未编译成功则返回 null
   */
  getLatestOutline(): OutlineData | null {
    return this.latestOutline
  }

  /**
   * 查找指定页面上的所有标题
   * 
   * @param page - 页码（从 1 开始）
   * @returns 该页面上的所有标题
   */
  findHeadingsOnPage(page: number): OutlineHeading[] {
    if (!this.latestOutline) return []
    return this.latestOutline.headings.filter(h => h.page === page)
  }

  /**
   * 获取文档的标题树结构
   * 
   * @returns 层级化的标题树
   */
  getHeadingTree(): OutlineHeadingNode[] {
    if (!this.latestOutline) return []
    return buildHeadingTree(this.latestOutline.headings)
  }
}

// ============================================================================
// Helper Types and Functions
// ============================================================================

/**
 * 大纲标题树节点
 */
export interface OutlineHeadingNode extends OutlineHeading {
  /** 子标题 */
  children: OutlineHeadingNode[]
}

/**
 * 将平面标题列表转换为树结构
 */
function buildHeadingTree(headings: OutlineHeading[]): OutlineHeadingNode[] {
  const root: OutlineHeadingNode[] = []
  const stack: OutlineHeadingNode[] = []

  for (const heading of headings) {
    const node: OutlineHeadingNode = {
      ...heading,
      children: [],
    }

    // 找到合适的父节点
    while (stack.length > 0) {
      const parent = stack[stack.length - 1]
      if (parent && parent.level >= heading.level) {
        stack.pop()
      } else {
        break
      }
    }

    if (stack.length === 0) {
      // 顶级标题
      root.push(node)
    } else {
      // 作为子标题添加到父节点
      const parent = stack[stack.length - 1]
      if (parent) {
        parent.children.push(node)
      }
    }

    stack.push(node)
  }

  return root
}

// ============================================================================
// Singleton Export
// ============================================================================

/**
 * TypstWorkerService 单例
 */
export const TypstWorkerService = new TypstWorkerServiceImpl()

export default TypstWorkerService

