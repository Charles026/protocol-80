/**
 * Typst Worker Types
 * 
 * This file contains domain-specific types used by the Worker.
 * 
 * IMPORTANT: All message protocol types are defined in '../types/bridge.d.ts'
 * This file re-exports them for convenience and adds Worker-specific utility types.
 * 
 * @module workers/types
 */

// ============================================================================
// Re-export Protocol Types from Single Source of Truth
// ============================================================================

export type {
  // FSM States
  WorkerState,
  
  // Inbound Messages
  MainToWorkerMessage,
  InitMessage,
  CompileMessage,
  HeartbeatMessage,
  ResetMessage,
  DisposeMessage,
  
  // Outbound Messages
  WorkerToMainMessage,
  ReadyMessage,
  CompileSuccessMessage,
  CompileErrorMessage,
  PanicMessage,
  HeartbeatAckMessage,
  ResetSuccessMessage,
  OutlineResultMessage,
  
  // Supporting Types
  DiagnosticInfo,
  DiagnosticMessage,
  WorkerHealthMetrics,
  CompileResult,
  
  // Outline Types
  OutlineHeading,
  OutlineFigure,
  OutlineData,
} from '../types/bridge.d'

// Re-export utility functions
export {
  assertNever,
  isCompileSuccess,
  isPanic,
  isHeartbeatAck,
  isOutlineResult,
  sendToWorker,
  postWorkerResponse,
  WorkerCrashedError,
} from '../types/bridge.d'

// ============================================================================
// Coordinate and Location Types
// ============================================================================

/**
 * Typst 文档中的位置坐标
 * 使用 Points (pt) 作为单位，1 inch = 72 pt
 */
export interface TypstLocation {
  /** 页码（从 1 开始） */
  page: number
  /** X 坐标（pt） */
  x: number
  /** Y 坐标（pt） */
  y: number
}

/**
 * 矩形区域，用于表示元素的边界框
 * [x, y, width, height] - 所有值使用 Points (pt)
 */
export type TypstRect = [number, number, number, number]

/**
 * 源码位置标记
 * 用于追踪源码与渲染位置的映射
 */
export interface SourceMarker {
  /** 唯一标识符，格式为 "L{line}-C{col}" 或自定义 */
  id: string
  /** 边界框 [x, y, width, height]（pt） */
  rect: TypstRect
  /** 所在页码 */
  page: number
  /** 元素类型 */
  type?: 'heading' | 'paragraph' | 'block' | 'inline'
}

/**
 * 内省数据 - 包含所有追踪标记的位置信息
 */
export interface IntrospectionData {
  /** 所有追踪标记 */
  markers: SourceMarker[]
  /** 文档总页数 */
  totalPages: number
  /** 各页面尺寸 [width, height]（pt） */
  pageSizes: Array<[number, number]>
  /** 调试框数据（可选） */
  debugBoxes?: DebugBox[]
}

// ============================================================================
// Debug Mode Types
// ============================================================================

/**
 * 调试框元素类型
 */
export type DebugBoxType = 
  | 'block' 
  | 'heading' 
  | 'figure' 
  | 'table' 
  | 'code' 
  | 'list' 
  | 'enum' 
  | 'par'
  | 'unknown'

/**
 * 调试框数据
 * 由 introspection.typ 的调试模式生成
 */
export interface DebugBox {
  /** 元素类型 */
  type: DebugBoxType
  /** 所在页码 */
  page: number
  /** X 坐标（pt） */
  x: number
  /** Y 坐标（pt） */
  y: number
  /** 宽度（pt） */
  width: number
  /** 高度（pt） */
  height: number
}

/**
 * 调试框颜色映射
 * 不同元素类型使用不同颜色以便区分
 */
export const DEBUG_BOX_COLORS: Record<DebugBoxType, string> = {
  block: 'rgba(255, 0, 0, 0.15)',      // 红色 - 通用块
  heading: 'rgba(0, 0, 255, 0.2)',     // 蓝色 - 标题
  figure: 'rgba(0, 255, 0, 0.15)',     // 绿色 - 图表
  table: 'rgba(255, 165, 0, 0.15)',    // 橙色 - 表格
  code: 'rgba(128, 0, 128, 0.15)',     // 紫色 - 代码
  list: 'rgba(0, 255, 255, 0.15)',     // 青色 - 列表
  enum: 'rgba(255, 255, 0, 0.15)',     // 黄色 - 编号列表
  par: 'rgba(255, 192, 203, 0.1)',     // 粉色 - 段落
  unknown: 'rgba(128, 128, 128, 0.15)' // 灰色 - 未知
}

/**
 * 调试框边框颜色映射
 */
export const DEBUG_BOX_BORDER_COLORS: Record<DebugBoxType, string> = {
  block: 'rgba(255, 0, 0, 0.5)',
  heading: 'rgba(0, 0, 255, 0.6)',
  figure: 'rgba(0, 255, 0, 0.5)',
  table: 'rgba(255, 165, 0, 0.5)',
  code: 'rgba(128, 0, 128, 0.5)',
  list: 'rgba(0, 255, 255, 0.5)',
  enum: 'rgba(255, 255, 0, 0.5)',
  par: 'rgba(255, 192, 203, 0.3)',
  unknown: 'rgba(128, 128, 128, 0.5)'
}

// ============================================================================
// Font Loading Types
// ============================================================================

/**
 * 字体请求消息 - 由 Worker 发送到主线程
 */
export interface FontRequest {
  family: string
  style?: 'normal' | 'italic'
  weight?: number
}

/**
 * 字体响应 - 由主线程发送到 Worker
 */
export interface FontResponse {
  family: string
  buffer: ArrayBuffer | null
  error?: string
}

// ============================================================================
// Typst Query Result Types (for type-safe query handling)
// ============================================================================

/**
 * Typst heading query result (raw from compiler)
 */
export interface TypstHeadingQueryResult {
  level?: number
  body?: unknown
  location?: {
    page?: number
    position?: { x?: number; y?: number }
  }
}

/**
 * Typst figure query result (raw from compiler)
 */
export interface TypstFigureQueryResult {
  kind?: string
  caption?: { body?: unknown }
  location?: {
    page?: number
    position?: { x?: number; y?: number }
  }
}

// ============================================================================
// Compiler State (for TypstWorkerService)
// ============================================================================

/**
 * 编译器状态
 */
export type CompilerState = 
  | 'uninitialized'
  | 'initializing'
  | 'ready'
  | 'compiling'
  | 'disposed'

/**
 * 用于追踪待处理请求的 Promise 解析器
 */
export interface PendingRequest<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
  timeout?: ReturnType<typeof setTimeout>
}
