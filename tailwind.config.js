import typography from '@tailwindcss/typography';

// LEAP-huisstijl. De kleuren zelf staan als CSS-variabelen in src/index.css
// (:root, --leap-*), zodat ze op één plek aan te passen zijn (en later ook een
// donkere modus mogelijk is). Hier koppelen we Tailwind-namen aan die variabelen:
//  * brand  — de LEAP-hoofdkleur. `blue` en `sky` wijzen er ook naartoe, zodat
//             alle bestaande blauwe knoppen, links en accenten meteen meegaan.
//  * ink    — de neutrale tinten (tekst, randen, achtergronden). `gray` en
//             `slate` wijzen hiernaartoe: overal dezelfde, licht koele grijzen.
//  * accent — warme kleur voor successen, beloningen en vieringen.
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const palette = (name) =>
  Object.fromEntries(SHADES.map((s) => [s, `rgb(var(--leap-${name}-${s}) / <alpha-value>)`]));

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: palette('brand'),
        blue: palette('brand'),
        sky: palette('brand'),
        ink: palette('ink'),
        gray: palette('ink'),
        slate: palette('ink'),
        accent: palette('accent'),
      },
      fontFamily: {
        sans: [
          '"Nunito Variable"', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"',
          'Roboto', '"Helvetica Neue"', 'Arial', '"Noto Sans"', '"Noto Sans SC"', '"Noto Sans TC"', '"Noto Sans JP"',
          '"Noto Sans KR"', '"Noto Sans Arabic"', '"PingFang SC"', '"Hiragino Sans"', '"Hiragino Kaku Gothic ProN"',
          '"Microsoft YaHei"', '"Malgun Gothic"', '"Geeza Pro"', 'sans-serif',
        ],
      },
    },
  },
  plugins: [typography],
};
