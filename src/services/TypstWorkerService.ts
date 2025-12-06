/**
 * TypstWorkerService - 主线程 Worker 管理服务
 * 
 * 设计原则：
 * 1. 单例模式：整个应用共享一个 Worker 实例
 * 2. Promise 化 API：所有 Worker 通信转换为 Promise
 * 3. 错误恢复：Worker 崩溃时自动重启
 * 4. 类型安全：严格的消息类型检查
 * 5. 健康监控：内存使用监控和软重启机制
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
  WorkerHealthMetrics,
} from '../workers/types'
import { FontService } from './FontService'
import { WorkerHealthMonitor, type HealthStatus, type HealthStatusEvent } from './WorkerHealthMonitor'

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

/**
 * 健康状态监听器
 */
export type HealthStatusListener = (event: HealthStatusEvent) => void

/**
 * 软重启事件
 */
export interface SoftRestartEvent {
  reason: string
  previousUptime: number
  timestamp: number
}

/**
 * 软重启监听器
 */
export type SoftRestartListener = (event: SoftRestartEvent) => void

// ============================================================================
// Constants
// ============================================================================

const REQUEST_TIMEOUT = 60000 // 60 seconds
const MAX_RESTART_ATTEMPTS = 3
const RESTART_DELAY = 1000 // 1 second

/** 软重启冷却时间（防止频繁重启） */
const SOFT_RESTART_COOLDOWN = 30000 // 30 seconds

/** 最大软重启次数（短时间内） */
const MAX_SOFT_RESTARTS = 3

/** 软重启计数重置时间 */
const SOFT_RESTART_RESET_INTERVAL = 5 * 60 * 1000 // 5 minutes

