/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

function noCache(): Plugin {
  return {
    name: 'no-cache',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        delete _req.headers['if-none-match'];
        delete _req.headers['if-modified-since'];
        res.setHeader('Cache-Control', 'no-store');
        next();
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), noCache()],
  optimizeDeps: {
    // pdfjs-dist buiten de dep-optimizer houden: het pre-bundelen van de
    // pdf.worker (?url) liet Vite midden in de sessie opnieuw optimaliseren,
    // wat de module-graph invalideerde ("Failed to fetch dynamically imported
    // module" + dubbele React → "Invalid hook call"-crash).
    exclude: ['lucide-react', 'pdfjs-dist'],
    // Zware deps die ALLEEN achter lazy routes (React.lazy) zitten — de
    // markdown/KaTeX-stack in MarkdownMessage en de Tiptap-editor + mammoth.
    // Zonder deze include ontdekt Vite ze pas bij het eerste bezoek aan zo'n
    // route en her-optimaliseert dan midden in de sessie. Dat geeft exact
    // dezelfde crash als hierboven (stale chunk-URL's → "Failed to fetch
    // dynamically imported module" + dubbele React → "Invalid hook call").
    // Vooraf bundelen bij serverstart voorkomt de mid-sessie her-optimalisatie.
    include: [
      'react-markdown',
      'remark-gfm',
      'remark-math',
      'rehype-katex',
      'katex',
      '@tiptap/react',
      '@tiptap/starter-kit',
      'tiptap-markdown',
      'mammoth',
    ],
  },
  server: {
    host: '0.0.0.0',
    port: 5000,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // Canvas-koppeling (server/lti/lti.js). /lti/start is een pagina van de app zelf.
      '^/lti/(login|launch|jwks|config\\.json)': {
        target: 'http://localhost:3001',
        changeOrigin: false,
      },
    },
  },
  test: {
    // Standaard de node-omgeving (server-tests); component-tests kiezen zelf
    // jsdom via een `// @vitest-environment jsdom`-docblock bovenaan het bestand.
    environment: 'node',
    // Tests gebruiken nooit de echte Supabase uit .env: vaste nepwaarden, zodat
    // ze overal hetzelfde draaien (ook in GitHub Actions, zonder geheimen).
    env: {
      VITE_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
      VITE_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
    },
    // In CI één herkansing per mislukte test: een kort haperende runner maakt
    // de run dan niet rood. Een test die pas bij de herkansing slaagt, staat
    // in de uitvoer als "retry"; zie hem als te repareren, niet als in orde.
    retry: process.env.CI ? 1 : 0,
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // Ruimere timeouts: in de gedeelde/CI-omgeving lopen de userEvent-zware
    // component-tests (jsdom) onder belasting soms over de standaard 5s heen,
    // ondanks correct gedrag. 15s geeft voldoende marge zonder echte bugs te maskeren.
    testTimeout: 15000,
    // De endpoint-suites booten in `beforeAll` de volledige Express-app
    // (`await import('../index.js')` + `app.listen`); dat duurt onder belasting
    // langer dan de standaard 10s. Draaien server- en component-tests samen op
    // een machine met veel kernen, dan laden tientallen workers die app tegelijk
    // en is 30s soms te krap (2026-10-27); 90s voorkomt valse hook-timeouts.
    hookTimeout: 90000,
    // Node 25+ has its own (empty) global localStorage that hides the jsdom one,
    // so component tests that store the UI language silently fell back to
    // English. Switch Node's version off where the flag exists.
    execArgv: process.allowedNodeEnvironmentFlags.has('--experimental-webstorage')
      ? ['--no-experimental-webstorage']
      : [],
  },
});
