/**
 * IntrospectionService - Source Probe Data Management
 * 
 * Protocol 80 MVP Phase Implementation
 * 
 * This service provides high-level APIs for extracting and querying
 * Source Probe data from compiled Typst documents. It bridges the
 * gap between the Wasm compiler and AI agents that need to understand
 * document physical layout.
 * 
 * Core Responsibilities:
 * 1. Parse probe dump from compiled artifacts
 * 2. Build spatial indices for efficient hit testing
 * 3. Provide query APIs for AI agents (by ID, by type, by region)
 * 4. Coordinate transformation utilities
 * 
 * @module IntrospectionService
 */

import type {
  Probe,
  ProbeData,
  GeoProbe,
  StructProbe,
  SemanticProbe,
  ProbeLocation,
  ProbeType,
} from '../types/bridge.d'

import {
  isGeoProbe,
  isStructProbe,
} from '../types/bridge.d'

import {
  CoordinateTransformer,
  type WebPosition,
  type WebRect,
} from '../utils/CoordinateTransformer'

// ============================================================================
// Types
// ============================================================================

/**
 * Probe query filter options
 */
export interface ProbeQueryOptions {
  /** Filter by probe type */
  type?: ProbeType
  /** Filter by tags (geo probes) */
  tags?: string[]
  /** Filter by kind (struct probes) */
  kind?: string
  /** Filter by page number */
  page?: number
  /** Filter by ID pattern (regex) */
  idPattern?: RegExp
}

/**
 * Bounding box calculated from start/end probe pairs
 */
export interface ProbeBoundingBox {
  /** Probe pair ID (without -start/-end suffix) */
  id: string
  /** Start probe */
  start: ProbeLocation
  /** End probe */
  end: ProbeLocation
  /** Page number (from start probe) */
  page: number
  /** Approximate height (end.y - start.y), may be negative if end is above start */
  height: number
}

/**
 * Structure tree node for hierarchical navigation
 */
export interface StructureNode {
  /** Probe ID */
  id: string
  /** Structure kind */
  kind: string
  /** Hierarchical level */
  level: number
  /** Title if available */
  title?: string
  /** Page location */
  page: number
  /** Y coordinate */
  y: number
  /** Child nodes */
  children: StructureNode[]
}


// ============================================================================
// IntrospectionService Class
// ============================================================================

/**
 * IntrospectionService manages probe data and provides query APIs
 * 
 * @example
 * ```ts
 * const service = new IntrospectionService()
 * service.loadProbeData(probeData)
 * 
 * // Find all geo probes on page 1
 * const page1Probes = service.queryProbes({ type: 'geo', page: 1 })
 * 
 * // Get structure tree
 * const outline = service.getStructureTree()
 * 
 * // Hit test a click position
 * const hit = service.hitTest({ x: 100, y: 200 })
 * ```
 */
export class IntrospectionService {
  /** Current probe data */
  private probeData: ProbeData | null = null
  
  /** Index by ID for O(1) lookup */
  private probeById: Map<string, Probe> = new Map()
  
  /** Index by type for filtered queries */
  private probesByType: Map<ProbeType, Probe[]> = new Map()
  
  /** Index by page for spatial queries */
  private probesByPage: Map<number, Probe[]> = new Map()
  
  /** Cached bounding boxes for start/end pairs */
  private boundingBoxes: Map<string, ProbeBoundingBox> = new Map()
  
  /** Cached structure tree */
  private structureTree: StructureNode[] | null = null
  
  /** Coordinate transformer */
  private transformer: CoordinateTransformer
  
  /** Event listeners */
  private listeners: Set<(data: ProbeData) => void> = new Set()

