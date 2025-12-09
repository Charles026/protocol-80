/**
 * WorkerHealthMonitor - Worker 健康状态监控
 * 
 * 监控 Worker 的内存使用和性能指标，在检测到内存激增时触发软重启。
 * 
 * 监控指标：
 * 1. 编译时间趋势（内存压力会导致编译变慢）
 * 2. Artifact 大小（大文档消耗更多内存）
 * 3. 错误/Panic 频率
 * 4. Worker 响应时间
 * 5. 实际内存使用（如果 API 可用）
 */

// ============================================================================
// Types
// ============================================================================

export interface HealthMetrics {
  /** 最近一次编译时间 (ms) */
  lastCompileTime: number
  /** 平均编译时间 (ms) */
  avgCompileTime: number
  /** 最近一次 artifact 大小 (bytes) */
  lastArtifactSize: number
  /** 最大 artifact 大小 (bytes) */
  maxArtifactSize: number
  /** 估算的页数 */
  estimatedPages: number
  /** 错误计数（最近 N 次编译） */
  recentErrorCount: number
  /** Panic 计数（最近 N 次编译） */
  recentPanicCount: number
  /** Worker 运行时长 (ms) */
  workerUptime: number
  /** 累计编译次数 */
  totalCompilations: number
  /** 内存使用估算 (bytes, 如果可用) */
  estimatedMemory: number | null
  /** 健康评分 (0-100) */
  healthScore: number
  /** 是否需要重启 */
  needsRestart: boolean
  /** 重启原因 */
  restartReason: string | null
}

export interface CompilationRecord {
  timestamp: number
  compileTime: number
  artifactSize: number
  hasError: boolean
  hasPanic: boolean
  estimatedPages: number
}

export type HealthStatus = 'healthy' | 'warning' | 'critical' | 'restarting'

export interface HealthStatusEvent {
  status: HealthStatus
  metrics: HealthMetrics
  message: string
}

export type HealthListener = (event: HealthStatusEvent) => void

// ============================================================================
// Constants
// ============================================================================

/** 编译记录保留数量 */
const MAX_COMPILATION_RECORDS = 50

/** 触发警告的页数阈值 */
const WARNING_PAGE_THRESHOLD = 50

/** 触发重启的页数阈值 */
const CRITICAL_PAGE_THRESHOLD = 100

/** 触发重启的 artifact 大小阈值 (10MB) */
const CRITICAL_ARTIFACT_SIZE = 10 * 1024 * 1024

/** 触发重启的编译时间增长倍数 */
const COMPILE_TIME_SPIKE_RATIO = 3

/** 触发重启的错误率阈值 */
const ERROR_RATE_THRESHOLD = 0.3 // 30%

/** 触发重启的 Panic 计数阈值 */
const PANIC_COUNT_THRESHOLD = 5

/** Worker 最大运行时长 (1 小时) */
const MAX_WORKER_UPTIME = 60 * 60 * 1000

/** 内存检查间隔 (30 秒) */
const MEMORY_CHECK_INTERVAL = 30 * 1000

/** 估算每页内存占用 (bytes) - 经验值 */
const ESTIMATED_MEMORY_PER_PAGE = 512 * 1024 // 512KB per page

// ============================================================================
// WorkerHealthMonitor
// ============================================================================

class WorkerHealthMonitorImpl {
  private compilationRecords: CompilationRecord[] = []
  private workerStartTime: number = Date.now()
  private listeners = new Set<HealthListener>()
  private memoryCheckInterval: ReturnType<typeof setInterval> | null = null
  private lastMemoryEstimate: number | null = null
  private isRestarting = false

  constructor() {
    this.startMemoryMonitoring()
  }

  // --------------------------------------------------------------------------
  // Recording
  // --------------------------------------------------------------------------

  /**
   * 记录一次编译结果
   */
  recordCompilation(record: Omit<CompilationRecord, 'timestamp'>): void {
    const fullRecord: CompilationRecord = {
      ...record,
      timestamp: Date.now(),
    }

    this.compilationRecords.push(fullRecord)

    // 保持记录数量在限制内
    if (this.compilationRecords.length > MAX_COMPILATION_RECORDS) {
      this.compilationRecords.shift()
    }

    // 更新内存估算
    this.updateMemoryEstimate(record.estimatedPages)

    // 检查健康状态
    this.checkHealth()
  }

  /**
   * 记录 Panic 事件
   */
  recordPanic(): void {
    // 找到最近的记录并标记 panic
    if (this.compilationRecords.length > 0) {
      const lastRecord = this.compilationRecords[this.compilationRecords.length - 1]
      if (lastRecord) {
        lastRecord.hasPanic = true
      }
    }
    this.checkHealth()
  }

