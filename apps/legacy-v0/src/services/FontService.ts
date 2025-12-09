/**
 * FontService - 按需字体加载服务
 * 
 * 设计原则：
 * 1. 懒加载：只在文档需要时才加载字体
 * 2. 缓存友好：利用浏览器缓存和 IndexedDB 存储字体数据
 * 3. 带宽优化：使用 Google Fonts CSS2 API 获取最优格式
 * 4. 错误容错：字体加载失败不应阻塞编译
 */

// ============================================================================
// Types
// ============================================================================

export interface FontDescriptor {
  family: string
  style?: 'normal' | 'italic'
  weight?: number | string
}

export interface FontLoadResult {
  family: string
  buffer: ArrayBuffer | null
  error?: string
}

/**
 * 字体分类
 */
export type FontCategory = 
  | 'text'     // 基础文本字体
  | 'cjk'      // 中日韩字体
  | 'emoji'    // Emoji 字体
  | 'math'     // 数学字体
  | 'custom'   // 自定义字体

// ============================================================================
// Font Mappings
// ============================================================================

/**
 * Typst 默认字体映射到 Google Fonts
 * 
 * Typst 使用的默认字体：
 * - Linux Libertine (text) → Libertinus Serif
 * - New Computer Modern (math) → 本地提供
 * - Noto Sans CJK (CJK) → Noto Sans SC/TC/JP/KR
 */
const FONT_MAPPINGS: Record<string, string> = {
  // Text fonts
  'Linux Libertine': 'Libertinus Serif',
  'Libertinus Serif': 'Libertinus Serif',
  'New Computer Modern': 'Computer Modern Serif',
  
  // Common alternatives
  'Times New Roman': 'Times New Roman',
  'Arial': 'Arial',
  'Helvetica': 'Helvetica Neue',
  
  // CJK fonts
  'Noto Sans CJK SC': 'Noto Sans SC',
  'Noto Sans CJK TC': 'Noto Sans TC',
  'Noto Sans CJK JP': 'Noto Sans JP',
  'Noto Sans CJK KR': 'Noto Sans KR',
  'Noto Serif CJK SC': 'Noto Serif SC',
  'Noto Serif CJK TC': 'Noto Serif TC',
  'Noto Serif CJK JP': 'Noto Serif JP',
  'Noto Serif CJK KR': 'Noto Serif KR',
  
  // Direct mappings
  'Noto Sans SC': 'Noto Sans SC',
  'Noto Serif SC': 'Noto Serif SC',
  'Source Han Sans': 'Noto Sans SC',
  'Source Han Serif': 'Noto Serif SC',
}

/**
 * 预置字体集合 - 用于快速初始化
 */
const FONT_PRESETS: Record<FontCategory, string[]> = {
  text: [
    'Libertinus Serif',
  ],
  cjk: [
    'Noto Sans SC',
    'Noto Serif SC',
  ],
  emoji: [
    'Noto Color Emoji',
  ],
  math: [
    // Math fonts 通常需要从其他源加载
  ],
  custom: [],
}

// ============================================================================
// Font Cache (IndexedDB)
// ============================================================================

const DB_NAME = 'typst-fonts'
const DB_VERSION = 1
const STORE_NAME = 'font-data'

let dbPromise: Promise<IDBDatabase> | null = null

/**
 * 获取或初始化 IndexedDB
 */
async function getDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => {
      reject(new Error('Failed to open IndexedDB'))
    }

    request.onsuccess = () => {
      resolve(request.result)
    }

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'family' })
      }
    }
  })

  return dbPromise
}

/**
 * 从缓存获取字体
 */
async function getCachedFont(family: string): Promise<ArrayBuffer | null> {
  try {
    const db = await getDB()
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.get(family)

      request.onsuccess = () => {
        resolve(request.result?.buffer ?? null)
      }

      request.onerror = () => {
        resolve(null)
      }
    })
  } catch {
    return null
  }
}

/**
 * 缓存字体数据
 */
async function cacheFont(family: string, buffer: ArrayBuffer): Promise<void> {
  try {
    const db = await getDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.put({ family, buffer, timestamp: Date.now() })

      request.onsuccess = () => resolve()
      request.onerror = () => reject(new Error('Failed to cache font'))
    })
  } catch (error) {
    console.warn('[FontService] Cache write failed:', error)
  }
}

// ============================================================================
// Font Loading
// ============================================================================

/**
 * 内存缓存 - 避免重复请求
 */
const loadingPromises = new Map<string, Promise<ArrayBuffer | null>>()
const loadedFonts = new Map<string, ArrayBuffer>()

/**
 * 从 Google Fonts 获取字体 URL
 * 
 * 使用 CSS2 API 获取最优化的字体文件
 */
