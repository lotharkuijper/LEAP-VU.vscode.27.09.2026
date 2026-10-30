import { useCallback, useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useLanguage } from "../i18n";
import { useAuth } from "../contexts/AuthContext";
import { useActiveCourse } from "../contexts/ActiveCourseContext";
import { useCourseAccess } from "../contexts/CourseAccessContext";
import { supabase } from "../lib/supabase";
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
  const { setActiveCourse, loading: activeLoading } = useActiveCourse();
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
    return <div style={{ padding: "2rem" }}>{t('common.loading')}</div>;
  }

  const cardStyle: React.CSSProperties = {
    padding: "1rem", borderRadius: "8px", border: "1px solid #ccc", background: "#f9f9f9", textAlign: "left", cursor: "pointer", transition: "0.2s", width: "100%",
  };

  return (
    <div style={{ padding: "2rem", maxWidth: "600px", margin: "0 auto" }}>
      {redirectedUnavailable && (
        <div
          data-testid="text-course-unavailable-notice"
          style={{ marginBottom: "1rem", padding: "0.75rem 1rem", borderRadius: "8px", background: "#fff7ed", border: "1px solid #fed7aa", color: "#9a3412" }}
        >
          {t('chooseCourse.unavailableRedirect')}
        </div>
      )}
      {error && (
        <div data-testid="text-choose-course-error" style={{ marginBottom: "1rem", padding: "0.75rem 1rem", borderRadius: "8px", background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b" }}>
          {error}
        </div>
      )}

      <h1 style={{ marginBottom: "1rem" }}>{t('chooseCourse.title')}</h1>
      {courses.length === 0 ? (
        <p style={{ marginBottom: "2rem" }} data-testid="text-no-courses">{t('chooseCourse.noCourses')}</p>
      ) : (
        <>
          <p style={{ marginBottom: "2rem", opacity: 0.8 }}>{t('chooseCourse.subtitle')}</p>
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            {courses.map((course) => (
              <div key={course.id} style={{ display: "flex", gap: "0.5rem", alignItems: "stretch" }}>
                <button
                  data-testid={`btn-course-${course.id}`}
                  onClick={() => handleSelect(course.id)}
                  style={{ ...cardStyle, flex: 1, minWidth: 0 }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#eee")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "#f9f9f9")}
                >
                  <strong style={{ fontSize: "1.1rem" }}>{course.name}</strong>
                  {course.description && <div style={{ opacity: 0.7 }}>{course.description}</div>}
                  {course.memberRole === 'alumni' && (
                    <div style={{ marginTop: "0.25rem", fontSize: "0.8rem", color: "#6b7280" }} data-testid={`text-course-alumni-${course.id}`}>{t('editions.alumniBadge')}</div>
                  )}
                </button>
                {course.memberRole === 'student' && allowsOpenRegistration(course.enrollment_mode) && (
                  <button
                    type="button"
                    onClick={() => handleLeave(course)}
                    disabled={busyId === course.id}
                    data-testid={`btn-leave-course-${course.id}`}
                    style={{ padding: "0 0.75rem", borderRadius: "8px", border: "1px solid #e5e7eb", background: "#fff", color: "#6b7280", fontSize: "0.8rem", whiteSpace: "nowrap", cursor: "pointer" }}
                  >
                    {t('chooseCourse.leave')}
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {openCourses.length > 0 && (
        <section style={{ marginTop: "2.5rem" }} data-testid="section-add-course">
          <h2 style={{ fontSize: "1.1rem", marginBottom: "0.25rem" }}>{t('chooseCourse.addTitle')}</h2>
          <p style={{ marginBottom: "1rem", opacity: 0.8, fontSize: "0.9rem" }}>{t('chooseCourse.addSubtitle')}</p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {openCourses.map((c) => (
              <div key={c.id} style={{ ...cardStyle, cursor: "default", display: "flex", gap: "0.75rem", alignItems: "center", background: "#fff" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{c.name}</strong>
                  {c.description && <div style={{ opacity: 0.7, fontSize: "0.9rem" }}>{c.description}</div>}
                </div>
                <button
                  type="button"
                  onClick={() => handleJoin(c.id)}
                  disabled={busyId === c.id}
                  data-testid={`btn-join-course-${c.id}`}
                  style={{ padding: "0.5rem 0.9rem", borderRadius: "8px", border: "none", background: "rgb(var(--leap-brand-700))", color: "#fff", fontWeight: 600, whiteSpace: "nowrap", cursor: "pointer", opacity: busyId === c.id ? 0.6 : 1 }}
                >
                  {busyId === c.id ? t('common.busy') : t('chooseCourse.join')}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
