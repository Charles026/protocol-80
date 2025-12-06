/**
 * useResilientWorker - FSM-based Supervisor Hook with Phoenix Protocol
 * 
 * Manages a Typst compiler Web Worker with:
 * - Finite State Machine: BOOTING → IDLE ↔ BUSY → CRASHED → RECOVERING
 * - Heartbeat-based deadlock detection (5s timeout)
 * - Phoenix Protocol: automatic worker resurrection on crash
 * - State hydration after restart
 * 
 * @module useResilientWorker
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
    WorkerState,
    WorkerToMainMessage,
    CompileResult,
    WorkerCrashedError,
} from '../types/bridge.d'

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
    // Worker Message Handler
    // ============================================================================

    const handleWorkerMessage = useCallback((event: MessageEvent<WorkerToMainMessage>) => {
        const message = event.data

        // Handle bridge protocol messages
        if ('kind' in message) {
            switch (message.kind) {
                case 'READY':
                    if (isMountedRef.current) {
                        setState('IDLE')
                        restartAttemptsRef.current = 0
                        setError(null)
                    }
                    break

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
                    break
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
                    break
                }

                case 'PANIC':
                    console.error('[useResilientWorker] Worker PANIC:', message.reason)
                    if (isMountedRef.current) {
                        setState('CRASHED')
                        setError(new Error(`Worker crashed: ${message.reason}`) as WorkerCrashedError)
                    }
                    // Reject all pending requests
                    for (const [, pending] of pendingRequestsRef.current) {
                        clearTimeout(pending.timeout)
                        pending.reject(new Error(`Worker panicked: ${message.reason}`))
                    }
                    pendingRequestsRef.current.clear()
                    // Trigger Phoenix Protocol
                    triggerPhoenixProtocol()
                    break

                case 'HEARTBEAT_ACK':
                    lastHeartbeatAckRef.current = message.timestamp
                    break

                case 'RESET_SUCCESS':
                    // Handle reset success if needed
                    break
            }
        }

        // Also handle legacy protocol for backward compatibility
        if ('type' in message) {
            const legacyMsg = message as {
                type: string
                id?: string
                payload?: {
                    artifact?: Uint8Array
                    diagnostics?: Array<{ severity: string; message: string }>
                    error?: string
                }
            }

            if (legacyMsg.type === 'ready' || legacyMsg.type === 'init_success') {
                if (isMountedRef.current && (state === 'BOOTING' || state === 'RECOVERING')) {
                    setState('IDLE')
                    restartAttemptsRef.current = 0
                    setError(null)
                }
            } else if (legacyMsg.type === 'compile_success' && legacyMsg.id) {
                const pending = pendingRequestsRef.current.get(legacyMsg.id)
                if (pending) {
                    clearTimeout(pending.timeout)
                    pendingRequestsRef.current.delete(legacyMsg.id)
                    pending.resolve({
                        artifact: legacyMsg.payload?.artifact ?? null,
                        timing: 0, // Legacy protocol doesn't include timing
                        hasError: false,
                        diagnostics: (legacyMsg.payload?.diagnostics ?? []).map(d => ({
                            severity: d.severity as 'error' | 'warning' | 'info' | 'hint',
                            message: d.message,
                        })),
                    })
                }
                if (isMountedRef.current) {
                    setState('IDLE')
                }
            } else if (legacyMsg.type === 'compile_error' && legacyMsg.id) {
                const pending = pendingRequestsRef.current.get(legacyMsg.id)
                if (pending) {
                    clearTimeout(pending.timeout)
                    pendingRequestsRef.current.delete(legacyMsg.id)
                    pending.resolve({
                        artifact: null,
                        timing: 0,
                        hasError: true,
                        diagnostics: (legacyMsg.payload?.diagnostics ?? []).map(d => ({
                            severity: d.severity as 'error' | 'warning' | 'info' | 'hint',
                            message: d.message,
                        })),
                    })
                }
                if (isMountedRef.current) {
                    setState('IDLE')
                }
            }
        }
    }, [state])

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
    }, [])

    // ============================================================================
    // Phoenix Protocol (Self-Healing)
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
            workerRef.current.removeEventListener('message', handleWorkerMessage as EventListener)
            workerRef.current.removeEventListener('error', handleWorkerError as EventListener)
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

        // 4. Wait and create new worker
        setTimeout(() => {
            if (isMountedRef.current) {
                createWorker()
            }
        }, RESTART_DELAY_MS)
    }, [handleWorkerMessage, handleWorkerError])

    // ============================================================================
    // Worker Creation
    // ============================================================================

    const createWorker = useCallback(() => {
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

            // Send init message
            workerRef.current.postMessage({ type: 'init', id: generateRequestId() })

            // Start heartbeat monitoring
            startHeartbeatMonitor()

        } catch (err) {
            console.error('[useResilientWorker] Failed to create worker:', err)
            if (isMountedRef.current) {
                setState('CRASHED')
                setError(err instanceof Error ? err : new Error(String(err)))
            }
        }
    }, [handleWorkerMessage, handleWorkerError, generateRequestId])

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

            // Send heartbeat
            workerRef.current.postMessage({
                kind: 'HEARTBEAT',
                timestamp: now,
            })

            // Check for timeout (deadlock detection)
            if (timeSinceLastAck > HEARTBEAT_TIMEOUT_MS && state === 'BUSY') {
                console.warn('[useResilientWorker] Heartbeat timeout - worker may be deadlocked')
                triggerPhoenixProtocol()
            }
        }, HEARTBEAT_TIMEOUT_MS / 2) // Check at half the timeout interval
    }, [state, triggerPhoenixProtocol])

    // ============================================================================
    // Compile Function
    // ============================================================================

    const compile = useCallback(async (source: string, options?: CompileOptions): Promise<CompileResult> => {
        // Check if worker is ready
        if (state !== 'IDLE' && state !== 'BUSY') {
            // Wait for worker to be ready or throw
            if (state === 'CRASHED') {
                throw new Error('Worker is crashed. Call restart() to recover.')
            }
            if (state === 'BOOTING' || state === 'RECOVERING') {
                // Wait a bit for worker to become ready
                await new Promise<void>((resolve, reject) => {
                    const checkInterval = setInterval(() => {
                        // Use stateRef to get current state in closure
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

            // Send compile request (using legacy protocol for now)
            workerRef.current!.postMessage({
                type: 'compile',
                id: requestId,
                payload: {
                    source,
                    mainFilePath: options?.mainFilePath ?? '/main.typ',
                    format: options?.format ?? 'vector',
                },
            })
        })
    }, [state, generateRequestId, triggerPhoenixProtocol])

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
        createWorker()

        return () => {
            isMountedRef.current = false

            // Cleanup
            if (heartbeatTimerRef.current) {
                clearInterval(heartbeatTimerRef.current)
            }

            if (workerRef.current) {
                workerRef.current.postMessage({ kind: 'DISPOSE' })
                workerRef.current.terminate()
            }

            // Clear pending requests
            for (const [, pending] of pendingRequestsRef.current) {
                clearTimeout(pending.timeout)
            }
            pendingRequestsRef.current.clear()
        }
    }, [])

    return {
        compile,
        state,
        restart,
        error,
        isReady: state === 'IDLE',
    }
}

export default useResilientWorker
