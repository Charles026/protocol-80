/**
 * WorkerHealthIndicator - Worker 健康状态指示器
 * 
 * 显示 Worker 的健康状态和关键指标，
 * 在检测到问题时提供视觉反馈。
 */

import { useState, useEffect, useCallback } from 'react'
import { TypstWorkerService } from '../services/TypstWorkerService'
import { WorkerHealthMonitor } from '../services/WorkerHealthMonitor'
import type { HealthStatus, HealthMetrics, HealthStatusEvent, SoftRestartEvent } from '../services'

// ============================================================================
// Types
// ============================================================================

interface WorkerHealthIndicatorProps {
  /** 是否显示详细信息 */
  showDetails?: boolean
  /** 是否紧凑模式 */
  compact?: boolean
}

// ============================================================================
// Constants
// ============================================================================

const STATUS_CONFIG: Record<HealthStatus, { color: string; label: string; icon: string }> = {
  healthy: { color: 'var(--color-success, #10b981)', label: 'Healthy', icon: '✓' },
  warning: { color: 'var(--color-warning, #f59e0b)', label: 'Warning', icon: '⚠' },
  critical: { color: 'var(--color-error, #ef4444)', label: 'Critical', icon: '✗' },
  restarting: { color: 'var(--color-accent, #3b82f6)', label: 'Restarting', icon: '↻' },
}

// ============================================================================
// Component
// ============================================================================

export function WorkerHealthIndicator({ 
  showDetails = false, 
  compact = true 
}: WorkerHealthIndicatorProps) {
  const [healthStatus, setHealthStatus] = useState<HealthStatus>('healthy')
  const [metrics, setMetrics] = useState<HealthMetrics | null>(null)
  const [isExpanded, setIsExpanded] = useState(false)
  const [lastRestartEvent, setLastRestartEvent] = useState<SoftRestartEvent | null>(null)
  const [showRestartNotice, setShowRestartNotice] = useState(false)

  // 订阅健康状态变化
  useEffect(() => {
    const unsubscribeHealth = TypstWorkerService.onHealthChange((event: HealthStatusEvent) => {
      setHealthStatus(event.status)
      setMetrics(event.metrics)
    })

    const unsubscribeRestart = TypstWorkerService.onSoftRestart((event: SoftRestartEvent) => {
      setLastRestartEvent(event)
      setShowRestartNotice(true)
      
      // 5 秒后隐藏重启通知
      setTimeout(() => setShowRestartNotice(false), 5000)
    })

    // 初始加载
    setHealthStatus(TypstWorkerService.getHealthStatus())
    setMetrics(WorkerHealthMonitor.getMetrics())

    return () => {
      unsubscribeHealth()
      unsubscribeRestart()
    }
  }, [])

  // 格式化时间
  const formatDuration = useCallback((ms: number): string => {
    if (ms < 1000) return `${Math.round(ms)}ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
    return `${Math.round(ms / 60000)}m`
  }, [])

  // 格式化大小
  const formatSize = useCallback((bytes: number): string => {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  }, [])

  const config = STATUS_CONFIG[healthStatus]

  // 紧凑模式：只显示状态点
  if (compact && !showDetails) {
    return (
      <div 
        className="worker-health-compact"
        title={`Worker: ${config.label}${metrics ? ` | Score: ${metrics.healthScore}` : ''}`}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span 
          className="health-dot"
          style={{ backgroundColor: config.color }}
        />
        {showRestartNotice && (
          <span className="restart-notice">Worker restarted</span>
        )}
      </div>
    )
  }

  return (
    <div className={`worker-health-indicator ${healthStatus}`}>
      {/* 状态头部 */}
      <div 
        className="health-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span 
          className="health-icon"
          style={{ color: config.color }}
        >
          {config.icon}
        </span>
        <span className="health-label">{config.label}</span>
        {metrics && (
          <span className="health-score">
            {metrics.healthScore}%
          </span>
        )}
        <span className="expand-toggle">
          {isExpanded ? '▼' : '▶'}
        </span>
      </div>

      {/* 重启通知 */}
      {showRestartNotice && lastRestartEvent && (
        <div className="restart-notification">
          <span className="restart-icon">↻</span>
          <span className="restart-message">
            Worker restarted: {lastRestartEvent.reason}
          </span>
        </div>
      )}

      {/* 详细指标 */}
      {isExpanded && metrics && (
        <div className="health-details">
          <div className="metric-row">
            <span className="metric-label">Uptime:</span>
            <span className="metric-value">{formatDuration(metrics.workerUptime)}</span>
          </div>
          <div className="metric-row">
            <span className="metric-label">Compilations:</span>
            <span className="metric-value">{metrics.totalCompilations}</span>
          </div>
          <div className="metric-row">
            <span className="metric-label">Avg Compile:</span>
            <span className="metric-value">{formatDuration(metrics.avgCompileTime)}</span>
          </div>
          <div className="metric-row">
            <span className="metric-label">Est. Pages:</span>
            <span className="metric-value">{metrics.estimatedPages}</span>
          </div>
          <div className="metric-row">
            <span className="metric-label">Max Artifact:</span>
            <span className="metric-value">{formatSize(metrics.maxArtifactSize)}</span>
          </div>
          {metrics.estimatedMemory && (
            <div className="metric-row">
              <span className="metric-label">Memory:</span>
              <span className="metric-value">{formatSize(metrics.estimatedMemory)}</span>
            </div>
          )}
          <div className="metric-row">
            <span className="metric-label">Errors:</span>
            <span className={`metric-value ${metrics.recentErrorCount > 0 ? 'error' : ''}`}>
              {metrics.recentErrorCount}
            </span>
          </div>
          <div className="metric-row">
            <span className="metric-label">Panics:</span>
            <span className={`metric-value ${metrics.recentPanicCount > 0 ? 'error' : ''}`}>
              {metrics.recentPanicCount}
            </span>
          </div>
          
          {/* 手动重启按钮 */}
          <button 
            className="manual-restart-btn"
            onClick={() => TypstWorkerService.manualSoftRestart('Manual restart by user')}
            disabled={TypstWorkerService.isSoftRestartInProgress()}
          >
            {TypstWorkerService.isSoftRestartInProgress() ? 'Restarting...' : 'Restart Worker'}
          </button>
        </div>
      )}
    </div>
  )
}

export default WorkerHealthIndicator

