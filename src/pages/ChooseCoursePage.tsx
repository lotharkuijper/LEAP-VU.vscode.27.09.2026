import { useCallback, useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { ArrowLeft, Check, ChevronRight, GraduationCap, Loader2, Plus } from "lucide-react";
import { useLanguage } from "../i18n";
import { useAuth } from "../contexts/AuthContext";
import { useActiveCourse } from "../contexts/ActiveCourseContext";
import { useCourseAccess } from "../contexts/CourseAccessContext";
import { supabase } from "../lib/supabase";
import { NoCourseWelcome } from "../components/access/NoCourseWelcome";
import { activateEnrollments, allowsOpenRegistration, fetchOpenCourses, joinCourse, leaveCourse, type OpenCourse } from "../services/enrollment.service";

// Cursuskeuze. Toegang = lidmaatschap (server/courses/enrollment.js): de lijst toont de
// cursussen waar je lid of docent van bent (de courses-RLS filtert), plus
// "Cursus toevoegen" met open cursussen waar je nog geen lid van bent.
type MyCourse = { id: string; name: string; description: string | null; enrollment_mode?: string | null; memberRole?: string | null };

export default function ChooseCoursePage() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, loading: authLoading } = useAuth();
  const { activeCourseId, setActiveCourse, loading: activeLoading } = useActiveCourse();
  const { refreshCourses } = useCourseAccess();

  // Task #270: gezet door de ActiveCourseRedirectGuard wanneer de actieve cursus
  // van de student niet meer beschikbaar is.
  const redirectedUnavailable = (location.state as { courseUnavailable?: boolean } | null)?.courseUnavailable === true;

  const [courses, setCourses] = useState<MyCourse[]>([]);
  const [openCourses, setOpenCourses] = useState<OpenCourse[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    // Aanmeldingen van de open registratie worden bij de eerste login lidmaatschappen.
    await activateEnrollments();
    const [{ data, error: e }, { data: members }, { data: alumni }, open] = await Promise.all([
      supabase.from("courses").select("id, name, description, enrollment_mode").eq("is_active", true).order("name", { ascending: true }),
      supabase.from("course_members").select("course_id, member_role").eq("user_id", user.id),
      // Oud-deelnemer van een vorige editie: de cursus blijft leesbaar (server/courseEditions.js).
      supabase.from("course_alumni").select("course_id").eq("user_id", user.id),
      fetchOpenCourses().catch(() => [] as OpenCourse[]),
    ]);
    if (e) console.error("[COURSE SELECT] Error loading courses:", e);
    const roleBy = new Map<string, string>((alumni ?? []).map((a: { course_id: string }) => [a.course_id, 'alumni']));
    for (const m of (members ?? []) as Array<{ course_id: string; member_role: string }>) roleBy.set(m.course_id, m.member_role);
    const mine: MyCourse[] = ((data ?? []) as MyCourse[]).map((c) => ({ ...c, memberRole: roleBy.get(c.id) ?? null }));
    setCourses(mine);
    const mineIds = new Set(mine.map((c) => c.id));
    setOpenCourses(open.filter((c) => !mineIds.has(c.id)));
    setLoading(false);
  }, [user]);

  useEffect(() => {
    if (!user || authLoading) return;
    void load();
  }, [user, authLoading, load]);

  const handleSelect = async (courseId: string) => {
    await setActiveCourse(courseId);
    navigate("/dashboard");
  };

  const handleJoin = async (courseId: string) => {
    setBusyId(courseId); setError(null);
    try {
      await joinCourse(courseId);
      await refreshCourses();
      await handleSelect(courseId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const handleLeave = async (c: MyCourse) => {
    if (!window.confirm(t('chooseCourse.leaveConfirm', { name: c.name }))) return;
    setBusyId(c.id); setError(null);
    try {
      await leaveCourse(c.id);
      await refreshCourses();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  if (authLoading || loading || activeLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-500">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-sky-50 via-white to-emerald-50/60 px-4 py-10 md:py-16">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-8 flex items-center justify-between gap-4">
          <img src="/leap-vu-logo.png" alt="LEAP-VU" className="h-12 w-auto" />
          {activeCourseId && (
            <button
              type="button"
              onClick={() => navigate("/dashboard")}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:text-brand-900 hover:underline"
              data-testid="link-back-dashboard"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              {t('nav.dashboard')}
            </button>
          )}
        </div>

        {redirectedUnavailable && (
          <div
            data-testid="text-course-unavailable-notice"
            className="mb-4 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-800"
          >
            {t('chooseCourse.unavailableRedirect')}
          </div>
        )}
        {error && (
          <div data-testid="text-choose-course-error" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        )}

        <section className="rounded-3xl border border-white/60 bg-white/70 p-6 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(56,189,248,0.25)] ring-1 ring-sky-100/60 backdrop-blur-md md:p-8">
          <h1 className="text-3xl font-bold tracking-tight text-brand-800">{t('chooseCourse.title')}</h1>
          {courses.length === 0 ? (
            <div className="mt-4">
              <NoCourseWelcome fallback={<p className="text-slate-600" data-testid="text-no-courses">{t('chooseCourse.noCourses')}</p>} />
            </div>
          ) : (
            <>
              <p className="mb-6 mt-1 text-slate-600">{t('chooseCourse.subtitle')}</p>
              <ul className="flex flex-col gap-3">
                {courses.map((course) => {
                  const isActive = course.id === activeCourseId;
                  return (
                    <li key={course.id} className="flex items-stretch gap-2">
                      <button
                        type="button"
                        data-testid={`btn-course-${course.id}`}
                        onClick={() => handleSelect(course.id)}
                        aria-current={isActive ? "true" : undefined}
                        className={`group flex min-w-0 flex-1 items-center gap-4 rounded-2xl border p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                          isActive ? "border-brand-300 bg-brand-50/80 ring-1 ring-brand-200" : "border-slate-200 bg-white hover:border-brand-200"
                        }`}
                      >
                        <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${isActive ? "bg-brand-600 text-white" : "bg-brand-50 text-brand-700 group-hover:bg-brand-100"}`}>
                          <GraduationCap className="h-5 w-5" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="break-words text-lg font-semibold text-slate-900">{course.name}</span>
                            {isActive && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-brand-100 px-2 py-0.5 text-xs font-semibold text-brand-800" data-testid={`text-course-active-${course.id}`}>
                                <Check className="h-3 w-3" aria-hidden="true" />
                                {t('chooseCourse.active')}
                              </span>
                            )}
                          </span>
                          {course.description && <span className="mt-0.5 block text-sm text-slate-600">{course.description}</span>}
                          {course.memberRole === 'alumni' && (
                            <span className="mt-1 block text-xs text-slate-500" data-testid={`text-course-alumni-${course.id}`}>{t('editions.alumniBadge')}</span>
                          )}
                        </span>
                        <ChevronRight className="h-5 w-5 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5 group-hover:text-brand-700" aria-hidden="true" />
                      </button>
                      {course.memberRole === 'student' && allowsOpenRegistration(course.enrollment_mode) && (
                        <button
                          type="button"
                          onClick={() => handleLeave(course)}
                          disabled={busyId === course.id}
                          data-testid={`btn-leave-course-${course.id}`}
                          className="whitespace-nowrap rounded-2xl border border-slate-200 bg-white px-3 text-xs font-medium text-slate-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                        >
                          {t('chooseCourse.leave')}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>

        {openCourses.length > 0 && (
          <section className="mt-8" data-testid="section-add-course">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
              <Plus className="h-5 w-5 text-brand-700" aria-hidden="true" />
              {t('chooseCourse.addTitle')}
            </h2>
            <p className="mb-4 mt-0.5 text-sm text-slate-600">{t('chooseCourse.addSubtitle')}</p>
            <ul className="flex flex-col gap-3">
              {openCourses.map((c) => (
                <li key={c.id} className="flex items-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-white/80 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="break-words font-semibold text-slate-900">{c.name}</div>
                    {c.description && <div className="text-sm text-slate-600">{c.description}</div>}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleJoin(c.id)}
                    disabled={busyId === c.id}
                    data-testid={`btn-join-course-${c.id}`}
                    className="whitespace-nowrap rounded-xl bg-brand-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-800 disabled:opacity-60"
                  >
                    {busyId === c.id ? t('common.busy') : t('chooseCourse.join')}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
