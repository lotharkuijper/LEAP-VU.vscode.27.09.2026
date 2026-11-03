import { useEffect, useState } from 'react';
import { Plus, Loader2, CheckCircle2, AlertTriangle, BookOpen, Pencil, X, Check, Power, Trash2, Users, FolderTree, FolderOpen, UserX, Flame, DoorOpen, School, UserPlus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useCourseAccess } from '../../contexts/CourseAccessContext';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import { useActiveCourse } from '../../contexts/ActiveCourseContext';
import { useLanguage } from '../../i18n';
import { AdminHint } from '../../components/help/AdminHint';
import { ListRow, StatusBadge } from '../../components/ui/ListRow';
import { EnrollmentModeDialog } from '../../components/EnrollmentModeDialog';
import type { EnrollmentMode } from '../../services/enrollment.service';

// Beheerder → Cursussen: cursussen aanmaken, naam en beschrijving, toegangsroute,
// (de)activeren en verwijderen. Alleen voor de beheerder; leden en het openstellen van
// één cursus staan bij Openstellen (Leden, Cursus) en gelden voor de actieve cursus.

interface CourseRow {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  cue_delta_max: number;
  // Task #270: zichtbaar/selecteerbaar voor studenten ja/nee.
  student_visible: boolean;
  // Toegangsroute (server/courses/enrollment.js); alleen de beheerder wijzigt hem.
  enrollment_mode: EnrollmentMode;
}

interface DeleteCounts {
  members: number;
  projects: number;
  sessions: number;
  journal_entries: number;
  extra_folders: number;
  documents: number;
}