async function getGoogleFontUrl(family: string): Promise<string | null> {
  const encodedFamily = encodeURIComponent(family)
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodedFamily}&display=swap`

  try {
    const response = await fetch(cssUrl, {
      headers: {
        // 请求 woff2 格式
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
      },
    })

    if (!response.ok) {
      return null
    }

    const css = await response.text()
    
    // 解析 CSS 获取 woff2 URL
    const urlMatch = css.match(/url\((https:\/\/fonts\.gstatic\.com[^)]+\.woff2)\)/)
    return urlMatch?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * 从 typst.ts 资源服务器加载字体
 */
async function getTypstFontUrl(family: string): Promise<string | null> {
  // typst.ts 提供的字体资源 CDN
  const TYPST_FONT_CDN = 'https://cdn.jsdelivr.net/npm/@aspect-ratio/typst-ts-font-assets@latest/dist'
  
  // 标准化字体名称
  const normalizedName = family.toLowerCase().replace(/\s+/g, '-')
  
  // 常见字体路径映射
  const fontPaths: Record<string, string> = {
    'libertinus-serif': 'LinLibertine_R.otf',
    'linux-libertine': 'LinLibertine_R.otf',
    'new-computer-modern': 'NewCM10-Regular.otf',
  }

  const path = fontPaths[normalizedName]
  if (path) {
    return `${TYPST_FONT_CDN}/${path}`
  }

  return null
}

/**
 * 加载单个字体
 */
async function loadFontBuffer(family: string): Promise<ArrayBuffer | null> {
  // 1. 检查内存缓存
  const cached = loadedFonts.get(family)
  if (cached) return cached

  // 2. 检查 IndexedDB 缓存
  const dbCached = await getCachedFont(family)
  if (dbCached) {
    loadedFonts.set(family, dbCached)
    return dbCached
  }

  // 3. 映射到实际字体名称
  const mappedFamily = FONT_MAPPINGS[family] ?? family

  // 4. 尝试从 typst.ts 资源加载
  let fontUrl = await getTypstFontUrl(mappedFamily)

  // 5. 尝试从 Google Fonts 加载
  if (!fontUrl) {
    fontUrl = await getGoogleFontUrl(mappedFamily)
  }

  if (!fontUrl) {
    console.warn(`[FontService] No source found for font: ${family}`)
    return null
  }

  // 6. 下载字体
  try {
    const response = await fetch(fontUrl)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const buffer = await response.arrayBuffer()
    
    // 缓存到内存和 IndexedDB
    loadedFonts.set(family, buffer)
    await cacheFont(family, buffer)

    return buffer
  } catch (error) {
    console.error(`[FontService] Failed to load font ${family}:`, error)
    return null
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * FontService 单例
 */
export const FontService = {
  /**
   * 按需加载字体
   * 
   * @param family - 字体家族名称
   * @returns 字体数据 ArrayBuffer，加载失败返回 null
   */
  async loadFont(family: string): Promise<FontLoadResult> {
    // 检查是否有正在进行的请求
    const existing = loadingPromises.get(family)
    if (existing) {
      const buffer = await existing
      return { family, buffer }
    }

    // 创建新的加载 Promise
    const loadPromise = loadFontBuffer(family)
    loadingPromises.set(family, loadPromise)

    try {
      const buffer = await loadPromise
      return { family, buffer }
    } catch (error) {
      return {
        family,
        buffer: null,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      // 加载完成后清理 loading 状态（但保留缓存）
      loadingPromises.delete(family)
    }
  },

  /**
   * 预加载字体集合
   * 
   * @param category - 字体分类
   */
  async preloadFonts(category: FontCategory): Promise<void> {
    const fonts = FONT_PRESETS[category]
    if (!fonts || fonts.length === 0) return

    await Promise.allSettled(
      fonts.map(family => this.loadFont(family))
    )
  },

  /**
   * 预加载多个字体
   * 
   * @param families - 字体家族名称数组
   */
  async preloadFontList(families: string[]): Promise<FontLoadResult[]> {
    const results = await Promise.allSettled(
      families.map(family => this.loadFont(family))
    )

    return results.map((result, index): FontLoadResult => {
      if (result.status === 'fulfilled') {
        return result.value
      }
      return {
        family: families[index]!, // families[index] is guaranteed to exist
        buffer: null,
        error: result.reason?.message ?? 'Unknown error',
      }
    })
  },

  /**
   * 检查字体是否已加载
   */
  isLoaded(family: string): boolean {
    return loadedFonts.has(family)
  },

  /**
   * 获取已加载的字体列表
   */
  getLoadedFonts(): string[] {
    return Array.from(loadedFonts.keys())
  },

  /**
   * 清除字体缓存
   */
  async clearCache(): Promise<void> {
    loadedFonts.clear()
    loadingPromises.clear()

    try {
      const db = await getDB()
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      store.clear()
    } catch (error) {
      console.warn('[FontService] Failed to clear cache:', error)
    }
  },
}

export default FontService

