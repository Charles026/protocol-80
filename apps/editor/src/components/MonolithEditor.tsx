/**
 * MonolithEditor Component
 * 
 * Main editor component implementing the one-way render loop:
 * Input → ProseMirror State → Serialize → Typst Compile → Canvas Render
 */

import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react'
import { Schema } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { createTypstRenderer, type TypstRenderer } from '@myriaddreamin/typst.ts/renderer'
import { serializePlainText } from '../core/serializer'
import TypstWorker from '../workers/typst.worker?worker'

// ============================================================================
// ProseMirror Schema
// ============================================================================

/**
 * Minimal schema for MVP - just documents with paragraphs and text
 */
const schema = new Schema({
    nodes: {
        doc: { content: 'block+' },
        paragraph: {
            group: 'block',
            content: 'inline*',
            parseDOM: [{ tag: 'p' }],
            toDOM() { return ['p', 0] }
        },
        text: { group: 'inline' }
    },
    marks: {
        strong: {
            parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
            toDOM() { return ['strong', 0] }
        },
        em: {
            parseDOM: [{ tag: 'em' }, { tag: 'i' }],
            toDOM() { return ['em', 0] }
        }
    }
})

// ============================================================================
// Types
// ============================================================================

type EditorStatus = 'initializing' | 'ready' | 'compiling' | 'error'

interface CompileStats {
    lastCompileTime: number
    probeCount: number
    artifactSize: number
}

// ============================================================================
// Constants
// ============================================================================

/** Pixels per point - must match renderToCanvas pixelPerPt value */
const PIXEL_PER_PT = 3.0

/** Default display scale factor (for now fixed, will be dynamic with zoom) */
const DEFAULT_SCALE = 1.0

// ============================================================================
// Types for Cursor and Layout
// ============================================================================

interface CursorState {
    /** Raw X coordinate from engine (in points) */
    x: number
    /** Raw Y coordinate from engine (in points) */
    y: number
    /** Cursor height in points */
    height: number
    /** Page index (for multi-page support) */
    pageIndex: number
}

interface LayoutState {
    /** Global scale factor (for zoom) */
    scale: number
    /** Canvas container padding in pixels */
    containerPadding: number
}

// ============================================================================
// Render Queue - Strictly serializes render calls to prevent Rust aliasing
// ============================================================================

class RenderQueue {
    private isBusy: boolean = false
    private pendingTask: (() => Promise<void>) | null = null

    enqueue(task: () => Promise<void>): void {
        // If busy, overwrite pending task (conflation/frame skipping)
        if (this.isBusy) {
            this.pendingTask = task
            return
        }

        // Otherwise start immediately
        this.process(task)
    }

    private async process(task: () => Promise<void>) {
        // console.log('[RenderQueue] Processing task...')
        this.isBusy = true

        try {
            await task()
            // console.log('[RenderQueue] Task finished')
        } catch (err) {
            console.warn('[RenderQueue] Task failed:', err)
            // Extra cooldown on error to let system settle
            await new Promise(resolve => setTimeout(resolve, 50))
        } finally {
            // Unlock on next animation frame for max smoothness
            requestAnimationFrame(() => {
                this.isBusy = false

                if (this.pendingTask) {
                    // console.log('[RenderQueue] Processing pending task...')
                    const next = this.pendingTask
                    this.pendingTask = null
                    this.process(next)
                } else {
                    // console.log('[RenderQueue] Idle')
                }
            })
        }
    }
}

// ============================================================================
// Phantom Cursor Component - Scale-aware cursor positioning
// ============================================================================

interface PhantomCursorProps {
    cursorState: CursorState | null
    layoutState: LayoutState
    containerRef: React.RefObject<HTMLDivElement | null>
}

/**
 * PhantomCursor renders a blinking cursor on the canvas.
 * Position is calculated using: Pos_cursor = (Pos_core × PIXEL_PER_PT × Scale) + Offset
 * 
 * Uses useLayoutEffect to prevent visual \"jump\" glitches during zoom.
 * Uses transform instead of left/top for better GPU performance.
 */
