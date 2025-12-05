/**
 * Typst Marker Injector - 源码位置追踪标记注入器
 *
 * 设计原则：
 * 1. 段落级插桩：MVP 阶段仅对 Heading 和 Paragraph 插桩，不对单词级别操作
 * 2. 行号追踪：使用 "L{行}-C{列}" 格式作为唯一标识符
 * 3. 保持语义：转换后的文档应保持相同的渲染结果
 *
 * 转换示例：
 * ```
 * = Hello World
 *
 * This is a paragraph.
 * ```
 *
 * 转换后：
 * ```
 * #import "introspection.typ": trace-node
 *
 * #trace-node("L1-C1", heading(level: 1)[Hello World])
 *
 * #trace-node("L3-C1", [This is a paragraph.])
 * ```
 */

// ============================================================================
// Types
// ============================================================================

/**
 * 源码位置信息
 */
interface SourceLocation {
  line: number
  column: number
}

/**
 * 解析出的文档节点
 */
interface DocumentNode {
  type: 'heading' | 'paragraph' | 'raw' | 'import' | 'code'
  content: string
  location: SourceLocation
  level?: number // 仅用于 heading
}

/**
 * 注入选项
 */
export interface InjectMarkersOptions {
  /**
   * 是否注入 import 语句
   * @default true
   */
  includeImport?: boolean

  /**
   * introspection 模块路径
   * @default "introspection.typ"
   */
  modulePath?: string

  /**
   * ID 前缀
   * @default ""
   */
  idPrefix?: string

  /**
   * 是否在文档末尾输出位置 JSON
   * @default false
   */
  emitPositions?: boolean
}

// ============================================================================
// Constants
// ============================================================================

/**
 * 匹配 Typst Heading 的正则表达式
 * 支持 1-6 级标题（= 到 ======）
 */
const HEADING_REGEX = /^(={1,6})\s+(.+)$/

/**
 * 匹配 Typst 代码块/函数调用的正则
 * 以 # 开头的行
 */
const CODE_LINE_REGEX = /^#/

/**
 * 匹配 import 语句
 */
const IMPORT_REGEX = /^#import\s+/

/**
 * 匹配空行
 */
const EMPTY_LINE_REGEX = /^\s*$/

// ============================================================================
// Parser
// ============================================================================

/**
 * 解析 Typst 源码为节点数组
 *
 * @param source - Typst 源码
 * @returns 解析出的节点数组
 */
function parseTypstSource(source: string): DocumentNode[] {
  const lines = source.split('\n')
  const nodes: DocumentNode[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line === undefined) {
      i++
      continue
    }

    const lineNumber = i + 1

    // 跳过空行
    if (EMPTY_LINE_REGEX.test(line)) {
      i++
      continue
    }

    // 检测 import 语句
    if (IMPORT_REGEX.test(line)) {
      nodes.push({
        type: 'import',
        content: line,
        location: { line: lineNumber, column: 1 },
      })
      i++
      continue
    }

    // 检测 Heading
    const headingMatch = line.match(HEADING_REGEX)
    if (headingMatch) {
      const levelStr = headingMatch[1]
      const contentStr = headingMatch[2]
      if (levelStr !== undefined && contentStr !== undefined) {
        nodes.push({
          type: 'heading',
          content: contentStr,
          level: levelStr.length,
          location: { line: lineNumber, column: 1 },
        })
      }
      i++
      continue
    }

    // 检测代码行（以 # 开头）
    if (CODE_LINE_REGEX.test(line)) {
      // 收集连续的代码行
      let codeContent = line
      let j = i + 1
      while (j < lines.length) {
        const nextLine = lines[j]
        if (nextLine === undefined) break
        // 代码块可能跨多行（通过缩进或括号续行）
        if (nextLine.startsWith('  ') || nextLine.startsWith('\t')) {
          codeContent += '\n' + nextLine
          j++
        } else {
          break
        }
      }
      nodes.push({
        type: 'code',
        content: codeContent,
        location: { line: lineNumber, column: 1 },
      })
      i = j
      continue
    }

    // 其他内容视为段落
    // 收集连续的非空行作为一个段落
    const paragraphLines: string[] = [line]
    let j = i + 1

    while (j < lines.length) {
      const nextLine = lines[j]
      if (nextLine === undefined) break

      // 空行表示段落结束
      if (EMPTY_LINE_REGEX.test(nextLine)) {
        break
      }

      // Heading 表示新节点
      if (HEADING_REGEX.test(nextLine)) {
        break
      }

      // 代码行表示新节点
      if (CODE_LINE_REGEX.test(nextLine)) {
        break
      }

      paragraphLines.push(nextLine)
      j++
    }

    nodes.push({
      type: 'paragraph',
      content: paragraphLines.join('\n'),
      location: { line: lineNumber, column: 1 },
    })

    i = j
  }

  return nodes
}

// ============================================================================
// Code Generator
// ============================================================================

/**
 * 生成节点 ID
 */
function generateNodeId(location: SourceLocation, prefix: string): string {
  const id = `L${location.line}-C${location.column}`
  return prefix ? `${prefix}-${id}` : id
}

