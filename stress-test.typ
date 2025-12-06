// ============================================================================
// Project Monolith - 编译器压力测试模板
// Protocol 80 Stress Test v1.0
// ============================================================================
// 目的：验证 Typst WASM 编译器在高负载场景下的性能表现
// 预期：50+ 页文档，触发 WorkerHealthMonitor 软重启机制
// ============================================================================

// 设置文档全局参数，模拟论文格式
#set page(
  width: 21cm,
  height: 29.7cm,
  margin: (top: 2.5cm, bottom: 2.5cm, left: 3cm, right: 2cm),
  header: context [
    #text(10pt, gray)[Project Monolith Stress Test v1.0 / Protocol 80]
    #h(1fr)
    #counter(page).display()
  ],
  footer: none,
)

// 设置全局字体和行距
#set text(font: "Linux Libertine", size: 11pt)
#set par(justify: true, leading: 0.65em)
#set math.equation(numbering: "(1)")

// 预定义一个用于生成复杂段落的函数
#let lorem-paragraph(i) = {
  let content = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum."
  
  if calc.rem(i, 5) == 0 {
    // 每 5 段插入一个复杂公式
    $ 
      E = m c^2 + sum_(n=1)^infinity 1/n^s dot.c ( integral_0^infinity e^(-x^2) dif x )
    $
    h(0pt)
    text(10pt, gray)[(公式 #calc.div-euclid(i, 5))]
  }
  
  // 每 10 段增加一个标题和列表
  if calc.rem(i, 10) == 0 {
    heading(level: 2, numbering: "1.a.")[Section #i: Distributed Consensus Algorithms]
    text(10pt)[The following list describes various Byzantine Fault Tolerance (BFT) protocols (#i):]
    list(
      tight: true,
      [*Paxos* - Leslie Lamport's consensus algorithm],
      [*Raft* - Understandable consensus],
      [*PBFT* - Practical Byzantine Fault Tolerance],
      [*Federated Byzantine Agreement (FBA)* - Stellar Consensus Protocol]
    )
  }
  
  // 视觉标记
  box(fill: blue.lighten(90%), inset: 2pt)[#text(6pt)[#i]]
  h(4pt)
  content
  [ (#i)]
  parbreak()
}

// --- 文档主体：生成 100 个段落的文本压力 ---
#heading(level: 1)[Project Monolith 编译器极限测试]

#text(12pt)[
  本文档旨在通过高密度内容和复杂元素，验证 Typst WASM 编译器的性能瓶颈。
  
  *测试指标:*
  - 预期文档页数：50+ 页
  - 数学公式数量：20+ 个
  - 二级标题数量：10 个
  - 列表元素：40+ 个
]

#v(1em)

#for i in range(1, 101) {
  lorem-paragraph(i)
}

// --- 图表与浮动对象压力 ---

#v(2em)

#figure(
  caption: [
    图 1：Project Monolith 架构示意图 - 用于测试浮动对象布局稳定性
  ],
  rect(
    width: 80%,
    height: 200pt,
    fill: gradient.linear(blue.lighten(80%), purple.lighten(80%)),
    stroke: 1pt + gray,
  )[
    #align(center + horizon)[
      #text(24pt, weight: "bold")[🏗️ Monolith Architecture]
      #v(1em)
      #text(12pt)[Worker FSM → Supervisor → UI]
    ]
  ]
)

#v(1em)

#heading(level: 2)[致谢与结论]

本压力测试模板成功生成了预期的高负载文档。如果您看到此页面，说明 Typst 编译器和 Worker 架构通过了基础压力测试。

#v(2em)
#align(center)[
  #box(
    fill: green.lighten(80%),
    inset: 1em,
    radius: 8pt,
  )[
    #text(16pt, weight: "bold")[✅ STRESS TEST COMPLETE]
    #v(0.5em)
    #text(10pt)[Protocol 80 / Gemini Architecture Team]
  ]
]
