/**
 * useTypstCompiler - Typst WASM 编译器生命周期管理 Hook
 *
 * 设计原则：
 * 1. 单例模式：编译器实例在整个应用生命周期中只初始化一次
 * 2. 类型安全：严格定义输入输出类型
 * 3. 错误处理：标准化错误信息对象
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createTypstCompiler,
  type TypstCompiler,
  type CompileOptions,
  CompileFormatEnum,
} from '@myriaddreamin/typst.ts/compiler'
import { preloadFontAssets } from '@myriaddreamin/typst.ts/options.init'

// ============================================================================
// Types
// ============================================================================

/**
 * 编译器状态枚举
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
 * 编译结果类型
 */
export interface CompileResult {
  /** 编译成功时的 artifact 数据 */
  artifact: Uint8Array | null
  /** 编译诊断信息 */
  diagnostics: DiagnosticMessage[]
  /** 是否存在错误 */
  hasError: boolean
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
  /** 最近一次错误 */
  error: CompileError | null
  /** 重置编译器状态 */
  reset: () => Promise<void>
  /** 编译器是否就绪 */
  isReady: boolean
}

// ============================================================================
// Module-level Singleton
// ============================================================================

/**
 * 模块级编译器实例（单例）
 * 使用 Promise 确保并发初始化请求只执行一次
 */
let compilerInstance: TypstCompiler | null = null
let initPromise: Promise<TypstCompiler> | null = null

/**
 * 获取 WASM 模块 URL
 * 在开发环境下，从 node_modules 加载；生产环境下从静态资源加载
 */
function getWasmModuleUrl(): string {
  // 使用 import.meta.url 相对路径，让 Vite 正确处理
  return new URL(
    '@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm',
    import.meta.url
  ).href
}

/**
 * 获取或初始化编译器单例
 */
async function getOrInitCompiler(): Promise<TypstCompiler> {
  // 如果已有实例，直接返回
  if (compilerInstance) {
    return compilerInstance
  }

  // 如果正在初始化，等待初始化完成
  if (initPromise) {
    return initPromise
  }

  // 开始初始化
  initPromise = (async () => {
    const compiler = createTypstCompiler()
    
    await compiler.init({
      beforeBuild: [
        // 预加载字体：文本、CJK（中日韩）、Emoji
        preloadFontAssets({ assets: ['text', 'cjk', 'emoji'] }),
      ],
      // 显式提供 WASM 模块 URL
      getModule: () => getWasmModuleUrl(),
    })

    compilerInstance = compiler
    return compiler
  })()

  try {
    return await initPromise
  } catch (error) {
    // 初始化失败，清理状态以允许重试
    initPromise = null
    throw error
  }
}

/**
 * 重置编译器单例（用于测试或错误恢复）
 */
async function resetCompilerSingleton(): Promise<void> {
  if (compilerInstance) {
    await compilerInstance.reset()
    compilerInstance.resetShadow()
  }
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
  const [status, setStatus] = useState<CompilerStatus>('idle')
  const [error, setError] = useState<CompileError | null>(null)
  
  // 使用 ref 跟踪组件挂载状态，避免在卸载后更新状态
  const isMountedRef = useRef(true)
  // 使用 ref 存储编译器引用，避免重复获取
  const compilerRef = useRef<TypstCompiler | null>(null)

  // 组件挂载时初始化编译器
  useEffect(() => {
    isMountedRef.current = true

    const initCompiler = async () => {
      if (compilerRef.current) return // 已初始化

      setStatus('initializing')
      setError(null)

      try {
        const compiler = await getOrInitCompiler()
        
        if (isMountedRef.current) {
          compilerRef.current = compiler
          setStatus('ready')
        }
      } catch (err) {
        if (isMountedRef.current) {
          setStatus('error')
          setError({
            type: 'init_error',
            message: `Failed to initialize Typst compiler: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          })
        }
      }
    }

    initCompiler()

    return () => {
      isMountedRef.current = false
    }
  }, [])

  /**
   * 编译 Typst 源码
   */
  const compile = useCallback(
    async (source: string, options?: UseTypstCompileOptions): Promise<CompileResult> => {
      const compiler = compilerRef.current

      // 前置检查
      if (!compiler) {
        const err: CompileError = {
          type: 'init_error',
          message: 'Compiler not initialized. Please wait for initialization to complete.',
        }
        setError(err)
        return { artifact: null, diagnostics: [], hasError: true }
      }

      if (!source || typeof source !== 'string') {
        const err: CompileError = {
          type: 'source_error',
          message: 'Invalid source: source must be a non-empty string.',
        }
        setError(err)
        return { artifact: null, diagnostics: [], hasError: true }
      }

      const mainFilePath = options?.mainFilePath ?? '/main.typ'
      const format = options?.format === 'pdf' 
        ? CompileFormatEnum.pdf 
        : CompileFormatEnum.vector

      setStatus('compiling')
      setError(null)

      try {
        // 重置之前的 shadow 文件，确保干净的编译环境
        compiler.resetShadow()
        
        // 添加源文件
        compiler.addSource(mainFilePath, source)

        // 编译选项
        const compileOptions: CompileOptions<typeof format, 'full'> = {
          mainFilePath,
          format,
          diagnostics: 'full',
        }

        // 执行编译
        const result = await compiler.compile(compileOptions)

        if (isMountedRef.current) {
          setStatus('ready')
        }

        // 处理编译结果
        const diagnostics = (result.diagnostics ?? []) as DiagnosticMessage[]
        const hasError = diagnostics.some(d => d.severity === 'error')

        if (hasError && !result.result) {
          const err: CompileError = {
            type: 'compile_error',
            message: diagnostics.find(d => d.severity === 'error')?.message ?? 'Compilation failed',
            diagnostics,
          }
          if (isMountedRef.current) {
            setError(err)
          }
        }

        return {
          artifact: result.result ?? null,
          diagnostics,
          hasError,
        }
      } catch (err) {
        if (isMountedRef.current) {
          setStatus('ready') // 恢复就绪状态，允许重试
          
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
   * 重置编译器状态
   */
  const reset = useCallback(async () => {
    try {
      await resetCompilerSingleton()
      setError(null)
      if (isMountedRef.current) {
        setStatus('ready')
      }
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
    error,
    reset,
    isReady: status === 'ready',
  }
}

export default useTypstCompiler

