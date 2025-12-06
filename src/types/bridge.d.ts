/**
 * Typst Worker Bridge Protocol
 * 
 * Strict discriminated union types for Main Thread ↔ Worker communication.
 * No `any` types allowed. All messages use `kind` discriminator.
 * 
 * @module bridge
 */

// ============================================================================
// Worker FSM States
// ============================================================================

/**
 * Finite State Machine states for the Worker Supervisor
 */
export type WorkerState =
    | 'BOOTING'     // Worker loading, Wasm initializing
    | 'IDLE'        // Ready to accept commands
    | 'BUSY'        // Processing compilation
    | 'CRASHED'     // Worker died (panic/error)
    | 'RECOVERING'  // Phoenix Protocol in progress

// ============================================================================
// Inbound Messages (Main Thread → Worker)
// ============================================================================

/**
 * Initialize the compiler with font data
 */
export interface InitMessage {
    readonly kind: 'INIT'
    /** Font bundle as ArrayBuffer (Transferable) */
    readonly fonts?: ArrayBuffer
}

/**
 * Compile Typst source code
 */
export interface CompileMessage {
    readonly kind: 'COMPILE'
    /** Typst source code */
    readonly source: string
    /** Unique request identifier for matching responses */
    readonly requestId: string
    /** Main file path (default: /main.typ) */
    readonly mainFilePath?: string
    /** Output format */
    readonly format?: 'vector' | 'pdf'
}

/**
 * Heartbeat ping for deadlock detection
 */
export interface HeartbeatMessage {
    readonly kind: 'HEARTBEAT'
    /** Timestamp when heartbeat was sent */
    readonly timestamp: number
}

/**
 * Reset compiler state (clear caches, shadow filesystem)
 */
export interface ResetMessage {
    readonly kind: 'RESET'
    readonly requestId: string
}

/**
 * Gracefully dispose the compiler
 */
export interface DisposeMessage {
    readonly kind: 'DISPOSE'
}

/**
 * Discriminated union of all inbound message types
 */
export type MainToWorkerMessage =
    | InitMessage
    | CompileMessage
    | HeartbeatMessage
    | ResetMessage
    | DisposeMessage

// ============================================================================
// Outbound Messages (Worker → Main Thread)
// ============================================================================

/**
 * Worker has finished booting and is ready
 */
export interface ReadyMessage {
    readonly kind: 'READY'
}

/**
 * Compilation completed successfully
 * 
 * @remarks
 * The `artifact` Uint8Array should be transferred (zero-copy) using
 * postMessage's transferable objects: `postMessage(msg, [artifact.buffer])`
 */
export interface CompileSuccessMessage {
    readonly kind: 'COMPILE_SUCCESS'
    /** Compiled artifact (Transferable via ArrayBuffer) */
    readonly artifact: Uint8Array
    /** Compilation time in milliseconds */
    readonly timing: number
    /** Match to original request */
    readonly requestId: string
    /** Diagnostic messages (warnings, hints) */
    readonly diagnostics?: DiagnosticInfo[]
}

/**
 * Compilation failed with recoverable error
 */
export interface CompileErrorMessage {
    readonly kind: 'COMPILE_ERROR'
    /** Error description */
    readonly error: string
    /** Match to original request */
    readonly requestId: string
    /** Diagnostic messages */
    readonly diagnostics?: DiagnosticInfo[]
}

/**
 * Unrecoverable Wasm panic occurred
 * 
 * @remarks
 * After sending this message, the Worker is in an undefined state.
 * The Supervisor should immediately terminate and recreate the Worker.
 */
export interface PanicMessage {
    readonly kind: 'PANIC'
    /** Panic reason/message */
    readonly reason: string
    /** Stack trace if available */
    readonly stack?: string
}

/**
 * Heartbeat acknowledgment for liveness check
 */
export interface HeartbeatAckMessage {
    readonly kind: 'HEARTBEAT_ACK'
    /** Echo back the timestamp */
    readonly timestamp: number
}

