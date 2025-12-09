/**
 * CoordinateTransformer - Typst/Web 坐标系转换工具
 * 
 * 设计原则：
 * 1. 处理 Typst Points (pt) 与 Web Pixels (px) 之间的转换
 * 2. 考虑 devicePixelRatio 以支持高分辨率屏幕
 * 3. 支持缩放和偏移变换
 * 
 * 坐标系说明：
 * - Typst: 使用 Points (pt)，1 inch = 72 pt
 * - Web: 使用 Pixels (px)，通常 96 DPI（CSS 像素）
 * - 物理像素: CSS 像素 * devicePixelRatio
 * 
 * 转换公式：
 * Px = Pt * (DPI / 72) * ScaleFactor
 * 
 * 其中：
 * - DPI: 通常为 96（CSS 标准）
 * - ScaleFactor: 用户自定义缩放（如 zoom level）
 */

import type { TypstLocation, TypstRect, SourceMarker } from '../workers/types'

// ============================================================================
// Types
// ============================================================================

/**
 * Web 坐标位置（像素）
 */
export interface WebPosition {
  /** X 坐标（CSS 像素） */
  x: number
  /** Y 坐标（CSS 像素） */
  y: number
}

/**
 * Web 矩形区域（像素）
 */
export interface WebRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 转换器配置选项
 */
export interface CoordinateTransformerOptions {
  /** 
   * 基础 DPI，默认 96（CSS 标准）
   * 这是 CSS 像素的基准，不要与物理 DPI 混淆
   */
  baseDpi?: number
  
  /**
   * 用户缩放比例，默认 1.0
   * 用于实现自定义缩放功能
   */
  scale?: number
  
  /**
   * 是否自动考虑 devicePixelRatio
   * 默认 true - 在计算时自动乘以 devicePixelRatio
   * 设为 false 时返回 CSS 像素（不含物理像素转换）
   */
  useDevicePixelRatio?: boolean
  
  /**
   * 页面偏移量（用于多页滚动视图）
   * 键为页码（从 1 开始），值为 Y 偏移（CSS 像素）
   */
  pageOffsets?: Map<number, number>
  
  /**
   * 容器左上角在页面中的偏移
   */
  containerOffset?: WebPosition
}

// ============================================================================
// Constants
// ============================================================================

/** Typst 标准：1 inch = 72 Points */
const POINTS_PER_INCH = 72

/** CSS 标准：1 inch = 96 CSS Pixels */
const CSS_PIXELS_PER_INCH = 96

// ============================================================================
// CoordinateTransformer Class
// ============================================================================

/**
 * 坐标转换器
 * 
 * 用于在 Typst 文档坐标系和 Web 像素坐标系之间进行转换
 * 
 * @example
 * ```ts
 * const transformer = new CoordinateTransformer({ scale: 1.5 })
 * 
 * // Typst 坐标转 Web 像素
 * const webPos = transformer.typstToWeb({ page: 1, x: 72, y: 144 })
 * // { x: 144, y: 288 } (at scale 1.5)
 * 
 * // Web 像素转 Typst 坐标
 * const typstPos = transformer.webToTypst({ x: 144, y: 288 }, 1)
 * // { page: 1, x: 72, y: 144 }
 * ```
 */
export class CoordinateTransformer {
  private readonly baseDpi: number
  private scale: number
  private useDevicePixelRatio: boolean
  private pageOffsets: Map<number, number>
  private containerOffset: WebPosition

  constructor(options: CoordinateTransformerOptions = {}) {
    this.baseDpi = options.baseDpi ?? CSS_PIXELS_PER_INCH
    this.scale = options.scale ?? 1.0
    this.useDevicePixelRatio = options.useDevicePixelRatio ?? true
    this.pageOffsets = options.pageOffsets ?? new Map()
    this.containerOffset = options.containerOffset ?? { x: 0, y: 0 }
  }

  // --------------------------------------------------------------------------
  // Configuration Methods
  // --------------------------------------------------------------------------

  /**
   * 设置缩放比例
   */
  setScale(scale: number): void {
    if (scale <= 0) {
      throw new Error('Scale must be positive')
    }
    this.scale = scale
  }

  /**
   * 获取当前缩放比例
   */
  getScale(): number {
    return this.scale
  }

  /**
   * 设置页面偏移量
   * 用于处理多页连续滚动视图
   */
  setPageOffset(page: number, offsetY: number): void {
    this.pageOffsets.set(page, offsetY)
  }

  /**
   * 批量设置所有页面偏移量
   */
  setAllPageOffsets(offsets: Map<number, number>): void {
    this.pageOffsets = new Map(offsets)
  }

  /**
   * 设置容器偏移量
   */
  setContainerOffset(offset: WebPosition): void {
    this.containerOffset = offset
  }

