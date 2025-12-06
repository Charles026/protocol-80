/**
 * useTypstCompiler - Typst WASM 编译器生命周期管理 Hook
 *
 * 设计原则：
 * 1. Worker 模式：编译器运行在 Web Worker 中，主线程零阻塞
 * 2. IncrementalServer：支持增量编译，提高性能
 * 3. 类型安全：严格定义输入输出类型
 * 4. 生命周期管理：正确处理 reset() 防止内存泄漏
 * 
 * 架构变更（v2.0）：
 * - 从直接调用 TypstCompiler 改为通过 TypstWorkerService
 * - 编译操作不再阻塞主线程
 * - 字体按需加载，不预加载所有字体
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  TypstWorkerService,
  type CompileResult,
  type WorkerStatus,
} from '../services'

// ============================================================================
// Types
// ============================================================================

/**
 * 编译器状态（映射自 WorkerStatus）
 */
export type CompilerStatus =
  | 'idle'           // 初始状态
  | 'initializing'   // 正在初始化 WASM
  | 'ready'          // 就绪，可以编译
  | 'compiling'      // 正在编译
  | 'error'          // 发生错误

/**
 * 诊断消息类型（来自 Typst 编译器）
 */
export interface DiagnosticMessage {
  package: string
  path: string
  severity: 'error' | 'warning' | 'info' | 'hint'
  range: string
  message: string
}

/**
 * 编译错误类型
 */
export interface CompileError {
  /** 错误类型标识 */
  type: 'init_error' | 'compile_error' | 'source_error'
  /** 人类可读的错误消息 */
  message: string
  /** 原始错误对象（如果存在） */
  cause?: unknown
  /** Typst 诊断信息（仅编译错误时存在） */
  diagnostics?: DiagnosticMessage[]
}

/**
 * 编译选项
 */
export interface UseTypstCompileOptions {
  /**
   * 输出格式
   * @default 'vector'
   */
  format?: 'vector' | 'pdf'
  /**
   * 主文件路径
   * @default '/main.typ'
   */
  mainFilePath?: string
}

/**
 * Hook 返回类型
 */
export interface UseTypstCompilerReturn {
  /** 当前编译器状态 */
  status: CompilerStatus
  /** 编译函数 */
  compile: (source: string, options?: UseTypstCompileOptions) => Promise<CompileResult>
  /** 增量更新编译 */
  incrementalCompile: (path: string, content: string) => Promise<CompileResult>
  /** 最近一次错误 */
  error: CompileError | null
  /** 重置编译器状态（用于文档全量重载） */
  reset: () => Promise<void>
  /** 编译器是否就绪 */
  isReady: boolean
}

// ============================================================================
// Status Mapping
// ============================================================================

/**
 * 将 WorkerStatus 映射到 CompilerStatus
 */
function mapWorkerStatus(status: WorkerStatus): CompilerStatus {
  switch (status) {
    case 'uninitialized':
      return 'idle'
    case 'initializing':
      return 'initializing'
    case 'ready':
      return 'ready'
    case 'compiling':
      return 'compiling'
    case 'disposed':
    case 'worker_error':
      return 'error'
    default:
      return 'idle'
  }
}

// ============================================================================
// External Store for Worker Status
// ============================================================================

/**
 * 使用 useSyncExternalStore 订阅 Worker 状态
 * 这确保了状态更新与 React 18 并发特性兼容
 */
function subscribeToWorkerStatus(callback: () => void): () => void {
  return TypstWorkerService.onStatusChange(callback)
}

