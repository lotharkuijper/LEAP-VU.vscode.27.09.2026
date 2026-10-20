// Sjablonen voor de cursusinstructies (2026-10-20).
//
// Per onderdeel (chat, Ik leg uit) schrijft de docent een eigen instructie voor
// zijn cursus (`__chat_prompt_<id>__` / `__explain_prompt_<id>__`). Zolang dat
// veld leeg is, krijgen studenten het SJABLOON: de actieve chatbot_prompts-rij
// van die sectie ("Sjabloon chat-instructie" / "Sjabloon Ik leg uit").
//
//  * Docenten LEZEN het sjabloon (om eruit te kopiëren), nooit schrijven.
//  * Alleen de beheerder wijzigt het, via PUT hieronder; de vorige tekst gaat
//    naar leap_setting_changes, zodat een wijziging terug te draaien is.
//  * De browser schrijft sjablonen niet meer rechtstreeks naar chatbot_prompts.

export const TEMPLATE_SECTIONS = ['chat', 'explain'];
export const TEMPLATE_MIN_LENGTH = 10;

const OVERRIDE_PREFIX = { chat: '__chat_prompt_', explain: '__explain_prompt_' };
const DEFAULT_NAME = { chat: 'Sjabloon chat-instructie', explain: 'Sjabloon Ik leg uit' };

export function isTemplateSection(s) {
  return TEMPLATE_SECTIONS.includes(s);
}

/** Cursus-id's met een eigen (niet-lege) instructie voor deze sectie. */
export function courseIdsWithOwnPrompt(rows, section) {
  const prefix = OVERRIDE_PREFIX[section];
  const out = new Set();
  for (const r of rows || []) {
    if (!r?.name?.startsWith(prefix) || !r.name.endsWith('__')) continue;
    if (!String(r.content || '').trim()) continue;
    out.add(r.name.slice(prefix.length, -2));
  }
  return out;
}

export function validateTemplateContent(content) {
  if (typeof content !== 'string' || content.trim().length < TEMPLATE_MIN_LENGTH) {
    return { ok: false, code: 'templateTooShort' };
  }
  return { ok: true };
}

/**
 * deps: supabaseAdmin, requireAuthUser, isAdminProfile(profile), isStaffAnywhere(user, profile),
 *       loadTemplate: { chat: () => {id, content}, explain: () => {id, content} }
 */
export function registerPromptTemplateRoutes(app, deps) {
  const { supabaseAdmin: db, requireAuthUser, isAdminProfile, isStaffAnywhere, loadTemplate } = deps;

  async function coursesOnTemplate(section) {
    const [{ data: courses }, { data: overrides }] = await Promise.all([
      db.from('courses').select('id').eq('is_active', true),
      db.from('chatbot_prompts').select('name, content').like('name', `${OVERRIDE_PREFIX[section]}%`),
    ]);
    const own = courseIdsWithOwnPrompt(overrides, section);
    return (courses || []).filter(c => !own.has(c.id)).length;
  }

  app.get('/api/admin/prompt-templates/:section', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { section } = req.params;
    if (!isTemplateSection(section)) return res.status(400).json({ error: 'Onbekend onderdeel' });
    if (!(await isStaffAnywhere(auth.user, auth.profile))) {
      return res.status(403).json({ error: 'Onvoldoende rechten' });
    }
    try {
      const tpl = await loadTemplate[section]();
      const canEdit = isAdminProfile(auth.profile);
      return res.json({
        section,
        content: tpl?.content || '',
        canEdit,
        // Alleen voor de beheerder relevant: op hoeveel cursussen een wijziging uitwerkt.
        ...(canEdit ? { coursesOnTemplate: await coursesOnTemplate(section) } : {}),
      });
    } catch (err) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.put('/api/admin/prompt-templates/:section', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { section } = req.params;
    if (!isTemplateSection(section)) return res.status(400).json({ error: 'Onbekend onderdeel' });
    if (!isAdminProfile(auth.profile)) {
      return res.status(403).json({ error: 'Alleen de beheerder kan een sjabloon aanpassen', code: 'adminOnly' });
    }
    const content = req.body?.content;
    const v = validateTemplateContent(content);
    if (!v.ok) return res.status(400).json({ error: 'Het sjabloon is te kort', code: v.code });
    try {
      const before = await loadTemplate[section]();
      const now = new Date().toISOString();
      if (before?.id) {
        const { error } = await db.from('chatbot_prompts').update({ content, updated_at: now }).eq('id', before.id);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await db.from('chatbot_prompts').insert({ name: DEFAULT_NAME[section], content, is_active: true, section });
        if (error) throw new Error(error.message);
      }
      await db.from('leap_setting_changes').insert({
        course_id: null,
        setting: `prompt_template_${section}`,
        value: { previous: before?.content ?? null, length: content.length },
        changed_by: auth.user.id,
      });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });
}
