import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { AppSettingsProvider } from './context/AppSettingsContext.tsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <AppSettingsProvider>
            <App />
        </AppSettingsProvider>
    </React.StrictMode>,
)