// Circuit Breaker Configuration
const CIRCUIT_FAILURE_THRESHOLD = 5      // Failures to trigger OPEN state
const CIRCUIT_WINDOW_MS = 60000          // 1 minute window for failure counting
const CIRCUIT_RESET_MS = 30000           // Time before trying HALF_OPEN

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

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

  // --------------------------------------------------------------------------
  // Soft Restart State
  // --------------------------------------------------------------------------

  /** 健康状态监听器 */
  private healthListeners = new Set<HealthStatusListener>()

  /** 软重启监听器 */
  private softRestartListeners = new Set<SoftRestartListener>()

  /** 最后一次软重启时间 */
  private lastSoftRestartTime = 0

  /** 短时间内软重启次数 */
  private softRestartCount = 0

  /** 软重启计数重置定时器 */
  private softRestartResetTimer: ReturnType<typeof setTimeout> | null = null

  /** 是否正在执行软重启 */
  private isSoftRestarting = false

  /** 当前健康状态 */
  private currentHealthStatus: HealthStatus = 'healthy'

  // --------------------------------------------------------------------------
  // Circuit Breaker State
  // --------------------------------------------------------------------------

  /** 熔断器状态 */
  private circuitState: CircuitState = 'CLOSED'

  /** 故障时间戳记录 */
  private circuitFailures: number[] = []

  /** 熔断器打开时间 (for debugging/metrics) */
  private _circuitOpenTime = 0

  constructor() {
    // 自动创建 Worker
    this.createWorker()

    // 订阅健康监控事件
    this.setupHealthMonitoring()
  }

  /**
   * 设置健康监控
   */
  private setupHealthMonitoring(): void {
    WorkerHealthMonitor.onHealthChange((event) => {
      this.currentHealthStatus = event.status

      // 通知健康状态监听器
      this.notifyHealthListeners(event)

      // 检查是否需要软重启
      if (event.metrics.needsRestart) {
        this.triggerSoftRestart(event.metrics.restartReason ?? 'Health check triggered restart')
      }
    })
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
        // Close circuit breaker on success (recover from HALF_OPEN)
        this.closeCircuit()
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

      case 'health_metrics':
        // Worker 上报的健康指标
        this.handleHealthMetrics(message.payload)
        break
    }
  }

  /**
   * 处理 Worker 上报的健康指标
   */
  private handleHealthMetrics(metrics: WorkerHealthMetrics): void {
    // 将指标传递给健康监控器
    WorkerHealthMonitor.recordCompilation({
      compileTime: metrics.compileTime,
      artifactSize: metrics.artifactSize,
      estimatedPages: metrics.estimatedPages,
      hasError: metrics.hasError,
      hasPanic: metrics.hasPanic,
    })
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

    // Record failure for circuit breaker
    this.recordCircuitFailure()

    // 拒绝所有待处理的请求
    for (const [, request] of this.pendingRequests) {
      request.reject(new Error(`Worker error: ${event.message}`))
      if (request.timeout) clearTimeout(request.timeout)
    }
    this.pendingRequests.clear()

    // 尝试重启 Worker (unless circuit is open)
    if (!this.isCircuitOpen()) {
      this.attemptRestart()
    }
  }

  /**
   * 尝试重启 Worker
   * 
   * Enhanced with:
   * - Pending request backup for retry notification
   * - Re-initialization after worker creation
   * - Proper error state management
   */
  private async attemptRestart(): Promise<void> {
    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      console.error('[TypstWorkerService] Max restart attempts reached')
      this.status = 'worker_error'
      this.notifyStatusChange({
        status: 'worker_error',
        error: 'Max restart attempts exceeded'
      })
      return
    }

    // Backup pending requests for retry notification
    const pendingBackup = new Map(this.pendingRequests)
    this.pendingRequests.clear()

    this.restartAttempts++
    console.log(`[TypstWorkerService] Attempting restart (${this.restartAttempts}/${MAX_RESTART_ATTEMPTS})`)

    await new Promise(resolve => setTimeout(resolve, RESTART_DELAY))

    this.createWorker()

    // Re-initialize worker after restart
    try {
      await this.init()

      // Reset restart counter on successful init
      this.restartAttempts = 0

      // Notify callers that their requests were cancelled - they should retry
      for (const [_id, req] of pendingBackup) {
        if (req.timeout) clearTimeout(req.timeout)
        req.reject(new Error('Worker restarted. Please retry your request.'))
      }

      console.log('[TypstWorkerService] Worker restart successful')
    } catch (error) {
      console.error('[TypstWorkerService] Re-initialization failed:', error)
      this.status = 'worker_error'
      this.notifyStatusChange({
        status: 'worker_error',
        error: `Re-init failed: ${error instanceof Error ? error.message : String(error)}`
      })

      // Reject backed up requests with final error
      for (const [, req] of pendingBackup) {
        if (req.timeout) clearTimeout(req.timeout)
        req.reject(new Error(`Worker restart failed: ${error instanceof Error ? error.message : String(error)}`))
      }
    }
  }

  // --------------------------------------------------------------------------
  // Circuit Breaker Methods
  // --------------------------------------------------------------------------

  /**
   * Record a failure and update circuit breaker state
   * Called when worker errors or crashes occur
   */
  private recordCircuitFailure(): void {
    const now = Date.now()

    // Prune failures outside the window
    this.circuitFailures = this.circuitFailures.filter(
      t => now - t < CIRCUIT_WINDOW_MS
    )

    // Add new failure
    this.circuitFailures.push(now)

    // Check if threshold exceeded
    if (this.circuitFailures.length >= CIRCUIT_FAILURE_THRESHOLD) {
      this.openCircuit()
    }
  }

  /**
   * Open the circuit breaker - block all requests
   */
  private openCircuit(): void {
    if (this.circuitState === 'OPEN') return

    console.warn('[TypstWorkerService] Circuit breaker OPEN - too many failures')
    this.circuitState = 'OPEN'
    this._circuitOpenTime = Date.now()

    // Schedule transition to HALF_OPEN
    setTimeout(() => {
      if (this.circuitState === 'OPEN') {
        console.log('[TypstWorkerService] Circuit breaker -> HALF_OPEN')
        this.circuitState = 'HALF_OPEN'
      }
    }, CIRCUIT_RESET_MS)

    this.notifyStatusChange({
      status: 'worker_error',
      error: 'Circuit breaker open: Service temporarily unavailable'
    })
  }

  /**
   * Check if requests should be allowed through
   */
  private isCircuitOpen(): boolean {
    if (this.circuitState === 'CLOSED') return false
    if (this.circuitState === 'OPEN') return true

    // HALF_OPEN: allow one request through to test
    return false
  }

  /**
   * Mark circuit as recovered after successful request in HALF_OPEN state
   */
  private closeCircuit(): void {
    if (this.circuitState === 'HALF_OPEN') {
      console.log('[TypstWorkerService] Circuit breaker CLOSED - recovered')
      this.circuitState = 'CLOSED'
      this.circuitFailures = []
    }
  }

  /**
   * Get current circuit breaker state
   */
  getCircuitState(): CircuitState {
    return this.circuitState
  }

  /**
   * Get how long the circuit has been open (ms), or 0 if closed
   */
  getCircuitOpenDuration(): number {
    if (this.circuitState === 'CLOSED') return 0
    return Date.now() - this._circuitOpenTime
  }

  // --------------------------------------------------------------------------
  // Soft Restart (Memory Management)
  // --------------------------------------------------------------------------

  /**
   * 触发软重启
   * 
   * 当检测到内存问题或大文档时，静默销毁旧 Worker 并创建新实例。
   * 包含冷却时间和频率限制，防止无限重启。
   * 
   * @param reason - 重启原因
   */
  private async triggerSoftRestart(reason: string): Promise<void> {
    // 检查是否正在重启
    if (this.isSoftRestarting) {
      console.log('[TypstWorkerService] Soft restart already in progress, skipping')
      return
    }

    // 检查冷却时间
    const now = Date.now()
    if (now - this.lastSoftRestartTime < SOFT_RESTART_COOLDOWN) {
      console.log('[TypstWorkerService] Soft restart cooldown active, skipping')
      return
    }

    // 检查重启频率
    if (this.softRestartCount >= MAX_SOFT_RESTARTS) {
      console.warn('[TypstWorkerService] Max soft restarts reached, waiting for reset')
      return
    }

    this.isSoftRestarting = true
    this.softRestartCount++
    this.lastSoftRestartTime = now

    // 设置计数重置定时器
    this.setupSoftRestartResetTimer()

    console.log(`[TypstWorkerService] Initiating soft restart: ${reason}`)

    // 记录旧 Worker 的运行时间
    const previousUptime = WorkerHealthMonitor.getMetrics().workerUptime

    // 通知监听器
    this.notifySoftRestartListeners({
      reason,
      previousUptime,
      timestamp: now,
    })

    try {
      // 暂存待处理的请求（不拒绝，等新 Worker 处理）
      const pendingRequestsBackup = new Map(this.pendingRequests)

      // 清除当前请求追踪
      this.pendingRequests.clear()

      // 终止旧 Worker（不等待）
      if (this.worker) {
        this.worker.removeEventListener('message', this.handleWorkerMessage)
        this.worker.removeEventListener('error', this.handleWorkerError)
        this.worker.terminate()
        this.worker = null
      }

      // 重置状态
      this.workerReady = false
      this.status = 'initializing'
      this.restartAttempts = 0

      // 通知健康监控器重置
      WorkerHealthMonitor.resetOnRestart()

      // 创建新 Worker
      this.createWorker()

      // 等待新 Worker 就绪
      await this.workerReadyPromise

      // 初始化新编译器
      await this.init()

      console.log('[TypstWorkerService] Soft restart completed successfully')

      // 重新发送备份的请求（可选，取决于业务需求）
      // 这里选择不重发，让调用方处理重试逻辑
      // 拒绝备份的请求，提示重试
      for (const [, request] of pendingRequestsBackup) {
        request.reject(new Error(`Worker restarted: ${reason}. Please retry the operation.`))
        if (request.timeout) clearTimeout(request.timeout)
      }

    } catch (error) {
      console.error('[TypstWorkerService] Soft restart failed:', error)
      this.status = 'worker_error'
      this.notifyStatusChange({
        status: 'worker_error',
        error: `Soft restart failed: ${error instanceof Error ? error.message : String(error)}`
      })
    } finally {
      this.isSoftRestarting = false
    }
  }

  /**
   * 设置软重启计数重置定时器
   */
  private setupSoftRestartResetTimer(): void {
    // 清除现有定时器
    if (this.softRestartResetTimer) {
      clearTimeout(this.softRestartResetTimer)
    }

    // 设置新定时器
    this.softRestartResetTimer = setTimeout(() => {
      this.softRestartCount = 0
      console.log('[TypstWorkerService] Soft restart count reset')
    }, SOFT_RESTART_RESET_INTERVAL)
  }

  /**
   * 通知健康状态监听器
   */
  private notifyHealthListeners(event: HealthStatusEvent): void {
    for (const listener of this.healthListeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[TypstWorkerService] Health listener error:', error)
      }
    }
  }

  /**
   * 通知软重启监听器
   */
  private notifySoftRestartListeners(event: SoftRestartEvent): void {
    for (const listener of this.softRestartListeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[TypstWorkerService] Soft restart listener error:', error)
      }
    }
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

  // --------------------------------------------------------------------------
  // Health Monitoring API
  // --------------------------------------------------------------------------

  /**
   * 订阅健康状态变化
   * 
   * @param listener - 状态变化回调
   * @returns 取消订阅函数
   */
  onHealthChange(listener: HealthStatusListener): () => void {
    this.healthListeners.add(listener)
    return () => this.healthListeners.delete(listener)
  }

  /**
   * 订阅软重启事件
   * 
   * @param listener - 软重启事件回调
   * @returns 取消订阅函数
   */
  onSoftRestart(listener: SoftRestartListener): () => void {
    this.softRestartListeners.add(listener)
    return () => this.softRestartListeners.delete(listener)
  }

  /**
   * 获取当前健康状态
   */
  getHealthStatus(): HealthStatus {
    return this.currentHealthStatus
  }

  /**
   * 获取详细健康指标
   */
  getHealthMetrics() {
    return WorkerHealthMonitor.getMetrics()
  }

  /**
   * 手动触发软重启
   * 
   * @param reason - 重启原因
   */
  async manualSoftRestart(reason = 'Manual restart requested'): Promise<void> {
    await this.triggerSoftRestart(reason)
  }

  /**
   * 检查是否正在执行软重启
   */
  isSoftRestartInProgress(): boolean {
    return this.isSoftRestarting
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

