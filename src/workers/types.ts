/**
 * Typst Worker Message Protocol
 * 
 * 定义主线程与 Worker 之间的通信协议
 * 遵循严格的类型安全原则
 */

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
// Outline / Semantic Extraction Types
// ============================================================================

/**
 * 文档标题项
 * 由 Typst query(heading) 生成
 */
export interface OutlineHeading {
  /** 标题级别 (1-6) */
  level: number
  /** 标题文本内容 */
  body: string
  /** 所在页码 */
  page: number
  /** Y 坐标（pt），用于页面内定位 */
  y: number
}

/**
 * 文档图表项
 * 由 Typst query(figure) 生成
 */
export interface OutlineFigure {
  /** 图表类型 (image, table, raw 等) */
  kind: string
  /** 图表标题/描述 */
  caption: string
  /** 图表编号 */
  number: number
  /** 所在页码 */
  page: number
  /** Y 坐标（pt），用于页面内定位 */
  y: number
}

/**
 * 文档大纲数据
 * 包含标题、图表等结构化信息
 */
export interface OutlineData {
  /** 所有标题 */
  headings: OutlineHeading[]
  /** 所有图表 */
  figures: OutlineFigure[]
  /** 文档总页数 */
  pageCount: number
}

/**
 * 大纲数据响应 - 编译成功后主动推送
 */
export interface OutlineResponse {
  type: 'outline_result'
  /** 关联的编译请求 ID */
  id: string
  /** 大纲数据 */
  payload: OutlineData
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
// Worker Messages (Main Thread → Worker)
// ============================================================================

/**
 * 初始化编译器
 */
export interface InitMessage {
  type: 'init'
  id: string
}

/**
 * 编译文档
 */
export interface CompileMessage {
  type: 'compile'
  id: string
  payload: {
    source: string
    mainFilePath: string
    format: 'vector' | 'pdf'
  }
}

/**
 * 增量更新文档
 */
export interface IncrementalUpdateMessage {
  type: 'incremental_update'
  id: string
  payload: {
    path: string
    content: string
  }
}

/**
 * 重置编译器状态
 */
export interface ResetMessage {
  type: 'reset'
  id: string
}

/**
 * 完全销毁编译器（释放 WASM 内存）
 */
export interface DisposeMessage {
  type: 'dispose'
  id: string
}

/**
 * 添加字体数据（响应字体请求）
 */
export interface AddFontMessage {
  type: 'add_font'
  id: string
  payload: FontResponse
}

/**
 * 所有可能的主线程消息类型
 */
export type MainToWorkerMessage =
  | InitMessage
  | CompileMessage
  | IncrementalUpdateMessage
  | ResetMessage
  | DisposeMessage
  | AddFontMessage

// ============================================================================
// Worker Responses (Worker → Main Thread)
// ============================================================================

/**
 * 诊断消息
 */
export interface DiagnosticMessage {
  package: string
  path: string
  severity: 'error' | 'warning' | 'info' | 'hint'
  range: string
  message: string
}

/**
 * 初始化成功响应
 */
export interface InitSuccessResponse {
  type: 'init_success'
  id: string
}

/**
 * 初始化失败响应
 */
export interface InitErrorResponse {
  type: 'init_error'
  id: string
  error: string
}

/**
 * 编译成功响应
 */
export interface CompileSuccessResponse {
  type: 'compile_success'
  id: string
  payload: {
    /** Vector artifact 数据（Transferable） */
    artifact: Uint8Array
    /** 编译诊断信息 */
    diagnostics: DiagnosticMessage[]
  }
}

/**
 * 编译失败响应（但编译器状态正常）
 */
export interface CompileErrorResponse {
  type: 'compile_error'
  id: string
  payload: {
    /** 错误消息 */
    error: string
    /** 编译诊断信息 */
    diagnostics: DiagnosticMessage[]
  }
}

/**
 * 重置成功响应
 */
export interface ResetSuccessResponse {
  type: 'reset_success'
  id: string
}

/**
 * 字体请求 - Worker 请求主线程加载字体
 */
export interface FontRequestMessage {
  type: 'font_request'
  id: string
  payload: FontRequest
}

/**
 * Worker 就绪状态
 */
export interface ReadyMessage {
  type: 'ready'
}

// ============================================================================
// Worker Health Metrics
// ============================================================================

/**
 * Worker 健康指标 - 用于内存监控和软重启决策
 */
export interface WorkerHealthMetrics {
  /** 编译时间 (ms) */
  compileTime: number
  /** Artifact 大小 (bytes) */
  artifactSize: number
  /** 估算页数 */
  estimatedPages: number
  /** 是否发生错误 */
  hasError: boolean
  /** 是否发生 Panic */
  hasPanic: boolean
  /** Worker 启动时间戳 */
  workerStartTime: number
  /** 累计编译次数 */
  totalCompilations: number
}

/**
 * 健康指标上报 - Worker 主动推送
 */
export interface HealthMetricsMessage {
  type: 'health_metrics'
  payload: WorkerHealthMetrics
}

/**
 * 内省数据响应 - 编译成功后主动推送
 * 包含所有追踪标记的位置信息，用于实现源码-预览同步
 */
export interface IntrospectionResponse {
  type: 'introspection_result'
  /** 关联的编译请求 ID */
  id: string
  /** 内省数据 */
  payload: IntrospectionData
}

/**
 * 所有可能的 Worker 响应类型
 */
export type WorkerToMainMessage =
  | InitSuccessResponse
  | InitErrorResponse
  | CompileSuccessResponse
  | CompileErrorResponse
  | ResetSuccessResponse
  | FontRequestMessage
  | ReadyMessage
  | IntrospectionResponse
  | OutlineResponse
  | HealthMetricsMessage

// ============================================================================
// Helper Types
// ============================================================================

/**
 * 提取消息 ID 的辅助类型
 */
export type MessageId<T extends { id?: string }> = T extends { id: infer U } ? U : never

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

