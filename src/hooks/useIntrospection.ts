/**
 * useIntrospection - React hook for Source Probe data
 * 
 * Protocol 80 MVP Phase
 * 
 * Provides React components with access to probe data from compiled
 * Typst documents. Automatically subscribes to updates and manages
 * the IntrospectionService lifecycle.
 * 
 * @example
 * ```tsx
 * function DocumentOutline() {
 *   const { probeData, structureTree, isLoading } = useIntrospection()
 *   
 *   if (isLoading) return <Spinner />
 *   
 *   return (
 *     <nav>
 *       {structureTree.map(node => (
 *         <OutlineItem key={node.id} node={node} />
 *       ))}
 *     </nav>
 *   )
 * }
 * ```
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  IntrospectionService,
  introspectionService,
  type ProbeBoundingBox,
  type StructureNode,
  type ProbeQueryOptions,
} from '../services/IntrospectionService'
import type {
  Probe,
  ProbeData,
  GeoProbe,
  StructProbe,
  SemanticProbe,
} from '../types/bridge.d'
import { CoordinateTransformer, type WebPosition } from '../utils/CoordinateTransformer'

// ============================================================================
// Types
// ============================================================================

export interface UseIntrospectionOptions {
  /** Custom IntrospectionService instance (default: singleton) */
  service?: IntrospectionService
  /** Custom coordinate transformer */
  transformer?: CoordinateTransformer
  /** Auto-subscribe to probe updates (default: true) */
  autoSubscribe?: boolean
}

