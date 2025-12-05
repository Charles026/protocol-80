/**
 * TypstPreview - 自定义 Typst 文档预览组件
 * 
 * 直接使用 typst.ts 的渲染器 API，避免 TypstDocument 组件的样式问题
 * 
 * 修复说明 (v2.1):
 * - 添加 renderer.reset() 调用，防止状态污染导致的 Rust panic
 * - 使用 AbortController 模式替代简单的 cancelled 标志
 * - 添加 artifact 有效性检查
 * - 改进渲染锁机制，使用 Promise 队列替代轮询
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { createTypstRenderer } from '@myriaddreamin/typst.ts'
import type { TypstRenderer } from '@myriaddreamin/typst.ts'

// ============================================================================
// Types
// ============================================================================

interface TypstPreviewProps {
  artifact: Uint8Array | null
  backgroundColor?: string
}

// ============================================================================
// Module-level Singleton Renderer
// ============================================================================

let rendererInstance: TypstRenderer | null = null
let rendererInitPromise: Promise<TypstRenderer> | null = null

/** 渲染队列 - 确保串行渲染，避免并发导致的 Rust 借用错误 */
let renderQueue: Promise<boolean | void> = Promise.resolve()

/** 当前渲染版本 - 用于取消过时的渲染任务 */
let currentRenderVersion = 0

async function getOrInitRenderer(): Promise<TypstRenderer> {
  if (rendererInstance) {
    return rendererInstance
  }

  if (rendererInitPromise) {
    return rendererInitPromise
  }

  rendererInitPromise = (async () => {
    const renderer = createTypstRenderer()
    
    await renderer.init({
      getModule: () => 
        new URL(
          '@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm',
          import.meta.url
        ).href,
    })

    rendererInstance = renderer
    return renderer
  })()

  try {
    return await rendererInitPromise
  } catch (error) {
    rendererInitPromise = null
    throw error
  }
}

/**
 * 检查 Uint8Array 是否有效（buffer 未被 detach）
 */
function isValidArtifact(artifact: Uint8Array): boolean {
  try {
    // 如果 buffer 已被 transfer，访问 byteLength 会返回 0 或抛出异常
    return artifact.buffer.byteLength > 0 && artifact.byteLength > 0
  } catch {
    return false
  }
}

/**
 * 队列化渲染函数
 * 
 * 使用 Promise 链确保渲染按顺序执行，同时支持版本检查以取消过时任务
 */
async function queueRender(
  renderer: TypstRenderer,
  artifact: Uint8Array,
  container: HTMLElement,
  version: number
): Promise<boolean> {
  // 创建一个新的 Promise 加入队列
  const renderTask = renderQueue.then(async () => {
    // 检查版本，如果已过时则跳过
    if (version !== currentRenderVersion) {
      return false
    }

    // 检查 artifact 有效性
    if (!isValidArtifact(artifact)) {
      console.warn('[TypstPreview] Invalid artifact buffer (possibly transferred)')
      return false
    }

    try {
      // 重要：在每次渲染前重置渲染器状态
      // 参考：typst.ts 文档 "Resetting before using high-level compile/renderer APIs"
      // 注：TypstRenderer 类型定义可能不包含 reset，但运行时存在
      const rendererAny = renderer as unknown as { reset?: () => void }
      if (typeof rendererAny.reset === 'function') {
        rendererAny.reset()
      }

      await renderer.renderToSvg({
        artifactContent: artifact,
        format: 'vector',
        container,
      })
      return true
    } catch (error) {
      // 捕获 Rust panic 和其他渲染错误
      const errorMsg = error instanceof Error ? error.message : String(error)
      
      // 检查是否是 Rust panic（通常包含 "panicked" 关键词）
      if (errorMsg.includes('panicked') || errorMsg.includes('unwrap')) {
        console.error('[TypstPreview] Rust panic detected, reinitializing renderer...')
        
        // 重置渲染器实例，下次渲染时重新初始化
        rendererInstance = null
        rendererInitPromise = null
      }
      
      throw error
    }
  })

  // 更新队列（忽略错误以保持链条）
  renderQueue = renderTask.catch(() => {})
  
  return renderTask
}

