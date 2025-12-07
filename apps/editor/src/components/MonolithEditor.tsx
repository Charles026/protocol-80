/**
 * MonolithEditor Component
 * 
 * Main editor component implementing the one-way render loop:
 * Input → ProseMirror State → Serialize → Typst Compile → Canvas Render
 */

import { useState, useEffect, useRef, useCallback } from 'react'
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

    // Refs
    const workerRef = useRef<Worker | null>(null)
    const rendererRef = useRef<TypstRenderer | null>(null)
    const canvasContainerRef = useRef<HTMLDivElement>(null)
    const requestIdRef = useRef<number>(0)
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const latestArtifactRef = useRef<Uint8Array | null>(null)
    const isRenderingRef = useRef<boolean>(false)

    // EditorState (headless) - kept for future use
    const editorStateRef = useRef<EditorState>(EditorState.create({ schema }))

    // ============================================================================
    // Initialize Worker and Renderer
    // ============================================================================

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
                const renderer = createTypstRenderer()
                await renderer.init({
                    getModule: () => new URL(
                        '@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm',
                        import.meta.url
                    ).href
                })
                rendererRef.current = renderer
                console.log('[MonolithEditor] Renderer ready')

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
    }, [])

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
                const probes = msg.probes as Array<{ id: string; location: { page: number; x: number; y: number } }>

                console.log(`[MonolithEditor] Compile success: ${timing.toFixed(0)}ms, ${probeCount} probes`)

                // Log probe data for debugging
                if (probes && probes.length > 0) {
                    console.log('[MonolithEditor] Probes extracted:')
                    probes.forEach((probe, i) => {
                        console.log(`  [${i}] ${probe.id}: page=${probe.location?.page}, x=${probe.location?.x?.toFixed(1)}, y=${probe.location?.y?.toFixed(1)}`)
                    })
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

        // Serialize to Typst with probes
        const typstSource = serializePlainText(text, {
            injectProbes: true,
            probeLibPath: '/lib/probe.typ',
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
        setInputText(text)

        // Update ProseMirror state (headless)
        const newDoc = schema.node('doc', null, [
            schema.node('paragraph', null, text ? [schema.text(text)] : [])
        ])
        editorStateRef.current = EditorState.create({ schema, doc: newDoc })

        // Debounce compilation
        if (debounceRef.current) {
            clearTimeout(debounceRef.current)
        }

        debounceRef.current = setTimeout(() => {
            triggerCompile(text)
        }, 300)
    }, [triggerCompile])

    // ============================================================================
    // Canvas Rendering
    // ============================================================================

    const renderArtifact = useCallback(async (artifact: Uint8Array) => {
        // [FIX] Queued rendering: if busy, save artifact and render after current completes
        if (isRenderingRef.current) {
            // Save this as the pending artifact - only keep the latest
            latestArtifactRef.current = artifact
            console.log('[MonolithEditor] Render busy, queued latest artifact')
            return
        }

        const renderer = rendererRef.current
        const container = canvasContainerRef.current

        if (!renderer || !container) {
            console.warn('[MonolithEditor] Renderer or container not ready')
            return
        }

        try {
            isRenderingRef.current = true // LOCK

            // Render the current artifact
            await renderer.renderToCanvas({
                container,
                artifactContent: artifact,
                format: 'vector',
                pixelPerPt: 3, // High DPI for retina
                backgroundColor: '#ffffff',
            })

        } catch (e) {
            console.error('[MonolithEditor] Render error:', e)
        } finally {
            // Add a small cooldown to let Rust WASM fully release resources
            await new Promise(resolve => setTimeout(resolve, 50))

            isRenderingRef.current = false // UNLOCK

            // Check if there's a pending artifact to render
            const pending = latestArtifactRef.current
            if (pending && pending !== artifact) {
                latestArtifactRef.current = null
                // Use setTimeout for async isolation  
                setTimeout(() => renderArtifact(pending), 0)
            }
        }
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
                </div>
            </div>
        </div>
    )
}
