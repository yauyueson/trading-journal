import React, { Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router-dom'
import { queryClient } from './lib/queryClient'
import { router } from './router'
import { AppSettingsProvider } from './context/AppSettingsContext'
import { AuthProvider } from './context/AuthContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LoadingSpinner } from './components/LoadingSpinner'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <QueryClientProvider client={queryClient}>
            <AppSettingsProvider>
                <AuthProvider>
                    <ErrorBoundary>
                        <Suspense fallback={<LoadingSpinner />}>
                            <RouterProvider router={router} />
                        </Suspense>
                    </ErrorBoundary>
                </AuthProvider>
            </AppSettingsProvider>
        </QueryClientProvider>
    </React.StrictMode>,
)
