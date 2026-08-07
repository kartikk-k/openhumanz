/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}', './src/renderer/index.ejs'],
  // Follows the OS color scheme. Switch to 'class' if you add a manual toggle.
  darkMode: 'media',
  theme: {
    extend: {},
  },
  plugins: [],
};
