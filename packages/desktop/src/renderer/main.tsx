import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { App } from './App.js'
import { createQueryClient } from './query.js'
import { ThemeProvider } from './theme.js'
import './styles/app.css'

/**
 * The renderer entry point. It mounts and nothing else — no data fetching, no
 * bridge calls, no error handling a component could not do better.
 *
 * Theme sits outside the query client because it must apply on the first paint,
 * before any read has resolved. A board that renders light and snaps to dark a
 * moment later is worse than one that takes the extra frame.
 */
const root = document.getElementById('root')
if (root === null) throw new Error('The renderer document has no #root element.')

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <App />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
