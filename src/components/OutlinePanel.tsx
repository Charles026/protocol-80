/**
 * OutlinePanel - 交互式文档大纲面板
 *
 * 功能：
 * 1. 显示文档结构（标题层级）
 * 2. 显示图表列表
 * 3. 点击项目跳转到对应页面/位置
 * 4. 实时更新（编译成功后自动刷新）
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { TypstWorkerService, type OutlineHeadingNode } from '../services/TypstWorkerService'
import type { OutlineData, OutlineHeading, OutlineFigure } from '../workers/types'

// ============================================================================
// Types
// ============================================================================

interface OutlinePanelProps {
  /** 当前查看的页码（可选，用于高亮当前位置） */
  currentPage?: number
  /** 点击标题时的回调 */
  onHeadingClick?: (heading: OutlineHeading) => void
  /** 点击图表时的回调 */
  onFigureClick?: (figure: OutlineFigure) => void
  /** 面板是否展开 */
  isExpanded?: boolean
  /** 切换展开状态 */
  onToggleExpand?: () => void
}

type TabType = 'headings' | 'figures'

// ============================================================================
// Sub-components
// ============================================================================

interface HeadingItemProps {
  node: OutlineHeadingNode
  depth: number
  currentPage?: number
  onClick?: (heading: OutlineHeading) => void
}

/**
 * 标题项组件 - 递归渲染标题树
 */
