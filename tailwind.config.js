/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            fontFamily: {
                sans: ['DM Sans', 'system-ui', 'sans-serif'],
                mono: ['DM Mono', 'monospace']
            },
            colors: {
                bg: { primary: '#000000', secondary: '#0D0D0D', tertiary: '#1A1A1A', elevated: '#242424' },
                text: { primary: '#FFFFFF', secondary: '#A3A3A3', tertiary: '#666666' },
                accent: {
                    green: '#00C805',
                    greenDim: '#00C80520',
                    red: '#FF5000',
                    redDim: '#FF500020',
                    yellow: '#FFD60A',
                    blue: '#0A84FF'
                },
                border: { default: '#2A2A2A', light: '#333333' }
            },
            spacing: {
                'safe-top': 'env(safe-area-inset-top)',
                'safe-bottom': 'env(safe-area-inset-bottom)',
                'safe-left': 'env(safe-area-inset-left)',
                'safe-right': 'env(safe-area-inset-right)'
            }
        },
    },
    plugins: [],
}