  /**
   * Worker 重启时重置状态
   */
  resetOnRestart(): void {
    this.workerStartTime = Date.now()
    this.compilationRecords = []
    this.lastMemoryEstimate = null
    this.isRestarting = false
    
    this.notifyListeners({
      status: 'healthy',
      metrics: this.getMetrics(),
      message: 'Worker restarted successfully',
    })
  }

  // --------------------------------------------------------------------------
  // Memory Monitoring
  // --------------------------------------------------------------------------

  /**
   * 启动内存监控
   */
  private startMemoryMonitoring(): void {
    // 使用 Chrome 的 measureUserAgentSpecificMemory API（如果可用）
    if (typeof performance !== 'undefined' && 'measureUserAgentSpecificMemory' in performance) {
      this.memoryCheckInterval = setInterval(() => {
        this.measureActualMemory()
      }, MEMORY_CHECK_INTERVAL)
    }
  }

  /**
   * 测量实际内存使用（Chrome only）
   */
  private async measureActualMemory(): Promise<void> {
    try {
      // @ts-expect-error - Chrome-specific API
      if (typeof performance !== 'undefined' && performance.measureUserAgentSpecificMemory) {
        // @ts-expect-error - Chrome-specific API
        const result = await performance.measureUserAgentSpecificMemory()
        if (result && result.bytes) {
          this.lastMemoryEstimate = result.bytes
        }
      }
    } catch {
      // API 不可用或被阻止，使用估算值
    }
  }

  /**
   * 基于页数更新内存估算
   */
  private updateMemoryEstimate(pages: number): void {
    if (!this.lastMemoryEstimate) {
      // 使用经验值估算
      this.lastMemoryEstimate = pages * ESTIMATED_MEMORY_PER_PAGE
    }
  }

  // --------------------------------------------------------------------------
  // Health Check
  // --------------------------------------------------------------------------

  /**
   * 检查 Worker 健康状态
   */
  private checkHealth(): void {
    if (this.isRestarting) return

    const metrics = this.getMetrics()
    let status: HealthStatus = 'healthy'
    let message = 'Worker is operating normally'

    // 检查是否需要重启
    if (metrics.needsRestart) {
      status = 'critical'
      message = metrics.restartReason ?? 'Critical health issue detected'
      this.isRestarting = true
    } else if (metrics.healthScore < 50) {
      status = 'warning'
      message = 'Worker performance degradation detected'
    }

    this.notifyListeners({ status, metrics, message })
  }

  /**
   * 获取当前健康指标
   */
  getMetrics(): HealthMetrics {
    const records = this.compilationRecords
    const recentRecords = records.slice(-10) // 最近 10 次

    // 计算平均编译时间
    const avgCompileTime = records.length > 0
      ? records.reduce((sum, r) => sum + r.compileTime, 0) / records.length
      : 0

    // 最近一次记录
    const lastRecord = records[records.length - 1]

    // 统计错误和 Panic
    const recentErrorCount = recentRecords.filter(r => r.hasError).length
    const recentPanicCount = recentRecords.filter(r => r.hasPanic).length

    // 最大 artifact 大小
    const maxArtifactSize = records.length > 0
      ? Math.max(...records.map(r => r.artifactSize))
      : 0

    // 最大页数
    const maxPages = records.length > 0
      ? Math.max(...records.map(r => r.estimatedPages))
      : 0

    // Worker 运行时长
    const workerUptime = Date.now() - this.workerStartTime

    // 计算健康评分
    const healthScore = this.calculateHealthScore({
      avgCompileTime,
      lastCompileTime: lastRecord?.compileTime ?? 0,
      maxPages,
      recentErrorCount,
      recentPanicCount,
      maxArtifactSize,
      workerUptime,
    })

    // 判断是否需要重启
    const { needsRestart, restartReason } = this.shouldRestart({
      maxPages,
      maxArtifactSize,
      recentPanicCount,
      avgCompileTime,
      lastCompileTime: lastRecord?.compileTime ?? 0,
      workerUptime,
      recentErrorCount,
      totalRecords: recentRecords.length,
    })

    return {
      lastCompileTime: lastRecord?.compileTime ?? 0,
      avgCompileTime,
      lastArtifactSize: lastRecord?.artifactSize ?? 0,
      maxArtifactSize,
      estimatedPages: maxPages,
      recentErrorCount,
      recentPanicCount,
      workerUptime,
      totalCompilations: records.length,
      estimatedMemory: this.lastMemoryEstimate,
      healthScore,
      needsRestart,
      restartReason,
    }
  }