function HeadingItem({ node, depth, currentPage, onClick }: HeadingItemProps) {
  const [isExpanded, setIsExpanded] = useState(true)
  const hasChildren = node.children.length > 0
  const isCurrentPage = currentPage === node.page

  const handleClick = useCallback(() => {
    onClick?.(node)
  }, [node, onClick])

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setIsExpanded(!isExpanded)
  }, [isExpanded])

  // 根据级别设置缩进和样式
  const levelStyles: Record<number, { fontSize: string; fontWeight: string; color: string }> = {
    1: { fontSize: '14px', fontWeight: '600', color: 'var(--text-primary, #1a1a1a)' },
    2: { fontSize: '13px', fontWeight: '500', color: 'var(--text-primary, #333)' },
    3: { fontSize: '12px', fontWeight: '500', color: 'var(--text-secondary, #555)' },
    4: { fontSize: '12px', fontWeight: '400', color: 'var(--text-secondary, #666)' },
    5: { fontSize: '11px', fontWeight: '400', color: 'var(--text-tertiary, #777)' },
    6: { fontSize: '11px', fontWeight: '400', color: 'var(--text-tertiary, #888)' },
  }

  const style = levelStyles[node.level] ?? levelStyles[6]

  return (
    <div className="outline-heading-container">
      <div
        className={`outline-heading-item ${isCurrentPage ? 'current-page' : ''}`}
        style={{
          paddingLeft: `${8 + depth * 12}px`,
          ...style,
        }}
        onClick={handleClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && handleClick()}
      >
        {/* 展开/折叠按钮 */}
        {hasChildren && (
          <button
            className="outline-toggle-btn"
            onClick={handleToggle}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            <span className={`toggle-icon ${isExpanded ? 'expanded' : ''}`}>›</span>
          </button>
        )}
        {!hasChildren && <span className="outline-spacer" />}

        {/* 标题文本 */}
        <span className="outline-heading-text" title={node.body}>
          {node.body}
        </span>

        {/* 页码 */}
        <span className="outline-page-number">{node.page}</span>
      </div>

      {/* 子标题 */}
      {hasChildren && isExpanded && (
        <div className="outline-children">
          {node.children.map((child, index) => (
            <HeadingItem
              key={`${child.page}-${child.y}-${index}`}
              node={child}
              depth={depth + 1}
              currentPage={currentPage}
              onClick={onClick}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface FigureItemProps {
  figure: OutlineFigure
  currentPage?: number
  onClick?: (figure: OutlineFigure) => void
}

/**
 * 图表项组件
 */
function FigureItem({ figure, currentPage, onClick }: FigureItemProps) {
  const isCurrentPage = currentPage === figure.page

  const handleClick = useCallback(() => {
    onClick?.(figure)
  }, [figure, onClick])

  // 图表类型图标
  const getIcon = (kind: string) => {
    switch (kind) {
      case 'image':
        return '🖼️'
      case 'table':
        return '📊'
      case 'raw':
        return '📝'
      default:
        return '📄'
    }
  }

  return (
    <div
      className={`outline-figure-item ${isCurrentPage ? 'current-page' : ''}`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && handleClick()}
    >
      <span className="figure-icon">{getIcon(figure.kind)}</span>
      <span className="figure-label">
        {figure.kind === 'image' ? 'Figure' : figure.kind === 'table' ? 'Table' : 'Item'}
        {figure.number > 0 && ` ${figure.number}`}
      </span>
      {figure.caption && (
        <span className="figure-caption" title={figure.caption}>
          : {figure.caption}
        </span>
      )}
      <span className="outline-page-number">{figure.page}</span>
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

export function OutlinePanel({
  currentPage,
  onHeadingClick,
  onFigureClick,
  isExpanded = true,
  onToggleExpand,
}: OutlinePanelProps) {
  const [outlineData, setOutlineData] = useState<OutlineData | null>(null)
  const [activeTab, setActiveTab] = useState<TabType>('headings')
  const [isLoading, setIsLoading] = useState(true)

  // 订阅大纲数据更新
  useEffect(() => {
    setIsLoading(true)

    const unsubscribe = TypstWorkerService.onOutlineUpdate((data) => {
      setOutlineData(data)
      setIsLoading(false)
    })

    // 如果已有缓存数据，直接使用
    const cached = TypstWorkerService.getLatestOutline()
    if (cached) {
      setOutlineData(cached)
      setIsLoading(false)
    }

    return unsubscribe
  }, [])

  // 构建标题树
  const headingTree = useMemo(() => {
    if (!outlineData) return []
    return TypstWorkerService.getHeadingTree()
  }, [outlineData])

  // 统计信息
  const stats = useMemo(() => {
    if (!outlineData) return { headings: 0, figures: 0, pages: 0 }
    return {
      headings: outlineData.headings.length,
      figures: outlineData.figures.length,
      pages: outlineData.pageCount,
    }
  }, [outlineData])

  if (!isExpanded) {
    return (
      <div className="outline-panel collapsed">
        <button className="outline-expand-btn" onClick={onToggleExpand} title="Show Outline">
          <span className="expand-icon">☰</span>
        </button>
      </div>
    )
  }

  return (
    <div className="outline-panel">
      {/* 面板头部 */}
      <div className="outline-header">
        <h3 className="outline-title">Outline</h3>
        {onToggleExpand && (
          <button className="outline-collapse-btn" onClick={onToggleExpand} title="Hide Outline">
            ✕
          </button>
        )}
      </div>

      {/* 标签切换 */}
      <div className="outline-tabs">
        <button
          className={`outline-tab ${activeTab === 'headings' ? 'active' : ''}`}
          onClick={() => setActiveTab('headings')}
        >
          Headings
          {stats.headings > 0 && <span className="tab-count">{stats.headings}</span>}
        </button>
        <button
          className={`outline-tab ${activeTab === 'figures' ? 'active' : ''}`}
          onClick={() => setActiveTab('figures')}
        >
          Figures
          {stats.figures > 0 && <span className="tab-count">{stats.figures}</span>}
        </button>
      </div>

      {/* 内容区域 */}
      <div className="outline-content">
        {isLoading ? (
          <div className="outline-loading">
            <span className="loading-spinner" />
            <span>Loading outline...</span>
          </div>
        ) : !outlineData ? (
          <div className="outline-empty">
            <p>No outline data available.</p>
            <p className="hint">Compile a document to see its structure.</p>
          </div>
        ) : activeTab === 'headings' ? (
          headingTree.length > 0 ? (
            <div className="outline-headings">
              {headingTree.map((node, index) => (
                <HeadingItem
                  key={`${node.page}-${node.y}-${index}`}
                  node={node}
                  depth={0}
                  currentPage={currentPage}
                  onClick={onHeadingClick}
                />
              ))}
            </div>
          ) : (
            <div className="outline-empty">
              <p>No headings found.</p>
              <p className="hint">Add headings using = syntax.</p>
            </div>
          )
        ) : outlineData.figures.length > 0 ? (
          <div className="outline-figures">
            {outlineData.figures.map((figure, index) => (
              <FigureItem
                key={`${figure.page}-${figure.y}-${index}`}
                figure={figure}
                currentPage={currentPage}
                onClick={onFigureClick}
              />
            ))}
          </div>
        ) : (
          <div className="outline-empty">
            <p>No figures found.</p>
            <p className="hint">Add figures using #figure().</p>
          </div>
        )}
      </div>

      {/* 页面统计 */}
      {outlineData && (
        <div className="outline-footer">
          <span className="page-count">{stats.pages} page{stats.pages !== 1 ? 's' : ''}</span>
        </div>
      )}
    </div>
  )
}

export default OutlinePanel