/**
 * Reset completed successfully
 */
export interface ResetSuccessMessage {
    readonly kind: 'RESET_SUCCESS'
    readonly requestId: string
}

/**
 * Discriminated union of all outbound message types
 */
export type WorkerToMainMessage =
    | ReadyMessage
    | CompileSuccessMessage
    | CompileErrorMessage
    | PanicMessage
    | HeartbeatAckMessage
    | ResetSuccessMessage

// ============================================================================
// Supporting Types
// ============================================================================

/**
 * Diagnostic information from the Typst compiler
 */
export interface DiagnosticInfo {
    /** Severity level */
    readonly severity: 'error' | 'warning' | 'info' | 'hint'
    /** Human-readable message */
    readonly message: string
    /** File path where the issue occurred */
    readonly path?: string
    /** Line/column range */
    readonly range?: string
    /** Package name if applicable */
    readonly package?: string
}

/** Alias for backward compatibility */
export type DiagnosticMessage = DiagnosticInfo

/**
 * Worker health metrics for monitoring
 */
export interface WorkerHealthMetrics {
    /** Memory usage in bytes */
    readonly memoryUsage: number
    /** Worker uptime in ms */
    readonly uptime: number
    /** Total compilation count */
    readonly compileCount: number
    /** Average compile time in ms */
    readonly averageCompileTime: number
    /** Last artifact size in bytes */
    readonly lastArtifactSize: number
    /** Estimated page count */
    readonly estimatedPages: number
}

/**
 * Compile result returned by the Supervisor hook
 */
export interface CompileResult {
    /** Compiled artifact data (null on error) */
    readonly artifact: Uint8Array | null
    /** Compilation timing in ms */
    readonly timing: number
    /** Whether compilation had errors */
    readonly hasError: boolean
    /** Diagnostic messages */
    readonly diagnostics: DiagnosticInfo[]
}

/**
 * Custom error class for Worker crashes
 * 
 * Can be caught by React Error Boundaries
 */
export class WorkerCrashedError extends Error {
    readonly name = 'WorkerCrashedError'
    readonly reason: string
    readonly stack?: string

    constructor(reason: string, stack?: string) {
        super(`Typst Worker crashed: ${reason}`)
        this.reason = reason
        if (stack) {
            this.stack = stack
        }
    }
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a message is a compile success
 */
export function isCompileSuccess(msg: WorkerToMainMessage): msg is CompileSuccessMessage {
    return msg.kind === 'COMPILE_SUCCESS'
}

/**
 * Check if a message is a panic
 */
export function isPanic(msg: WorkerToMainMessage): msg is PanicMessage {
    return msg.kind === 'PANIC'
}

/**
 * Check if a message is a heartbeat ack
 */
export function isHeartbeatAck(msg: WorkerToMainMessage): msg is HeartbeatAckMessage {
    return msg.kind === 'HEARTBEAT_ACK'
}

// ============================================================================
// Type-Safe Message Sending
// ============================================================================

/**
 * Send a message to the worker with compile-time type validation
 * 
 * @example
 * ```typescript
 * sendToWorker(worker, {
 *   kind: 'COMPILE',
 *   source: '...',
 *   requestId: '123'
 * })
 * ```
 */
export function sendToWorker(
    worker: Worker,
    message: MainToWorkerMessage,
    transfer?: Transferable[]
): void {
    if (transfer && transfer.length > 0) {
        worker.postMessage(message satisfies MainToWorkerMessage, transfer)
    } else {
        worker.postMessage(message satisfies MainToWorkerMessage)
    }
}

/**
 * Post a response from worker to main thread with type validation
 */
export function postWorkerResponse(
    message: WorkerToMainMessage,
    transfer?: Transferable[]
): void {
    if (transfer && transfer.length > 0) {
        self.postMessage(message satisfies WorkerToMainMessage, transfer)
    } else {
        self.postMessage(message satisfies WorkerToMainMessage)
    }
}
