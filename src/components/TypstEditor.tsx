/**
 * TypstEditor - 主编辑器组件
 * 
 * 集成源码编辑器和实时预览，支持防抖编译
 */

import { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { useTypstCompiler } from '../hooks'
import { useDebouncedCallback } from '../utils/useDebounce'
import { TypstPreview } from './TypstPreview'

// ============================================================================
// Constants
// ============================================================================

const DEBOUNCE_DELAY = 400 // ms

const DEFAULT_SOURCE = `#set page(width: 15cm, height: auto, margin: 1.5cm)
#set text(size: 11pt)

= Welcome to Typst

This is a *live preview* editor powered by _Typst WASM_.

== Features

- Real-time compilation
- Browser-based rendering  
- No server required

== Math Support

The quadratic formula:

$ x = (-b plus.minus sqrt(b^2 - 4 a c)) / (2 a) $

#v(1em)

#align(center)[
  #text(fill: gray, size: 9pt)[Built with React + Vite + Typst.ts]
]
`

// ============================================================================
// Sub-components
// ============================================================================

interface StatusBarProps {
  status: string
  artifactSize: number | null
  compileTime: number | null
}

function StatusBar({ status, artifactSize, compileTime }: StatusBarProps) {
  return (
    <div className="editor-status-bar">
      <div className="status-left">
        <span className={`status-dot status-${status}`} />
        <span className="status-text">{status}</span>
      </div>
      <div className="status-right">
        {compileTime !== null && (
          <span className="compile-time">{compileTime}ms</span>
        )}
        {artifactSize !== null && (
          <span className="artifact-size">{(artifactSize / 1024).toFixed(1)} KB</span>
        )}
      </div>
    </div>
  )
}

interface LoadingOverlayProps {
  message: string
}

function LoadingOverlay({ message }: LoadingOverlayProps) {
  return (
    <div className="loading-overlay">
      <div className="loading-spinner" />
      <p>{message}</p>
    </div>
  )
}

interface ErrorDisplayProps {
  message: string
  onDismiss?: () => void
}

function ErrorDisplay({ message, onDismiss }: ErrorDisplayProps) {
  return (
    <div className="error-display">
      <div className="error-content">
        <span className="error-icon">⚠</span>
        <span className="error-message">{message}</span>
      </div>
      {onDismiss && (
        <button className="error-dismiss" onClick={onDismiss}>×</button>
      )}
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

export function TypstEditor() {
  const { compile, incrementalCompile, status, error, isReady, reset } = useTypstCompiler()
  
  const [source, setSource] = useState(DEFAULT_SOURCE)
  const [artifact, setArtifact] = useState<Uint8Array | null>(null)
  const [compileTime, setCompileTime] = useState<number | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)

  // 是否使用增量编译（首次编译后启用）
  const hasCompiledOnce = useRef(false)

  // 执行编译
  const doCompile = useCallback(async (src: string) => {
    if (!isReady || !src.trim()) return

    const startTime = performance.now()
    
    // 使用增量编译提升性能（首次编译使用完整编译）
    const result = hasCompiledOnce.current
      ? await incrementalCompile('/main.typ', src)
      : await compile(src)
    
    const endTime = performance.now()

    setCompileTime(Math.round(endTime - startTime))

    if (result.artifact) {
      hasCompiledOnce.current = true
      setArtifact(result.artifact)
      setLocalError(null)
    } else if (result.hasError && result.diagnostics.length > 0) {
      // 保留上次成功的 artifact，显示编译错误
      const firstError = result.diagnostics.find(d => d.severity === 'error')
      setLocalError(firstError?.message ?? 'Compilation failed')
    }
  }, [compile, incrementalCompile, isReady])

  // 防抖编译
  const debouncedCompile = useDebouncedCallback(doCompile, DEBOUNCE_DELAY)

  // 源码变化时触发防抖编译
  useEffect(() => {
    if (isReady) {
      debouncedCompile(source)
    }
  }, [source, isReady, debouncedCompile])

  // 初始编译（编译器就绪后立即编译一次）
  useEffect(() => {
    if (isReady && !artifact) {
      doCompile(source)
    }
  }, [isReady]) // eslint-disable-line react-hooks/exhaustive-deps

  // 处理源码输入
  const handleSourceChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setSource(e.target.value)
  }

  // 手动触发编译
  const handleManualCompile = () => {
    doCompile(source)
  }

  // 清除本地错误
  const dismissError = () => {
    setLocalError(null)
  }

  // 重置编译器（用于文档全量重载）
  // @ts-expect-error - Reserved for future use (document reload functionality)
  const _handleReset = useCallback(async () => {
    await reset()
    hasCompiledOnce.current = false
    // 重新编译当前源码
    doCompile(source)
  }, [reset, source, doCompile])

  const displayError = error?.message ?? localError

  return (
    <div className="typst-editor">
      <StatusBar 
        status={status} 
        artifactSize={artifact?.byteLength ?? null}
        compileTime={compileTime}
      />

      {displayError && (
        <ErrorDisplay 
          message={displayError} 
          onDismiss={localError ? dismissError : undefined}
        />
      )}

      <div className="editor-layout">
        {/* 源码编辑器 */}
        <div className="editor-pane source-pane">
          <div className="pane-header">
            <h3>Source</h3>
            <button 
              className="compile-btn"
              onClick={handleManualCompile}
              disabled={!isReady || status === 'compiling'}
            >
              {status === 'compiling' ? 'Compiling...' : 'Compile'}
            </button>
          </div>
          <textarea
            className="source-textarea"
            value={source}
            onChange={handleSourceChange}
            placeholder="Enter Typst source code..."
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>

        {/* 预览区 */}
        <div className="editor-pane preview-pane">
          <div className="pane-header">
            <h3>Preview</h3>
          </div>
          <div className="preview-container">
            {status === 'initializing' ? (
              <LoadingOverlay message="Loading Typst Engine..." />
            ) : status === 'compiling' && !artifact ? (
              <LoadingOverlay message="Compiling..." />
            ) : artifact ? (
              <Suspense fallback={<LoadingOverlay message="Rendering..." />}>
                <div className="preview-scroll">
                  <TypstPreview artifact={artifact} backgroundColor="#ffffff" />
                </div>
              </Suspense>
            ) : (
              <div className="preview-empty">
                <p>Enter Typst code to see preview</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default TypstEditor

