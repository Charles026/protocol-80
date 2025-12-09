// ==========================================
// Project Monolith: Standard Probe Library
// Version: 1.0.0 (Protocol 80 MVP Phase)
// ==========================================
//
// Architecture: Source Probe System
// 
// This library implements the Source Probe specification for Project Monolith.
// Probes are invisible metadata markers that enable AI agents to query the
// physical layout of compiled documents without affecting visual rendering.
//
// Three Axioms of Probe Design:
// 1. Physical Inertia - Zero visual impact, no layout shift
// 2. Semantic Self-Containment - Each probe carries full identity in payload
// 3. Global Addressability - Unified label for batch query, unique ID per probe
//
// Probe Taxonomy:
// - Geo Probe (geo): Physical coordinates for RAG, cropping, highlighting
// - Struct Probe (struct): Logical structure boundaries (start/end)
// - Semantic Probe (semantic): AI-generated metadata injection
//
// Usage:
// ```typst
// #import "std_probe.typ": probe_geo, probe_block, probe_semantic
// 
// #probe_geo("p1-start")
// First paragraph content.
// #probe_geo("p1-end")
// 
// #probe_block("section-intro")[
//   = Introduction
//   This is the introduction section.
// ]
// ```
//
// WARNING: 
// - NEVER place probe code with surrounding whitespace that affects layout
// - Probes must NOT trigger Typst's convergence loop (no state updates inside probes)

// ============================================================================
// Constants & Configuration
// ============================================================================

/// Global unified probe label for batch query
/// All probes share this label for efficient retrieval via query(<__monolith_probe>)
#let PROBE_LABEL = <__monolith_probe>

/// Protocol version for backward compatibility checks
#let PROBE_PROTOCOL_VERSION = "1.0.0"

// ============================================================================
// Internal Helpers
// ============================================================================

/// Core probe emission function (internal use only)
/// 
/// Wraps payload in metadata with the unified label.
/// Uses place() to ensure zero layout impact.
///
/// @param payload: Dictionary containing probe data
#let _emit_probe(payload) = {
  // metadata() is inherently invisible (zero-width, zero-height)
  // place() ensures it's removed from document flow entirely
  place(
    dx: 0pt,
    dy: 0pt,
    metadata(payload) + PROBE_LABEL
  )
}

/// Generate timestamp for probe creation
/// Note: Typst doesn't have real timestamps, using counter as fallback
#let _probe_counter = counter("__monolith_probe_counter")

/// Emit probe with position data captured via context
/// This variant captures the physical location at probe insertion point
///
/// @param payload: Base payload dictionary (id, type, etc.)
#let _emit_positioned_probe(payload) = {
  // Use context to capture layout-time position
  // place() ensures the probe doesn't affect layout
  place(
    dx: 0pt,
    dy: 0pt,
    context {
      let pos = here().position()
      _probe_counter.step()
      let seq = _probe_counter.get().first()
      
      metadata((
        ..payload,
        // Position data (populated at layout time)
        loc: (
          page: pos.page,
          x: pos.x,
          y: pos.y,
        ),
        // Sequence number for ordering
        seq: seq,
        // Protocol version
        _v: PROBE_PROTOCOL_VERSION,
      ))
    } + PROBE_LABEL
  )
}

// ============================================================================
// Geo Probe - Physical Coordinate Markers
// ============================================================================

/// Geo Probe: Mark a specific position in the document
///
/// Use this to track physical coordinates for:
/// - Multimodal RAG (cropping images to specific regions)
/// - Click-to-source mapping
/// - Visual annotations
///
/// @param id: Unique identifier (recommend UUID v4 or "L{line}-C{col}" format)
/// @param anchor: Position semantics - "start", "end", or "point" (default)
/// @param tags: Optional array of tags for filtering (e.g., ["heading", "h1"])
///
/// Example:
/// ```typst
/// Text before#probe_geo("marker-1")Text after
/// ```
#let probe_geo(id, anchor: "point", tags: ()) = {
  _emit_positioned_probe((
    type: "geo",
    id: id,
    anchor: anchor,
    tags: tags,
  ))
}

/// Geo Probe Pair: Mark start and end of a region
///
/// Convenience function to mark both boundaries of a text region.
/// Useful for calculating bounding boxes of inline content.
///
/// @param id: Base identifier (suffixed with "-start" and "-end")
/// @param body: Content to wrap
/// @param tags: Optional tags array
///
/// Example:
/// ```typst
/// #probe_geo_pair("important-text")[This text is tracked]
/// ```
#let probe_geo_pair(id, tags: (), body) = {
  probe_geo(id + "-start", anchor: "start", tags: tags)
  body
  probe_geo(id + "-end", anchor: "end", tags: tags)
}