  // --------------------------------------------------------------------------
  // Conversion Methods: Typst → Web
  // --------------------------------------------------------------------------

  /**
   * 获取当前的像素/点转换比率
   * 考虑 DPI、缩放和 devicePixelRatio
   */
  getPixelsPerPoint(): number {
    const baseRatio = this.baseDpi / POINTS_PER_INCH
    const dpr = this.useDevicePixelRatio ? this.getDevicePixelRatio() : 1
    return baseRatio * this.scale * dpr
  }

  /**
   * 获取 CSS 像素/点转换比率（不含 devicePixelRatio）
   */
  getCssPixelsPerPoint(): number {
    return (this.baseDpi / POINTS_PER_INCH) * this.scale
  }

  /**
   * Points 转 CSS Pixels
   */
  ptToPx(pt: number): number {
    return pt * this.getCssPixelsPerPoint()
  }

  /**
   * CSS Pixels 转 Points
   */
  pxToPt(px: number): number {
    return px / this.getCssPixelsPerPoint()
  }

  /**
   * 将 Typst 位置转换为 Web 坐标
   * 
   * @param location - Typst 文档中的位置
   * @returns Web 坐标（CSS 像素）
   */
  typstToWeb(location: TypstLocation): WebPosition {
    const pxPerPt = this.getCssPixelsPerPoint()
    const pageOffset = this.pageOffsets.get(location.page) ?? 0

    return {
      x: location.x * pxPerPt + this.containerOffset.x,
      y: location.y * pxPerPt + pageOffset + this.containerOffset.y,
    }
  }

  /**
   * 将 Typst 矩形转换为 Web 矩形
   * 
   * @param rect - Typst 矩形 [x, y, width, height]（pt）
   * @param page - 所在页码
   * @returns Web 矩形（CSS 像素）
   */
  typstRectToWeb(rect: TypstRect, page: number): WebRect {
    const [x, y, width, height] = rect
    const pxPerPt = this.getCssPixelsPerPoint()
    const pageOffset = this.pageOffsets.get(page) ?? 0

    return {
      x: x * pxPerPt + this.containerOffset.x,
      y: y * pxPerPt + pageOffset + this.containerOffset.y,
      width: width * pxPerPt,
      height: height * pxPerPt,
    }
  }

  /**
   * 转换源码标记为 Web 坐标
   * 
   * @param marker - 源码标记
   * @returns 带 Web 坐标的标记
   */
  transformMarker(marker: SourceMarker): SourceMarker & { webRect: WebRect } {
    return {
      ...marker,
      webRect: this.typstRectToWeb(marker.rect, marker.page),
    }
  }

  /**
   * 批量转换所有标记
   */
  transformMarkers(markers: SourceMarker[]): Array<SourceMarker & { webRect: WebRect }> {
    return markers.map(m => this.transformMarker(m))
  }

  // --------------------------------------------------------------------------
  // Conversion Methods: Web → Typst
  // --------------------------------------------------------------------------

  /**
   * 将 Web 坐标转换为 Typst 位置
   * 
   * @param position - Web 坐标（CSS 像素）
   * @param page - 目标页码（用于确定 Y 偏移）
   * @returns Typst 位置
   */
  webToTypst(position: WebPosition, page: number): TypstLocation {
    const pxPerPt = this.getCssPixelsPerPoint()
    const pageOffset = this.pageOffsets.get(page) ?? 0

    return {
      page,
      x: (position.x - this.containerOffset.x) / pxPerPt,
      y: (position.y - pageOffset - this.containerOffset.y) / pxPerPt,
    }
  }

  /**
   * 根据 Y 坐标自动确定页码并转换
   * 需要提供每页的高度信息
   * 
   * @param position - Web 坐标（CSS 像素）
   * @param pageSizes - 每页尺寸 [width, height]（pt）
   * @returns Typst 位置，如果超出范围返回 null
   */
  webToTypstAuto(
    position: WebPosition,
    pageSizes: Array<[number, number]>
  ): TypstLocation | null {
    const pxPerPt = this.getCssPixelsPerPoint()
    let accumulatedY = this.containerOffset.y

    for (let i = 0; i < pageSizes.length; i++) {
      const page = i + 1
      const pageSize = pageSizes[i]
      if (!pageSize) continue
      
      const heightPt = pageSize[1]
      const heightPx = heightPt * pxPerPt
      const pageTop = accumulatedY
      const pageBottom = accumulatedY + heightPx

      if (position.y >= pageTop && position.y < pageBottom) {
        return {
          page,
          x: (position.x - this.containerOffset.x) / pxPerPt,
          y: (position.y - pageTop) / pxPerPt,
        }
      }

      accumulatedY = pageBottom
    }

    // 超出最后一页
    return null
  }

