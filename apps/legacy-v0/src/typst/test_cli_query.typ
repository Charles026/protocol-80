// Test document for Zero-Size Probe CLI Query
// Run: typst query test_cli_query.typ "<monolith-probe>" --field value

#import "probe.typ": probe, probe-debug, semantic-node, origin-probe, probe-region

// Mark document origin
#origin-probe("document")

// Test 1: Simple probe
#probe("test-1", payload: (type: "marker", note: "first probe"))

= Hello World

Some introductory text.

// Test 2: Probe with content region
#probe-region("paragraph-1")[
  This is a tracked paragraph with start and end markers.
]

// Test 3: Semantic heading wrapper
#semantic-node(kind: "section", scope: "introduction")[
  == Introduction
  
  Content inside a semantic section container.
]

// Test 4: Page 2 marker
#pagebreak()
#probe("page-2-start", payload: (type: "page-marker", page: 2))

= Second Page

More content here.

#probe("document-end", payload: (type: "end-marker"))