/**
 * 将 DocumentNode 转换为带追踪标记的 Typst 代码
 */
function nodeToTracedTypst(node: DocumentNode, options: Required<InjectMarkersOptions>): string {
  const id = generateNodeId(node.location, options.idPrefix)

  switch (node.type) {
    case 'import':
      // import 语句保持不变
      return node.content

    case 'code':
      // 代码块保持不变（不追踪）
      return node.content

    case 'heading':
      // Heading: #trace-node("id", heading(level: N)[content])
      return `#trace-node("${id}", heading(level: ${node.level ?? 1})[${node.content}])`

    case 'paragraph':
      // Paragraph: #trace-node("id", [content])
      // 需要处理多行内容
      const content = node.content.trim()
      return `#trace-node("${id}", [${content}])`

    default:
      return node.content
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * 向 Typst 源码注入位置追踪标记
 *
 * 这个函数会：
 * 1. 解析源码，识别 Heading 和 Paragraph
 * 2. 用 `#trace-node()` 包裹这些元素
 * 3. 可选地添加 import 语句和位置输出
 *
 * @param source - 原始 Typst 源码
 * @param options - 注入选项
 * @returns 带有追踪标记的 Typst 源码
 *
 * @example
 * ```typescript
 * const source = `
 * = Hello World
 *
 * This is a paragraph.
 *
 * Another paragraph here.
 * `
 *
 * const traced = injectMarkers(source)
 * // 输出：
 * // #import "introspection.typ": trace-node
 * //
 * // #trace-node("L2-C1", heading(level: 1)[Hello World])
 * //
 * // #trace-node("L4-C1", [This is a paragraph.])
 * //
 * // #trace-node("L6-C1", [Another paragraph here.])
 * ```
 */
export function injectMarkers(
  source: string,
  options: InjectMarkersOptions = {}
): string {
  const opts: Required<InjectMarkersOptions> = {
    includeImport: options.includeImport ?? true,
    modulePath: options.modulePath ?? 'introspection.typ',
    idPrefix: options.idPrefix ?? '',
    emitPositions: options.emitPositions ?? false,
  }

  // 解析源码
  const nodes = parseTypstSource(source)

  // 检查是否已有 introspection import
  const hasImport = nodes.some(
    node => node.type === 'import' && node.content.includes('introspection')
  )

  // 生成输出
  const outputLines: string[] = []

  // 添加 import（如果需要且不存在）
  if (opts.includeImport && !hasImport) {
    outputLines.push(`#import "${opts.modulePath}": trace-node`)
    outputLines.push('')
  }

  // 转换各节点
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node === undefined) continue

    const traced = nodeToTracedTypst(node, opts)
    outputLines.push(traced)

    // 在节点之间添加空行（保持可读性）
    if (i < nodes.length - 1 && node.type !== 'import') {
      outputLines.push('')
    }
  }

  // 添加位置输出（如果需要）
  if (opts.emitPositions) {
    outputLines.push('')
    outputLines.push('#emit-positions-json()')
  }

  return outputLines.join('\n')
}

/**
 * 从带追踪标记的源码中提取原始源码
 *
 * 这是 injectMarkers 的逆操作，用于在编辑器中显示原始内容。
 *
 * @param tracedSource - 带有追踪标记的 Typst 源码
 * @returns 原始 Typst 源码
 */
export function stripMarkers(tracedSource: string): string {
  let result = tracedSource

  // 移除 import 语句
  result = result.replace(/^#import\s+"[^"]*introspection[^"]*"[^\n]*\n\n?/gm, '')

  // 移除 trace-node 包裹的 heading
  // #trace-node("id", heading(level: N)[content]) → = content (N 个等号)
  result = result.replace(
    /#trace-node\("[^"]+",\s*heading\(level:\s*(\d+)\)\[([^\]]+)\]\)/g,
    (_, levelStr: string, content: string) => '='.repeat(parseInt(levelStr, 10)) + ' ' + content
  )

  // 移除 trace-node 包裹的段落
  // #trace-node("id", [content]) → content
  result = result.replace(
    /#trace-node\("[^"]+",\s*\[([^\]]*)\]\)/g,
    (_, content: string) => content
  )

  // 移除 emit-positions-json 调用
  result = result.replace(/\n?#emit-positions-json\(\)/g, '')

  return result.trim()
}

/**
 * 从 Typst artifact 中提取位置信息
 *
 * @param artifact - 编译后的 artifact 数据
 * @returns 位置信息数组
 */
export interface PositionInfo {
  id: string
  page: number
  x: number
  y: number
}

/**
 * 解析位置 ID 获取源码行列号
 */
export function parsePositionId(id: string): SourceLocation | null {
  const match = id.match(/^(?:.*-)?L(\d+)-C(\d+)$/)
  if (!match) return null

  const lineStr = match[1]
  const colStr = match[2]
  if (lineStr === undefined || colStr === undefined) return null

  return {
    line: parseInt(lineStr, 10),
    column: parseInt(colStr, 10),
  }
}

export default injectMarkers