function PhantomCursor({ cursorState, layoutState }: PhantomCursorProps) {
    const cursorRef = useRef<HTMLDivElement>(null)

    useLayoutEffect(() => {
        if (!cursorRef.current || !cursorState) {
            if (cursorRef.current) {
                cursorRef.current.style.display = 'none'
            }
            return
        }

        const { x, y, height } = cursorState
        const { scale, containerPadding } = layoutState

        // Formula: Pos_cursor = (Pos_core × PIXEL_PER_PT × Scale) + Offset
        // PIXEL_PER_PT converts pt → px at 1:1 scale
        // scale applies the current zoom level
        const visualX = x * PIXEL_PER_PT * scale
        const visualY = y * PIXEL_PER_PT * scale
        const visualHeight = height * PIXEL_PER_PT * scale

        // Add container padding offset
        const finalLeft = containerPadding + visualX
        const finalTop = containerPadding + visualY

        // Apply styles directly for performance (bypass React render cycle)
        cursorRef.current.style.display = 'block'
        cursorRef.current.style.transform = `translate(${finalLeft}px, ${finalTop}px)`
        cursorRef.current.style.height = `${visualHeight}px`

    }, [cursorState, layoutState])

    // Width stays constant (2px) regardless of scale for visibility
    return (
        <div
            ref={cursorRef}
            className="phantom-cursor"
            style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: '2px',
                backgroundColor: '#000000',
                pointerEvents: 'none',
                zIndex: 100,
                display: 'none', // Initially hidden until positioned
            }}
        />
    )
}

// ============================================================================
// Component
// ============================================================================

