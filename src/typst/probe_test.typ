// Probe Extraction Test Document
// This file tests the Worker's ability to extract probe data

#import "std_probe.typ": probe_geo, probe_block, probe_struct, probe_semantic

// Test 1: Simple Geo Probe
#probe_geo("test-point-1")
= Hello World

This is a test paragraph.

// Test 2: Geo Probe Pair (start/end)
#probe_geo("para-1-start", anchor: "start")
Some important text that we want to track.
#probe_geo("para-1-end", anchor: "end")

// Test 3: Block Probe (struct with content)
#probe_block("section-1", kind: "section", level: 1, title: "Test Section")[
  == Test Section
  
  Content inside a tracked section.
]

// Test 4: Semantic Probe (AI metadata)
#probe_semantic("semantic-1", (
  model: "test-model",
  purpose: "verification",
))

// Test 5: Another Geo Probe on a different position
#pagebreak()
#probe_geo("page-2-marker")
= Page 2

Content on page 2.

#probe_geo("end-marker")
