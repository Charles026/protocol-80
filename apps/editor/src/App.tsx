import { MonolithEditor } from './components/MonolithEditor'

function App() {
    return (
        <div className="app">
            <header className="app-header">
                <h1>Monolith Kernel MVP</h1>
                <p className="subtitle">ProseMirror → Typst → Canvas Render Loop</p>
            </header>
            <main className="app-main">
                <MonolithEditor />
            </main>
        </div>
    )
}

export default App