export function MonolithEditor() {
    // State
    const [status, setStatus] = useState<EditorStatus>('initializing')
    const [error, setError] = useState<string | null>(null)
    const [inputText, setInputText] = useState<string>(
        'Hello, *Monolith* Editor!\n\nThis is a paragraph with inline $x^2 + y^2 = z^2$ math.\n\nAnother paragraph here.'
    )
    const [stats, setStats] = useState<CompileStats>({
        lastCompileTime: 0,
        probeCount: 0,
        artifactSize: 0,
    })

    // Cursor state from probe (raw coordinates in points)
    const [cursorState, setCursorState] = useState<CursorState | null>(null)

    // Layout state for scale support
    const [layoutState, setLayoutState] = useState<LayoutState>({
        scale: DEFAULT_SCALE,
        containerPadding: 20, // matches CSS .canvas-container padding
    })

    // Cursor offset in textarea
    const cursorOffsetRef = useRef<number>(0)

    // Refs
    const workerRef = useRef<Worker | null>(null)
    const rendererRef = useRef<TypstRenderer | null>(null)
    const canvasContainerRef = useRef<HTMLDivElement>(null)
    const typstMountRef = useRef<HTMLDivElement>(null) // Dedicated mount point for Typst
    const requestIdRef = useRef<number>(0)
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const latestArtifactRef = useRef<Uint8Array | null>(null)

    // Render Queue for strict serialization (prevents Rust aliasing panic)
    const renderQueueRef = useRef(new RenderQueue())

    // EditorState (headless) - kept for future use
    const editorStateRef = useRef<EditorState>(EditorState.create({ schema }))

    // ============================================================================
    // Initialize Worker and Renderer
    // ============================================================================

    // Initialize renderer helper
    const initRenderer = useCallback(async () => {
        try {
            const renderer = createTypstRenderer()
            await renderer.init({
                getModule: () => new URL(
                    '@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm',
                    import.meta.url
                ).href
            })
            rendererRef.current = renderer
            console.log('[MonolithEditor] Renderer initialized')
            return true
        } catch (e) {
            console.error('[MonolithEditor] Failed to init renderer:', e)
            return false
        }
    }, [])

    useEffect(() => {
        let mounted = true

        async function init() {
            try {
                console.log('[MonolithEditor] Initializing...')

                // Create worker
                const worker = new TypstWorker()
                workerRef.current = worker

                // Set up message handler
                worker.onmessage = (event: MessageEvent) => {
                    if (!mounted) return
                    handleWorkerMessage(event.data)
                }

                worker.onerror = (err) => {
                    console.error('[MonolithEditor] Worker error:', err)
                    setStatus('error')
                    setError('Worker crashed')
                }

                // Initialize renderer
                await initRenderer()

                // Initialize compiler
                worker.postMessage({ kind: 'INIT' })

            } catch (e) {
                console.error('[MonolithEditor] Init error:', e)
                setStatus('error')
                setError(e instanceof Error ? e.message : String(e))
            }
        }

        init()
        return () => {
            mounted = false
            workerRef.current?.terminate()
        }
    }, [initRenderer])

    // ============================================================================
    // Worker Message Handler
    // ============================================================================

    const handleWorkerMessage = useCallback((msg: { kind: string;[key: string]: unknown }) => {
        switch (msg.kind) {
            case 'READY':
                console.log('[MonolithEditor] Worker ready, triggering initial compile')
                setStatus('ready')
                // Trigger initial compile
                triggerCompile(inputText)
                break

            case 'COMPILE_SUCCESS': {
                const artifact = msg.artifact as Uint8Array
                const timing = msg.timing as number
                const probeCount = msg.probeCount as number
                const probes = msg.probes as Array<{ id: string; payload?: { kind?: string }; location: { page: number; x: number; y: number } }>

                console.log(`[MonolithEditor] Compile success: ${timing.toFixed(0)}ms, ${probeCount} probes`)

                // Find cursor probe and update position (store raw pt coords)
                const cursorProbe = probes?.find(p => p.id === 'cursor' || p.payload?.kind === 'cursor')
                if (cursorProbe?.location) {
                    // Store RAW coordinates in points - scaling applied in PhantomCursor
                    setCursorState({
                        x: cursorProbe.location.x,
                        y: cursorProbe.location.y,
                        height: 12, // Default cursor height in pt
                        pageIndex: cursorProbe.location.page,
                    })
                    console.log(`[MonolithEditor] Cursor at: (${cursorProbe.location.x.toFixed(1)}, ${cursorProbe.location.y.toFixed(1)}) pt`)
                } else {
                    setCursorState(null)
                }

                setStats({
                    lastCompileTime: timing,
                    probeCount,
                    artifactSize: artifact.byteLength,
                })

                // Store artifact and render
                latestArtifactRef.current = artifact
                renderArtifact(artifact)
                setStatus('ready')
                setError(null)
                break
            }

            case 'COMPILE_ERROR':
                console.error('[MonolithEditor] Compile error:', msg.error)
                setStatus('error')
                setError(msg.error as string)
                break

            case 'PANIC':
                console.error('[MonolithEditor] Worker panic:', msg.reason)
                setStatus('error')
                setError(`Worker panic: ${msg.reason}`)
                break
        }
    }, [inputText])

    // ============================================================================
    // Compile Logic
    // ============================================================================

    const triggerCompile = useCallback((text: string) => {
        const worker = workerRef.current
        if (!worker || status === 'initializing') return

        setStatus('compiling')

        // Serialize to Typst with probes, including cursor probe
        const typstSource = serializePlainText(text, {
            injectProbes: true,
            probeLibPath: '/lib/probe.typ',
            cursorOffset: cursorOffsetRef.current,
        })

        console.log('[MonolithEditor] Generated Typst source:\n', typstSource)

        // Send to worker
        requestIdRef.current++
        worker.postMessage({
            kind: 'COMPILE',
            requestId: `req-${requestIdRef.current}`,
            source: typstSource,
            mainFilePath: '/main.typ',
        })
    }, [status])

    // ============================================================================
    // Debounced Input Handler
    // ============================================================================

    const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const text = e.target.value
        const cursorOffset = e.target.selectionStart ?? 0

        setInputText(text)
        cursorOffsetRef.current = cursorOffset

        // Update ProseMirror state (headless)
        const newDoc = schema.node('doc', null, [
            schema.node('paragraph', null, text ? [schema.text(text)] : [])
        ])
        editorStateRef.current = EditorState.create({ schema, doc: newDoc })

        // Debounce compilation (200ms to reduce Rust aliasing panics)
        if (debounceRef.current) {
            clearTimeout(debounceRef.current)
        }

        debounceRef.current = setTimeout(() => {
            triggerCompile(text)
        }, 16)
    }, [triggerCompile])

    // Track cursor position changes (click, arrow keys, etc.)
    const handleSelect = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
        const target = e.target as HTMLTextAreaElement
        cursorOffsetRef.current = target.selectionStart ?? 0

        // Trigger recompile to update cursor position
        if (debounceRef.current) {
            clearTimeout(debounceRef.current)
        }
        debounceRef.current = setTimeout(() => {
            triggerCompile(inputText)
        }, 16)
    }, [inputText, triggerCompile])

    // ============================================================================
    // Canvas Rendering
    // ============================================================================

    const renderArtifact = useCallback((artifact: Uint8Array) => {
        // Use RenderQueue to strictly serialize render calls
        renderQueueRef.current.enqueue(async () => {
            const renderer = rendererRef.current
            const mountPoint = typstMountRef.current

            if (!renderer || !mountPoint) {
                console.warn('[MonolithEditor] Renderer or mount point not ready')
                return
            }

            // Render the artifact
            console.log(`[MonolithEditor] Rendering artifact (${artifact.byteLength} bytes) to mount point...`)
            try {
                await renderer.renderToCanvas({
                    container: mountPoint,
                    artifactContent: artifact,
                    format: 'vector',
                    pixelPerPt: PIXEL_PER_PT,
                    backgroundColor: '#ffffff',
                })
            } catch (e) {
                console.error('[MonolithEditor] renderToCanvas failed:', e)

                // Auto-Recovery for critical WASM ownership errors
                const errStr = String(e)
                if (errStr.includes('attempted to take ownership') || errStr.includes('recursive use')) {
                    console.warn('[MonolithEditor] Critical renderer error detected. Re-initializing renderer...')
                    rendererRef.current = null // Prevent further use
                    await initRenderer()
                    console.log('[MonolithEditor] Renderer recovered. Skipping this frame.')
                    return // Skip this frame
                }

                throw e // Re-throw other errors
            }

            // Calculate scale after render (CSS fit-to-width)
            const canvas = mountPoint.querySelector('canvas')
            if (canvas) {
                const rect = canvas.getBoundingClientRect()
                console.log(`[MonolithEditor] Render check - Canvas: Intrinsic=${canvas.width}x${canvas.height}, Display=${rect.width}x${rect.height}`)

                // Effective scale = Rendered Width (px) / Intrinsic Width (px)
                // Intrinsic width is set by canvas.width (which is scaled by pixelRatio in typst.ts, or just width * pixelPerPt)
                // Actually typst.ts sets width/height attributes based on pixelPerPt.

                // Effective scale = Rendered Width (px) / Intrinsic Width (px)
                // Intrinsic Width = Width (pt) * PIXEL_PER_PT

                // Wait a tick for layout to settle? Usually sync after renderToCanvas is fine if DOM is updated.
                // However, let's measuring the ratio directly:
                const renderedScale = rect.width / canvas.width

                // The 'scale' in our formula earlier was meant to be the zoom level relative to 'intrinsic'.
                // If canvas.width is 3000px (1000pt * 3), and it renders at 1000px width.
                // renderedScale = 0.333.
                // Pos (pt) = 500pt.
                // Visual Pos (px) = 500 * 3 * 0.333 = 500px. Correct.

                console.log(`[MonolithEditor] Scale updated: ${renderedScale.toFixed(4)} (Rendered: ${rect.width}px / Intrinsic: ${canvas.width}px)`)

                // Update layout state
                setLayoutState((prev: LayoutState) => {
                    if (Math.abs(prev.scale - renderedScale) > 0.001) {
                        return { ...prev, scale: renderedScale }
                    }
                    return prev
                })
            }
        })
    }, [])

    // Update scale on window resize
    useEffect(() => {
        const handleResize = () => {
            const mountPoint = typstMountRef.current
            const canvas = mountPoint?.querySelector('canvas')
            if (canvas) {
                const rect = canvas.getBoundingClientRect()
                const newScale = rect.width / canvas.width

                // Only update if changed significantly
                setLayoutState((prev: LayoutState) => {
                    if (Math.abs(prev.scale - newScale) > 0.001) {
                        console.log(`[MonolithEditor] Resize scale: ${newScale.toFixed(4)}`)
                        return { ...prev, scale: newScale }
                    }
                    return prev
                })
            }
        }

        window.addEventListener('resize', handleResize)
        return () => window.removeEventListener('resize', handleResize)
    }, [])

    // ============================================================================
    // Render
    // ============================================================================

    return (
        <div className="monolith-editor">
            {/* Input Panel */}
            <div className="editor-panel">
                <div className="panel-header">
                    <h2>Input</h2>
                    <span className={`status-badge ${status}`}>
                        {status === 'initializing' && 'Initializing...'}
                        {status === 'ready' && 'Ready'}
                        {status === 'compiling' && 'Compiling...'}
                        {status === 'error' && 'Error'}
                    </span>
                </div>
                <div className="input-area">
                    <textarea
                        value={inputText}
                        onChange={handleInputChange}
                        onSelect={handleSelect}
                        onClick={handleSelect}
                        onKeyUp={handleSelect}
                        placeholder="Type here... Use $...$ for math equations"
                        disabled={status === 'initializing'}
                    />
                </div>

                {/* Stats */}
                <div className="info-panel">
                    <div className="info-grid">
                        <div className="info-item">
                            <span className="label">Last Compile</span>
                            <span className="value">{stats.lastCompileTime.toFixed(0)}ms</span>
                        </div>
                        <div className="info-item">
                            <span className="label">Probes</span>
                            <span className="value">{stats.probeCount}</span>
                        </div>
                        <div className="info-item">
                            <span className="label">Artifact Size</span>
                            <span className="value">{(stats.artifactSize / 1024).toFixed(1)}KB</span>
                        </div>
                    </div>
                </div>

                {/* Error Display */}
                {error && (
                    <div className="error-panel">
                        {error}
                    </div>
                )}
            </div>

            {/* Canvas Panel */}
            <div className="canvas-panel">
                <div className="panel-header">
                    <h2>Typst Output</h2>
                </div>
                <div className="canvas-container" ref={canvasContainerRef}>
                    {status === 'initializing' && (
                        <div className="loading-overlay">Initializing Typst Engine</div>
                    )}

                    {/* Typst Render Layer (Isolated) */}
                    <div className="typst-mount-point" ref={typstMountRef} />

                    {/* Cursor Layer (Isolated) */}
                    <PhantomCursor
                        cursorState={cursorState}
                        layoutState={layoutState}
                        containerRef={canvasContainerRef}
                    />
                </div>
            </div>
        </div>
    )
}
