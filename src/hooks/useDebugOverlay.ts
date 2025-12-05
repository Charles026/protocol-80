/**
 * useDebugOverlay - 调试覆盖层状态管理 Hook
 * 
 * 管理调试模式的开关、过滤类型等状态。
 * 提供与 DebugOverlay 组件配合使用的状态和操作。
 */

import { useState, useCallback, useMemo } from 'react'
import type { DebugBox, DebugBoxType } from '../workers/types'
import { CoordinateTransformer, createDomTransformer } from '../utils'

// ============================================================================
// Types
// ============================================================================

export interface UseDebugOverlayOptions {
  /** 初始是否启用 */
  initialEnabled?: boolean
  /** 初始是否显示标签 */
  initialShowLabels?: boolean
  /** 初始过滤类型 */
  initialFilterTypes?: DebugBoxType[]
  /** 初始缩放比例 */
  initialScale?: number
}

export interface UseDebugOverlayReturn {
  /** 是否启用调试模式 */
  enabled: boolean
  /** 切换启用状态 */
  toggleEnabled: () => void
  /** 设置启用状态 */
  setEnabled: (enabled: boolean) => void
  
  /** 是否显示标签 */
  showLabels: boolean
  /** 切换标签显示 */
  toggleShowLabels: () => void
  
  /** 当前过滤的类型 */
  filterTypes: DebugBoxType[]
  /** 设置过滤类型 */
  setFilterTypes: (types: DebugBoxType[]) => void
  /** 切换单个类型 */
  toggleFilterType: (type: DebugBoxType) => void
  
  /** 坐标转换器 */
  transformer: CoordinateTransformer
  /** 设置缩放比例 */
  setScale: (scale: number) => void
  
  /** 当前页码过滤 (0 = 全部) */
  currentPage: number
  /** 设置当前页码 */
  setCurrentPage: (page: number) => void
}

// ============================================================================
// Default Values
// ============================================================================

const DEFAULT_FILTER_TYPES: DebugBoxType[] = [
  'block', 'heading', 'figure', 'table', 'code', 'list', 'enum'
]

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * 调试覆盖层状态管理 Hook
 * 
 * @example
 * ```tsx
 * const debug = useDebugOverlay({ initialEnabled: true })
 * 
 * return (
 *   <>
 *     <DebugControls
 *       enabled={debug.enabled}
 *       onToggle={debug.toggleEnabled}
 *       showLabels={debug.showLabels}
 *       onToggleLabels={debug.toggleShowLabels}
 *       filterTypes={debug.filterTypes}
 *       onSetFilterTypes={debug.setFilterTypes}
 *       boxCount={debugBoxes.length}
 *     />
 *     {debug.enabled && (
 *       <DebugOverlay
 *         debugBoxes={debugBoxes}
 *         transformer={debug.transformer}
 *         width={width}
 *         height={height}
 *         showLabels={debug.showLabels}
 *         filterTypes={debug.filterTypes}
 *         currentPage={debug.currentPage}
 *       />
 *     )}
 *   </>
 * )
 * ```
 */
export function useDebugOverlay(options: UseDebugOverlayOptions = {}): UseDebugOverlayReturn {
  const {
    initialEnabled = false,
    initialShowLabels = false,
    initialFilterTypes = DEFAULT_FILTER_TYPES,
    initialScale = 1.0,
  } = options

  // 状态
  const [enabled, setEnabled] = useState(initialEnabled)
  const [showLabels, setShowLabels] = useState(initialShowLabels)
  const [filterTypes, setFilterTypes] = useState<DebugBoxType[]>(initialFilterTypes)
  const [currentPage, setCurrentPage] = useState(0)
  const [scale, setScaleState] = useState(initialScale)

  // 坐标转换器（缓存）
  const transformer = useMemo(() => {
    return createDomTransformer(scale)
  }, [scale])

  // 操作函数
  const toggleEnabled = useCallback(() => {
    setEnabled(prev => !prev)
  }, [])

  const toggleShowLabels = useCallback(() => {
    setShowLabels(prev => !prev)
  }, [])

  const toggleFilterType = useCallback((type: DebugBoxType) => {
    setFilterTypes(prev => {
      if (prev.includes(type)) {
        return prev.filter(t => t !== type)
      } else {
        return [...prev, type]
      }
    })
  }, [])

  const setScale = useCallback((newScale: number) => {
    if (newScale > 0) {
      setScaleState(newScale)
      transformer.setScale(newScale)
    }
  }, [transformer])

  return {
    enabled,
    toggleEnabled,
    setEnabled,
    showLabels,
    toggleShowLabels,
    filterTypes,
    setFilterTypes,
    toggleFilterType,
    transformer,
    setScale,
    currentPage,
    setCurrentPage,
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * 从原始内省数据中提取调试框
 * 
 * 解析 typst query 返回的 metadata 数据，提取 debug-box 类型的条目
 */
export function extractDebugBoxes(queryResult: string): DebugBox[] {
  try {
    const data = JSON.parse(queryResult)
    
    if (!Array.isArray(data)) {
      return []
    }

    return data
      .filter((item: any) => item?.value?.kind === 'debug-box')
      .map((item: any) => {
        const v = item.value
        return {
          type: (v.type || 'unknown') as DebugBoxType,
          page: typeof v.page === 'number' ? v.page : 1,
          x: extractPtValue(v.x),
          y: extractPtValue(v.y),
          width: extractPtValue(v.w),
          height: extractPtValue(v.h),
        }
      })
  } catch {
    return []
  }
}

/**
 * 提取 pt 值
 * 
 * Typst 返回的长度值可能是 { pt: number } 格式或直接数字
 */
function extractPtValue(value: unknown): number {
  if (typeof value === 'number') {
    return value
  }
  if (typeof value === 'object' && value !== null && 'pt' in value) {
    return (value as { pt: number }).pt
  }
  return 0
}

export default useDebugOverlay

