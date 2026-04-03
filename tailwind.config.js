/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            screens: {
                xs: '475px'
            },
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
            spacing: {
                'safe-top': 'env(safe-area-inset-top)',
                'safe-bottom': 'env(safe-area-inset-bottom)',
                'safe-left': 'env(safe-area-inset-left)',
                'safe-right': 'env(safe-area-inset-right)'
            },
            boxShadow: {
                'glow-green': '0 0 20px rgba(78, 190, 150, 0.2), 0 0 6px rgba(78, 190, 150, 0.1)',
                'glow-red': '0 0 20px rgba(255, 107, 107, 0.2), 0 0 6px rgba(255, 107, 107, 0.1)',
                'glow-blue': '0 0 20px rgba(71, 159, 250, 0.2), 0 0 6px rgba(71, 159, 250, 0.1)',
                'glow-yellow': '0 0 20px rgba(255, 214, 10, 0.15), 0 0 6px rgba(255, 214, 10, 0.1)',
                'glow-coral': '0 0 20px rgba(255, 161, 108, 0.2), 0 0 6px rgba(255, 161, 108, 0.1)',
                'card-hover': '0 16px 48px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.08)',
            },
            borderWidth: {
                '0.5': '0.5px',
            },
            backgroundImage: {
                'gradient-radial': 'radial-gradient(ellipse at top, var(--tw-gradient-stops))',
                'gradient-subtle': 'radial-gradient(600px circle at 50% 0%, rgba(0, 200, 5, 0.04), transparent 70%)',
            },
        },
    },
    plugins: [],
}
