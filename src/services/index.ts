/**
 * Services Index
 * 
 * 导出所有服务模块
 */

export { FontService } from './FontService'
export type { FontDescriptor, FontLoadResult, FontCategory } from './FontService'

export { TypstWorkerService } from './TypstWorkerService'
export type {
  CompileOptions,
  CompileResult,
  WorkerStatus,
  WorkerStatusEvent,
  StatusListener,
  IntrospectionListener,
} from './TypstWorkerService'

// Re-export introspection types from workers/types
export type {
  TypstLocation,
  TypstRect,
  SourceMarker,
  IntrospectionData,
  DebugBox,
  DebugBoxType,
} from '../workers/types'

// Re-export debug box colors
export {
  DEBUG_BOX_COLORS,
  DEBUG_BOX_BORDER_COLORS,
} from '../workers/types'

