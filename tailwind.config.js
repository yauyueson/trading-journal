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
                text: { primary: '#FFFFFF', secondary: '#A3A3A3', tertiary: '#666666' },
                accent: {
                    green: '#4EBE96',
                    greenDim: '#4EBE9620',
                    red: '#FF6B6B',
                    redDim: '#FF6B6B20',
                    yellow: '#FFD60A',
                    blue: '#479FFA',
                    coral: '#FFA16C',
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
                'card-hover': '0 16px 48px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.08)',
            },
            backgroundImage: {
                'gradient-radial': 'radial-gradient(ellipse at top, var(--tw-gradient-stops))',
                'gradient-subtle': 'radial-gradient(600px circle at 50% 0%, rgba(0, 200, 5, 0.04), transparent 70%)',
            },
        },
    },
    plugins: [],
}
