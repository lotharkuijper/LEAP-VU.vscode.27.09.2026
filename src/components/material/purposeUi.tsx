import { BookOpen, Info, FolderKanban, Share2, Lock, type LucideIcon } from 'lucide-react';
import type { Purpose, MaterialKind } from '../../services/course-files.service';

// Weergave per bestandsdoel: één plek voor volgorde, kleur en icoon, zodat de
// werkruimte, de eenmalige controle en het overzicht er hetzelfde uitzien.
export const PURPOSE_ORDER: Purpose[] = ['course_material', 'course_info', 'project', 'shared', 'teacher_only'];

export const PURPOSE_STYLE: Record<Purpose, { icon: LucideIcon; chip: string; ring: string; dot: string }> = {
  course_material: { icon: BookOpen, chip: 'bg-sky-50 text-sky-800 border-sky-200', ring: 'border-sky-200', dot: 'bg-sky-500' },
  course_info: { icon: Info, chip: 'bg-violet-50 text-violet-800 border-violet-200', ring: 'border-violet-200', dot: 'bg-violet-500' },
  project: { icon: FolderKanban, chip: 'bg-emerald-50 text-emerald-800 border-emerald-200', ring: 'border-emerald-200', dot: 'bg-emerald-500' },
  shared: { icon: Share2, chip: 'bg-amber-50 text-amber-800 border-amber-200', ring: 'border-amber-200', dot: 'bg-amber-500' },
  teacher_only: { icon: Lock, chip: 'bg-slate-100 text-slate-800 border-slate-300', ring: 'border-slate-300', dot: 'bg-slate-600' },
};

export const MATERIAL_KIND_ORDER: MaterialKind[] = ['assignment', 'data', 'literature', 'other'];

export function PurposeChip({ purpose, label }: { purpose: Purpose; label: string }) {
  const s = PURPOSE_STYLE[purpose];
  const Icon = s.icon;
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${s.chip}`} data-testid={`chip-purpose-${purpose}`}>
      <Icon className="w-3 h-3" />
      {label}
    </span>
  );
}

export function formatBytes(n: number | null | undefined): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
