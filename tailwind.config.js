/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        rounded: [
          '"Quicksand"',
          '"Zen Maru Gothic"',
          '"Noto Sans TC"',
          '"PingFang TC"',
          '"Microsoft JhengHei"',
          'sans-serif',
        ],
      },
      colors: {
        oat: {
          50: '#FAF8F3',
          100: '#EFECE4',
          200: '#ECE8DF',
          300: '#DDD7C9',
        },
        espresso: {
          DEFAULT: '#2D251E',
          muted: '#5C5044',
          soft: '#8A7E70',
        },
        butter: {
          DEFAULT: '#F2CA62',
          hover: '#EAB949',
        },
        caramel: {
          DEFAULT: '#C48E63',
          fur: '#C99661',
        },
        navy: {
          DEFAULT: '#1E3158',
        },
        cupred: {
          DEFAULT: '#C83D33',
        },
      },
    },
  },
  plugins: [],
};
