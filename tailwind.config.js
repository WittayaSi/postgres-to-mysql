module.exports = {
  purge: [
    './public/**/*.html',
    './public/**/*.js',
  ],
  darkMode: false,
  theme: {
    extend: {
      colors: {
        // Brand Colors
        brand: {
          primary: '#3b82f6',
          secondary: '#1e40af',
          accent: '#6366f1',
        },
        // Status Colors
        status: {
          success: '#22c55e',
          warning: '#f59e0b',
          error: '#ef4444',
          info: '#3b82f6',
          pending: '#f97316',
        },
        // Database Colors
        db: {
          postgres: '#336791',
          mysql: '#f29111',
        },
      },
      boxShadow: {
        'card': '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
        'raised': '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
        'modal': '0 25px 50px -12px rgb(0 0 0 / 0.25)',
      },
    },
  },
  variants: {
    extend: {},
  },
  plugins: [],
}
