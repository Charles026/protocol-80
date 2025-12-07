// ==========================================
// Project Monolith: Zero-Size Probe Library
// Version: 2.1.0 (Hardening Update)
// ==========================================
//
// Changes from v2.0:
// - Ghost Box Pattern: 0x0pt box wrapper for guaranteed zero layout impact
// - Auto-Sequencing: Global counter for integrity checking
// - Auto-ID: Fallback ID generation when id=auto
//
// Query Command:
// ```bash
// typst query document.typ "<monolith-probe>" --field value
// ```

// ============================================================================
// State & Constants
// ============================================================================

/// Unified probe label for batch query via CLI
#let PROBE_LABEL = <monolith-probe>

/// Protocol version
#let PROBE_VERSION = "2.1.0"

/// Global counter to track the sequence of probes in the document flow.
/// This helps the external parser reconstruct the tree order and detect missing nodes.
#let probe-counter = counter("monolith-probe-seq")

// ============================================================================
// Core Functions
// ============================================================================

/// Zero-Size Probe v2.1
///
/// Features:
/// - Completely invisible (0x0 Ghost Box)
/// - Auto-sequenced (_seq field for integrity)
/// - Auto-ID support (id: auto generates "auto-N")
///
/// @param id: Unique identifier (or `auto` for auto-generation)
/// @param payload: Business data dictionary
///
/// Example:
/// ```typst
/// #probe("para-1", payload: (type: "paragraph"))
/// #probe(auto)  // Auto-generates ID like "auto-42"
/// ```
#let probe(id, payload: (:)) = {
  // 1. Advance the sequence counter
  probe-counter.step()

  // 2. Context-aware rendering
  context {
    let seq = probe-counter.get().first()
    let final-id = if id == auto { "auto-" + str(seq) } else { id }
    let pos = here().position()
    
    // 3. The "Ghost Box" Wrapper
    // Enforces zero dimensions to prevent any layout shifts
    box(width: 0pt, height: 0pt, inset: 0pt, outset: 0pt)[
      #metadata((
        kind: "probe",
        id: final-id,
        payload: payload,
        location: (
          page: pos.page,
          x: pos.x.pt(),
          y: pos.y.pt()
        ),
        _seq: seq,
        _v: PROBE_VERSION,
      ))
      #PROBE_LABEL
    ]
  }
}

/// Debug-enabled probe with visible sequence number
#let probe-debug(id, payload: (:)) = {
  probe(id, payload: payload)
  // Show sequence for debugging
  context {
    let seq = probe-counter.get().first()
    text(size: 6pt, fill: red)[\[#seq\]]
  }
}

// ============================================================================
// Semantic Wrappers
// ============================================================================

/// Semantic Node v2.1
///
/// Wraps content with start/end probes using figure as container.
/// Robust for show rules and cross-page content.
///
/// @param body: Content to wrap
/// @param scope: Scope identifier
/// @param kind: Node type (section, paragraph, etc.)
/// @param probe-it: Whether to inject probes (default: true)
#let semantic-node(
  body,
  scope: "global",
  kind: "node",
  probe-it: true
) = {
  // Start Probe
  if probe-it {
    probe(kind + "-" + scope + "-start", payload: (kind: kind, scope: scope, edge: "start"))
  }
  
  // Container - figure is locatable and works with show rules
  figure(
    body,
    kind: kind,
    supplement: none,
    numbering: none,
    outlined: false
  )
  
  // End Probe
  if probe-it {
    probe(kind + "-" + scope + "-end", payload: (kind: kind, scope: scope, edge: "end"))
  }
}

/// Semantic Heading Wrapper
#let semantic-heading(level, id, body) = {
  probe("heading-" + id + "-start", payload: (kind: "heading", level: level, edge: "start"))
  heading(level: level, body)
  probe("heading-" + id + "-end", payload: (kind: "heading", level: level, edge: "end"))
}

// ============================================================================
// Coordinate System Helpers
// ============================================================================

/// Origin Probe: Mark container origin for relative coordinate calculation
#let origin-probe(container-id) = {
  probe("origin-" + container-id, payload: (kind: "origin", container: container-id))
}

/// Region Probe Pair: Mark start and end of content
#let probe-region(id, body, payload: (:)) = {
  probe(id + "-start", payload: (..payload, edge: "start"))
  body
  probe(id + "-end", payload: (..payload, edge: "end"))
}

// ============================================================================
// Specialized Probes
// ============================================================================

/// Table Cell Probe
#let probe-cell(row, col, table-id: "table") = {
  probe(
    table-id + "-r" + str(row) + "-c" + str(col),
    payload: (kind: "cell", row: row, col: col, table: table-id)
  )
}

/// Page Break Probe
#let probe-page(page-label) = {
  probe("page-" + page-label, payload: (kind: "page-marker"))
}
