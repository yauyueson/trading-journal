import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { PortfolioSettingsProvider } from './context/PortfolioSettingsContext.tsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <PortfolioSettingsProvider>
            <App />
        </PortfolioSettingsProvider>
    </React.StrictMode>,
)
