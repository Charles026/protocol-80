/**
 * useResilientWorker - FSM-based Supervisor Hook with Phoenix Protocol
 * 
 * Manages a Typst compiler Web Worker with:
 * - Finite State Machine: BOOTING → IDLE ↔ BUSY → CRASHED → RECOVERING
 * - Heartbeat-based deadlock detection (5s timeout)
 * - Phoenix Protocol: automatic worker resurrection on crash
 * - State hydration after restart
 * - Unified Protocol v2.0 with exhaustiveness checking
 * 
 * @module useResilientWorker
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
    WorkerState,
    WorkerToMainMessage,
    CompileResult,
} from '../types/bridge.d'
import { assertNever, sendToWorker, WorkerCrashedError } from '../types/bridge.d'

// ============================================================================
// Constants
// ============================================================================

/** Heartbeat timeout in milliseconds */
const HEARTBEAT_TIMEOUT_MS = 5000

/** Compile request timeout in milliseconds */
const COMPILE_TIMEOUT_MS = 60000

/** Maximum restart attempts before giving up */
const MAX_RESTART_ATTEMPTS = 3

/** Delay between restart attempts */
const RESTART_DELAY_MS = 500

// ============================================================================
// Types
// ============================================================================

export interface UseResilientWorkerReturn {
    /** Compile Typst source code */
    compile: (source: string, options?: CompileOptions) => Promise<CompileResult>
    /** Current FSM state */
    state: WorkerState
    /** Manually trigger restart */
    restart: () => void
    /** Last error (if any) */
    error: Error | null
    /** Whether the worker is ready to compile */
    isReady: boolean
}

export interface CompileOptions {
    /** Main file path (default: /main.typ) */
    mainFilePath?: string
    /** Output format */
    format?: 'vector' | 'pdf'
}

