import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "./AuthContext";
import { normalizeCourseFeatures, type CourseFeatures } from "../lib/courseFeatures";

interface ActiveCourseInfo {
  id: string;
  name: string;
  description: string | null;
}

interface ActiveCourseContextType {
  activeCourseId: string | null;
  activeCourse: ActiveCourseInfo | null;
  activeCourseRagFolderIds: string[];
  // Task #270: true zodra de actieve cursus voor deze gebruiker niet (meer)
  // bereikbaar is (verborgen voor studenten of verwijderd → RLS geeft 0 rijen).
  // De guard stuurt de student dan terug naar de kies-cursus-pagina.
  activeCourseUnavailable: boolean;
  // Onderdelen per cursus (courses.features): wat studenten mogen gebruiken.
  courseFeatures: CourseFeatures;
  // Docent van de actieve cursus of beheerder: ziet uitgezette onderdelen nog
  // (met "uit voor studenten") om voor te bereiden en te testen.
  isCourseStaff: boolean;
  setActiveCourse: (courseId: string) => Promise<void>;
  refreshActiveCourse: () => Promise<void>;
  loading: boolean;
}

const ActiveCourseContext = createContext<ActiveCourseContextType | undefined>(undefined);

export function ActiveCourseProvider({ children }: { children: ReactNode }) {
  const { user, profile, refreshProfile, loading: authLoading, isAdmin, isDocent } = useAuth();
  const [activeCourseId, setActiveCourseId] = useState<string | null>(null);
  const [activeCourse, setActiveCourseData] = useState<ActiveCourseInfo | null>(null);
  const [activeCourseRagFolderIds, setActiveCourseRagFolderIds] = useState<string[]>([]);
  const [activeCourseUnavailable, setActiveCourseUnavailable] = useState(false);
  const [courseFeatures, setCourseFeatures] = useState<CourseFeatures>(() => normalizeCourseFeatures(null));
  const [isCourseTeacher, setIsCourseTeacher] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (profile?.last_active_course_id) {
      setActiveCourseId(profile.last_active_course_id);
    } else {
      setActiveCourseId(null);
      setActiveCourseData(null);
      setActiveCourseRagFolderIds([]);
      setActiveCourseUnavailable(false);
      setLoading(false);
    }
  }, [authLoading, profile]);

  useEffect(() => {
    if (!activeCourseId) return;
    loadCourseData(activeCourseId);
  }, [activeCourseId]);

  // Docent van de actieve cursus? (Beheerders zijn altijd staf.)
  useEffect(() => {
    if (!activeCourseId || !user || !isDocent || isAdmin) {
      setIsCourseTeacher(false);
      return;
    }
    let cancelled = false;
    supabase
      .from("course_members")
      .select("member_role")
      .eq("user_id", user.id)
      .eq("course_id", activeCourseId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setIsCourseTeacher((data as { member_role?: string } | null)?.member_role === "teacher");
      });
    return () => {
      cancelled = true;
    };
  }, [activeCourseId, user?.id, isDocent, isAdmin]);

  const loadCourseData = async (courseId: string) => {
    try {
      type CourseRow = { id: string; name: string; description: string | null; features?: unknown };
      let courseRes = (await supabase
        .from("courses")
        .select("id, name, description, features")
        .eq("id", courseId)
        .single()) as unknown as { data: CourseRow | null; error: { code?: string } | null };
      // Oude database zonder courses.features: alles aan.
      if (courseRes.error?.code === "42703") {
        courseRes = (await supabase.from("courses").select("id, name, description").eq("id", courseId).single()) as unknown as typeof courseRes;
      }

      if (courseRes.data) {
        setActiveCourseData({
          id: courseRes.data.id,
          name: courseRes.data.name,
          description: courseRes.data.description,
        });
        setCourseFeatures(normalizeCourseFeatures(courseRes.data.features));
        setActiveCourseUnavailable(false);
      } else if (courseRes.error?.code === "PGRST116") {
        // PGRST116 = 0 (of >1) rijen bij .single(): de cursus is voor deze
        // gebruiker niet zichtbaar (verborgen via RLS) of verwijderd. Alleen
        // dán markeren we onbeschikbaar — netwerk-/andere fouten laten de
        // bestaande actieve cursus staan, zonder ongewenste redirect.
        console.warn("[ACTIVE COURSE] Active course unavailable (hidden or removed):", courseId);
        setActiveCourseData(null);
        setActiveCourseRagFolderIds([]);
        setActiveCourseUnavailable(true);
        return;
      } else if (courseRes.error) {
        console.error("[ACTIVE COURSE] Failed to load course:", courseRes.error);
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (token) {
        try {
          const response = await fetch(
            `/api/course-rag-folder-ids?courseId=${encodeURIComponent(courseId)}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (response.ok) {
            const json = await response.json();
            setActiveCourseRagFolderIds(json.ragFolderIds ?? []);
          } else {
            console.error("[ACTIVE COURSE] course-rag-folder-ids error:", response.status);
            setActiveCourseRagFolderIds([]);
          }
        } catch (fetchErr) {
          console.error("[ACTIVE COURSE] course-rag-folder-ids fetch failed:", fetchErr);
          setActiveCourseRagFolderIds([]);
        }
      } else {
        setActiveCourseRagFolderIds([]);
      }
    } catch (err) {
      console.error("[ACTIVE COURSE] Failed to load course data:", err);
    } finally {
      setLoading(false);
    }
  };

  const refreshActiveCourse = async () => {
    if (activeCourseId) {
      await loadCourseData(activeCourseId);
    }
  };

  const setActiveCourse = async (courseId: string) => {
    if (!user) return;

    setLoading(true);
    setActiveCourseUnavailable(false);

    const { error } = await supabase
      .from("profiles")
      .update({ last_active_course_id: courseId })
      .eq("id", user.id);

    if (error) {
      console.error("[ACTIVE COURSE] Failed to update:", error);
      setLoading(false);
      return;
    }

    await refreshProfile();
    setActiveCourseId(courseId);
    await loadCourseData(courseId);
  };

  return (
    <ActiveCourseContext.Provider
      value={{
        activeCourseId,
        activeCourse,
        activeCourseRagFolderIds,
        activeCourseUnavailable,
        courseFeatures,
        isCourseStaff: isAdmin || isCourseTeacher,
        setActiveCourse,
        refreshActiveCourse,
        loading,
      }}
    >
      {children}
    </ActiveCourseContext.Provider>
  );
}

/** Zoals useActiveCourse, maar zonder fout buiten de provider (dan undefined). */
export function useOptionalActiveCourse(): Partial<ActiveCourseContextType> | undefined {
  return useContext(ActiveCourseContext);
}

export function useActiveCourse() {
  const ctx = useContext(ActiveCourseContext);
  if (!ctx) {
    throw new Error("useActiveCourse must be used within an ActiveCourseProvider");
  }
  return ctx;
}
