/**
 * Hooks - 自定义 React Hooks 统一导出
 */

export {
  useTypstCompiler,
  type CompilerStatus,
  type CompileError,
  type UseTypstCompileOptions,
  type UseTypstCompilerReturn,
  type DiagnosticMessage,
} from './useTypstCompiler'

export {
  useDebugOverlay,
  extractDebugBoxes,
  type UseDebugOverlayOptions,
  type UseDebugOverlayReturn,
} from './useDebugOverlay'

export {
  useResilientWorker,
  type UseResilientWorkerReturn,
  type CompileOptions,
} from './useResilientWorker'

// Introspection hooks (Protocol 80 MVP)
export {
  useIntrospection,
  useGeoProbes,
  useStructProbes,
  useSemanticProbes,
  useStructureTree,
  useHeadings,
  usePageProbes,
  type UseIntrospectionOptions,
  type UseIntrospectionResult,
} from './useIntrospection'

// Re-export CompileResult from services for backwards compatibility
export type { CompileResult } from '../services'

// Re-export WorkerState from bridge types
export type { WorkerState } from '../types/bridge.d'

