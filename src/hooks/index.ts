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

// Re-export CompileResult from services for backwards compatibility
export type { CompileResult } from '../services'
