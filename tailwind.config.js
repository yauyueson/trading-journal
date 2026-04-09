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
                text: { primary: '#E6E6E6', secondary: '#868F97', tertiary: '#6B6B6B' },
                accent: {
                    green: '#4EBE96',
                    greenDim: '#4EBE9620',
                    red: '#FF6B6B',
                    redDim: '#FF6B6B20',
                    yellow: '#FFD60A',
                    yellowDim: '#FFD60A20',
                    blue: '#479FFA',
                    blueDim: '#479FFA20',
                    coral: '#FFA16C',
                    coralDim: '#FFA16C20',
                },
                border: { default: '#2A2A2A', light: '#333333' }
            },
        },
    },
    plugins: [],
}
