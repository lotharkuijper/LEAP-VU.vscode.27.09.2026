import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Tussentijds opslaan in het leerdagboek (2026-10-27): de student hoeft een
// gesprek niet meer te verwijderen om een reflectie te krijgen. Elke opslag gaat
// over wat sinds de vorige opslag is gezegd; verwijderen met samenvatting
// gebruikt dezelfde functie en maakt geen dubbele regel.

const root = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
const helper = src.slice(src.indexOf('async function createChatReflection'), src.indexOf("app.post('/api/chat/reflect'"));
const reflectRoute = src.slice(src.indexOf("app.post('/api/chat/reflect'"), src.indexOf("app.post(['/api/chat/delete'"));
const deleteRoute = src.slice(src.indexOf("app.post(['/api/chat/delete'"), src.indexOf("app.post('/api/embeddings'"));

describe('tussentijds opslaan in het leerdagboek', () => {
  it('kijkt eerst of het leerdagboek aan staat', () => {
    expect(helper).toMatch(/if \(!\(await courseFeatureOnFor\(user, null, courseId, 'journal'\)\)\) return \{ status: 'journalOff' \};/);
  });
  it('alleen over wat sinds de vorige opslag van DIT gesprek is gezegd; niets nieuws → geen regel', () => {
    expect(helper).toMatch(/\.like\('source_ref', `chat:\$\{conversation\.id\}:%`\)/);
    expect(helper).toMatch(/source_ref: `chat:\$\{conversation\.id\}:\$\{fresh\[fresh\.length - 1\]\.id\}`/);
    expect(helper).toMatch(/if \(!fresh\.some\(m => m\.role === 'user'\)\) return \{ status: 'nothingNew' \};/);
  });
  it('de opslagroute verwijdert niets en controleert dat het gesprek van de student is', () => {
    expect(reflectRoute).toMatch(/conversation\.user_id !== user\.id/);
    expect(reflectRoute).not.toMatch(/\.delete\(\)/);
  });
  it('verwijderen met samenvatting gebruikt dezelfde functie (geen tweede, eigen prompt)', () => {
    expect(deleteRoute).toMatch(/if \(generateSummary\) reflection = await createChatReflection\(/);
    expect(deleteRoute).not.toMatch(/summaryPrompt/);
    expect(deleteRoute).toMatch(/summaryAlreadySaved/);
  });
  it('de chat biedt de knop alleen aan als het leerdagboek aan staat', () => {
    const page = fs.readFileSync(path.join(root, 'src', 'pages', 'ChatPage.tsx'), 'utf8').replace(/\r\n/g, '\n');
    expect(page).toMatch(/pageFeatures\.visible\('journal'\) && \(\s*<span[\s\S]{0,900}data-testid="button-save-journal"/);
  });
});
