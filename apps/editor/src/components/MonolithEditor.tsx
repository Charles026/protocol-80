/**
 * MonolithEditor Component
 * 
 * Main editor component implementing the one-way render loop:
 * Input → ProseMirror State → Serialize → Typst Compile → Canvas Render
 */

import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react'
import { Schema } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { serializePlainText } from '../core/serializer'
import { MonolithRenderManager } from '../core/MonolithRenderManager'
import TypstWorker from '../workers/typst.worker?worker'
import { EDITOR_CONFIG } from '../config/editor'

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
// Constants (extracted from EDITOR_CONFIG for local use)
// ============================================================================

// Note: All magic numbers are now centralized in EDITOR_CONFIG
// These local references provide cleaner usage in the render code

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
        const visualX = x * EDITOR_CONFIG.PIXEL_PER_PT * scale
        const visualY = y * EDITOR_CONFIG.PIXEL_PER_PT * scale
        const visualHeight = height * EDITOR_CONFIG.PIXEL_PER_PT * scale

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
        scale: EDITOR_CONFIG.DEFAULT_SCALE,
        containerPadding: EDITOR_CONFIG.CANVAS_PADDING,
    })

    // Cursor offset in textarea
    const cursorOffsetRef = useRef<number>(0)

    // Refs
    const workerRef = useRef<Worker | null>(null)
    const canvasContainerRef = useRef<HTMLDivElement>(null)
    const typstMountRef = useRef<HTMLDivElement>(null) // Dedicated mount point for Typst
    const requestIdRef = useRef<number>(0)
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const latestArtifactRef = useRef<Uint8Array | null>(null)

    // Strict render loop state (latest-only, serialized)
    const isRenderingRef = useRef(false)

    // EditorState (headless) - kept for future use
    const editorStateRef = useRef<EditorState>(EditorState.create({ schema }))

    // Refs for stable callbacks (avoid useEffect dependency churn)
    const inputTextRef = useRef(inputText)
    inputTextRef.current = inputText


    // ============================================================================
    // Compile Logic
    // ============================================================================

    const triggerCompile = useCallback((text: string) => {
        const worker = workerRef.current
        if (!worker) return

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
    }, [])

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
        }, EDITOR_CONFIG.INPUT_DEBOUNCE_MS)
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
        }, EDITOR_CONFIG.INPUT_DEBOUNCE_MS)
    }, [inputText, triggerCompile])


    // ============================================================================
    // Initialize Worker and Renderer (runs once on mount)
    // ============================================================================

    useEffect(() => {
        let mounted = true

        async function init() {
            try {
                // Singleton Init (protects against strict mode double-init internally)
                const renderManager = MonolithRenderManager.getInstance()
                await renderManager.init()

                if (!mounted) return

                // We no longer need local rendererRef for rendering, 
                // but if other parts use it, we might need to expose it from manager.
                // However, current code uses manager for scheduling.

                console.log('[MonolithEditor] Renderer initialized (Singleton)')

                // 2. Create worker
                const worker = new TypstWorker()
                workerRef.current = worker

                // 3. Set up message handler (uses refs for stable access to current state)
                worker.onmessage = (event: MessageEvent) => {
                    if (!mounted) return
                    const msg = event.data as { kind: string;[key: string]: unknown }

                    switch (msg.kind) {
                        case 'READY': {
                            console.log('[MonolithEditor] Worker ready, triggering initial compile')
                            setStatus('ready')

                            // Trigger initial compile using ref for current inputText
                            const text = inputTextRef.current
                            const typstSource = serializePlainText(text, {
                                injectProbes: true,
                                probeLibPath: '/lib/probe.typ',
                                cursorOffset: cursorOffsetRef.current,
                            })
                            console.log('[MonolithEditor] Generated Typst source:\n', typstSource)
                            requestIdRef.current++
                            worker.postMessage({
                                kind: 'COMPILE',
                                requestId: `req-${requestIdRef.current}`,
                                source: typstSource,
                                mainFilePath: '/main.typ',
                            })
                            break
                        }

                        case 'COMPILE_SUCCESS': {
                            const artifact = msg.artifact as Uint8Array
                            const timing = msg.timing as number
                            const probeCount = msg.probeCount as number
                            const probes = msg.probes as Array<{ id: string; payload?: { kind?: string }; location: { page: number; x: number; y: number } }>

                            console.log(`[MonolithEditor] Compile success: ${timing.toFixed(0)}ms, ${probeCount} probes`)

                            // Find cursor probe and update position
                            const cursorProbe = probes?.find(p => p.id === 'cursor' || p.payload?.kind === 'cursor')
                            if (cursorProbe?.location) {
                                setCursorState({
                                    x: cursorProbe.location.x,
                                    y: cursorProbe.location.y,
                                    height: EDITOR_CONFIG.CURSOR_HEIGHT_PT,
                                    pageIndex: cursorProbe.location.page,
                                })
                            } else {
                                setCursorState(null)
                            }

                            setStats({
                                lastCompileTime: timing,
                                probeCount,
                                artifactSize: artifact.byteLength,
                            })

                            // Schedule render via Singleton Manager
                            if (typstMountRef.current) {
                                MonolithRenderManager.getInstance().scheduleRender(new Uint8Array(artifact), typstMountRef.current)
                                    .then(() => {
                                        // Update scale after render
                                        const canvas = typstMountRef.current?.querySelector('canvas')
                                        if (canvas) {
                                            const rect = canvas.getBoundingClientRect()
                                            const renderedScale = rect.width / canvas.width
                                            setLayoutState(prev => {
                                                if (Math.abs(prev.scale - renderedScale) > 0.001) {
                                                    return { ...prev, scale: renderedScale }
                                                }
                                                return prev
                                            })
                                        }
                                    })
                            }

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
                }

                worker.onerror = (err) => {
                    console.error('[MonolithEditor] Worker error:', err)
                    setStatus('error')
                    setError('Worker crashed')
                }

                // 4. Initialize compiler in worker
                worker.postMessage({ kind: 'INIT' })
            } catch (e) {
                console.error('[MonolithEditor] Init error:', e)
                setStatus('error')
                setError(e instanceof Error ? e.message : String(e))
                // initMutex.current = false // Reset mutex on failure -> Removed for Singleton
            }
        }

        void init()
        return () => {
            mounted = false
            workerRef.current?.terminate()
            workerRef.current = null
            latestArtifactRef.current = null
            isRenderingRef.current = false
            // Note: We don't reset initMutex.current immediately because strict mode 
            // mounts/unmounts rapidly. We want to preserve the 'initialized' state
            // or we'd need a more complex singleton pattern.
            // But for now, ensuring we don't start the second init is key.
            // Actually, if we unmount, we SHOULD verify if we need to let it re-init.
            // But strict mode re-uses the component state? No, useEffect runs twice.
            // If we terminate on Unmount1, and block Init2, we have nothing.
            // FIX: We must allow re-init IF we fully cleaned up, OR we persist the worker.
            // Since we terminate worker, we MUST re-init.

            // Removed initMutex reset
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []) // Empty deps - init runs once on mount

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
