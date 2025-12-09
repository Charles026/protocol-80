/**
 * TestResilientWorker - Test component for the new useResilientWorker hook
 */

import { useState } from 'react'
import { useResilientWorker } from '../hooks'

const TEST_SOURCE = `#set page(width: 15cm, height: auto, margin: 1.5cm)
#set text(size: 11pt)

= Testing Resilient Worker

This is a test of the new *FSM-based* worker architecture.

== Current State

The worker should be in one of these states:
- BOOTING (initializing)
- IDLE (ready)
- BUSY (compiling)
- CRASHED (error)
- RECOVERING (restarting)

== Math Test

$ x = (-b plus.minus sqrt(b^2 - 4 a c)) / (2 a) $
`

export function TestResilientWorker() {
    const { compile, state, restart, error, isReady } = useResilientWorker()
    const [artifact, setArtifact] = useState<Uint8Array | null>(null)
    const [compileTime, setCompileTime] = useState<number | null>(null)
    const [compileError, setCompileError] = useState<string | null>(null)

    const handleCompile = async () => {
        setCompileError(null)
        try {
            const result = await compile(TEST_SOURCE)
            if (result.artifact) {
                setArtifact(result.artifact)
                setCompileTime(result.timing)
                console.log('[TestResilientWorker] Compile success:', {
                    timing: result.timing,
                    artifactSize: result.artifact.byteLength,
                })
            } else {
                setCompileError(result.diagnostics[0]?.message || 'Compilation failed')
            }
        } catch (err) {
            setCompileError(err instanceof Error ? err.message : String(err))
            console.error('[TestResilientWorker] Compile error:', err)
        }
    }

    return (
        <div style={{
            padding: '2rem',
            maxWidth: '800px',
            margin: '0 auto',
            fontFamily: 'system-ui, sans-serif',
        }}>
            <h1>🧪 Resilient Worker Test</h1>

            <div style={{
                background: '#f5f5f5',
                padding: '1rem',
                borderRadius: '8px',
                marginBottom: '1rem',
            }}>
                <h3>Worker Status</h3>
                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                    <span style={{
                        display: 'inline-block',
                        padding: '0.5rem 1rem',
                        background: state === 'IDLE' ? '#4caf50' :
                            state === 'BUSY' ? '#2196f3' :
                                state === 'CRASHED' ? '#f44336' :
                                    state === 'RECOVERING' ? '#ff9800' : '#9e9e9e',
                        color: 'white',
                        borderRadius: '4px',
                        fontWeight: 'bold',
                    }}>
                        {state}
                    </span>
                    <span>Ready: {isReady ? '✅' : '❌'}</span>
                </div>
            </div>

            {error && (
                <div style={{
                    background: '#ffebee',
                    color: '#c62828',
                    padding: '1rem',
                    borderRadius: '8px',
                    marginBottom: '1rem',
                }}>
                    <strong>Error:</strong> {error.message}
                </div>
            )}

            {compileError && (
                <div style={{
                    background: '#fff3e0',
                    color: '#e65100',
                    padding: '1rem',
                    borderRadius: '8px',
                    marginBottom: '1rem',
                }}>
                    <strong>Compile Error:</strong> {compileError}
                </div>
            )}

            <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
                <button
                    onClick={handleCompile}
                    disabled={!isReady}
                    style={{
                        padding: '0.75rem 1.5rem',
                        background: isReady ? '#2196f3' : '#ccc',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: isReady ? 'pointer' : 'not-allowed',
                        fontWeight: 'bold',
                    }}
                >
                    {state === 'BUSY' ? 'Compiling...' : 'Compile Test Document'}
                </button>

                <button
                    onClick={restart}
                    style={{
                        padding: '0.75rem 1.5rem',
                        background: '#ff9800',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontWeight: 'bold',
                    }}
                >
                    🔄 Restart Worker
                </button>
            </div>

            {artifact && compileTime !== null && (
                <div style={{
                    background: '#e8f5e9',
                    padding: '1rem',
                    borderRadius: '8px',
                }}>
                    <h3>✅ Compilation Success</h3>
                    <p>Artifact size: {(artifact.byteLength / 1024).toFixed(2)} KB</p>
                    <p>Compile time: {compileTime}ms</p>
                </div>
            )}

            <div style={{
                marginTop: '2rem',
                padding: '1rem',
                background: '#f5f5f5',
                borderRadius: '8px',
            }}>
                <h3>Test Source Code</h3>
                <pre style={{
                    background: 'white',
                    padding: '1rem',
                    borderRadius: '4px',
                    overflow: 'auto',
                    fontSize: '0.9rem',
                }}>
                    {TEST_SOURCE}
                </pre>
            </div>
        </div>
    )
}

export default TestResilientWorker