// ============================================================================
// Struct Probe - Logical Structure Markers
// ============================================================================

/// Struct Probe: Mark logical structure boundaries
///
/// Use this to track document structure for:
/// - Outline generation
/// - Section-level AI operations
/// - Cross-page element tracking
///
/// @param id: Unique identifier for the structure
/// @param kind: Structure type ("section", "chapter", "block", "figure", etc.)
/// @param level: Hierarchical level (1 for h1, 2 for h2, etc.)
/// @param edge: Boundary marker - "start" or "end"
/// @param title: Optional title/label for the structure
///
/// Example:
/// ```typst
/// #probe_struct("ch1", kind: "chapter", level: 1, edge: "start", title: "Introduction")
/// = Introduction
/// Content here...
/// #probe_struct("ch1", kind: "chapter", level: 1, edge: "end")
/// ```
#let probe_struct(id, kind: "block", level: 1, edge: "start", title: none) = {
  let payload = (
    type: "struct",
    id: id,
    kind: kind,
    level: level,
    edge: edge,
  )
  
  // Add title if provided
  if title != none {
    payload.insert("title", title)
  }
  
  _emit_positioned_probe(payload)
}

/// Block Probe: Wrap content with structure markers
///
/// Convenience function that wraps content with start/end struct probes.
/// The wrapped content is rendered normally between the probes.
///
/// @param id: Unique identifier for the block
/// @param body: Content to wrap
/// @param kind: Structure type (default: "generic")
/// @param level: Hierarchical level (default: 1)
/// @param title: Optional title
///
/// Example:
/// ```typst
/// #probe_block("intro-section", kind: "section", level: 1, title: "Introduction")[
///   = Introduction
///   This is the introduction.
/// ]
/// ```
#let probe_block(id, kind: "generic", level: 1, title: none, body) = {
  // Start marker
  probe_struct(id, kind: kind, level: level, edge: "start", title: title)
  
  // Render content (unchanged)
  body
  
  // End marker
  probe_struct(id, kind: kind, level: level, edge: "end", title: title)
}

/// Heading Probe: Specialized wrapper for headings
///
/// Wraps a heading with appropriate struct probes and preserves heading semantics.
///
/// @param id: Unique identifier
/// @param level: Heading level (1-6)
/// @param body: Heading text content
///
/// Example:
/// ```typst
/// #probe_heading("h1-intro", 1)[Introduction]
/// ```
#let probe_heading(id, level, body) = {
  probe_struct(id, kind: "heading", level: level, edge: "start", title: if type(body) == str { body } else { none })
  heading(level: level, body)
  probe_struct(id, kind: "heading", level: level, edge: "end")
}

// ============================================================================
// Semantic Probe - AI Metadata Injection
// ============================================================================

/// Semantic Probe: Inject AI-generated metadata
///
/// Use this to embed invisible AI-related information:
/// - Generation confidence scores
/// - Model identifiers
/// - Prompt references
/// - Quality audit trails
///
/// @param id: Unique identifier (recommend UUID v4)
/// @param data: Dictionary of arbitrary metadata
///
/// Example:
/// ```typst
/// #probe_semantic("gen-001", (
///   model: "claude-3.5-sonnet",
///   prompt_id: "rewrite-formal",
///   confidence: 0.92,
///   generated_at: "2024-12-06T10:30:00Z",
/// ))
/// // AI-generated content here
/// ```
#let probe_semantic(id, data) = {
  _emit_positioned_probe((
    type: "semantic",
    id: id,
    data: data,
  ))
}

/// Content Audit Probe: Mark AI-generated content with audit trail
///
/// Convenience function for wrapping AI-generated content with full audit metadata.
///
/// @param id: Unique identifier
/// @param model: AI model identifier
/// @param prompt_id: Reference to the prompt used
/// @param body: The AI-generated content
/// @param confidence: Optional confidence score (0.0-1.0)
/// @param meta: Optional additional metadata
///
/// Example:
/// ```typst
/// #probe_ai_content("para-001", "gpt-4", "summarize")[
///   This is AI-generated summary text.
/// ]
/// ```
#let probe_ai_content(id, model, prompt_id, confidence: none, meta: (:), body) = {
  let audit_data = (
    model: model,
    prompt_id: prompt_id,
    ..meta,
  )
  
  if confidence != none {
    audit_data.insert("confidence", confidence)
  }
  
  probe_semantic(id + "-audit", audit_data)
  body
}

// ============================================================================
// Query & Collection Functions
// ============================================================================