export function CoursesAdminTab() {
  const { session, isAdmin } = useAuth();
  const { refreshCourses } = useCourseAccess();
  const { setActiveCourse } = useActiveCourse();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [courses, setCourses] = useState<CourseRow[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Bewerk-state per rij.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Per-rij state voor activeren/deactiveren en verwijderen.
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [enrollmentFor, setEnrollmentFor] = useState<CourseRow | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string | null>>({});
  const [rowCounts, setRowCounts] = useState<Record<string, DeleteCounts | null>>({});
  const [confirmBulkMembersId, setConfirmBulkMembersId] = useState<string | null>(null);
  // Net aangemaakte cursus: vervolgstappen tonen.
  const [createdCourseId, setCreatedCourseId] = useState<string | null>(null);

  // Bevestigingsdialoog voor het verwijderen van een cursus.
  const [deleteTarget, setDeleteTarget] = useState<CourseRow | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteDialogError, setDeleteDialogError] = useState<string | null>(null);

  // Cascade-dialoog: verwijder cursus inclusief ALLE gekoppelde data.
  const [cascadeTarget, setCascadeTarget] = useState<CourseRow | null>(null);
  const [cascadeCounts, setCascadeCounts] = useState<DeleteCounts | null>(null);
  const [cascadeLoading, setCascadeLoading] = useState(false);
  const [cascadeConfirmText, setCascadeConfirmText] = useState('');
  const [cascadeDialogError, setCascadeDialogError] = useState<string | null>(null);

  function setRowError(id: string, msg: string | null) {
    setRowErrors((m) => ({ ...m, [id]: msg }));
  }

  function setRowCount(id: string, counts: DeleteCounts | null) {
    setRowCounts((m) => ({ ...m, [id]: counts }));
  }

  async function goToAdminTab(courseId: string, tab: string) {
    try {
      await setActiveCourse(courseId);
    } catch (err) {
      console.error('[CoursesAdmin] setActiveCourse failed:', err);
    }
    navigate(`/admin?tab=${tab}`);
  }

  async function bulkRemoveMembers(c: CourseRow) {
    setRowError(c.id, null);
    const token = session?.access_token;
    if (!token) {
      setRowError(c.id, t('admin.users.notLoggedIn'));
      return;
    }
    setRowBusyId(c.id);
    try {
      const res = await fetch(`/api/admin/courses/${c.id}/members`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRowError(c.id, json.error || t('coursesAdmin.errors.deleteFailed', { status: String(res.status) }));
        return;
      }
      // Update counts: members nu 0.
      setRowCounts((m) => {
        const prev = m[c.id];
        if (!prev) return m;
        return { ...m, [c.id]: { ...prev, members: 0 } };
      });
      setConfirmBulkMembersId(null);
      await Promise.all([loadCourses(), refreshCourses()]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      setRowError(c.id, msg);
    } finally {
      setRowBusyId(null);
    }
  }

  async function loadCourses() {
    setLoadingList(true);
    // Defensief: oude DB zonder cue_delta_max- of student_visible-kolom →
    // fall back zonder die velden (Task #173 + Task #270).
    let rows: CourseRow[] | null = null;
    const primary = await supabase
      .from('courses')
      .select('id, name, description, is_active, cue_delta_max, student_visible, enrollment_mode')
      .order('name', { ascending: true });
    const missingNewColumn = primary.error
      && (primary.error.code === '42703' || /cue_delta_max|student_visible|enrollment_mode/i.test(primary.error.message || ''));
    if (missingNewColumn) {
      const fallback = await supabase
        .from('courses')
        .select('id, name, description, is_active')
        .order('name', { ascending: true });
      if (fallback.error) console.error('[CoursesAdmin] load error:', fallback.error);
      rows = ((fallback.data as Array<Omit<CourseRow, 'cue_delta_max' | 'student_visible' | 'enrollment_mode'>>) ?? []).map((c) => ({
        ...c, cue_delta_max: 2, student_visible: true, enrollment_mode: 'open' as EnrollmentMode,
      }));
    } else if (primary.error) {
      console.error('[CoursesAdmin] load error:', primary.error);
      rows = [];
    } else {
      rows = ((primary.data as Array<Partial<CourseRow>>) ?? []).map((c) => ({
        id: c.id as string,
        name: c.name as string,
        description: (c.description as string) ?? null,
        is_active: !!c.is_active,
        cue_delta_max: Number.isFinite(Number(c.cue_delta_max)) ? Number(c.cue_delta_max) : 2,
        // Ontbrekende/onbekende waarde → behandel als zichtbaar (default true).
        student_visible: c.student_visible !== false,
        enrollment_mode: (c.enrollment_mode as EnrollmentMode) || 'open',
      }));
    }
    setCourses(rows);
    setLoadingList(false);
  }

  useEffect(() => {
    loadCourses();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setCreatedCourseId(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('coursesAdmin.errors.nameRequired'));
      return;
    }
    const token = session?.access_token;
    if (!token) {
      setError(t('admin.users.notLoggedIn'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/courses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: trimmed, description: description.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || t('coursesAdmin.errors.createFailed', { status: String(res.status) }));
        return;
      }
      setSuccessMsg(t('coursesAdmin.create.success', { name: trimmed }));
      setCreatedCourseId(json.course?.id ?? null);
      setName('');
      setDescription('');
      await Promise.all([loadCourses(), refreshCourses()]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(c: CourseRow) {
    setEditingId(c.id);
    setEditName(c.name);
    setEditDesc(c.description ?? '');
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName('');
    setEditDesc('');
    setEditError(null);
  }

  async function toggleActive(c: CourseRow) {
    setRowError(c.id, null);
    const token = session?.access_token;
    if (!token) {
      setRowError(c.id, t('admin.users.notLoggedIn'));
      return;
    }
    setRowBusyId(c.id);
    try {
      const res = await fetch(`/api/admin/courses/${c.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ is_active: !c.is_active }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRowError(c.id, json.error || t('coursesAdmin.errors.changeFailed', { status: String(res.status) }));
        return;
      }
      await Promise.all([loadCourses(), refreshCourses()]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      setRowError(c.id, msg);
    } finally {
      setRowBusyId(null);
    }
  }

  function requestDelete(c: CourseRow) {
    setRowError(c.id, null);
    setRowCount(c.id, null);
    setDeleteConfirmText('');
    setDeleteDialogError(null);
    setDeleteTarget(c);
  }

  function closeDeleteDialog() {
    setDeleteTarget(null);
    setDeleteConfirmText('');
    setDeleteDialogError(null);
  }

  async function requestCascadeDelete(c: CourseRow) {
    setRowError(c.id, null);
    setRowCount(c.id, null);
    setCascadeConfirmText('');
    setCascadeDialogError(null);
    setCascadeCounts(null);
    setCascadeTarget(c);
    const token = session?.access_token;
    if (!token) {
      setCascadeDialogError(t('admin.users.notLoggedIn'));
      return;
    }
    setCascadeLoading(true);
    try {
      const res = await fetch(`/api/admin/courses/${c.id}?preview=true`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCascadeDialogError(json.error || t('coursesAdmin.errors.countsFailed', { status: String(res.status) }));
        return;
      }
      setCascadeCounts((json.counts ?? null) as DeleteCounts | null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      setCascadeDialogError(msg);
    } finally {
      setCascadeLoading(false);
    }
  }

  function closeCascadeDialog() {
    setCascadeTarget(null);
    setCascadeCounts(null);
    setCascadeConfirmText('');
    setCascadeDialogError(null);
  }

  async function confirmCascadeDelete() {
    const c = cascadeTarget;
    if (!c) return;
    if (cascadeConfirmText.trim() !== c.name) return;
    const token = session?.access_token;
    if (!token) {
      setCascadeDialogError(t('admin.users.notLoggedIn'));
      return;
    }
    setRowBusyId(c.id);
    setCascadeDialogError(null);
    let success = false;
    try {
      const res = await fetch(`/api/admin/courses/${c.id}?cascade=true`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCascadeDialogError(json.error || t('coursesAdmin.errors.deleteFailed', { status: String(res.status) }));
        return;
      }
      await Promise.all([loadCourses(), refreshCourses()]);
      success = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      setCascadeDialogError(msg);
    } finally {
      setRowBusyId(null);
      if (success) closeCascadeDialog();
    }
  }

  async function confirmDeleteCourse() {
    const c = deleteTarget;
    if (!c) return;
    if (deleteConfirmText.trim() !== c.name) return;
    const token = session?.access_token;
    if (!token) {
      setDeleteDialogError(t('admin.users.notLoggedIn'));
      return;
    }
    setRowBusyId(c.id);
    setDeleteDialogError(null);
    let success = false;
    try {
      const res = await fetch(`/api/admin/courses/${c.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = json.error || t('coursesAdmin.errors.deleteFailed', { status: String(res.status) });
        if (res.status === 409 && json.counts) {
          // Schakel terug naar de rij-weergave zodat de admin de
          // category-specifieke cleanup-acties (Leden, Open projecten,
          // Open cursusmap, bulk-leden verwijderen) ziet bij de juiste cursus.
          setRowError(c.id, message);
          setRowCount(c.id, json.counts as DeleteCounts);
          closeDeleteDialog();
        } else {
          setDeleteDialogError(message);
        }
        return;
      }
      await Promise.all([loadCourses(), refreshCourses()]);
      success = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      setDeleteDialogError(msg);
    } finally {
      setRowBusyId(null);
      if (success) closeDeleteDialog();
    }
  }

  async function saveEdit(courseId: string) {
    setEditError(null);
    const trimmedName = editName.trim();
    const trimmedDesc = editDesc.trim();
    if (!trimmedName) {
      setEditError(t('coursesAdmin.errors.nameEmpty'));
      return;
    }
    const token = session?.access_token;
    if (!token) {
      setEditError(t('admin.users.notLoggedIn'));
      return;
    }
    setEditSaving(true);
    try {
      const res = await fetch(`/api/admin/courses/${courseId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: trimmedName, description: trimmedDesc }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEditError(json.error || t('coursesAdmin.errors.updateFailed', { status: String(res.status) }));
        return;
      }
      cancelEdit();
      await Promise.all([loadCourses(), refreshCourses()]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('common.unknownError');
      setEditError(msg);
    } finally {
      setEditSaving(false);
    }
  }

  if (!isAdmin) return null;

  return (
    <div className="space-y-8" data-testid="tab-courses">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-blue-600" />
          {t('admin.tabs.courses')}
        </h2>
        <AdminHint variant="intro">{t('coursesAdmin.intro.admin')}</AdminHint>
      </header>

      <section className="bg-white border border-gray-200 rounded-lg p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('coursesAdmin.create.title')}</h2>
        <form onSubmit={handleCreate} className="space-y-4" data-testid="form-create-course">
          <div>
            <label htmlFor="course-name" className="block text-sm font-medium text-gray-700 mb-1">
              {t('admin.users.nameCol')} <span className="text-red-600">*</span>
            </label>
            <input
              id="course-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('coursesAdmin.create.namePlaceholder')}
              maxLength={120}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={submitting}
              data-testid="input-course-name"
            />
          </div>
          <div>
            <label htmlFor="course-desc" className="block text-sm font-medium text-gray-700 mb-1">
              {t('folderTree.descriptionOptional')}
            </label>
            <textarea
              id="course-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={submitting}
              data-testid="input-course-description"
            />
          </div>

          {error && (
            <div
              className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2"
              data-testid="text-course-error"
            >
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {successMsg && (
            <div
              className="flex items-start gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2"
              data-testid="text-course-success"
            >
              <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}
          {(() => {
            const created = createdCourseId ? courses.find((c) => c.id === createdCourseId) : null;
            if (!created) return null;
            return (
              <div className="rounded-md border border-brand-100 bg-brand-50 px-3 py-3 space-y-2" data-testid="panel-course-next-steps">
                <p className="text-sm font-medium text-brand-900">{t('coursesAdmin.nextSteps.title')}</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void goToAdminTab(created.id, 'members')}
                    className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-white px-3 py-1.5 text-sm font-medium text-brand-700 ring-1 ring-brand-200 hover:bg-brand-100"
                    data-testid="button-next-add-teacher"
                  >
                    <UserPlus className="w-4 h-4" />
                    {t('coursesAdmin.nextSteps.addTeacher')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEnrollmentFor(created)}
                    className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-white px-3 py-1.5 text-sm font-medium text-brand-700 ring-1 ring-brand-200 hover:bg-brand-100"
                    data-testid="button-next-enrollment"
                  >
                    <DoorOpen className="w-4 h-4" />
                    {t('coursesAdmin.nextSteps.enrollment')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void goToAdminTab(created.id, 'material')}
                    className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-white px-3 py-1.5 text-sm font-medium text-brand-700 ring-1 ring-brand-200 hover:bg-brand-100"
                    data-testid="button-next-material"
                  >
                    <FolderOpen className="w-4 h-4" />
                    {t('coursesAdmin.nextSteps.material')}
                  </button>
                </div>
              </div>
            );
          })()}

          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-md transition-colors"
            data-testid="button-create-course"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            {t('coursesAdmin.create.submit')}
          </button>
        </form>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">{t('coursesAdmin.list.title')}</h2>
        {loadingList ? (
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <Loader2 className="w-4 h-4 animate-spin" /> {t('common.loading')}
          </div>
        ) : courses.length === 0 ? (
          <p className="text-sm text-gray-500" data-testid="text-no-courses">
            {t('coursesAdmin.list.empty')}
          </p>
        ) : (
          <ul className="space-y-2" data-testid="list-courses">
            {courses.map((c) => {
              const isEditing = editingId === c.id;
              return (
                <li
                  key={c.id}
                  className="border border-gray-200 rounded-md px-4 py-3 bg-white"
                  data-testid={`row-course-${c.id}`}
                >
                  {isEditing ? (
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">{t('admin.users.nameCol')}</label>
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          maxLength={120}
                          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          disabled={editSaving}
                          data-testid={`input-edit-name-${c.id}`}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          {t('coursesAdmin.edit.descriptionLabel')}
                        </label>
                        <textarea
                          value={editDesc}
                          onChange={(e) => setEditDesc(e.target.value)}
                          rows={2}
                          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          disabled={editSaving}
                          data-testid={`input-edit-description-${c.id}`}
                        />
                      </div>
                      {editError && (
                        <div
                          className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2"
                          data-testid={`text-edit-error-${c.id}`}
                        >
                          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                          <span>{editError}</span>
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => saveEdit(c.id)}
                          disabled={editSaving || !editName.trim()}
                          className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm font-medium px-3 py-1.5 rounded-md transition-colors"
                          data-testid={`button-save-course-${c.id}`}
                        >
                          {editSaving ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Check className="w-3.5 h-3.5" />
                          )}
                          {t('common.save')}
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          disabled={editSaving}
                          className="inline-flex items-center gap-1.5 bg-white hover:bg-gray-50 text-gray-700 border border-gray-300 text-sm font-medium px-3 py-1.5 rounded-md transition-colors"
                          data-testid={`button-cancel-edit-${c.id}`}
                        >
                          <X className="w-3.5 h-3.5" />
                          {t('coursesAdmin.cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <ListRow
                        testId={`row-course-main-${c.id}`}
                        menuTestId={`button-more-course-${c.id}`}
                        title={<span data-testid={`text-course-name-${c.id}`}>{c.name}</span>}
                        badges={
                          <>
                            <StatusBadge tone={c.is_active ? 'success' : 'neutral'} testId={`status-course-active-${c.id}`}>
                              {c.is_active ? t('chooseCourse.active') : t('coursesAdmin.row.inactive')}
                            </StatusBadge>
                            <StatusBadge
                              tone={c.student_visible ? 'success' : 'warning'}
                              title={c.student_visible ? t('coursesAdmin.row.visibleTitle') : t('coursesAdmin.row.hiddenTitle')}
                              testId={`status-course-visible-${c.id}`}
                            >
                              {c.student_visible ? t('coursesAdmin.row.available') : t('coursesAdmin.row.unavailable')}
                            </StatusBadge>
                            <StatusBadge
                              tone={c.enrollment_mode === 'closed' ? 'neutral' : 'info'}
                              title={t(`enrollment.modeDesc.${c.enrollment_mode}` as Parameters<typeof t>[0])}
                              testId={`status-course-enrollment-${c.id}`}
                            >
                              {t(`enrollment.mode.${c.enrollment_mode}` as Parameters<typeof t>[0])}
                            </StatusBadge>
                          </>
                        }
                        meta={
                          <>
                            {c.description && <div>{c.description}</div>}
                          </>
                        }
                        actions={[
                          {
                            key: 'edit', label: t('coursesAdmin.row.edit'), icon: Pencil, tone: 'primary' as const,
                            title: t('coursesAdmin.row.editTitle'), onClick: () => startEdit(c),
                            disabled: rowBusyId === c.id, testId: `button-edit-course-${c.id}`,
                          }, {
                            key: 'enrollment', label: t('enrollment.action'), icon: DoorOpen, tone: 'primary' as const,
                            title: t('enrollment.actionTitle'), onClick: () => setEnrollmentFor(c),
                            disabled: rowBusyId === c.id, testId: `button-enrollment-mode-${c.id}`,
                          },
                          // Leden en openstellen gelden voor de actieve cursus: maak deze cursus actief en ga erheen.
                          {
                            key: 'members', label: t('admin.tabs.members'), icon: Users, tone: 'primary' as const,
                            title: t('coursesAdmin.row.openMembersTitle'), onClick: () => void goToAdminTab(c.id, 'members'),
                            disabled: rowBusyId === c.id, testId: `button-open-members-${c.id}`,
                          }, {
                            key: 'course', label: t('admin.tabs.course'), icon: School, tone: 'primary' as const,
                            title: t('coursesAdmin.row.openCourseTitle'), onClick: () => void goToAdminTab(c.id, 'course'),
                            disabled: rowBusyId === c.id, testId: `button-open-course-${c.id}`,
                          }, {
                            key: 'active', label: c.is_active ? t('coursesAdmin.row.deactivate') : t('coursesAdmin.row.activate'),
                            icon: Power, tone: (c.is_active ? 'warning' : 'success') as 'warning' | 'success',
                            title: c.is_active ? t('coursesAdmin.row.deactivateTitle') : t('coursesAdmin.row.activateTitle'),
                            onClick: () => toggleActive(c), busy: rowBusyId === c.id, testId: `button-toggle-active-${c.id}`,
                          }, {
                            key: 'delete', label: t('coursesAdmin.delete'), icon: Trash2, tone: 'danger' as const,
                            title: t('coursesAdmin.row.deleteTitle'), onClick: () => requestDelete(c),
                            disabled: rowBusyId === c.id, testId: `button-delete-course-${c.id}`,
                          }, {
                            key: 'cascade', label: t('coursesAdmin.row.cascade'), icon: Flame, tone: 'danger' as const,
                            title: t('coursesAdmin.row.cascadeTitle'), onClick: () => requestCascadeDelete(c),
                            disabled: rowBusyId === c.id, testId: `button-cascade-delete-course-${c.id}`,
                          },
                        ]}
                      />
                      {rowErrors[c.id] && (
                        <div
                          className="flex flex-col gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2"
                          data-testid={`text-row-error-${c.id}`}
                        >
                          <div className="flex items-start gap-2">
                            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                            <span>{rowErrors[c.id]}</span>
                          </div>
                          {rowCounts[c.id] && (
                            <div className="pl-6 flex flex-col gap-2" data-testid={`cleanup-actions-${c.id}`}>
                              {rowCounts[c.id]!.members > 0 && (
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-gray-700 text-xs">
                                    {t('coursesAdmin.counts.members', { count: String(rowCounts[c.id]!.members) })}
                                  </span>
                                  {confirmBulkMembersId === c.id ? (
                                      <span className="inline-flex items-center gap-1.5">
                                        <span className="text-xs text-amber-800">{t('coursesAdmin.cleanup.confirmBulk')}</span>
                                        <button
                                          type="button"
                                          onClick={() => bulkRemoveMembers(c)}
                                          disabled={rowBusyId === c.id}
                                          className="inline-flex items-center gap-1 text-xs font-medium text-white bg-red-600 hover:bg-red-700 disabled:bg-gray-300 px-2 py-1 rounded transition-colors"
                                          data-testid={`button-confirm-bulk-remove-members-${c.id}`}
                                        >
                                          {rowBusyId === c.id ? (
                                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                          ) : (
                                            <Check className="w-3.5 h-3.5" />
                                          )}
                                          {t('admin.concepts.yesDelete')}
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => setConfirmBulkMembersId(null)}
                                          disabled={rowBusyId === c.id}
                                          className="inline-flex items-center gap-1 text-xs font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 px-2 py-1 rounded transition-colors"
                                          data-testid={`button-cancel-bulk-remove-members-${c.id}`}
                                        >
                                          <X className="w-3.5 h-3.5" />
                                          {t('coursesAdmin.cancel')}
                                        </button>
                                      </span>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => setConfirmBulkMembersId(c.id)}
                                        disabled={rowBusyId === c.id}
                                        className="inline-flex items-center gap-1 text-xs font-medium text-red-700 hover:text-red-900 disabled:text-gray-400 px-2 py-1 rounded border border-red-200 hover:bg-red-50 transition-colors"
                                        title={t('coursesAdmin.cleanup.bulkRemoveTitle')}
                                        data-testid={`button-bulk-remove-members-${c.id}`}
                                      >
                                        <UserX className="w-3.5 h-3.5" />
                                        {t('coursesAdmin.cleanup.bulkRemove')}
                                      </button>
                                    )}
                                  <button
                                    type="button"
                                    onClick={() => void goToAdminTab(c.id, 'members')}
                                    className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-900 px-2 py-1 rounded border border-blue-200 hover:bg-blue-50 transition-colors"
                                    data-testid={`button-manage-members-${c.id}`}
                                  >
                                    <Users className="w-3.5 h-3.5" />
                                    {t('admin.tabs.members')}
                                  </button>
                                </div>
                              )}
                              {rowCounts[c.id]!.projects > 0 && (
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-gray-700 text-xs">
                                    {t('coursesAdmin.counts.projects', { count: String(rowCounts[c.id]!.projects) })}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => goToAdminTab(c.id, 'projects_admin')}
                                    className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-900 px-2 py-1 rounded border border-blue-200 hover:bg-blue-50 transition-colors"
                                    data-testid={`button-open-projects-${c.id}`}
                                  >
                                    <FolderTree className="w-3.5 h-3.5" />
                                    {t('dashboard.tile.project.cta')}
                                  </button>
                                </div>
                              )}
                              {(rowCounts[c.id]!.extra_folders > 0 || rowCounts[c.id]!.documents > 0) && (
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-gray-700 text-xs">
                                    {rowCounts[c.id]!.extra_folders > 0 && t('coursesAdmin.counts.extraFolders', { count: String(rowCounts[c.id]!.extra_folders) })}
                                    {rowCounts[c.id]!.extra_folders > 0 && rowCounts[c.id]!.documents > 0 && ', '}
                                    {rowCounts[c.id]!.documents > 0 && t('coursesAdmin.counts.documents', { count: String(rowCounts[c.id]!.documents) })}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => goToAdminTab(c.id, 'material&step=files')}
                                    className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-900 px-2 py-1 rounded border border-blue-200 hover:bg-blue-50 transition-colors"
                                    data-testid={`button-open-course-folder-${c.id}`}
                                  >
                                    <FolderOpen className="w-3.5 h-3.5" />
                                    {t('coursesAdmin.cleanup.openCourseFolder')}
                                  </button>
                                </div>
                              )}
                              {rowCounts[c.id]!.sessions > 0 && (
                                <div className="text-xs text-gray-700">
                                  {t('coursesAdmin.cleanup.sessions', { count: String(rowCounts[c.id]!.sessions) })}
                                </div>
                              )}
                              {rowCounts[c.id]!.journal_entries > 0 && (
                                <div className="text-xs text-gray-700">
                                  {t('coursesAdmin.cleanup.journal', { count: String(rowCounts[c.id]!.journal_entries) })}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && rowBusyId !== deleteTarget?.id) closeDeleteDialog();
        }}
      >
        {deleteTarget && (
          <AlertDialogContent data-testid="dialog-delete-course">
            <AlertDialogHeader>
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                  <AlertTriangle className="w-5 h-5 text-red-700" />
                </div>
                <div className="flex-1 min-w-0">
                  <AlertDialogTitle>{t('coursesAdmin.deleteDialog.title')}</AlertDialogTitle>
                  <AlertDialogDescription className="mt-1">
                    {t('coursesAdmin.deleteDialog.descBefore')}{' '}
                    <span
                      className="font-semibold text-gray-900"
                      data-testid="text-delete-course-name"
                    >
                      {deleteTarget.name}
                    </span>{' '}
                    {t('coursesAdmin.deleteDialog.descAfter')}
                  </AlertDialogDescription>
                </div>
              </div>
            </AlertDialogHeader>

            <div className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>
                {t('coursesAdmin.deleteDialog.warning')}
              </span>
            </div>

            <div>
              <label
                htmlFor="delete-course-confirm-input"
                className="block text-sm font-medium text-gray-700"
              >
                {t('coursesAdmin.dialog.typeBefore')} <span className="font-mono font-semibold">{deleteTarget.name}</span>{' '}
                {t('coursesAdmin.dialog.typeAfter')}
              </label>
              <input
                id="delete-course-confirm-input"
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                disabled={rowBusyId === deleteTarget.id}
                autoFocus
                className="mt-1 w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 disabled:bg-gray-100"
                placeholder={deleteTarget.name}
                data-testid="input-delete-course-confirm"
              />
            </div>

            {deleteDialogError && (
              <div
                className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2"
                data-testid="text-delete-course-error"
              >
                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>{deleteDialogError}</span>
              </div>
            )}

            <AlertDialogFooter>
              <AlertDialogCancel
                disabled={rowBusyId === deleteTarget.id}
                data-testid="button-cancel-delete-course"
              >
                {t('coursesAdmin.cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDeleteCourse}
                disabled={
                  rowBusyId === deleteTarget.id ||
                  deleteConfirmText.trim() !== deleteTarget.name
                }
                data-testid="button-confirm-delete-course"
              >
                {rowBusyId === deleteTarget.id && (
                  <Loader2 className="w-4 h-4 animate-spin" />
                )}
                <Trash2 className="w-4 h-4" />
                {t('admin.users.deleteConfirmBtn')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>

      <AlertDialog
        open={cascadeTarget !== null}
        onOpenChange={(open) => {
          if (!open && rowBusyId !== cascadeTarget?.id) closeCascadeDialog();
        }}
      >
        {cascadeTarget && (
          <AlertDialogContent data-testid="dialog-cascade-delete-course">
            <AlertDialogHeader>
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                  <Flame className="w-5 h-5 text-red-700" />
                </div>
                <div className="flex-1 min-w-0">
                  <AlertDialogTitle>{t('coursesAdmin.cascadeDialog.title')}</AlertDialogTitle>
                  <AlertDialogDescription className="mt-1">
                    {t('coursesAdmin.cascadeDialog.descBefore')}{' '}
                    <span
                      className="font-semibold text-gray-900"
                      data-testid="text-cascade-course-name"
                    >
                      {cascadeTarget.name}
                    </span>{' '}
                    {t('coursesAdmin.cascadeDialog.descAfter')}
                  </AlertDialogDescription>
                </div>
              </div>
            </AlertDialogHeader>

            <div
              className="flex flex-col gap-2 text-sm text-red-800 bg-red-50 border border-red-200 rounded-md px-3 py-2"
              data-testid="cascade-counts-summary"
            >
              <div className="flex items-start gap-2 font-medium">
                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>
                  {t('coursesAdmin.cascadeDialog.intro')}
                </span>
              </div>
              {cascadeLoading ? (
                <div className="flex items-center gap-2 text-gray-700 pl-6">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('coursesAdmin.cascadeDialog.loadingCounts')}
                </div>
              ) : cascadeCounts ? (
                <ul className="list-disc pl-10 space-y-0.5 text-gray-800">
                  <li data-testid="cascade-count-members">
                    {t('coursesAdmin.counts.members', { count: String(cascadeCounts.members) })}
                  </li>
                  <li data-testid="cascade-count-projects">
                    {t('coursesAdmin.cascadeDialog.projects', { count: String(cascadeCounts.projects) })}
                  </li>
                  <li data-testid="cascade-count-sessions">
                    {t('coursesAdmin.cascadeDialog.sessions', { count: String(cascadeCounts.sessions) })}
                  </li>
                  <li data-testid="cascade-count-journal">
                    {t('coursesAdmin.cascadeDialog.journal', { count: String(cascadeCounts.journal_entries) })}
                  </li>
                  <li data-testid="cascade-count-extra-folders">
                    {t('coursesAdmin.cascadeDialog.extraFolders', { count: String(cascadeCounts.extra_folders) })}
                  </li>
                  <li data-testid="cascade-count-documents">
                    {t('coursesAdmin.cascadeDialog.documents', { count: String(cascadeCounts.documents) })}
                  </li>
                  <li>
                    {t('coursesAdmin.cascadeDialog.defaultFolderBefore')} <strong>RAG</strong> {t('coursesAdmin.cascadeDialog.defaultFolderAnd')}{' '}
                    <strong>Projectdata</strong> {t('coursesAdmin.cascadeDialog.defaultFolderAfter')}
                  </li>
                </ul>
              ) : (
                <div className="text-gray-700 pl-6 text-xs">
                  {t('coursesAdmin.cascadeDialog.noCounts')}
                </div>
              )}
            </div>

            <div>
              <label
                htmlFor="cascade-course-confirm-input"
                className="block text-sm font-medium text-gray-700"
              >
                {t('coursesAdmin.dialog.typeBefore')} <span className="font-mono font-semibold">{cascadeTarget.name}</span>{' '}
                {t('coursesAdmin.dialog.typeAfter')}
              </label>
              <input
                id="cascade-course-confirm-input"
                type="text"
                value={cascadeConfirmText}
                onChange={(e) => setCascadeConfirmText(e.target.value)}
                disabled={rowBusyId === cascadeTarget.id}
                autoFocus
                className="mt-1 w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 disabled:bg-gray-100"
                placeholder={cascadeTarget.name}
                data-testid="input-cascade-delete-confirm"
              />
            </div>

            {cascadeDialogError && (
              <div
                className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2"
                data-testid="text-cascade-delete-error"
              >
                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>{cascadeDialogError}</span>
              </div>
            )}

            <AlertDialogFooter>
              <AlertDialogCancel
                disabled={rowBusyId === cascadeTarget.id}
                data-testid="button-cancel-cascade-delete"
              >
                {t('coursesAdmin.cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmCascadeDelete}
                disabled={
                  rowBusyId === cascadeTarget.id ||
                  cascadeLoading ||
                  !cascadeCounts ||
                  cascadeConfirmText.trim() !== cascadeTarget.name
                }
                className="bg-red-700 hover:bg-red-800 text-white"
                data-testid="button-confirm-cascade-delete"
              >
                {rowBusyId === cascadeTarget.id && (
                  <Loader2 className="w-4 h-4 animate-spin" />
                )}
                <Flame className="w-4 h-4" />
                {t('coursesAdmin.cascadeDialog.confirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
      {enrollmentFor && (
        <EnrollmentModeDialog
          courseId={enrollmentFor.id}
          courseName={enrollmentFor.name}
          current={enrollmentFor.enrollment_mode}
          onClose={() => setEnrollmentFor(null)}
          onSaved={() => { setEnrollmentFor(null); void loadCourses(); }}
        />
      )}
    </div>
  );
}
