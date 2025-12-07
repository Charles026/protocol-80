/**
 * Typst Compiler Web Worker
 * 
 * Simplified worker for the Monolith Editor MVP.
 * Handles WASM compilation, font loading, and probe extraction.
 */

import {
    createTypstCompiler,
    type TypstCompiler,
} from '@myriaddreamin/typst.ts/compiler'
import { loadFonts } from '@myriaddreamin/typst.ts'

// ============================================================================
// Types
// ============================================================================

interface ProbeLocation {
    page: number
    x: number
    y: number
}

interface ProbeData {
    kind: string
    id: string
    payload: Record<string, unknown>
    location: ProbeLocation
    _seq: number
}

interface CompileRequest {
    kind: 'COMPILE'
    requestId: string
    source: string
    mainFilePath?: string
}

interface InitRequest {
    kind: 'INIT'
}

interface HeartbeatRequest {
    kind: 'HEARTBEAT'
    timestamp: number
}

type WorkerRequest = CompileRequest | InitRequest | HeartbeatRequest

interface CompileSuccess {
    kind: 'COMPILE_SUCCESS'
    requestId: string
    artifact: Uint8Array
    timing: number
    probeCount: number
    probes: ProbeData[]
}

interface CompileError {
    kind: 'COMPILE_ERROR'
    requestId: string
    error: string
}

interface WorkerReady {
    kind: 'READY'
}

interface WorkerPanic {
    kind: 'PANIC'
    reason: string
}

interface HeartbeatAck {
    kind: 'HEARTBEAT_ACK'
    timestamp: number
}

type WorkerResponse = CompileSuccess | CompileError | WorkerReady | WorkerPanic | HeartbeatAck

// ============================================================================
// Worker State
// ============================================================================

let compiler: TypstCompiler | null = null
let isInitializing = false
let probeLibrarySource: string | null = null

// Font data buffers (loaded once during init)

// ============================================================================
// Message Posting
// ============================================================================

function postMessage(message: WorkerResponse, transfer?: Transferable[]): void {
    if (transfer) {
        (self as unknown as Worker).postMessage(message, transfer)
    } else {
        self.postMessage(message)
    }
}

// ============================================================================
// Probe Library Loading
// ============================================================================

/**
 * Fetch the probe library source from public directory.
 */
async function fetchProbeLibrary(): Promise<string> {
    console.log('[Worker] Fetching probe.typ library...')
    try {
        const response = await fetch('/lib/probe.typ')
        if (!response.ok) {
            throw new Error(`Failed to fetch probe.typ: ${response.status}`)
        }
        const text = await response.text()
        console.log(`[Worker] Loaded probe.typ (${text.length} bytes)`)
        return text
    } catch (e) {
        console.warn('[Worker] Could not load probe.typ, using fallback:', e)
        // Minimal fallback probe implementation
        return `
// Fallback probe implementation
#let PROBE_LABEL = <monolith-probe>
#let probe-counter = counter("monolith-probe-seq")

#let probe(id, payload: (:)) = {
  probe-counter.step()
  context {
    let seq = probe-counter.get().first()
    let final-id = if id == auto { "auto-" + str(seq) } else { id }
    let pos = here().position()
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
      ))
      #PROBE_LABEL
    ]
  }
}
`
    }
}

// ============================================================================
// Compiler Functions
// ============================================================================

function getWasmModuleUrl(): string {
    return new URL(
        '@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm',
        import.meta.url
    ).href
}

async function initCompiler(): Promise<void> {
    if (compiler || isInitializing) return

    isInitializing = true
    console.log('[Worker] Initializing Typst compiler...')

    try {
        // Fetch probe library and CJK font in parallel
        // Text/math fonts come from CDN, only CJK is loaded locally
        const [probeLib, cjkFont] = await Promise.all([
            fetchProbeLibrary(),
            fetchFontAsUint8Array('/fonts/NotoSerifSC-Regular.ttf'),
        ])

        probeLibrarySource = probeLib
        console.log('[Worker] Assets loaded:', {
            probe: !!probeLibrarySource,
            cjk: !!cjkFont,
        })

        // Create compiler with fonts loaded via beforeBuild
        compiler = createTypstCompiler()

        // Local CJK font (14MB)
        const localFonts: Uint8Array[] = []
        if (cjkFont) localFonts.push(cjkFont)

        await compiler.init({
            beforeBuild: [
                // Load text fonts from CDN (includes math fonts like NewCM)
                // plus our local CJK font
                loadFonts(localFonts, {
                    assets: ['text'] // Load LibertinusSerif + NewCM math from CDN
                }),
            ],
            getModule: () => getWasmModuleUrl(),
        })

        isInitializing = false
        console.log('[Worker] Typst compiler ready with fonts!')
        postMessage({ kind: 'READY' })
    } catch (e) {
        isInitializing = false
        console.error('[Worker] Init failed', e)
        throw e
    }
}

