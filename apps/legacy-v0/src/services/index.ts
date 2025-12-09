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
  OutlineListener,
  HealthStatusListener,
  SoftRestartEvent,
  SoftRestartListener,
} from './TypstWorkerService'

export { WorkerHealthMonitor } from './WorkerHealthMonitor'
export type {
  HealthMetrics,
  CompilationRecord,
  HealthStatus,
  HealthStatusEvent,
  HealthListener,
} from './WorkerHealthMonitor'

// IntrospectionService (Protocol 80 MVP)
export {
  IntrospectionService,
  createIntrospectionService,
  introspectionService,
} from './IntrospectionService'
export type {
  ProbeQueryOptions,
  ProbeBoundingBox,
  StructureNode,
} from './IntrospectionService'

// Re-export Probe types from bridge
export type {
  ProbeLocation,
  ProbeType,
  ProbeAnchor,
  ProbeEdge,
  ProbeBase,
  GeoProbe,
  StructProbe,
  SemanticProbe,
  Probe,
  ProbeData,
} from '../types/bridge.d'

export {
  isGeoProbe,
  isStructProbe,
  isSemanticProbe,
  isProbeResult,
} from '../types/bridge.d'

// Re-export introspection types from workers/types
export type {
  TypstLocation,
  TypstRect,
  SourceMarker,
  IntrospectionData,
  DebugBox,
  DebugBoxType,
  WorkerHealthMetrics,
} from '../workers/types'

// Re-export debug box colors
export {
  DEBUG_BOX_COLORS,
  DEBUG_BOX_BORDER_COLORS,
} from '../workers/types'

