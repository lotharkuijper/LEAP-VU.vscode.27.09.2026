// Eén kleur per onderdeel van de app, op één plek. Het menu (Layout), de
// tegels op het Dashboard en de pagina's zelf gebruiken deze lijst, zodat een
// student die op de gele "Ik leg uit"-tegel klikt ook in een gele omgeving
// terechtkomt. Tailwind vindt alleen klassen die letterlijk in de code staan;
// daarom staat alles hier voluit (niet opbouwen met `${kleur}`).

export type SectionKey = 'dashboard' | 'chat' | 'explain' | 'quiz' | 'projects' | 'studiecafe' | 'journal' | 'resources' | 'admin';

export interface SectionColor {
  /** Tailwind-kleurfamilie (voor tests en documentatie). */
  family: string;
  /** Verloop voor het actieve menu-item en de hoofdknop van het onderdeel. */
  gradient: string;
  gradientHover: string;
  /** Dun kleurbalkje boven een tegel. */
  bar: string;
  iconBg: string;
  iconText: string;
  border: string;
  hoverBorder: string;
  /** Zachte achtergrond voor een geselecteerd item in een lijst. */
  selected: string;
  /** Zacht vlak (banner, lege toestand). */
  tint: string;
  /** Tekst/links in de kleur van het onderdeel. */
  text: string;
  focusRing: string;
}

export const SECTION_COLORS: Record<SectionKey, SectionColor> = {
  dashboard: {
    family: 'gray', gradient: 'from-gray-600 to-gray-700', gradientHover: 'hover:from-gray-700 hover:to-gray-800',
    bar: 'from-gray-50 to-gray-100', iconBg: 'bg-gray-100', iconText: 'text-gray-700', border: 'border-gray-200',
    hoverBorder: 'hover:border-gray-400', selected: 'from-gray-100 to-gray-200', tint: 'bg-gray-50', text: 'text-gray-700', focusRing: 'focus:ring-gray-400',
  },
  chat: {
    family: 'emerald', gradient: 'from-emerald-500 to-emerald-600', gradientHover: 'hover:from-emerald-600 hover:to-emerald-700',
    bar: 'from-emerald-50 to-emerald-100', iconBg: 'bg-emerald-100', iconText: 'text-emerald-700', border: 'border-emerald-200',
    hoverBorder: 'hover:border-emerald-400', selected: 'from-emerald-100 to-emerald-200', tint: 'bg-emerald-50', text: 'text-emerald-700', focusRing: 'focus:ring-emerald-400',
  },
  explain: {
    family: 'amber', gradient: 'from-amber-500 to-amber-600', gradientHover: 'hover:from-amber-600 hover:to-amber-700',
    bar: 'from-amber-50 to-amber-100', iconBg: 'bg-amber-100', iconText: 'text-amber-700', border: 'border-amber-200',
    hoverBorder: 'hover:border-amber-400', selected: 'from-amber-100 to-amber-200', tint: 'bg-amber-50', text: 'text-amber-700', focusRing: 'focus:ring-amber-400',
  },
  quiz: {
    family: 'cyan', gradient: 'from-cyan-500 to-cyan-600', gradientHover: 'hover:from-cyan-600 hover:to-cyan-700',
    bar: 'from-cyan-50 to-cyan-100', iconBg: 'bg-cyan-100', iconText: 'text-cyan-700', border: 'border-cyan-200',
    hoverBorder: 'hover:border-cyan-400', selected: 'from-cyan-100 to-cyan-200', tint: 'bg-cyan-50', text: 'text-cyan-700', focusRing: 'focus:ring-cyan-400',
  },
  projects: {
    family: 'orange', gradient: 'from-orange-500 to-orange-600', gradientHover: 'hover:from-orange-600 hover:to-orange-700',
    bar: 'from-orange-50 to-orange-100', iconBg: 'bg-orange-100', iconText: 'text-orange-700', border: 'border-orange-200',
    hoverBorder: 'hover:border-orange-400', selected: 'from-orange-100 to-orange-200', tint: 'bg-orange-50', text: 'text-orange-700', focusRing: 'focus:ring-orange-400',
  },
  // Zacht paars/lila: duidelijk anders dan de warme projectenruimte.
  studiecafe: {
    family: 'violet', gradient: 'from-violet-400 to-purple-500', gradientHover: 'hover:from-violet-500 hover:to-purple-600',
    bar: 'from-violet-50 to-violet-100', iconBg: 'bg-violet-100', iconText: 'text-violet-700', border: 'border-violet-200',
    hoverBorder: 'hover:border-violet-400', selected: 'from-violet-100 to-violet-200', tint: 'bg-violet-50', text: 'text-violet-700', focusRing: 'focus:ring-violet-400',
  },
  journal: {
    family: 'teal', gradient: 'from-teal-500 to-teal-600', gradientHover: 'hover:from-teal-600 hover:to-teal-700',
    bar: 'from-teal-50 to-teal-100', iconBg: 'bg-teal-100', iconText: 'text-teal-700', border: 'border-teal-200',
    hoverBorder: 'hover:border-teal-400', selected: 'from-teal-100 to-teal-200', tint: 'bg-teal-50', text: 'text-teal-700', focusRing: 'focus:ring-teal-400',
  },
  resources: {
    family: 'pink', gradient: 'from-pink-500 to-pink-600', gradientHover: 'hover:from-pink-600 hover:to-pink-700',
    bar: 'from-pink-50 to-pink-100', iconBg: 'bg-pink-100', iconText: 'text-pink-700', border: 'border-pink-200',
    hoverBorder: 'hover:border-pink-400', selected: 'from-pink-100 to-pink-200', tint: 'bg-pink-50', text: 'text-pink-700', focusRing: 'focus:ring-pink-400',
  },
  admin: {
    family: 'slate', gradient: 'from-slate-600 to-slate-700', gradientHover: 'hover:from-slate-700 hover:to-slate-800',
    bar: 'from-slate-50 to-slate-100', iconBg: 'bg-slate-100', iconText: 'text-slate-700', border: 'border-slate-200',
    hoverBorder: 'hover:border-slate-400', selected: 'from-slate-100 to-slate-200', tint: 'bg-slate-50', text: 'text-slate-700', focusRing: 'focus:ring-slate-400',
  },
};
