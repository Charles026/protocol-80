/**
 * Workers Index
 * 
 * 导出 Worker 相关类型（不导出 Worker 文件本身）
 * 
 * NOTE: Types are now unified in bridge.d.ts and re-exported from types.ts
 */

export type {
  // FSM States
  WorkerState,
  
  // Message Types (Unified Protocol v2.0)
  MainToWorkerMessage,
  WorkerToMainMessage,
  
  // Inbound Messages
  InitMessage,
  CompileMessage,
  HeartbeatMessage,
  ResetMessage,
  DisposeMessage,
  
  // Outbound Messages
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
  
  // Worker-specific Types
  CompilerState,
  PendingRequest,
  FontRequest,
  FontResponse,
  
  // Location Types
  TypstLocation,
  TypstRect,
  SourceMarker,
  IntrospectionData,
  
  // Debug Types
  DebugBoxType,
  DebugBox,
  
  // Query Types
  TypstHeadingQueryResult,
  TypstFigureQueryResult,
} from './types'

// Re-export utilities
export {
  assertNever,
  isCompileSuccess,
  isPanic,
  isHeartbeatAck,
  isOutlineResult,
  sendToWorker,
  postWorkerResponse,
  WorkerCrashedError,
  DEBUG_BOX_COLORS,
  DEBUG_BOX_BORDER_COLORS,
} from './types'
