import { useEffect, useState } from 'react';
import { Loader2, Send, Trash2, UserPlus, UserX } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../i18n';

// Leden van één cursus: docent toevoegen, rol wisselen, iemand verwijderen en
// openstaande uitnodigingen opnieuw sturen of intrekken (server/courses/courseMembers.js,
// courseInvitations.js). De server controleert per actie of je dit voor deze cursus mag.

interface Member {
  user_id: string;
  member_role: 'student' | 'teacher';
  email: string | null;
  full_name: string | null;
  global_role: string;
  // Uitgenodigd maar nog niet geactiveerd.
  invitation?: { status: 'queued' | 'failed' | 'pending' | 'expired'; expiresAt: string; lastSentAt: string | null } | null;
}

export function CourseMembersPanel({ courseId, courseName, canEdit, reloadKey = 0 }: {
  courseId: string;
  courseName: string;
  canEdit: boolean;
  /** Ophogen om de lijst opnieuw te laden (bijvoorbeeld na een uitnodiging). */
  reloadKey?: number;
}) {
  const { session, isAdmin, user } = useAuth();
  const { t } = useLanguage();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [teacherEmail, setTeacherEmail] = useState('');
  const [teacherBusy, setTeacherBusy] = useState(false);

  async function load() {
    const token = session?.access_token;
    if (!token) { setError(t('admin.users.notLoggedIn')); setLoading(false); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/courses/${courseId}/members`, { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) setError(json.error || t('coursesAdmin.errors.loadFailed', { status: String(res.status) }));
      else setMembers(json.members || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setError(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, reloadKey, session?.access_token]);

  useEffect(() => { setNotice(null); setMembers([]); }, [courseId]);

  async function addTeacher() {
    const email = teacherEmail.trim();
    const token = session?.access_token;
    if (!email || !token) return;
    setTeacherBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/courses/${courseId}/invitations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: [email], role: 'teacher' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error || t('common.unknownError')); return; }
      if (json.summary?.invalid) { setError(t('coursesAdmin.addTeacher.invalid')); return; }
      const status = json.results?.[0]?.status as string | undefined;
      if (status === 'failed') { setError(json.results[0].error || t('common.unknownError')); return; }
      setNotice(t(`coursesAdmin.addTeacher.result.${status || 'added'}` as 'coursesAdmin.addTeacher.result.added', { email }));
      setTeacherEmail('');
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setTeacherBusy(false);
    }
  }

  // PUT (rol) of DELETE (verwijderen). Bij de laatste docent mag een beheerder
  // na een expliciete bevestiging forceren; de bescherming blijft zichtbaar.
  async function memberRequest(userId: string, method: 'PUT' | 'DELETE', body?: object, force = false): Promise<boolean> {
    const token = session?.access_token;
    if (!token) { setError(t('admin.users.notLoggedIn')); return false; }
    setBusyId(userId);
    setError(null);
    try {
      const res = await fetch(`/api/admin/courses/${courseId}/members/${userId}${force ? '?force=1' : ''}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) return true;
      if (res.status === 409 && json.code === 'last_teacher' && isAdmin && !force) {
        if (window.confirm(t('coursesAdmin.confirm.lastTeacherForce', { error: String(json.error) }))) {
          return memberRequest(userId, method, body, true);
        }
        setError(json.error);
        return false;
      }
      const fallback = method === 'PUT' ? 'coursesAdmin.errors.updateFailed' : 'coursesAdmin.errors.deleteFailed';
      setError(json.error || t(fallback, { status: String(res.status) }));
      return false;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('common.unknownError'));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function changeRole(userId: string, role: 'student' | 'teacher') {
    if (await memberRequest(userId, 'PUT', { member_role: role })) {
      setMembers((prev) => prev.map((m) => (m.user_id === userId ? { ...m, member_role: role } : m)));
    }
  }

  async function removeMember(m: Member) {
    const label = m.full_name || m.email || t('coursesAdmin.members.thisMember');
    if (!window.confirm(t('coursesAdmin.confirm.removeMember', { label, course: courseName }))) return;
    if (await memberRequest(m.user_id, 'DELETE')) {
      setMembers((prev) => prev.filter((x) => x.user_id !== m.user_id));
    }
  }

  async function inviteAction(m: Member, action: 'resend' | 'revoke') {
    const token = session?.access_token;
    if (!token) { setError(t('admin.users.notLoggedIn')); return; }
    if (action === 'revoke' && !window.confirm(t('coursesAdmin.invite.confirmRevoke', { email: m.email || '', course: courseName }))) return;
    setBusyId(m.user_id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/courses/${courseId}/invitations/${m.user_id}${action === 'resend' ? '/resend' : ''}`, {
        method: action === 'resend' ? 'POST' : 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error || t('common.unknownError')); return; }
      if (action === 'revoke') {
        setMembers((prev) => prev.filter((x) => x.user_id !== m.user_id));
        setNotice(t('coursesAdmin.invite.revoked'));
      } else {
        setMembers((prev) => prev.map((x) => (x.user_id === m.user_id && x.invitation ? { ...x, invitation: { ...x.invitation, status: 'queued' } } : x)));
        setNotice(t('coursesAdmin.invite.resent'));
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setBusyId(null);
    }
  }

  const teacherCount = members.filter((m) => m.member_role === 'teacher').length;

  return (
    <div className="space-y-3" data-testid="panel-course-members">
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">{error}</div>
      )}
      {notice && (
        <div className="rounded-lg bg-accent-50 border border-accent-200 px-3 py-2 text-sm text-accent-800" data-testid="text-invite-notice">{notice}</div>
      )}
      {canEdit && (
        <form
          onSubmit={(e) => { e.preventDefault(); void addTeacher(); }}
          className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3"
          data-testid="form-add-teacher"
        >
          <label htmlFor="add-teacher-email" className="block text-sm font-medium text-gray-800">
            {t('coursesAdmin.addTeacher.label')}
          </label>
          <p className="text-xs text-gray-600 mb-2">{t('coursesAdmin.addTeacher.hint')}</p>
          <div className="flex flex-wrap gap-2">
            <input
              id="add-teacher-email"
              type="email"
              value={teacherEmail}
              onChange={(e) => setTeacherEmail(e.target.value)}
              placeholder={t('coursesAdmin.addTeacher.placeholder')}
              className="min-w-0 flex-1 basis-56 border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={teacherBusy}
              data-testid="input-add-teacher"
            />
            <button
              type="submit"
              disabled={teacherBusy || !teacherEmail.trim()}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-300"
              data-testid="button-add-teacher"
            >
              {teacherBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
              {t('coursesAdmin.addTeacher.submit')}
            </button>
          </div>
        </form>
      )}
      {loading ? (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          {t('coursesAdmin.members.loading')}
        </div>
      ) : members.length === 0 ? (
        <p className="text-sm text-gray-500 py-8 text-center">{t('coursesAdmin.members.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-2 px-2 font-semibold text-gray-700">{t('admin.users.nameCol')}</th>
                <th className="text-left py-2 px-2 font-semibold text-gray-700">{t('admin.users.emailCol')}</th>
                <th className="text-left py-2 px-2 font-semibold text-gray-700">{t('coursesAdmin.members.roleCol')}</th>
                <th className="text-right py-2 px-2 font-semibold text-gray-700">{t('admin.users.actionsCol')}</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                // De laatste docent kan zichzelf niet degraderen (de server blokkeert dit ook).
                const isSoleTeacherSelf = m.member_role === 'teacher' && teacherCount <= 1 && m.user_id === user?.id && !isAdmin;
                const busy = busyId === m.user_id;
                return (
                  <tr key={m.user_id} className="border-b border-gray-100" data-testid={`row-member-${m.user_id}`}>
                    <td className="py-2 px-2">{m.full_name || '—'}</td>
                    <td className="py-2 px-2 text-gray-600">
                      <div className="min-w-0 break-words">{m.email || '—'}</div>
                      {m.invitation && (
                        <span
                          className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            m.invitation.status === 'failed' || m.invitation.status === 'expired' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'
                          }`}
                          data-testid={`badge-invite-${m.user_id}`}
                        >
                          {t(`coursesAdmin.invite.status.${m.invitation.status}` as 'coursesAdmin.invite.status.pending', {
                            date: new Date(m.invitation.expiresAt).toLocaleDateString(),
                          })}
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-2">
                      {canEdit ? (
                        <select
                          value={m.member_role}
                          disabled={busy || isSoleTeacherSelf}
                          onChange={(e) => changeRole(m.user_id, e.target.value as 'student' | 'teacher')}
                          className="border border-gray-300 rounded px-2 py-1 text-xs bg-white disabled:opacity-50"
                          data-testid={`select-member-role-${m.user_id}`}
                          title={isSoleTeacherSelf ? t('coursesAdmin.members.soleTeacherTitle') : undefined}
                        >
                          <option value="student">{t('nav.role.student')}</option>
                          <option value="teacher">{t('nav.role.docent')}</option>
                        </select>
                      ) : (
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${m.member_role === 'teacher' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                          {m.member_role === 'teacher' ? t('nav.role.docent') : t('nav.role.student')}
                        </span>
                      )}
                      {isSoleTeacherSelf && (
                        <span className="ml-2 text-[11px] text-amber-700" data-testid={`text-sole-teacher-${m.user_id}`}>
                          {t('coursesAdmin.members.soleTeacherBadge')}
                        </span>
                      )}
                      {busy && <Loader2 className="w-3 h-3 inline-block ml-2 animate-spin text-gray-400" />}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {canEdit && m.invitation ? (
                        <div className="flex flex-wrap justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => inviteAction(m, 'resend')}
                            disabled={busy || m.invitation.status === 'queued'}
                            className="inline-flex items-center gap-1 whitespace-nowrap px-2 py-1 text-xs font-medium text-brand-700 bg-brand-50 hover:bg-brand-100 rounded disabled:opacity-50"
                            data-testid={`button-resend-invite-${m.user_id}`}
                          >
                            <Send className="w-3.5 h-3.5" />
                            {t('coursesAdmin.invite.resend')}
                          </button>
                          <button
                            type="button"
                            onClick={() => inviteAction(m, 'revoke')}
                            disabled={busy}
                            className="inline-flex items-center gap-1 whitespace-nowrap px-2 py-1 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded disabled:opacity-50"
                            data-testid={`button-revoke-invite-${m.user_id}`}
                          >
                            <UserX className="w-3.5 h-3.5" />
                            {t('coursesAdmin.invite.revoke')}
                          </button>
                        </div>
                      ) : canEdit && (
                        <button
                          type="button"
                          onClick={() => removeMember(m)}
                          disabled={busy || isSoleTeacherSelf}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded disabled:opacity-50 disabled:cursor-not-allowed"
                          data-testid={`button-remove-member-${m.user_id}`}
                          title={isSoleTeacherSelf ? t('coursesAdmin.members.soleTeacherTitle') : t('coursesAdmin.members.removeTitle')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          {t('coursesAdmin.delete')}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
