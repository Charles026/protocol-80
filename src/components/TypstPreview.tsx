/**
 * TypstPreview - 自定义 Typst 文档预览组件
 * 
 * 直接使用 typst.ts 的渲染器 API，避免 TypstDocument 组件的样式问题
 */

import { useEffect, useRef, useState } from 'react'
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
let renderingLock = false

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
 * 带锁的渲染函数，防止并发渲染导致 Rust 借用错误
 */
async function renderWithLock(
  renderer: TypstRenderer,
  artifact: Uint8Array,
  container: HTMLElement
): Promise<void> {
  // 等待之前的渲染完成
  while (renderingLock) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  
  renderingLock = true
  try {
    await renderer.renderToSvg({
      artifactContent: artifact,
      format: 'vector',
      container,
    })
  } finally {
    renderingLock = false
  }
}

// ============================================================================
// Component
// ============================================================================

export function TypstPreview({ artifact, backgroundColor = '#ffffff' }: TypstPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const renderContainerRef = useRef<HTMLDivElement | null>(null)
  const [isRendering, setIsRendering] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      return
    }

    let cancelled = false

    const render = async () => {
      setIsRendering(true)
      setError(null)

      try {
        const renderer = await getOrInitRenderer()
        
        if (cancelled) return

        // 清空之前的内容
        renderTarget.innerHTML = ''

        // 使用带锁的渲染，防止并发冲突
        await renderWithLock(renderer, artifact, renderTarget)

        if (!cancelled) {
          setIsRendering(false)
        }
      } catch (err) {
        if (!cancelled) {
          const errorMsg = err instanceof Error ? err.message : 'Render failed'
          // 忽略 Rust 借用错误（通常是临时并发问题）
          if (!errorMsg.includes('ownership') && !errorMsg.includes('borrowed')) {
            setError(errorMsg)
          }
          setIsRendering(false)
        }
      }
    }

    render()

    return () => {
      cancelled = true
    }
  }, [artifact, backgroundColor])

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