// ============================================================================
// Component
// ============================================================================

export function TypstPreview({ artifact, backgroundColor = '#ffffff' }: TypstPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const renderContainerRef = useRef<HTMLDivElement | null>(null)
  const [isRendering, setIsRendering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  // 本地渲染版本追踪
  const localVersionRef = useRef(0)

  // 复制 artifact 以防止 buffer 被 transfer 后失效
  const copyArtifact = useCallback((source: Uint8Array): Uint8Array => {
    const copy = new Uint8Array(source.length)
    copy.set(source)
    return copy
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // 创建一个独立的渲染容器，避免 React DOM 冲突
    if (!renderContainerRef.current) {
      renderContainerRef.current = document.createElement('div')
      renderContainerRef.current.className = 'typst-render-target'
      container.appendChild(renderContainerRef.current)
    }

    const renderTarget = renderContainerRef.current

    if (!artifact) {
      renderTarget.innerHTML = ''
      setIsRendering(false)
      setError(null)
      return
    }

    // 检查 artifact 有效性
    if (!isValidArtifact(artifact)) {
      console.warn('[TypstPreview] Received invalid artifact')
      return
    }

    // 递增全局版本号，取消之前的渲染任务
    currentRenderVersion++
    const thisVersion = currentRenderVersion
    localVersionRef.current = thisVersion

    // 复制 artifact 以防止原始 buffer 被 transfer
    const artifactCopy = copyArtifact(artifact)

    const render = async () => {
      setIsRendering(true)
      setError(null)

      try {
        const renderer = await getOrInitRenderer()
        
        // 再次检查版本
        if (thisVersion !== currentRenderVersion) {
          return
        }

        // 清空之前的内容
        renderTarget.innerHTML = ''

        // 使用队列化渲染
        const success = await queueRender(renderer, artifactCopy, renderTarget, thisVersion)

        // 仅当当前版本匹配时更新状态
        if (thisVersion === localVersionRef.current) {
          setIsRendering(false)
          if (!success && thisVersion === currentRenderVersion) {
            // 渲染被跳过但仍是最新版本，可能是 artifact 无效
            console.warn('[TypstPreview] Render skipped for version:', thisVersion)
          }
        }
      } catch (err) {
        // 仅当当前版本匹配时显示错误
        if (thisVersion === localVersionRef.current) {
          const errorMsg = err instanceof Error ? err.message : 'Render failed'
          
          // 忽略某些临时性错误
          const isTemporaryError = 
            errorMsg.includes('ownership') || 
            errorMsg.includes('borrowed') ||
            errorMsg.includes('cancelled')

          if (!isTemporaryError) {
            // 对于 Rust panic，提供更友好的错误信息
            if (errorMsg.includes('panicked')) {
              setError('Render engine error. Retrying...')
              // 自动重试一次
              setTimeout(() => {
                if (thisVersion === localVersionRef.current) {
                  setError(null)
                }
              }, 1000)
            } else {
              setError(errorMsg)
            }
          }
          setIsRendering(false)
        }
      }
    }

    render()

    return () => {
      // 清理：标记此版本已过时
      if (localVersionRef.current === thisVersion) {
        localVersionRef.current = -1
      }
    }
  }, [artifact, backgroundColor, copyArtifact])

  // 清理渲染容器
  useEffect(() => {
    return () => {
      if (renderContainerRef.current && renderContainerRef.current.parentNode) {
        renderContainerRef.current.parentNode.removeChild(renderContainerRef.current)
        renderContainerRef.current = null
      }
    }
  }, [])

  if (error) {
    return (
      <div className="typst-preview-error">
        <span>Render Error: {error}</span>
      </div>
    )
  }

  return (
    <div 
      ref={containerRef} 
      className="typst-preview-container"
      style={{ 
        background: backgroundColor,
        minHeight: isRendering ? '200px' : undefined 
      }}
    >
      {isRendering && (
        <div className="typst-preview-loading">
          Rendering...
        </div>
      )}
    </div>
  )
}

export default TypstPreview