function getWorkerStatusSnapshot(): CompilerStatus {
  return mapWorkerStatus(TypstWorkerService.getStatus())
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * useTypstCompiler - 管理 Typst WASM 编译器的 React Hook
 *
 * @example
 * ```tsx
 * function Editor() {
 *   const { compile, status, error, isReady } = useTypstCompiler()
 *
 *   const handleCompile = async () => {
 *     if (!isReady) return
 *     const result = await compile('#set page(width: 10cm)\nHello, Typst!')
 *     if (result.artifact) {
 *       // 使用 artifact 渲染文档
 *     }
 *   }
 *
 *   return (
 *     <div>
 *       <p>Status: {status}</p>
 *       {error && <p>Error: {error.message}</p>}
 *       <button onClick={handleCompile} disabled={!isReady}>
 *         Compile
 *       </button>
 *     </div>
 *   )
 * }
 * ```
 */
export function useTypstCompiler(): UseTypstCompilerReturn {
  const [error, setError] = useState<CompileError | null>(null)

  // 使用 useSyncExternalStore 订阅 Worker 状态
  // 这比手动 useState + useEffect 更高效且并发安全
  const status = useSyncExternalStore(
    subscribeToWorkerStatus,
    getWorkerStatusSnapshot,
    getWorkerStatusSnapshot // SSR 快照（相同）
  )

  // 使用 ref 跟踪组件挂载状态
  const isMountedRef = useRef(true)

  // 组件挂载时初始化编译器
  useEffect(() => {
    let active = true

    const initCompiler = async () => {
      if (!active || TypstWorkerService.isReady()) return // 已初始化或已卸载

      try {
        await TypstWorkerService.init()
      } catch (err) {
        if (active) {
          setError({
            type: 'init_error',
            message: `Failed to initialize Typst compiler: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          })
        }
      }
    }

    initCompiler()

    // Cleanup on unmount
    return () => {
      active = false
      // NOTE: Do NOT dispose singleton worker here
      // Worker lifetime is managed by the service, not by individual consumers
      // Disposing here causes "Worker not available" on re-mount (React Strict Mode/HMR)
    }
  }, [])

  /**
   * 编译 Typst 源码
   */
  const compile = useCallback(
    async (source: string, options?: UseTypstCompileOptions): Promise<CompileResult> => {
      // 前置检查
      if (!source || typeof source !== 'string') {
        const err: CompileError = {
          type: 'source_error',
          message: 'Invalid source: source must be a non-empty string.',
        }
        setError(err)
        return { artifact: null, diagnostics: [], hasError: true }
      }

      setError(null)

      try {
        const result = await TypstWorkerService.compile(source, {
          mainFilePath: options?.mainFilePath ?? '/main.typ',
          format: options?.format ?? 'vector',
        })

        // 处理编译错误
        if (result.hasError && isMountedRef.current) {
          const firstError = result.diagnostics.find(d => d.severity === 'error')
          setError({
            type: 'compile_error',
            message: firstError?.message ?? 'Compilation failed',
            diagnostics: result.diagnostics as DiagnosticMessage[],
          })
        }

        return {
          artifact: result.artifact,
          diagnostics: result.diagnostics as DiagnosticMessage[],
          hasError: result.hasError,
        }
      } catch (err) {
        if (isMountedRef.current) {
          const compileError: CompileError = {
            type: 'compile_error',
            message: `Compilation failed: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          }
          setError(compileError)
        }

        return {
          artifact: null,
          diagnostics: [],
          hasError: true,
        }
      }
    },
    []
  )

  /**
   * 增量更新编译
   * 
   * 用于编辑器实时预览场景，只更新变化的文件
   */
  const incrementalCompile = useCallback(
    async (path: string, content: string): Promise<CompileResult> => {
      if (!content || typeof content !== 'string') {
        const err: CompileError = {
          type: 'source_error',
          message: 'Invalid content: content must be a non-empty string.',
        }
        setError(err)
        return { artifact: null, diagnostics: [], hasError: true }
      }

      setError(null)

      try {
        const result = await TypstWorkerService.incrementalUpdate(path, content)

        if (result.hasError && isMountedRef.current) {
          const firstError = result.diagnostics.find(d => d.severity === 'error')
          setError({
            type: 'compile_error',
            message: firstError?.message ?? 'Incremental compilation failed',
            diagnostics: result.diagnostics as DiagnosticMessage[],
          })
        }

        return {
          artifact: result.artifact,
          diagnostics: result.diagnostics as DiagnosticMessage[],
          hasError: result.hasError,
        }
      } catch (err) {
        if (isMountedRef.current) {
          setError({
            type: 'compile_error',
            message: `Incremental compilation failed: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          })
        }

        return {
          artifact: null,
          diagnostics: [],
          hasError: true,
        }
      }
    },
    []
  )

  /**
   * 重置编译器状态
   * 
   * 在文档全量重载时调用：
   * - 清理内部编译状态
   * - 防止内存泄漏
   * - 重置 shadow 文件系统
   */
  const reset = useCallback(async () => {
    try {
      await TypstWorkerService.reset()
      setError(null)
    } catch (err) {
      if (isMountedRef.current) {
        setError({
          type: 'init_error',
          message: `Failed to reset compiler: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        })
      }
    }
  }, [])

  return {
    status,
    compile,
    incrementalCompile,
    error,
    reset,
    isReady: status === 'ready',
  }
}

export default useTypstCompiler