  // --------------------------------------------------------------------------
  // Hit Testing
  // --------------------------------------------------------------------------

  /**
   * 检测点击位置命中了哪个标记
   * 
   * @param position - 点击位置（CSS 像素，相对于容器）
   * @param markers - 所有标记
   * @returns 命中的标记，如果没有命中返回 null
   */
  hitTest(
    position: WebPosition,
    markers: Array<SourceMarker & { webRect: WebRect }>
  ): SourceMarker | null {
    // 从后向前遍历（后面的元素在上层）
    for (let i = markers.length - 1; i >= 0; i--) {
      const marker = markers[i]
      if (!marker) continue
      
      const webRect = marker.webRect

      if (
        position.x >= webRect.x &&
        position.x <= webRect.x + webRect.width &&
        position.y >= webRect.y &&
        position.y <= webRect.y + webRect.height
      ) {
        return marker
      }
    }

    return null
  }

  /**
   * 查找最接近点击位置的标记
   * 
   * @param position - 点击位置（CSS 像素）
   * @param markers - 所有标记
   * @param maxDistance - 最大搜索距离（CSS 像素），默认 50
   * @returns 最近的标记，如果超出最大距离返回 null
   */
  findNearest(
    position: WebPosition,
    markers: Array<SourceMarker & { webRect: WebRect }>,
    maxDistance = 50
  ): SourceMarker | null {
    let nearest: (SourceMarker & { webRect: WebRect }) | null = null
    let minDistance = Infinity

    for (const marker of markers) {
      const webRect = marker.webRect
      const centerX = webRect.x + webRect.width / 2
      const centerY = webRect.y + webRect.height / 2

      const distance = Math.sqrt(
        Math.pow(position.x - centerX, 2) + Math.pow(position.y - centerY, 2)
      )

      if (distance < minDistance && distance <= maxDistance) {
        minDistance = distance
        nearest = marker
      }
    }

    return nearest
  }

  // --------------------------------------------------------------------------
  // Utility Methods
  // --------------------------------------------------------------------------

  /**
   * 获取当前设备像素比
   */
  getDevicePixelRatio(): number {
    if (typeof window !== 'undefined') {
      return window.devicePixelRatio || 1
    }
    return 1
  }

  /**
   * 计算将 Typst 页面填充到指定容器所需的缩放比例
   * 
   * @param pageSize - 页面尺寸 [width, height]（pt）
   * @param containerSize - 容器尺寸 [width, height]（CSS 像素）
   * @param mode - 缩放模式：'fit' 完全包含，'cover' 完全覆盖，'width' 宽度适配
   * @returns 所需的缩放比例
   */
  calculateFitScale(
    pageSize: [number, number],
    containerSize: [number, number],
    mode: 'fit' | 'cover' | 'width' = 'fit'
  ): number {
    const baseRatio = this.baseDpi / POINTS_PER_INCH
    const pageW = pageSize[0]
    const pageH = pageSize[1]
    const containerW = containerSize[0]
    const containerH = containerSize[1]

    const pageWPx = pageW * baseRatio
    const pageHPx = pageH * baseRatio

    const scaleX = containerW / pageWPx
    const scaleY = containerH / pageHPx

    switch (mode) {
      case 'fit':
        return Math.min(scaleX, scaleY)
      case 'cover':
        return Math.max(scaleX, scaleY)
      case 'width':
        return scaleX
      default:
        return Math.min(scaleX, scaleY)
    }
  }

  /**
   * 创建转换器的快照（用于调试）
   */
  toDebugString(): string {
    return JSON.stringify({
      baseDpi: this.baseDpi,
      scale: this.scale,
      useDevicePixelRatio: this.useDevicePixelRatio,
      devicePixelRatio: this.getDevicePixelRatio(),
      pxPerPt: this.getCssPixelsPerPoint(),
      containerOffset: this.containerOffset,
      pageOffsetsCount: this.pageOffsets.size,
    }, null, 2)
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * 创建默认配置的转换器
 */
export function createTransformer(options?: CoordinateTransformerOptions): CoordinateTransformer {
  return new CoordinateTransformer(options)
}

/**
 * 创建用于 Canvas 渲染的转换器
 * 自动考虑 devicePixelRatio
 */
export function createCanvasTransformer(scale = 1.0): CoordinateTransformer {
  return new CoordinateTransformer({
    scale,
    useDevicePixelRatio: true,
  })
}

/**
 * 创建用于 DOM 元素定位的转换器
 * 不考虑 devicePixelRatio（使用 CSS 像素）
 */
export function createDomTransformer(scale = 1.0): CoordinateTransformer {
  return new CoordinateTransformer({
    scale,
    useDevicePixelRatio: false,
  })
}

export default CoordinateTransformer

