import { Suspense } from 'react'
import { TypstEditor } from './components'

function App() {
  return (
    <div className="app">
      <header className="app-header">
        <div className="header-content">
          <h1>Monolith Paper Writer</h1>
          <p>Browser-based Typst Editor</p>
        </div>
      </header>
      
      <main className="app-main">
        <Suspense fallback={
          <div className="global-loading">
            <div className="loading-spinner" />
            <p>Loading application...</p>
          </div>
        }>
          <TypstEditor />
        </Suspense>
      </main>
    </div>
  )
}

export default App
