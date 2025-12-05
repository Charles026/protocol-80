// introspection.typ - 编译时源码位置收集模块
//
// 设计原则：
// 1. 零布局干扰：所有内省元素必须生成 Zero-width, Zero-height 内容
// 2. 避免无限循环：严格使用 place() 将元素移出文档流
// 3. 延迟坐标回填：使用 context 在布局完成后获取精确位置
//
// 警告：
// 如果内省逻辑改变文档高度，会导致：
// 布局改变 → 触发重排 → 坐标改变 → 触发重排 → 无限循环！
// 必须确保所有插入内容不影响文档流。

/// 追踪节点函数
/// 
/// 在内容周围插入位置锚点，用于在布局后收集精确坐标。
/// 所有锚点元素都被 place() 包裹，确保不影响文档布局。
///
/// 参数：
/// - id: 唯一标识符（通常为 "line-{行号}" 或 "L{行}-C{列}"）
/// - body: 要追踪的内容
///
/// 返回：
/// - 原始内容，附带不可见的位置锚点
///
/// 示例：
/// ```typst
/// #trace-node("line-10", [这是一段被追踪的文本])
/// ```
#let trace-node(id, body) = {
  // 开始锚点 - 标记内容起始位置
  // 使用 place() 确保不影响文档流（零宽高）
  place(
    dx: 0pt,
    dy: 0pt,
    metadata((
      kind: "anchor",
      id: id,
      type: "start",
    ))
  )
  
  // 位置回填 - 在布局完成后获取精确坐标
  // context 块会在布局阶段之后执行
  // place() 确保结果不影响文档流
  place(
    dx: 0pt,
    dy: 0pt,
    context {
      let pos = here().position()
      metadata((
        kind: "pos",
        id: id,
        page: pos.page,
        x: pos.x,
        y: pos.y,
      ))
    }
  )
  
  // 渲染原始内容（不做任何修改）
  body
  
  // 结束锚点 - 标记内容结束位置（可选，用于计算范围）
  place(
    dx: 0pt,
    dy: 0pt,
    metadata((
      kind: "anchor",
      id: id,
      type: "end",
    ))
  )
}

/// 追踪标题节点
/// 
/// 专用于标题的追踪函数，保持标题语义。
///
/// 参数：
/// - id: 唯一标识符
/// - level: 标题级别 (1-6)
/// - body: 标题内容
#let trace-heading(id, level, body) = {
  trace-node(id, heading(level: level, body))
}

/// 追踪段落节点
///
/// 专用于段落的追踪函数。
///
/// 参数：
/// - id: 唯一标识符  
/// - body: 段落内容
#let trace-paragraph(id, body) = {
  trace-node(id, par(body))
}

/// 查询所有位置锚点
///
/// 在文档末尾调用此函数，收集所有已记录的位置信息。
/// 
/// 返回格式：
/// ```
/// (
///   (id: "line-1", page: 1, x: 72pt, y: 100pt),
///   (id: "line-5", page: 1, x: 72pt, y: 200pt),
///   ...
/// )
/// ```
#let collect-positions() = {
  context {
    let anchors = query(metadata.where(value => {
      type(value) == dictionary and value.at("kind", default: none) == "pos"
    }))
    
    anchors.map(anchor => {
      let v = anchor.value
      (
        id: v.id,
        page: v.page,
        x: v.x,
        y: v.y,
      )
    })
  }
}

/// 输出位置信息为 JSON（调试用）
///
/// 在文档末尾插入一个隐藏的 metadata，包含所有位置信息的 JSON 表示。
/// 可以通过 typst.ts 的 artifact 解析此信息。
#let emit-positions-json() = {
  place(
    dx: 0pt,
    dy: 0pt,
    context {
      let positions = collect-positions()
      metadata((
        kind: "positions-dump",
        data: positions,
      ))
    }
  )
}

// ============================================================================
// Debug Mode - 调试模式
// ============================================================================

/// 调试模式状态
/// 设为 true 启用调试模式，将为所有 block 元素生成边界框数据
#let debug-mode = state("debug-mode", false)

/// 启用调试模式
///
/// 在文档开头调用此函数以启用调试可视化。
/// 启用后，所有 block 元素的位置和尺寸信息会被注入为 metadata。
///
/// 示例：
/// ```typst
/// #import "introspection.typ": enable-debug
/// #enable-debug()
/// ```
#let enable-debug() = {
  debug-mode.update(true)
}

/// 禁用调试模式
#let disable-debug() = {
  debug-mode.update(false)
}

/// 调试框 show rule 生成器
///
/// 为指定元素类型生成调试边界框 metadata。
/// 使用 context 在布局完成后获取精确的位置和尺寸信息。
///
/// 参数：
/// - element-type: 元素类型名称（"block", "heading", "figure" 等）
/// - it: 原始元素内容
///
/// 注意：
/// - 使用 measure() 获取元素尺寸
/// - 使用 here().position() 获取位置
/// - place() 确保 metadata 不影响文档流
#let debug-box(element-type, it) = context {
  // 仅在调试模式下执行
  if debug-mode.get() {
    let size = measure(it)
    let pos = here().position()
    
    // 注入调试框 metadata
    // 使用 place() 确保不影响文档布局
    place(
      dx: 0pt,
      dy: 0pt,
      metadata((
        kind: "debug-box",
        type: element-type,
        page: pos.page,
        x: pos.x,
        y: pos.y,
        w: size.width,
        h: size.height,
      ))
    )
  }
  
  // 渲染原始内容
  it
}

/// 应用调试 show rules
///
/// 为 block、heading、figure、table 等元素应用调试边界框。
/// 在 enable-debug() 之后调用以启用可视化。
///
/// 使用方法：
/// ```typst
/// #import "introspection.typ": enable-debug, apply-debug-rules
/// #enable-debug()
/// #show: apply-debug-rules
/// ```
#let apply-debug-rules(doc) = {
  // Block 元素 - 通用块级容器
  show block: it => debug-box("block", it)
  
  // Heading 元素 - 标题
  show heading: it => debug-box("heading", it)
  
  // Figure 元素 - 图表
  show figure: it => debug-box("figure", it)
  
  // Table 元素 - 表格
  show table: it => debug-box("table", it)
  
  // Raw 元素 - 代码块
  show raw.where(block: true): it => debug-box("code", it)
  
  // List 元素 - 列表
  show list: it => debug-box("list", it)
  
  // Enum 元素 - 编号列表
  show enum: it => debug-box("enum", it)
  
  // Par 元素 - 段落（注意：这可能产生大量数据）
  // show par: it => debug-box("par", it)
  
  // 渲染文档
  doc
}

/// 收集所有调试框数据
///
/// 在文档末尾调用，收集所有已记录的调试框信息。
#let collect-debug-boxes() = {
  context {
    let boxes = query(metadata.where(value => {
      type(value) == dictionary and value.at("kind", default: none) == "debug-box"
    }))
    
    boxes.map(box => {
      let v = box.value
      (
        type: v.type,
        page: v.page,
        x: v.x,
        y: v.y,
        w: v.w,
        h: v.h,
      )
    })
  }
}

/// 输出调试框数据为 JSON
///
/// 在文档末尾插入包含所有调试框信息的 metadata。
#let emit-debug-boxes-json() = {
  place(
    dx: 0pt,
    dy: 0pt,
    context {
      let boxes = collect-debug-boxes()
      metadata((
        kind: "debug-boxes-dump",
        data: boxes,
      ))
    }
  )
}

