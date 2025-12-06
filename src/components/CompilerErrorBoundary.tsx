/**
 * CompilerErrorBoundary - React Error Boundary for Worker Crashes
 * 
 * Catches WorkerCrashedError and provides a fallback UI with restart capability.
 * 
 * @module CompilerErrorBoundary
 */

import { Component, type ReactNode, createContext, useContext } from 'react'

// ============================================================================
// Context for Restart Function
// ============================================================================

export interface CompilerContextValue {
    /** Restart the compiler worker */
    restart: () => void
}

const CompilerContext = createContext<CompilerContextValue | null>(null)

/**
 * Hook to access compiler controls from within the error boundary
 */
export function useCompilerContext(): CompilerContextValue {
    const context = useContext(CompilerContext)
    if (!context) {
        throw new Error('useCompilerContext must be used within CompilerErrorBoundary')
    }
    return context
}

// ============================================================================
// Error Boundary Component
// ============================================================================

export interface CompilerErrorBoundaryProps {
    children: ReactNode
    /** Callback to restart the worker (typically from useResilientWorker) */
    onRestart: () => void
    /** Optional custom fallback UI */
    fallback?: ReactNode
}

interface CompilerErrorBoundaryState {
    hasError: boolean
    error: Error | null
    errorInfo: React.ErrorInfo | null
}

/**
 * Error Boundary that catches compiler/worker crashes
 * 
 * @example
 * ```tsx
 * const { restart } = useResilientWorker()
 * 
 * return (
 *   <CompilerErrorBoundary onRestart={restart}>
 *     <TypstEditor />
 *   </CompilerErrorBoundary>
 * )
 * ```
 */
export class CompilerErrorBoundary extends Component<
    CompilerErrorBoundaryProps,
    CompilerErrorBoundaryState
> {
    constructor(props: CompilerErrorBoundaryProps) {
        super(props)
        this.state = {
            hasError: false,
            error: null,
            errorInfo: null,
        }
    }

    static getDerivedStateFromError(error: Error): Partial<CompilerErrorBoundaryState> {
        return {
            hasError: true,
            error,
        }
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
        console.error('[CompilerErrorBoundary] Caught error:', error)
        console.error('[CompilerErrorBoundary] Component stack:', errorInfo.componentStack)

        this.setState({
            errorInfo,
        })
    }

    handleRestart = (): void => {
        // Reset error state
        this.setState({
            hasError: false,
            error: null,
            errorInfo: null,
        })

        // Trigger worker restart
        this.props.onRestart()
    }

    handleDismiss = (): void => {
        this.setState({
            hasError: false,
            error: null,
            errorInfo: null,
        })
    }

    render(): ReactNode {
        const { hasError, error } = this.state
        const { children, fallback, onRestart } = this.props

        if (hasError) {
            // Custom fallback provided
            if (fallback) {
                return fallback
            }

            // Default fallback UI
            return (
                <div className="compiler-error-boundary">
                    <div className="compiler-crash-fallback">
                        <div className="crash-icon">⚠️</div>
                        <h2>The typesetting engine has crashed</h2>
                        <p className="crash-message">
                            {error?.message || 'An unexpected error occurred in the compiler.'}
                        </p>
                        <div className="crash-actions">
                            <button
                                className="restart-button primary"
                                onClick={this.handleRestart}
                            >
                                🔄 Restart Engine
                            </button>
                            <button
                                className="dismiss-button secondary"
                                onClick={this.handleDismiss}
                            >
                                Dismiss
                            </button>
                        </div>
                        {error?.name === 'WorkerCrashedError' && (
                            <p className="crash-hint">
                                The Wasm runtime encountered a fatal error.
                                Your work has been preserved.
                            </p>
                        )}
                    </div>

                    <style>{`
            .compiler-error-boundary {
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 200px;
              padding: 2rem;
              background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
              border-radius: 8px;
              margin: 1rem;
            }
            
            .compiler-crash-fallback {
              text-align: center;
              color: #e8e8e8;
              max-width: 400px;
            }
            
            .crash-icon {
              font-size: 3rem;
              margin-bottom: 1rem;
            }
            
            .compiler-crash-fallback h2 {
              margin: 0 0 0.5rem 0;
              font-size: 1.5rem;
              color: #ff6b6b;
            }
            
            .crash-message {
              color: #a0a0a0;
              margin-bottom: 1.5rem;
              font-size: 0.9rem;
              line-height: 1.5;
            }
            
            .crash-actions {
              display: flex;
              gap: 0.75rem;
              justify-content: center;
              margin-bottom: 1rem;
            }
            
            .restart-button,
            .dismiss-button {
              padding: 0.75rem 1.5rem;
              border-radius: 6px;
              font-size: 0.9rem;
              font-weight: 500;
              cursor: pointer;
              transition: all 0.2s ease;
              border: none;
            }
            
            .restart-button.primary {
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
            }
            
            .restart-button.primary:hover {
              transform: translateY(-1px);
              box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
            }
            
            .dismiss-button.secondary {
              background: transparent;
              color: #a0a0a0;
              border: 1px solid #404040;
            }
            
            .dismiss-button.secondary:hover {
              background: #2a2a4a;
              color: #e8e8e8;
            }
            
            .crash-hint {
              font-size: 0.8rem;
              color: #666;
              margin-top: 1rem;
            }
          `}</style>
                </div>
            )
        }

        // Provide context for children to access restart
        return (
            <CompilerContext.Provider value={{ restart: onRestart }}>
                {children}
            </CompilerContext.Provider>
        )
    }
}

export default CompilerErrorBoundary