  constructor(transformer?: CoordinateTransformer) {
    this.transformer = transformer ?? new CoordinateTransformer()
    this.initializeIndices()
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  /**
   * Initialize empty indices
   */
  private initializeIndices(): void {
    this.probeById = new Map()
    this.probesByType = new Map([
      ['geo', []],
      ['struct', []],
      ['semantic', []],
    ])
    this.probesByPage = new Map()
    this.boundingBoxes = new Map()
    this.structureTree = null
  }

  /**
   * Load probe data from compiled document
   * Builds all indices for efficient querying
   */
  loadProbeData(data: ProbeData): void {
    this.probeData = data
    this.initializeIndices()
    
    // Build indices
    for (const probe of data.probes) {
      // ID index
      this.probeById.set(probe.id, probe)
      
      // Type index
      const typeList = this.probesByType.get(probe.type)
      if (typeList) {
        typeList.push(probe)
      }
      
      // Page index
      const page = probe.loc.page
      if (!this.probesByPage.has(page)) {
        this.probesByPage.set(page, [])
      }
      this.probesByPage.get(page)!.push(probe)
    }
    
    // Build bounding boxes for paired probes
    this.buildBoundingBoxes()
    
    // Notify listeners
    this.notifyListeners(data)
  }

  /**
   * Build bounding boxes from start/end probe pairs
   */
  private buildBoundingBoxes(): void {
    const startProbes = new Map<string, Probe>()
    const endProbes = new Map<string, Probe>()
    
    for (const probe of this.probeData?.probes ?? []) {
      // Check for -start suffix
      if (probe.id.endsWith('-start')) {
        const baseId = probe.id.slice(0, -6)
        startProbes.set(baseId, probe)
      }
      // Check for -end suffix
      else if (probe.id.endsWith('-end')) {
        const baseId = probe.id.slice(0, -4)
        endProbes.set(baseId, probe)
      }
      // Check struct probes with edge field
      else if (isStructProbe(probe)) {
        if (probe.edge === 'start') {
          startProbes.set(probe.id, probe)
        } else if (probe.edge === 'end') {
          endProbes.set(probe.id, probe)
        }
      }
    }
    
    // Match pairs and create bounding boxes
    for (const [baseId, startProbe] of startProbes) {
      const endProbe = endProbes.get(baseId)
      if (endProbe) {
        this.boundingBoxes.set(baseId, {
          id: baseId,
          start: startProbe.loc,
          end: endProbe.loc,
          page: startProbe.loc.page,
          height: endProbe.loc.y - startProbe.loc.y,
        })
      }
    }
  }

  // --------------------------------------------------------------------------
  // Query APIs
  // --------------------------------------------------------------------------

  /**
   * Get probe by exact ID
   */
  getProbeById(id: string): Probe | undefined {
    return this.probeById.get(id)
  }

  /**
   * Query probes with filters
   */
  queryProbes(options: ProbeQueryOptions = {}): Probe[] {
    let results: Probe[] = []
    
    // Start with type filter if specified
    if (options.type) {
      results = [...(this.probesByType.get(options.type) ?? [])]
    } else {
      results = [...(this.probeData?.probes ?? [])]
    }
    
    // Page filter
    if (options.page !== undefined) {
      results = results.filter(p => p.loc.page === options.page)
    }
    
    // ID pattern filter
    if (options.idPattern) {
      results = results.filter(p => options.idPattern!.test(p.id))
    }
    
    // Tags filter (geo probes only)
    if (options.tags && options.tags.length > 0) {
      results = results.filter(p => {
        if (!isGeoProbe(p)) return false
        const probeTags = p.tags ?? []
        return options.tags!.some(tag => probeTags.includes(tag))
      })
    }
    
    // Kind filter (struct probes only)
    if (options.kind) {
      results = results.filter(p => {
        if (!isStructProbe(p)) return false
        return p.kind === options.kind
      })
    }
    
    return results
  }

  /**
   * Get all geo probes
   */
  getGeoProbes(): GeoProbe[] {
    return (this.probesByType.get('geo') ?? []) as GeoProbe[]
  }

  /**
   * Get all struct probes
   */
  getStructProbes(): StructProbe[] {
    return (this.probesByType.get('struct') ?? []) as StructProbe[]
  }

  /**
   * Get all semantic probes
   */
  getSemanticProbes(): SemanticProbe[] {
    return (this.probesByType.get('semantic') ?? []) as SemanticProbe[]
  }

  /**
   * Get probes on a specific page
   */
  getProbesOnPage(page: number): Probe[] {
    return this.probesByPage.get(page) ?? []
  }

  /**
   * Get bounding box for a probe pair
   */
  getBoundingBox(baseId: string): ProbeBoundingBox | undefined {
    return this.boundingBoxes.get(baseId)
  }

  /**
   * Get all bounding boxes
   */
  getAllBoundingBoxes(): ProbeBoundingBox[] {
    return Array.from(this.boundingBoxes.values())
  }

  // --------------------------------------------------------------------------
  // Structure Tree APIs
  // --------------------------------------------------------------------------

  /**
   * Build and get the document structure tree
   * 
   * Creates a hierarchical representation of struct probes
   * based on their level property
   */
  getStructureTree(): StructureNode[] {
    if (this.structureTree) {
      return this.structureTree
    }
    
    // Get all struct probes with edge === 'start'
    const startProbes = this.getStructProbes()
      .filter(p => p.edge === 'start')
      .sort((a, b) => {
        // Sort by page first, then by y coordinate
        if (a.loc.page !== b.loc.page) {
          return a.loc.page - b.loc.page
        }
        return a.loc.y - b.loc.y
      })
    
    // Build tree using stack-based algorithm
    const root: StructureNode[] = []
    const stack: StructureNode[] = []
    
    for (const probe of startProbes) {
      const node: StructureNode = {
        id: probe.id,
        kind: probe.kind,
        level: probe.level,
        title: probe.title,
        page: probe.loc.page,
        y: probe.loc.y,
        children: [],
      }
      
      // Pop nodes from stack until we find a parent with lower level
      while (stack.length > 0) {
        const top = stack[stack.length - 1]
        if (top && top.level >= probe.level) {
          stack.pop()
        } else {
          break
        }
      }
      
      // Add to parent or root
      if (stack.length === 0) {
        root.push(node)
      } else {
        const parent = stack[stack.length - 1]
        if (parent) {
          parent.children.push(node)
        }
      }
      
      stack.push(node)
    }
    
    this.structureTree = root
    return root
  }

  /**
   * Find all headings in the document
   * Returns struct probes with kind === 'heading'
   */
  getHeadings(): StructProbe[] {
    return this.queryProbes({
      type: 'struct',
      kind: 'heading',
    }).filter(p => isStructProbe(p) && p.edge === 'start') as StructProbe[]
  }

  // --------------------------------------------------------------------------
  // Spatial Query APIs
  // --------------------------------------------------------------------------

  /**
   * Hit test: find probe at a web position
   * 
   * @param position Click position in CSS pixels
   * @param page Target page number
   * @param tolerance Hit tolerance in pixels (default 5)
   */
  hitTest(
    position: WebPosition,
    page: number,
    tolerance = 5
  ): Probe | null {
    const typstPos = this.transformer.webToTypst(position, page)
    const tolerancePt = this.transformer.pxToPt(tolerance)
    
    // Get probes on the page
    const pageProbes = this.getProbesOnPage(page)
    
    // Find closest probe within tolerance
    let closest: Probe | null = null
    let minDistance = Infinity
    
    for (const probe of pageProbes) {
      const dx = probe.loc.x - typstPos.x
      const dy = probe.loc.y - typstPos.y
      const distance = Math.sqrt(dx * dx + dy * dy)
      
      if (distance < tolerancePt && distance < minDistance) {
        minDistance = distance
        closest = probe
      }
    }
    
    return closest
  }

  /**
   * Find all probes within a rectangular region
   * 
   * @param rect Region in web coordinates (CSS pixels)
   * @param page Target page number
   */
  findProbesInRegion(rect: WebRect, page: number): Probe[] {
    const topLeft = this.transformer.webToTypst({ x: rect.x, y: rect.y }, page)
    const bottomRight = this.transformer.webToTypst({
      x: rect.x + rect.width,
      y: rect.y + rect.height,
    }, page)
    
    const pageProbes = this.getProbesOnPage(page)
    
    return pageProbes.filter(probe => {
      return (
        probe.loc.x >= topLeft.x &&
        probe.loc.x <= bottomRight.x &&
        probe.loc.y >= topLeft.y &&
        probe.loc.y <= bottomRight.y
      )
    })
  }

  /**
   * Get probe location in web coordinates
   */
  getProbeWebPosition(probe: Probe): WebPosition {
    return this.transformer.typstToWeb(probe.loc)
  }

  // --------------------------------------------------------------------------
  // AI Agent APIs
  // --------------------------------------------------------------------------

  /**
   * Get all probes as JSON for AI agent consumption
   * 
   * Useful for passing to LLMs for document analysis
   */
  toJSON(): object {
    return {
      version: this.probeData?.version ?? 'unknown',
      count: this.probeData?.count ?? 0,
      pageCount: this.probeData?.pageCount ?? 0,
      probes: this.probeData?.probes ?? [],
      boundingBoxes: Object.fromEntries(this.boundingBoxes),
      structure: this.getStructureTree(),
    }
  }

  /**
   * Export probes for a specific page as JSON
   * 
   * Useful for multimodal RAG where we want to associate
   * probe data with a specific PDF page screenshot
   */
  exportPageProbes(page: number): object {
    const probes = this.getProbesOnPage(page)
    const boxes = Array.from(this.boundingBoxes.values())
      .filter(b => b.page === page)
    
    return {
      page,
      probeCount: probes.length,
      probes: probes.map(p => ({
        ...p,
        // Add web coordinates for convenience
        webPos: this.getProbeWebPosition(p),
      })),
      boundingBoxes: boxes,
    }
  }

  /**
   * Find the structure context for a position
   * 
   * Returns the hierarchy of struct probes that contain the given position.
   * Useful for AI agents to understand "where" in the document they're working.
   */
  getStructureContext(page: number, y: number): StructProbe[] {
    const context: StructProbe[] = []
    
    // Find all struct probes that start before and end after this position
    for (const [id, box] of this.boundingBoxes) {
      if (box.page !== page) continue
      if (box.start.y <= y && box.end.y >= y) {
        const probe = this.probeById.get(id + '-start') ?? this.probeById.get(id)
        if (probe && isStructProbe(probe)) {
          context.push(probe)
        }
      }
    }
    
    // Sort by level (deepest first)
    context.sort((a, b) => b.level - a.level)
    
    return context
  }

  // --------------------------------------------------------------------------
  // Event System
  // --------------------------------------------------------------------------

  /**
   * Subscribe to probe data updates
   */
  onProbeDataUpdate(listener: (data: ProbeData) => void): () => void {
    this.listeners.add(listener)
    
    // Immediately notify with current data if available
    if (this.probeData) {
      listener(this.probeData)
    }
    
    return () => this.listeners.delete(listener)
  }

  /**
   * Notify all listeners of data update
   */
  private notifyListeners(data: ProbeData): void {
    for (const listener of this.listeners) {
      try {
        listener(data)
      } catch (error) {
        console.error('[IntrospectionService] Listener error:', error)
      }
    }
  }

  // --------------------------------------------------------------------------
  // Utilities
  // --------------------------------------------------------------------------

  /**
   * Set coordinate transformer
   */
  setTransformer(transformer: CoordinateTransformer): void {
    this.transformer = transformer
  }

  /**
   * Get current transformer
   */
  getTransformer(): CoordinateTransformer {
    return this.transformer
  }

  /**
   * Check if probe data is loaded
   */
  hasData(): boolean {
    return this.probeData !== null
  }

  /**
   * Get probe count
   */
  getProbeCount(): number {
    return this.probeData?.count ?? 0
  }

  /**
   * Get page count
   */
  getPageCount(): number {
    return this.probeData?.pageCount ?? 0
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.probeData = null
    this.initializeIndices()
  }

  /**
   * Debug string representation
   */
  toDebugString(): string {
    return JSON.stringify({
      hasData: this.hasData(),
      probeCount: this.getProbeCount(),
      geoCount: this.getGeoProbes().length,
      structCount: this.getStructProbes().length,
      semanticCount: this.getSemanticProbes().length,
      boundingBoxCount: this.boundingBoxes.size,
      pageCount: this.probesByPage.size,
    }, null, 2)
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create default IntrospectionService instance
 */
export function createIntrospectionService(
  transformer?: CoordinateTransformer
): IntrospectionService {
  return new IntrospectionService(transformer)
}

// ============================================================================
// Singleton Instance
// ============================================================================

/**
 * Default IntrospectionService singleton
 */
export const introspectionService = new IntrospectionService()

export default introspectionService

