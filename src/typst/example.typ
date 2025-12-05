// example.typ - introspection 模块使用示例
//
// 此文件展示如何使用 introspection.typ 进行源码位置追踪。

#import "introspection.typ": trace-node, emit-positions-json

// 追踪标题
#trace-node("L7-C1", heading(level: 1)[Welcome to Typst])

// 追踪段落
#trace-node("L10-C1", [
  This is a paragraph that demonstrates the introspection feature.
  The trace-node function wraps content and records its position.
])

// 追踪第二级标题
#trace-node("L16-C1", heading(level: 2)[Features])

// 追踪列表（作为段落内容）
#trace-node("L19-C1", [
  - Real-time position tracking
  - Zero layout impact
  - Source mapping support
])

// 数学公式追踪
#trace-node("L26-C1", [
  The quadratic formula:
  $ x = (-b plus.minus sqrt(b^2 - 4 a c)) / (2 a) $
])

// 在文档末尾输出位置信息（调试用）
#emit-positions-json()

