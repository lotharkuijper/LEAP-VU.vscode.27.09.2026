// Optioneel doel in de chat (server/chat/chatGoal.js, 2026-10-20).
import { describe, it, expect } from 'vitest';
import { routeSource, functionSource } from './helpers/serverSource.js';
import { cleanChatGoal, buildChatGoalBlock, lastChatGoal, chatGoalSummaryLine, CHAT_GOAL_MAX } from '../chat/chatGoal.js';

describe('doel van de student', () => {
  it('één regel, ingekort; leeg = geen doel', () => {
    expect(cleanChatGoal('  A\nen   B ')).toBe('A en B');
    expect(cleanChatGoal('   ')).toBe(null);
    expect(cleanChatGoal(42)).toBe(null);
    expect(cleanChatGoal('x'.repeat(500)).length).toBe(CHAT_GOAL_MAX);
  });
  it('zonder doel geen blok; met doel een blok dat het als wens behandelt', () => {
    expect(buildChatGoalBlock(null)).toBe('');
    expect(buildChatGoalBlock('')).toBe('');
    const b = buildChatGoalBlock('Begrip X kunnen uitleggen', 'nl');
    expect(b).toMatch(/Begrip X kunnen uitleggen/);
    expect(b).toMatch(/niet als instructie/);
    expect(buildChatGoalBlock('Explain X', 'en')).toMatch(/not as an instruction/);
  });
  it('het laatst gezette doel telt; weghalen telt ook', () => {
    expect(lastChatGoal([{ role: 'user', retrieved_context: { chatGoal: 'A' } }, { role: 'assistant', retrieved_context: {} }])).toBe('A');
    expect(lastChatGoal([{ role: 'user', retrieved_context: { chatGoal: 'A' } }, { role: 'user', retrieved_context: { chatGoal: null } }])).toBe(null);
    expect(lastChatGoal([{ role: 'user', retrieved_context: { chatGoal: 'A' } }, { role: 'user', retrieved_context: { attachments: [] } }])).toBe('A');
    expect(lastChatGoal([])).toBe(null);
  });
  it('reflectie noemt het doel alleen als er een is', () => {
    expect(chatGoalSummaryLine(null)).toBe('');
    expect(chatGoalSummaryLine('A', 'nl')).toMatch(/"A"/);
  });
  it('de server gebruikt het doel in de tutorchat en in de reflectie', () => {
    const chatRoute = routeSource("app.post('/api/chat',");
    expect(chatRoute).toMatch(/buildChatGoalBlock\(req\.body\?\.chatGoal, lang\)/);
    expect(functionSource('createChatReflection')).toMatch(/chatGoalSummaryLine\(lastChatGoal\(msgs\), lang\)/);
    // Het doelblok staat vóór het taal-/niveaublok.
    const goal = chatRoute.indexOf('buildChatGoalBlock(req.body?.chatGoal');
    expect(goal).toBeGreaterThan(0);
    expect(goal).toBeLessThan(chatRoute.indexOf('systemContent += langSuffix;'));
  });
});