/// Collect all probes from the document
///
/// Returns an array of all probe payloads. Call this at document end
/// inside a context block, or use emit_probes_json() for automatic embedding.
///
/// Example:
/// ```typst
/// #context {
///   let probes = collect_probes()
///   // Process probes...
/// }
/// ```
#let collect_probes() = {
  // Query all metadata with our label
  query(PROBE_LABEL).map(el => el.value)
}

/// Collect probes filtered by type
///
/// @param probe_type: "geo", "struct", or "semantic"
#let collect_probes_by_type(probe_type) = {
  query(PROBE_LABEL)
    .filter(el => el.value.at("type", default: none) == probe_type)
    .map(el => el.value)
}

/// Collect probes filtered by tags
///
/// @param tag: Tag to filter by
#let collect_probes_by_tag(tag) = {
  query(PROBE_LABEL)
    .filter(el => {
      let tags = el.value.at("tags", default: ())
      tag in tags
    })
    .map(el => el.value)
}

/// Emit all probe data as embedded metadata
///
/// **DEPRECATED (Protocol 80 Phase 2)**: This function is no longer needed.
/// The Worker now extracts probes directly via `compiler.query(<__monolith_probe>)`.
/// Keeping for backward compatibility but will be removed in future versions.
///
/// Call this at the very end of your document to embed all probe data
/// in a single queryable metadata block. This is the recommended approach
/// for extracting probe data via the Wasm bridge.
///
/// Example:
/// ```typst
/// // ... document content with probes ...
/// 
/// #emit_probes_json()
/// ```
#let emit_probes_json() = {
  place(
    dx: 0pt,
    dy: 0pt,
    context {
      let all_probes = collect_probes()
      
      metadata((
        kind: "__monolith_probe_dump",
        version: PROBE_PROTOCOL_VERSION,
        count: all_probes.len(),
        probes: all_probes,
      ))
    } + <__monolith_probe_dump>
  )
}

// ============================================================================
// Specialized Probe Constructors
// ============================================================================

/// Figure Probe: Track figure elements with full metadata
///
/// @param id: Unique identifier
/// @param fig_kind: Figure kind ("image", "table", "code", etc.)
/// @param caption: Figure caption text
/// @param body: Figure content
#let probe_figure(id, fig_kind: "image", caption: none, body) = {
  probe_struct(id, kind: "figure-" + fig_kind, edge: "start", title: caption)
  body
  probe_struct(id, kind: "figure-" + fig_kind, edge: "end")
}

/// Math Probe: Track mathematical expressions
///
/// @param id: Unique identifier
/// @param body: Math content
/// @param display: Whether this is display math (block) or inline
#let probe_math(id, display: false, body) = {
  let kind = if display { "math-display" } else { "math-inline" }
  probe_geo_pair(id, tags: ("math", kind), body)
}

/// Code Probe: Track code blocks
///
/// @param id: Unique identifier
/// @param lang: Programming language
/// @param body: Code content
#let probe_code(id, lang: none, body) = {
  let tags = ("code",)
  if lang != none {
    tags = tags + (lang,)
  }
  probe_block(id, kind: "code", title: lang)[
    #body
  ]
}

/// List Item Probe: Track individual list items
///
/// @param id: Base identifier
/// @param index: Item index (0-based)
/// @param body: Item content
#let probe_list_item(id, index, body) = {
  probe_geo_pair(id + "-item-" + str(index), tags: ("list-item",), body)
}

// ============================================================================
// Debug & Development Helpers
// ============================================================================

/// Debug mode state
#let _debug_probes = state("__monolith_debug_probes", false)

/// Enable probe visualization (development only)
///
/// When enabled, probes will render a small visual indicator.
/// DO NOT use in production - it violates Physical Inertia axiom.
#let enable_probe_debug() = {
  _debug_probes.update(true)
}

/// Disable probe visualization
#let disable_probe_debug() = {
  _debug_probes.update(false)
}

/// Debug probe with visual indicator (development only)
///
/// Renders a tiny colored dot at probe location for debugging.
/// Color indicates probe type: blue=geo, green=struct, orange=semantic
#let probe_debug(id, probe_type: "geo") = {
  context {
    if _debug_probes.get() {
      let color = if probe_type == "geo" { rgb("#0066ff") }
                  else if probe_type == "struct" { rgb("#00cc44") }
                  else { rgb("#ff9900") }
      
      place(
        dx: -2pt,
        dy: -2pt,
        circle(radius: 2pt, fill: color.transparentize(50%))
      )
    }
  }
  
  // Still emit the actual probe
  if probe_type == "geo" {
    probe_geo(id)
  } else if probe_type == "struct" {
    probe_struct(id)
  } else {
    probe_semantic(id, (:))
  }
}

