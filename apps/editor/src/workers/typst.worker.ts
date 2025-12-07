/**
 * Typst Compiler Web Worker (App Shell)
 *
 * Responsibilities:
 * - Load fonts and probe library into the Typst VFS
 * - Compile Typst source
 * - Extract probe metadata using the compiled world (no post-compile mutations)
 */

import {
    createTypstCompiler,
    type TypstCompiler,
} from '@myriaddreamin/typst.ts/compiler'
import { loadFonts } from '@myriaddreamin/typst.ts'

// ============================================================================
// Types (local to keep the worker standalone for Vite bundling)
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
    _v?: string
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

interface ResetRequest {
    kind: 'RESET'
    requestId: string
}

type WorkerRequest = CompileRequest | InitRequest | HeartbeatRequest | ResetRequest

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

interface ResetSuccess {
    kind: 'RESET_SUCCESS'
    requestId: string
}

type WorkerResponse =
    | CompileSuccess
    | CompileError
    | WorkerReady
    | WorkerPanic
    | HeartbeatAck
    | ResetSuccess

// ============================================================================
// Constants
// ============================================================================

const MAIN_FILE_PATH = '/main.typ'
const PROBE_LIB_PATH = '/lib/probe.typ'

// ============================================================================
// Worker State
// ============================================================================

let compiler: TypstCompiler | null = null
let isInitializing = false
let probeLibrarySource: string | null = null

// ============================================================================
// Messaging helpers
// ============================================================================

function postMessage(message: WorkerResponse, transfer?: Transferable[]): void {
    if (transfer && transfer.length > 0) {
        ; (self as unknown as Worker).postMessage(message, transfer)
    } else {
        self.postMessage(message)
    }
}

// ============================================================================
// Asset Loading
// ============================================================================

async function fetchProbeLibrary(): Promise<string> {
    console.log('[Worker] Fetching probe.typ library...')
    try {
        const response = await fetch(PROBE_LIB_PATH)
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

// ============================================================================
// Compiler Lifecycle
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
        // Load probe library and CJK font in parallel
        const [probeLib, cjkFont] = await Promise.all([
            fetchProbeLibrary(),
            fetchFontAsUint8Array('/fonts/NotoSerifSC-Regular.ttf'),
        ])

        probeLibrarySource = probeLib
        console.log('[Worker] Assets loaded:', {
            probe: !!probeLibrarySource,
            cjk: !!cjkFont,
        })

        compiler = createTypstCompiler()

        const localFonts: Uint8Array[] = []
        if (cjkFont) localFonts.push(cjkFont)

        await compiler.init({
            beforeBuild: [
                loadFonts(localFonts, {
                    assets: ['text'], // pulls text + math fonts from CDN
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
        postMessage({
            kind: 'PANIC',
            reason: e instanceof Error ? e.message : String(e),
        })
    }
}

function setupVirtualFileSystem(mainFilePath: string, source: string): void {
    if (!compiler) return

    if (probeLibrarySource) {
        compiler.addSource(PROBE_LIB_PATH, probeLibrarySource)
    }
    compiler.addSource(mainFilePath, source)
}

function extractProbesFromResults(results: unknown[]): ProbeData[] {
    const probes: ProbeData[] = []

    for (const result of results) {
        if (result && typeof result === 'object') {
            const value = (result as { value?: unknown }).value
            if (value && typeof value === 'object' && 'id' in (value as object)) {
                probes.push(value as ProbeData)
            }
        }
    }

    return probes
}

// Note: Probe extraction is now done inline within the runWithWorld callback in compile()
// to ensure we query from the same compiled world context.


async function compile(requestId: string, source: string, mainFilePath: string): Promise<void> {
    if (!compiler) {
        throw new Error('Compiler not initialized')
    }

    const start = performance.now()

    try {
        setupVirtualFileSystem(mainFilePath, source)

        // [FIX] Use runWithWorld to compile AND query in the same world context.
        // This ensures the compiled document is available for probe querying.
        const result = await compiler.runWithWorld({ mainFilePath }, async (world) => {
            // 1. Compile the document in this world
            const compileResult = await world.compile({ diagnostics: 'full' })

            if (compileResult.hasError) {
                return {
                    success: false,
                    diagnostics: compileResult.diagnostics ?? [],
                    artifact: null,
                    probes: [],
                }
            }

            // 2. Query probes from the SAME compiled world
            let probes: ProbeData[] = []
            try {
                const rawResults = await world.query({ selector: '<monolith-probe>' }) as Array<{ value?: unknown }>
                probes = extractProbesFromResults(rawResults)
                console.log(`[Worker] Extracted ${probes.length} probes from compiled world`)
            } catch (e) {
                console.warn('[Worker] Probe query failed:', e)
            }

            // 3. Export artifact from the compiled world
            const vectorResult = await world.vector({ diagnostics: 'full' })

            return {
                success: true,
                diagnostics: vectorResult.diagnostics ?? [],
                artifact: vectorResult.result as Uint8Array | null,
                probes,
            }
        })

        const duration = performance.now() - start

        if (result.success && result.artifact) {
            postMessage(
                {
                    kind: 'COMPILE_SUCCESS',
                    requestId,
                    artifact: result.artifact,
                    timing: duration,
                    probeCount: result.probes.length,
                    probes: result.probes,
                },
                [result.artifact.buffer]
            )
        } else {
            const errorMsg =
                result.diagnostics.length > 0
                    ? JSON.stringify(result.diagnostics, null, 2)
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
                msg.mainFilePath ?? MAIN_FILE_PATH
            ).catch(reportPanic)
            return

        case 'HEARTBEAT':
            postMessage({
                kind: 'HEARTBEAT_ACK',
                timestamp: msg.timestamp,
            })
            return

        case 'RESET':
            if (compiler) {
                // Keep RESET explicit; not invoked between compile and query paths.
                compiler.resetShadow()
            }
            postMessage({ kind: 'RESET_SUCCESS', requestId: msg.requestId })
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


