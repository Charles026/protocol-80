/**
 * DebugOverlay - 调试可视化覆盖层组件
 * 
 * 在预览 Canvas 之上渲染一个 SVG 层，用于显示：
 * - 元素边界框（block, heading, figure 等）
 * - 间距信息
 * - 布局调试信息
 * 
 * 设计原则：
 * 1. pointer-events: none - 不阻止底层交互
 * 2. 使用 SVG 绘制半透明矩形
 * 3. 不同元素类型使用不同颜色
 * 4. 支持缩放和滚动同步
 */

import { useMemo, memo } from 'react'
import type { DebugBox, DebugBoxType } from '../workers/types'
import { DEBUG_BOX_COLORS, DEBUG_BOX_BORDER_COLORS } from '../workers/types'
import { CoordinateTransformer } from '../utils'

// ============================================================================
// Types
// ============================================================================

export interface DebugOverlayProps {
  /** 调试框数据 */
  debugBoxes: DebugBox[]
  /** 坐标转换器（用于 pt → px 转换） */
  transformer: CoordinateTransformer
  /** 容器宽度（CSS 像素） */
  width: number
  /** 容器高度（CSS 像素） */
  height: number
  /** 是否显示标签 */
  showLabels?: boolean
  /** 仅显示特定类型的框 */
  filterTypes?: DebugBoxType[]
  /** 当前显示的页码（0 表示显示所有页） */
  currentPage?: number
}

interface DebugRectProps {
  box: DebugBox
  transformer: CoordinateTransformer
  showLabel: boolean
}

// ============================================================================
// Sub-components
// ============================================================================

/**
 * 单个调试矩形
 */
const DebugRect = memo(function DebugRect({ 
  box, 
  transformer, 
  showLabel 
}: DebugRectProps) {
  // 转换坐标
  const pxPerPt = transformer.getCssPixelsPerPoint()
  const x = box.x * pxPerPt
  const y = box.y * pxPerPt
  const width = box.width * pxPerPt
  const height = box.height * pxPerPt

  const fillColor = DEBUG_BOX_COLORS[box.type] || DEBUG_BOX_COLORS.unknown
  const strokeColor = DEBUG_BOX_BORDER_COLORS[box.type] || DEBUG_BOX_BORDER_COLORS.unknown

  return (
    <g className="debug-rect">
      {/* 矩形框 */}
      <rect
        x={x}
        y={y}
        width={Math.max(width, 1)}
        height={Math.max(height, 1)}
        fill={fillColor}
        stroke={strokeColor}
        strokeWidth={1}
        strokeDasharray={box.type === 'par' ? '2,2' : 'none'}
      />
      
      {/* 类型标签 */}
      {showLabel && width > 30 && height > 12 && (
        <text
          x={x + 2}
          y={y + 10}
          fontSize="9px"
          fontFamily="monospace"
          fill={strokeColor}
          style={{ userSelect: 'none' }}
        >
          {box.type}
        </text>
      )}
    </g>
  )
})

// ============================================================================
// Main Component
// ============================================================================

/**
 * 调试覆盖层
 * 
 * 渲染一个 SVG 层，显示所有调试框。
 * 使用 pointer-events: none 确保不阻止底层交互。
 * 
 * @example
 * ```tsx
 * <DebugOverlay
 *   debugBoxes={debugBoxes}
 *   transformer={transformer}
 *   width={800}
 *   height={600}
 *   showLabels
 * />
 * ```
 */
export function DebugOverlay({
  debugBoxes,
  transformer,
  width,
  height,
  showLabels = false,
  filterTypes,
  currentPage = 0,
}: DebugOverlayProps) {
  // 过滤调试框
  const filteredBoxes = useMemo(() => {
    let boxes = debugBoxes

    // 按类型过滤
    if (filterTypes && filterTypes.length > 0) {
      boxes = boxes.filter(box => filterTypes.includes(box.type))
    }

    // 按页码过滤
    if (currentPage > 0) {
      boxes = boxes.filter(box => box.page === currentPage)
    }

    return boxes
  }, [debugBoxes, filterTypes, currentPage])

  // 如果没有数据，不渲染
  if (filteredBoxes.length === 0) {
    return null
  }

  return (
    <svg
      className="debug-overlay"
      width={width}
      height={height}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        pointerEvents: 'none',
        zIndex: 10,
        overflow: 'visible',
      }}
    >
      {/* 调试框 */}
      {filteredBoxes.map((box, index) => (
        <DebugRect
          key={`debug-${box.type}-${box.page}-${index}`}
          box={box}
          transformer={transformer}
          showLabel={showLabels}
        />
      ))}
    </svg>
  )
}

// ============================================================================
// Debug Controls Component
// ============================================================================

export interface DebugControlsProps {
  /** 是否启用调试模式 */
  enabled: boolean
  /** 切换调试模式 */
  onToggle: () => void
  /** 是否显示标签 */
  showLabels: boolean
  /** 切换标签显示 */
  onToggleLabels: () => void
  /** 当前过滤的类型 */
  filterTypes: DebugBoxType[]
  /** 设置过滤类型 */
  onSetFilterTypes: (types: DebugBoxType[]) => void
  /** 调试框数量 */
  boxCount: number
}

const ALL_DEBUG_TYPES: DebugBoxType[] = [
  'block', 'heading', 'figure', 'table', 'code', 'list', 'enum', 'par'
]

/**
 * 调试控制面板
 * 
 * 提供调试模式的开关和过滤选项
 */
export function DebugControls({
  enabled,
  onToggle,
  showLabels,
  onToggleLabels,
  filterTypes,
  onSetFilterTypes,
  boxCount,
}: DebugControlsProps) {
  const handleTypeToggle = (type: DebugBoxType) => {
    if (filterTypes.includes(type)) {
      onSetFilterTypes(filterTypes.filter(t => t !== type))
    } else {
      onSetFilterTypes([...filterTypes, type])
    }
  }

  const handleSelectAll = () => {
    onSetFilterTypes([...ALL_DEBUG_TYPES])
  }

  const handleSelectNone = () => {
    onSetFilterTypes([])
  }

  return (
    <div className="debug-controls">
      <div className="debug-controls-header">
        <label className="debug-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={onToggle}
          />
          <span>Debug Mode</span>
        </label>
        
        {enabled && (
          <span className="debug-box-count">
            {boxCount} boxes
          </span>
        )}
      </div>

      {enabled && (
        <div className="debug-controls-body">
          <label className="debug-toggle">
            <input
              type="checkbox"
              checked={showLabels}
              onChange={onToggleLabels}
            />
            <span>Show Labels</span>
          </label>

          <div className="debug-type-filters">
            <div className="debug-filter-actions">
              <button onClick={handleSelectAll} className="debug-filter-btn">
                All
              </button>
              <button onClick={handleSelectNone} className="debug-filter-btn">
                None
              </button>
            </div>
            
            <div className="debug-type-list">
              {ALL_DEBUG_TYPES.map(type => (
                <label 
                  key={type} 
                  className="debug-type-item"
                  style={{
                    '--type-color': DEBUG_BOX_COLORS[type],
                    '--type-border': DEBUG_BOX_BORDER_COLORS[type],
                  } as React.CSSProperties}
                >
                  <input
                    type="checkbox"
                    checked={filterTypes.includes(type)}
                    onChange={() => handleTypeToggle(type)}
                  />
                  <span 
                    className="debug-type-swatch"
                    style={{
                      backgroundColor: DEBUG_BOX_COLORS[type],
                      borderColor: DEBUG_BOX_BORDER_COLORS[type],
                    }}
                  />
                  <span>{type}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default DebugOverlay