/**
 * Fetch a font file as Uint8Array
 */
async function fetchFontAsUint8Array(path: string): Promise<Uint8Array | null> {
    try {
        const response = await fetch(path)
        if (!response.ok) {
            console.warn(`[Worker] Font not found: ${path}`)
            return null
        }
        const buffer = await response.arrayBuffer()
        console.log(`[Worker] Loaded font: ${path} (${(buffer.byteLength / 1024).toFixed(1)}KB)`)
        return new Uint8Array(buffer)
    } catch (e) {
        console.warn(`[Worker] Failed to load font ${path}:`, e)
        return null
    }
}

/**
 * Add required files to the compiler's virtual filesystem
 * [CORRECTION] Do NOT reset. Just update the Virtual File System.
 * Typst compiler is stateful; overwriting the file is enough for incremental updates.
 */
function setupVirtualFileSystem(mainFilePath: string, source: string): void {
    if (!compiler) return

    // Add the probe library (text file) - addSource overwrites if exists
    if (probeLibrarySource) {
        compiler.addSource('/lib/probe.typ', probeLibrarySource)
    }

    // Add the main source file at fixed path
    compiler.addSource(mainFilePath, source)
}

/**
 * Extract probe data from query results
 */
function extractProbesFromResults(results: unknown[]): ProbeData[] {
    const probes: ProbeData[] = []

    for (const result of results) {
        // The query returns objects with a 'value' property
        if (result && typeof result === 'object') {
            const value = (result as { value?: unknown }).value
            if (value && typeof value === 'object' && 'id' in (value as object)) {
                probes.push(value as ProbeData)
            }
        }
    }

    return probes
}

async function compile(requestId: string, source: string, mainFilePath: string): Promise<void> {
    if (!compiler) {
        throw new Error('Compiler not initialized')
    }

    const start = performance.now()

    try {
        // Set up VFS with fonts, probe library and main source
        setupVirtualFileSystem(mainFilePath, source)

        // Compile the document
        const result = await compiler.compile({
            mainFilePath,
            format: 0, // vector format
            diagnostics: 'full',
        })

        const duration = performance.now() - start
        const artifact = result.result as Uint8Array | null

        if (artifact) {
            // Extract probes using the existing compiled state.
            // Do NOT mutate the virtual FS here—addSource would mark the world dirty
            // and the query API would reject with "document is not compiled".
            let probes: ProbeData[] = []
            try {
                const queryResults = await compiler.query({
                    mainFilePath,
                    selector: '<monolith-probe>',
                }) as unknown[]

                probes = extractProbesFromResults(queryResults)
                console.log(`[Worker] Extracted ${probes.length} probes:`, probes)
            } catch (e) {
                console.warn('[Worker] Probe extraction failed:', e)
            }

            // Zero-copy transfer
            postMessage(
                {
                    kind: 'COMPILE_SUCCESS',
                    requestId,
                    artifact,
                    timing: duration,
                    probeCount: probes.length,
                    probes,
                },
                [artifact.buffer]
            )
        } else {
            const diagnostics = result.diagnostics ?? []
            const errorMsg = diagnostics.length > 0
                ? JSON.stringify(diagnostics, null, 2)
                : 'Compilation produced no output'

            postMessage({
                kind: 'COMPILE_ERROR',
                requestId,
                error: errorMsg,
            })
        }
    } catch (err) {
        console.error('[Worker] Compile Exception:', err)
        postMessage({
            kind: 'COMPILE_ERROR',
            requestId,
            error: err instanceof Error ? err.message : String(err),
        })
    }
}

// ============================================================================
// Message Handler
// ============================================================================

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
    const msg = event.data

    switch (msg.kind) {
        case 'INIT':
            initCompiler().catch(reportPanic)
            return

        case 'COMPILE':
            compile(
                msg.requestId,
                msg.source,
                msg.mainFilePath ?? '/main.typ'
            ).catch(reportPanic)
            return

        case 'HEARTBEAT':
            postMessage({
                kind: 'HEARTBEAT_ACK',
                timestamp: msg.timestamp,
            })
            return

        default:
            console.warn('[Worker] Unknown message kind:', (msg as { kind: string }).kind)
    }
}

// ============================================================================
// Error Handling
// ============================================================================

function reportPanic(err: unknown): void {
    console.error('[Worker PANIC]', err)
    postMessage({
        kind: 'PANIC',
        reason: err instanceof Error ? err.message : String(err),
    })
}

self.onerror = (e) => {
    reportPanic(e)
    return true
}

self.onunhandledrejection = (e: PromiseRejectionEvent) => {
    reportPanic(e.reason)
}