  /**
   * 计算健康评分 (0-100)
   */
  private calculateHealthScore(params: {
    avgCompileTime: number
    lastCompileTime: number
    maxPages: number
    recentErrorCount: number
    recentPanicCount: number
    maxArtifactSize: number
    workerUptime: number
  }): number {
    let score = 100

    // 编译时间惩罚
    if (params.lastCompileTime > params.avgCompileTime * 2 && params.avgCompileTime > 0) {
      score -= 15
    }

    // 页数惩罚
    if (params.maxPages > CRITICAL_PAGE_THRESHOLD) {
      score -= 25
    } else if (params.maxPages > WARNING_PAGE_THRESHOLD) {
      score -= 10
    }

    // 错误惩罚
    score -= params.recentErrorCount * 5

    // Panic 惩罚
    score -= params.recentPanicCount * 10

    // Artifact 大小惩罚
    if (params.maxArtifactSize > CRITICAL_ARTIFACT_SIZE) {
      score -= 20
    }

    // 运行时长惩罚（长时间运行可能导致内存泄漏）
    if (params.workerUptime > MAX_WORKER_UPTIME * 0.8) {
      score -= 10
    }

    return Math.max(0, Math.min(100, score))
  }

  /**
   * 判断是否需要重启
   */
  private shouldRestart(params: {
    maxPages: number
    maxArtifactSize: number
    recentPanicCount: number
    avgCompileTime: number
    lastCompileTime: number
    workerUptime: number
    recentErrorCount: number
    totalRecords: number
  }): { needsRestart: boolean; restartReason: string | null } {
    // 条件 1: 超大文档（100+ 页）
    if (params.maxPages > CRITICAL_PAGE_THRESHOLD) {
      return {
        needsRestart: true,
        restartReason: `Large document detected (${params.maxPages} pages). Restarting to free memory.`,
      }
    }

    // 条件 2: Artifact 过大
    if (params.maxArtifactSize > CRITICAL_ARTIFACT_SIZE) {
      const sizeMB = (params.maxArtifactSize / (1024 * 1024)).toFixed(1)
      return {
        needsRestart: true,
        restartReason: `Large artifact size (${sizeMB}MB). Restarting to free memory.`,
      }
    }

    // 条件 3: 频繁 Panic
    if (params.recentPanicCount >= PANIC_COUNT_THRESHOLD) {
      return {
        needsRestart: true,
        restartReason: `Too many panics (${params.recentPanicCount}). Restarting worker.`,
      }
    }

    // 条件 4: 编译时间异常增长
    if (
      params.avgCompileTime > 0 &&
      params.lastCompileTime > params.avgCompileTime * COMPILE_TIME_SPIKE_RATIO &&
      params.lastCompileTime > 5000 // 至少 5 秒
    ) {
      return {
        needsRestart: true,
        restartReason: `Compile time spike detected (${Math.round(params.lastCompileTime)}ms vs avg ${Math.round(params.avgCompileTime)}ms). Possible memory pressure.`,
      }
    }

    // 条件 5: Worker 运行时间过长
    if (params.workerUptime > MAX_WORKER_UPTIME) {
      return {
        needsRestart: true,
        restartReason: `Worker uptime exceeded ${Math.round(MAX_WORKER_UPTIME / 60000)} minutes. Preventive restart.`,
      }
    }

    // 条件 6: 高错误率
    if (params.totalRecords >= 5) {
      const errorRate = params.recentErrorCount / params.totalRecords
      if (errorRate > ERROR_RATE_THRESHOLD) {
        return {
          needsRestart: true,
          restartReason: `High error rate (${Math.round(errorRate * 100)}%). Restarting worker.`,
        }
      }
    }

    return { needsRestart: false, restartReason: null }
  }

  // --------------------------------------------------------------------------
  // Listeners
  // --------------------------------------------------------------------------

  /**
   * 订阅健康状态变化
   */
  onHealthChange(listener: HealthListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 通知所有监听器
   */
  private notifyListeners(event: HealthStatusEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[WorkerHealthMonitor] Listener error:', error)
      }
    }
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  /**
   * 清理资源
   */
  dispose(): void {
    if (this.memoryCheckInterval) {
      clearInterval(this.memoryCheckInterval)
      this.memoryCheckInterval = null
    }
    this.listeners.clear()
    this.compilationRecords = []
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const WorkerHealthMonitor = new WorkerHealthMonitorImpl()

export default WorkerHealthMonitor