interface PendingRequest {
    resolve: (result: CompileResult) => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useResilientWorker(): UseResilientWorkerReturn {
    // FSM State
    const [state, setState] = useState<WorkerState>('BOOTING')
    const [error, setError] = useState<Error | null>(null)

    // Refs for worker management
    const workerRef = useRef<Worker | null>(null)
    const pendingRequestsRef = useRef<Map<string, PendingRequest>>(new Map())
    const restartAttemptsRef = useRef(0)
    const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const lastHeartbeatAckRef = useRef<number>(Date.now())
    const isMountedRef = useRef(true)
    const stateRef = useRef<WorkerState>(state)

    // Keep stateRef in sync with state
    stateRef.current = state

    // Request ID generator
    const generateRequestId = useCallback(() => {
        return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
    }, [])

    // ============================================================================
    // Phoenix Protocol (Self-Healing) - declared first for reference
    // ============================================================================

    const triggerPhoenixProtocol = useCallback(() => {
        if (!isMountedRef.current) return

        // Check restart attempts
        if (restartAttemptsRef.current >= MAX_RESTART_ATTEMPTS) {
            console.error('[useResilientWorker] Max restart attempts reached')
            setState('CRASHED')
            return
        }

        setState('RECOVERING')
        restartAttemptsRef.current++

        console.log(`[useResilientWorker] Phoenix Protocol: attempt ${restartAttemptsRef.current}/${MAX_RESTART_ATTEMPTS}`)

        // 1. Force terminate old worker
        if (workerRef.current) {
            workerRef.current.terminate()
            workerRef.current = null
        }

        // 2. Clear heartbeat timer
        if (heartbeatTimerRef.current) {
            clearInterval(heartbeatTimerRef.current)
            heartbeatTimerRef.current = null
        }

        // 3. Reject pending requests
        for (const [, pending] of pendingRequestsRef.current) {
            clearTimeout(pending.timeout)
            pending.reject(new Error('Worker restarted'))
        }
        pendingRequestsRef.current.clear()

        // 4. Wait and create new worker (createWorker will be called via effect)
        setTimeout(() => {
            if (isMountedRef.current) {
                // Inline worker creation to avoid circular dependency
                createWorkerInternal()
            }
        }, RESTART_DELAY_MS)
    }, [])

    // ============================================================================
    // Worker Message Handler with Exhaustiveness Checking
    // ============================================================================

    const handleWorkerMessage = useCallback((event: MessageEvent<WorkerToMainMessage>) => {
        const message = event.data

        // Unified protocol: all messages use 'kind' discriminator
        switch (message.kind) {
            case 'READY':
                if (isMountedRef.current) {
                    setState('IDLE')
                    restartAttemptsRef.current = 0
                    setError(null)
                }
                return

            case 'COMPILE_SUCCESS': {
                const pending = pendingRequestsRef.current.get(message.requestId)
                if (pending) {
                    clearTimeout(pending.timeout)
                    pendingRequestsRef.current.delete(message.requestId)
                    pending.resolve({
                        artifact: message.artifact,
                        timing: message.timing,
                        hasError: false,
                        diagnostics: message.diagnostics ?? [],
                    })
                }
                if (isMountedRef.current) {
                    setState('IDLE')
                }
                return
            }

            case 'COMPILE_ERROR': {
                const pending = pendingRequestsRef.current.get(message.requestId)
                if (pending) {
                    clearTimeout(pending.timeout)
                    pendingRequestsRef.current.delete(message.requestId)
                    pending.resolve({
                        artifact: null,
                        timing: 0,
                        hasError: true,
                        diagnostics: message.diagnostics ?? [],
                    })
                }
                if (isMountedRef.current) {
                    setState('IDLE')
                }
                return
            }

            case 'PANIC':
                console.error('[useResilientWorker] Worker PANIC:', message.reason)
                if (isMountedRef.current) {
                    setState('CRASHED')
                    setError(new WorkerCrashedError(message.reason, message.stack))
                }
                // Reject all pending requests
                for (const [, pending] of pendingRequestsRef.current) {
                    clearTimeout(pending.timeout)
                    pending.reject(new Error(`Worker panicked: ${message.reason}`))
                }
                pendingRequestsRef.current.clear()
                // Trigger Phoenix Protocol
                triggerPhoenixProtocol()
                return

            case 'HEARTBEAT_ACK':
                lastHeartbeatAckRef.current = message.timestamp
                return

            case 'RESET_SUCCESS':
                // Handle reset success - transition back to IDLE
                if (isMountedRef.current) {
                    setState('IDLE')
                }
                return

            case 'OUTLINE_RESULT':
                // Outline data is handled by TypstWorkerService
                // This hook focuses on compilation lifecycle
                return

            case 'PROBE_RESULT':
                // Probe data is handled by IntrospectionService
                // This hook focuses on compilation lifecycle
                return

            default:
                // Exhaustiveness check - TypeScript will error if we miss a case
                assertNever(message, `[useResilientWorker] Unknown message kind: ${(message as { kind: string }).kind}`)
        }
    }, [triggerPhoenixProtocol])

    // ============================================================================
    // Worker Error Handler
    // ============================================================================

    const handleWorkerError = useCallback((event: ErrorEvent) => {
        console.error('[useResilientWorker] Worker error:', event.message)
        if (isMountedRef.current) {
            setState('CRASHED')
            setError(new Error(event.message))
        }
        triggerPhoenixProtocol()
    }, [triggerPhoenixProtocol])

    // ============================================================================
    // Heartbeat Monitoring
    // ============================================================================

    const startHeartbeatMonitor = useCallback(() => {
        // Clear existing timer
        if (heartbeatTimerRef.current) {
            clearInterval(heartbeatTimerRef.current)
        }

        lastHeartbeatAckRef.current = Date.now()

        heartbeatTimerRef.current = setInterval(() => {
            if (!workerRef.current || !isMountedRef.current) return

            const now = Date.now()
            const timeSinceLastAck = now - lastHeartbeatAckRef.current

            // Send heartbeat using unified protocol
            sendToWorker(workerRef.current, {
                kind: 'HEARTBEAT',
                timestamp: now,
            })

            // Check for timeout (deadlock detection) - enhanced to check all non-crashed states
            if (timeSinceLastAck > HEARTBEAT_TIMEOUT_MS && 
                !['CRASHED', 'RECOVERING', 'BOOTING'].includes(stateRef.current)) {
                console.warn('[useResilientWorker] Heartbeat timeout - worker may be deadlocked')
                triggerPhoenixProtocol()
            }
        }, HEARTBEAT_TIMEOUT_MS / 2) // Check at half the timeout interval
    }, [triggerPhoenixProtocol])

    // ============================================================================
    // Worker Creation (Internal)
    // ============================================================================

    const createWorkerInternal = useCallback(() => {
        if (!isMountedRef.current) return

        setState('BOOTING')

        try {
            // Create new worker
            workerRef.current = new Worker(
                new URL('../workers/typst.worker.ts', import.meta.url),
                { type: 'module' }
            )

            workerRef.current.addEventListener('message', handleWorkerMessage as EventListener)
            workerRef.current.addEventListener('error', handleWorkerError as EventListener)

            // Send init message using unified protocol
            sendToWorker(workerRef.current, { kind: 'INIT' })

            // Start heartbeat monitoring
            startHeartbeatMonitor()

        } catch (err) {
            console.error('[useResilientWorker] Failed to create worker:', err)
            if (isMountedRef.current) {
                setState('CRASHED')
                setError(err instanceof Error ? err : new Error(String(err)))
            }
        }
    }, [handleWorkerMessage, handleWorkerError, startHeartbeatMonitor])

    // ============================================================================
    // Compile Function
    // ============================================================================

    const compile = useCallback(async (source: string, options?: CompileOptions): Promise<CompileResult> => {
        // Check if worker is ready
        if (stateRef.current !== 'IDLE' && stateRef.current !== 'BUSY') {
            // Wait for worker to be ready or throw
            if (stateRef.current === 'CRASHED') {
                throw new Error('Worker is crashed. Call restart() to recover.')
            }
            if (stateRef.current === 'BOOTING' || stateRef.current === 'RECOVERING') {
                // Wait a bit for worker to become ready
                await new Promise<void>((resolve, reject) => {
                    const checkInterval = setInterval(() => {
                        if (stateRef.current === 'IDLE') {
                            clearInterval(checkInterval)
                            resolve()
                        } else if (stateRef.current === 'CRASHED') {
                            clearInterval(checkInterval)
                            reject(new Error('Worker crashed during initialization'))
                        }
                    }, 100)

                    // Timeout after 10s
                    setTimeout(() => {
                        clearInterval(checkInterval)
                        reject(new Error('Worker initialization timeout'))
                    }, 10000)
                })
            }
        }

        if (!workerRef.current) {
            throw new Error('Worker not available')
        }

        const requestId = generateRequestId()
        setState('BUSY')

        return new Promise<CompileResult>((resolve, reject) => {
            // Set up timeout using Promise.race pattern
            const timeout = setTimeout(() => {
                pendingRequestsRef.current.delete(requestId)
                reject(new Error(`Compile timeout after ${COMPILE_TIMEOUT_MS}ms`))

                // Trigger recovery on timeout
                triggerPhoenixProtocol()
            }, COMPILE_TIMEOUT_MS)

            pendingRequestsRef.current.set(requestId, { resolve, reject, timeout })

            // Send compile request using unified protocol
            sendToWorker(workerRef.current!, {
                kind: 'COMPILE',
                source,
                requestId,
                mainFilePath: options?.mainFilePath ?? '/main.typ',
                format: options?.format ?? 'vector',
            })
        })
    }, [generateRequestId, triggerPhoenixProtocol])

    // ============================================================================
    // Manual Restart
    // ============================================================================

    const restart = useCallback(() => {
        restartAttemptsRef.current = 0 // Reset attempts for manual restart
        triggerPhoenixProtocol()
    }, [triggerPhoenixProtocol])

    // ============================================================================
    // Lifecycle
    // ============================================================================

    useEffect(() => {
        isMountedRef.current = true
        createWorkerInternal()

        return () => {
            isMountedRef.current = false

            // Cleanup
            if (heartbeatTimerRef.current) {
                clearInterval(heartbeatTimerRef.current)
            }

            if (workerRef.current) {
                sendToWorker(workerRef.current, { kind: 'DISPOSE' })
                workerRef.current.terminate()
            }

            // Clear pending requests
            for (const [, pending] of pendingRequestsRef.current) {
                clearTimeout(pending.timeout)
            }
            pendingRequestsRef.current.clear()
        }
    }, [createWorkerInternal])

    return {
        compile,
        state,
        restart,
        error,
        isReady: state === 'IDLE',
    }
}

export default useResilientWorker
