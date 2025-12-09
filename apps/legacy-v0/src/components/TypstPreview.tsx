/**
 * TypstPreview - Typst 文档预览组件
 * 
 * 使用 @myriaddreamin/typst.react 的 TypstDocument 组件进行渲染
 * 该组件经过优化，能正确处理 vector 格式的 artifact
 * 
 * 修复说明 (v3.0):
 * - 切换到 TypstDocument 组件，修复 SVG/Canvas 渲染 panic 问题
 * - 使用官方推荐的渲染方式，确保兼容性
 */

import { useState, useEffect, memo, useMemo } from 'react'
import { TypstDocument } from '@myriaddreamin/typst.react'

// ============================================================================
// Types
// ============================================================================

interface TypstPreviewProps {
  artifact: Uint8Array | null
  backgroundColor?: string
}

// ============================================================================
// Module-level State
// ============================================================================

/** 重置渲染状态 - 允许用户手动重试 */
export function resetRenderingState(): void {
  console.log('[TypstPreview] Rendering state reset')
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * 检查 Uint8Array 是否有效
 */
function isValidArtifact(artifact: Uint8Array): boolean {
  try {
    if (artifact.buffer.byteLength === 0 || artifact.byteLength === 0) {
      return false
    }
    if (artifact.byteLength < 100) {
      console.warn('[TypstPreview] Artifact too small:', artifact.byteLength, 'bytes')
      return false
    }
    
    let hasNonZero = false
    const checkLength = Math.min(artifact.byteLength, 64)
    for (let i = 0; i < checkLength; i++) {
      if (artifact[i] !== 0) {
        hasNonZero = true
        break
      }
    }
    if (!hasNonZero) {
      console.warn('[TypstPreview] Artifact appears to be empty')
      return false
    }
    
    return true
  } catch (e) {
    console.warn('[TypstPreview] Artifact validation error:', e)
    return false
  }
}

// ============================================================================
// Component
// ============================================================================

function TypstPreviewImpl({ artifact, backgroundColor = '#ffffff' }: TypstPreviewProps) {
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  
  // Keep a stable copy of the artifact
  const stableArtifact = useMemo(() => {
    if (!artifact || !isValidArtifact(artifact)) {
      return null
    }
    // Create a copy to prevent detachment issues
    const copy = new Uint8Array(artifact.length)
    copy.set(artifact)
    return copy
  }, [artifact])

  useEffect(() => {
    if (stableArtifact) {
      setIsLoading(false)
      setError(null)
    }
  }, [stableArtifact])


  if (!stableArtifact) {
    return (
      <div 
        className="typst-preview-container"
        style={{ background: backgroundColor }}
      >
        <div className="preview-empty">
          Waiting for content...
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="typst-preview-error">
        <span>Render Error: {error}</span>
      </div>
    )
  }

  return (
    <div 
      className="typst-preview-container"
      style={{ 
        background: backgroundColor,
        minHeight: '200px',
      }}
    >
      {isLoading && (
        <div className="typst-preview-loading">
          Rendering...
        </div>
      )}
      <TypstDocument 
        artifact={stableArtifact}
      />
    </div>
  )
}

export const TypstPreview = memo(TypstPreviewImpl)

export default TypstPreview