export interface UseIntrospectionResult {
  /** Current probe data */
  probeData: ProbeData | null
  /** Whether data is being loaded */
  isLoading: boolean
  /** Total probe count */
  probeCount: number
  /** Page count from probe data */
  pageCount: number
  /** Hierarchical structure tree */
  structureTree: StructureNode[]
  /** All bounding boxes */
  boundingBoxes: ProbeBoundingBox[]
  /** Query probes with filters */
  queryProbes: (options: ProbeQueryOptions) => Probe[]
  /** Get probes on specific page */
  getProbesOnPage: (page: number) => Probe[]
  /** Hit test at position */
  hitTest: (position: WebPosition, page: number) => Probe | null
  /** Get probe by ID */
  getProbeById: (id: string) => Probe | undefined
  /** Get structure context at position */
  getStructureContext: (page: number, y: number) => StructProbe[]
  /** Load probe data manually */
  loadProbeData: (data: ProbeData) => void
  /** Clear all data */
  clear: () => void
  /** The service instance */
  service: IntrospectionService
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * React hook for accessing Source Probe data
 */
export function useIntrospection(
  options: UseIntrospectionOptions = {}
): UseIntrospectionResult {
  const {
    service = introspectionService,
    transformer,
    autoSubscribe = true,
  } = options

  // State
  const [probeData, setProbeData] = useState<ProbeData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [updateTrigger, setUpdateTrigger] = useState(0)

  // Set transformer if provided
  useEffect(() => {
    if (transformer) {
      service.setTransformer(transformer)
    }
  }, [service, transformer])

  // Subscribe to probe updates
  useEffect(() => {
    if (!autoSubscribe) return

    const unsubscribe = service.onProbeDataUpdate((data) => {
      setProbeData(data)
      setUpdateTrigger(t => t + 1)
    })

    // Check for existing data
    if (service.hasData()) {
      setProbeData(service['probeData'])
    }

    return unsubscribe
  }, [service, autoSubscribe])

  // Memoized computed values
  const probeCount = useMemo(() => {
    return probeData?.count ?? 0
  }, [probeData])

  const pageCount = useMemo(() => {
    return probeData?.pageCount ?? 0
  }, [probeData])

  const structureTree = useMemo(() => {
    return service.getStructureTree()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, updateTrigger])

  const boundingBoxes = useMemo(() => {
    return service.getAllBoundingBoxes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, updateTrigger])

  // Callback functions
  const queryProbes = useCallback(
    (queryOptions: ProbeQueryOptions) => {
      return service.queryProbes(queryOptions)
    },
    [service]
  )

  const getProbesOnPage = useCallback(
    (page: number) => {
      return service.getProbesOnPage(page)
    },
    [service]
  )

  const hitTest = useCallback(
    (position: WebPosition, page: number) => {
      return service.hitTest(position, page)
    },
    [service]
  )

  const getProbeById = useCallback(
    (id: string) => {
      return service.getProbeById(id)
    },
    [service]
  )

  const getStructureContext = useCallback(
    (page: number, y: number) => {
      return service.getStructureContext(page, y)
    },
    [service]
  )

  const loadProbeData = useCallback(
    (data: ProbeData) => {
      setIsLoading(true)
      try {
        service.loadProbeData(data)
        setProbeData(data)
      } finally {
        setIsLoading(false)
      }
    },
    [service]
  )

  const clear = useCallback(() => {
    service.clear()
    setProbeData(null)
  }, [service])

  return {
    probeData,
    isLoading,
    probeCount,
    pageCount,
    structureTree,
    boundingBoxes,
    queryProbes,
    getProbesOnPage,
    hitTest,
    getProbeById,
    getStructureContext,
    loadProbeData,
    clear,
    service,
  }
}

// ============================================================================
// Specialized Hooks
// ============================================================================

/**
 * Hook for getting geo probes with optional filtering
 */
export function useGeoProbes(
  options: UseIntrospectionOptions & { tags?: string[] } = {}
): GeoProbe[] {
  const { service = introspectionService, tags } = options
  const [probes, setProbes] = useState<GeoProbe[]>([])

  useEffect(() => {
    const updateProbes = () => {
      if (tags && tags.length > 0) {
        setProbes(
          service.queryProbes({ type: 'geo', tags }) as GeoProbe[]
        )
      } else {
        setProbes(service.getGeoProbes())
      }
    }

    const unsubscribe = service.onProbeDataUpdate(() => {
      updateProbes()
    })

    updateProbes()

    return unsubscribe
  }, [service, tags])

  return probes
}

/**
 * Hook for getting struct probes with optional kind filter
 */
export function useStructProbes(
  options: UseIntrospectionOptions & { kind?: string } = {}
): StructProbe[] {
  const { service = introspectionService, kind } = options
  const [probes, setProbes] = useState<StructProbe[]>([])

  useEffect(() => {
    const updateProbes = () => {
      if (kind) {
        setProbes(
          service.queryProbes({ type: 'struct', kind }) as StructProbe[]
        )
      } else {
        setProbes(service.getStructProbes())
      }
    }

    const unsubscribe = service.onProbeDataUpdate(() => {
      updateProbes()
    })

    updateProbes()

    return unsubscribe
  }, [service, kind])

  return probes
}

/**
 * Hook for getting semantic probes
 */
export function useSemanticProbes(
  options: UseIntrospectionOptions = {}
): SemanticProbe[] {
  const { service = introspectionService } = options
  const [probes, setProbes] = useState<SemanticProbe[]>([])

  useEffect(() => {
    const unsubscribe = service.onProbeDataUpdate(() => {
      setProbes(service.getSemanticProbes())
    })

    setProbes(service.getSemanticProbes())

    return unsubscribe
  }, [service])

  return probes
}

/**
 * Hook for document structure tree
 */
export function useStructureTree(
  options: UseIntrospectionOptions = {}
): StructureNode[] {
  const { service = introspectionService } = options
  const [tree, setTree] = useState<StructureNode[]>([])

  useEffect(() => {
    const unsubscribe = service.onProbeDataUpdate(() => {
      setTree(service.getStructureTree())
    })

    setTree(service.getStructureTree())

    return unsubscribe
  }, [service])

  return tree
}

/**
 * Hook for headings (struct probes with kind === 'heading')
 */
export function useHeadings(
  options: UseIntrospectionOptions = {}
): StructProbe[] {
  const { service = introspectionService } = options
  const [headings, setHeadings] = useState<StructProbe[]>([])

  useEffect(() => {
    const unsubscribe = service.onProbeDataUpdate(() => {
      setHeadings(service.getHeadings())
    })

    setHeadings(service.getHeadings())

    return unsubscribe
  }, [service])

  return headings
}

/**
 * Hook for probes on a specific page
 */
export function usePageProbes(
  page: number,
  options: UseIntrospectionOptions = {}
): Probe[] {
  const { service = introspectionService } = options
  const [probes, setProbes] = useState<Probe[]>([])

  useEffect(() => {
    const unsubscribe = service.onProbeDataUpdate(() => {
      setProbes(service.getProbesOnPage(page))
    })

    setProbes(service.getProbesOnPage(page))

    return unsubscribe
  }, [service, page])

  return probes
}

export default useIntrospection

