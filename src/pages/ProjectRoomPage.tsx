import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useLanguage } from '../i18n';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { liveUpdates } from '../lib/liveUpdates';
import { AutoTranslatedNotice } from '../components/AutoTranslatedNotice';
import { useContentTranslation, type TranslatableItem } from '../hooks/useContentTranslation';
import { PersonaMessageBody, personaSourcesFrom } from '../components/PersonaMessageBody';
import { ViewerErrorBoundary } from '../components/ViewerErrorBoundary';
import { PersonaAvatar } from '../components/PersonaAvatar';
import { ProductFeedbackPanel } from '../components/ProductFeedbackPanel';
import { RELATIONSHIP_BADGE, RELATIONSHIP_LEVELS, type RelationshipKey } from '../lib/relationshipLevels';
// De viewer (met pdf.js) pas laden als een student een bron opent.
const DocumentViewer = lazy(() => import('../components/DocumentViewer').then(m => ({ default: m.DocumentViewer })));
import {
  ArrowLeft, Send, Users, MessageCircle, Bot, CheckCircle2,
  Flag, Clipboard, Copy, Loader2, BookOpen, Paperclip, Trash2, FileText, ShieldAlert, Download, Database, EyeOff,
  LogOut, ScrollText, ChevronDown, ChevronRight, UploadCloud,
} from 'lucide-react';

interface Persona {
  id: string;
  name: string;
  avatar_emoji: string;
  avatar?: unknown;
  system_prompt: string;
  rag_enabled: boolean;
  rag_folder_ids: string[];
  _source: 'project' | 'course' | 'default';
}
interface GroupMember {
  id: string;
  user_id: string;
  role: string;
  profiles: { id: string; full_name: string | null; email: string };
}
interface Project {
  id: string;
  title: string;
  briefing_markdown: string | null;
  rubric_criteria: any[];
  research_question: string;
  submissions_enabled?: boolean | null;
  course_id?: string | null;
}
interface Submission {
  id: string;
  filename: string;
  byte_size: number | null;
  mime_type: string | null;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
  uploaded_by_email: string | null;
  created_at: string;
}
interface ProjectGroup {
  id: string;
  name: string;
  invite_code: string;
  status: 'active' | 'finalized' | 'archived';
  finalized_at: string | null;
}
interface ChatMsg {
  id: string;
  group_id: string;
  user_id: string | null;
  body: string;
  reactions: Record<string, string[]>;
  created_at: string;
  profiles?: { full_name: string | null; email: string } | null;
}
interface PersonaMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  user_id: string | null;
  /** Bronnen uit het cursusmateriaal waar [n] in het antwoord naar verwijst. */
  rag_sources?: unknown;
}
interface Checkpoint {
  id: string;
  kind: 'checkpoint' | 'final';
  reflection: string;
  ai_summary: string | null;
  rubric_feedback: any;
  created_at: string;
}
interface PersonaDoc {
  id: string;
  filename: string;
  byte_size: number | null;
  uploaded_by: string | null;
  created_at: string;
}
interface PreviewThread {
  threadId: string;
  personaId: string;
  personaName: string;
  avatarEmoji: string;
  studentSummary: string;
  personaSummary: string;
}

interface CheckpointSynthesis {
  overeenstemming: string[];
  spanningspunten: string[];
  suggesties: string[];
}

interface ProjectMaterialDoc {
  id: string;
  filename: string;
  byte_size: number | null;
  mime_type?: string | null;
  document_ref_id?: string | null;
  is_visible_to_students: boolean;
  created_at: string;
}
interface EvaluatorRubric {
  id: string;
  filename: string;
  byte_size: number | null;
  visible_to_students?: boolean;
}
interface EvaluatorPersona {
  id: string;
  name: string;
  avatar_emoji: string | null;
  avatar?: unknown;
  rubrics?: EvaluatorRubric[];
}
// Verstandhouding met een rolspeler (alleen als de docent die bijhoudt).
interface RelationshipHistoryEvent {
  ts: string | null;
  source: string | null;
  step?: number;
  from?: number;
  to?: number;
  note?: string;
  by?: string;
  refId?: string;
}
interface RelationshipInfo {
  personaId: string;
  personaName: string;
  avatarEmoji: string | null;
  avatar?: unknown;
  level: number;
  key: RelationshipKey;
  label: string;
  broken: boolean;
  lastReason: { note: string; ts: string | null; step: number } | null;
  updatedAt: string | null;
  history?: RelationshipHistoryEvent[];
}
// Task #252 — raadpleeglimiet per project-persona (per groep).
interface ConsultationInfo {
  personaId: string;
  used: number;
  extra: number;
  baseLimit: number | null;
  limit: number | null;
  remaining: number | null;
  blocked: boolean;
  hasOpenThread?: boolean;
  autoCloseHours: number | null;
}
// Task #252/#296: pure beslissing of een bericht een NIEUWE raadpleging start
// terwijl er een eindige limiet geldt — dan moet eerst worden bevestigd. Los
// gehouden van de component zodat de regressie (o.a. de readiness-knop die via
// requestSendPersona door deze poort moet) los testbaar is.
export function startsNewConsultation(
  consult: ConsultationInfo | undefined | null,
  hasActiveThread: boolean,
): boolean {
  return !!(
    consult &&
    consult.limit !== null &&
    !hasActiveThread &&
    !consult.hasOpenThread
  );
}
interface ClosedConversation {
  threadId: string;
  personaId: string;
  personaName: string;
  avatarEmoji: string;
  avatar?: unknown;
  closedAt: string;
  topics: string[];
  agreements: string[];
  reputation?: { step: number; reason: string; to: number | null };
}

const QUICK_REACTIONS = ['👍', '❤️', '🤔', '✅'];

export function ProjectRoomPage() {
  const { t, lang } = useLanguage();
  const { projectId, groupId } = useParams<{ projectId: string; groupId: string }>();
  const { profile, session, isAdmin, isDocent } = useAuth();
  const navigate = useNavigate();
  const isStaff = isAdmin || isDocent;

  const [project, setProject] = useState<Project | null>(null);
  const [group, setGroup] = useState<ProjectGroup | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [activePersonaId, setActivePersonaId] = useState<string | null>(null);
  const [personaMessages, setPersonaMessages] = useState<PersonaMsg[]>([]);
  // Cursusdocument dat vanuit een bronverwijzing in een persona-antwoord is geopend.
  const [viewerDoc, setViewerDoc] = useState<{ documentId: string; title: string; page?: number; seq: number } | null>(null);
  const viewerSeqRef = useRef(0);
  const [personaInput, setPersonaInput] = useState('');
  const [personaLoading, setPersonaLoading] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [showCheckpointModal, setShowCheckpointModal] = useState<null | 'checkpoint' | 'final'>(null);
  const [checkpointSaved, setCheckpointSaved] = useState(false);
  const [reflection, setReflection] = useState('');
  const [submittingCheckpoint, setSubmittingCheckpoint] = useState(false);
  // Stabiele requestId per checkpoint-poging: pas resetten na succesvolle
  // submit, zodat netwerk-retries van dezelfde knopdruk dedupeer-baar blijven.
  const [checkpointRequestId, setCheckpointRequestId] = useState<string | null>(null);
  const [checkpointPreview, setCheckpointPreview] = useState<PreviewThread[] | null>(null);
  const [checkpointSynthesis, setCheckpointSynthesis] = useState<CheckpointSynthesis | null>(null);
  const [checkpointPreviewLoading, setCheckpointPreviewLoading] = useState(false);
  const [checkpointPreviewError, setCheckpointPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingRoom, setLoadingRoom] = useState(true);
  const [personaDocs, setPersonaDocs] = useState<PersonaDoc[]>([]);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [projectMaterials, setProjectMaterials] = useState<ProjectMaterialDoc[]>([]);
  const [bestandenOpen, setBestandenOpen] = useState(false);
  const [hasEvaluator, setHasEvaluator] = useState(false);
  const [evaluators, setEvaluators] = useState<EvaluatorPersona[]>([]);
  // Task #167 — Persona-relaties
  const [relationships, setRelationships] = useState<RelationshipInfo[]>([]);
  const [adjustingPersona, setAdjustingPersona] = useState<RelationshipInfo | null>(null);
  const [adjustLevel, setAdjustLevel] = useState<number>(0);
  const [adjustNote, setAdjustNote] = useState<string>('');
  const [adjustSaving, setAdjustSaving] = useState(false);
  const [adjustError, setAdjustError] = useState<string | null>(null);
  // Task #252 — raadpleeglimieten + grant-modal + bevestiging nieuwe raadpleging
  const [consultations, setConsultations] = useState<ConsultationInfo[]>([]);
  const [grantingPersona, setGrantingPersona] = useState<{ personaId: string; personaName: string } | null>(null);
  const [grantExtra, setGrantExtra] = useState<number>(1);
  const [grantNote, setGrantNote] = useState<string>('');
  const [grantSaving, setGrantSaving] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [confirmConsult, setConfirmConsult] = useState<ConsultationInfo | null>(null);
  // Task #296: tekst die wacht op bevestiging van een nieuwe raadpleging (kan de
  // gewone invoer zijn of een quick-prompt zoals de readiness-vraag).
  const [pendingPersonaText, setPendingPersonaText] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submitFileRef = useRef<HTMLInputElement>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [evaluateRequestId, setEvaluateRequestId] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Gesprek afsluiten
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [closeModalLoading, setCloseModalLoading] = useState(false);
  const [closePreviewData, setClosePreviewData] = useState<{ topics: string[]; agreements: string[] } | null>(null);
  const [closeModalError, setCloseModalError] = useState<string | null>(null);
  const [closingConversation, setClosingConversation] = useState(false);

  // Gesprekslogboek
  const [conversationLog, setConversationLog] = useState<ClosedConversation[]>([]);
  const [logbookLoading, setLogbookLoading] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<'briefing' | 'logboek'>('briefing');
  const [openPersonaFolders, setOpenPersonaFolders] = useState<Set<string>>(new Set());
  const [expandedLogItems, setExpandedLogItems] = useState<Set<string>>(new Set());

  const fileInputRef = useRef<HTMLInputElement>(null);
  const personaInputRef = useRef<HTMLTextAreaElement>(null);
  const personaScrollRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  const token = session?.access_token;

  const loadRoom = useCallback(async () => {
    if (!token || !projectId || !groupId) return;
    setLoadingRoom(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/room?groupId=${groupId}&lang=${lang}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        setError((await r.json()).error || t('room.couldNotLoadRoom'));
        return;
      }
      const data = await r.json();
      setProject(data.project);
      setGroup(data.group);
      setMembers(data.members || []);
      setPersonas(data.personas || []);
      setCheckpoints(data.checkpoints || []);
      setProjectMaterials(data.projectDocuments || []);
      setEvaluators(data.evaluators || []);
      setHasEvaluator(!!data.hasEvaluator);
      setConsultations(data.consultations || []);
      if (!activePersonaId && data.personas?.length > 0) {
        setActivePersonaId(data.personas[0].id);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingRoom(false);
    }
  }, [token, projectId, groupId, activePersonaId, lang]);

  useEffect(() => { loadRoom(); }, [loadRoom]);

  const loadSubmissions = useCallback(async () => {
    if (!token || !projectId || !groupId || !project?.submissions_enabled) {
      setSubmissions([]);
      return;
    }
    try {
      const r = await fetch(`/api/projects/${projectId}/submissions?groupId=${groupId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        const d = await r.json();
        setSubmissions(d.submissions || []);
      }
    } catch {
      /* niet fataal */
    }
  }, [token, projectId, groupId, project?.submissions_enabled]);

  useEffect(() => { loadSubmissions(); }, [loadSubmissions]);

  const submitProduct = async (file: File) => {
    if (!token || !projectId || !groupId) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('groupId', groupId);
      const r = await fetch(`/api/projects/${projectId}/submissions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || t('room.uploadFailed'));
      await loadSubmissions();
      setShowSubmitModal(false);
      setInfo(t('room.submission.submitted'));
      setTimeout(() => setInfo(null), 4000);
    } catch (e: any) {
      setSubmitError(e.message);
    } finally {
      setSubmitting(false);
      if (submitFileRef.current) submitFileRef.current.value = '';
    }
  };

  const downloadSubmission = async (s: Submission) => {
    if (!token || !projectId) return;
    try {
      const r = await fetch(`/api/projects/${projectId}/submissions/${s.id}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); setError(j.error || t('room.downloadFailed')); return; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = s.filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) { setError(e.message); }
  };

  // Reset thread + active persona als groep wisselt — voorkomt dat berichten
  // van een vorige groep blijven hangen bij snel navigeren.
  useEffect(() => {
    setPersonaMessages([]);
    setActivePersonaId(null);
  }, [groupId]);

  // Load persona thread berichten als active persona verandert. Cancel-guard
  // tegen stale responses bij snelle persona-wissels.
  useEffect(() => {
    if (!token || !groupId || !activePersonaId) return;
    let cancelled = false;
    setPersonaMessages([]);
    setActiveThreadId(null);
    fetch(`/api/projects/persona-thread?groupId=${groupId}&personaId=${activePersonaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(d => {
        if (!cancelled) {
          setPersonaMessages(d.messages || []);
          setActiveThreadId(d.threadId || null);
        }
      })
      .catch(() => { /* genegeerd — UI valt terug op leeg */ });
    return () => { cancelled = true; };
  }, [token, groupId, activePersonaId]);

  // Documenten van de actieve persona ophalen.
  const loadPersonaDocs = useCallback(async () => {
    if (!token || !projectId || !groupId || !activePersonaId || activePersonaId === '__default__') {
      setPersonaDocs([]); return;
    }
    try {
      const r = await fetch(`/api/projects/${projectId}/personas/${activePersonaId}/documents?groupId=${groupId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      if (r.ok) setPersonaDocs(d.documents || []);
    } catch { /* stil */ }
  }, [token, projectId, groupId, activePersonaId]);
  useEffect(() => { loadPersonaDocs(); }, [loadPersonaDocs]);

  const uploadFile = async (file: File) => {
    if (!token || !projectId || !activePersonaId || activePersonaId === '__default__') {
      setError(t('room.addPersonaFirst'));
      return;
    }
    const ALLOWED = /\.(txt|md|markdown|csv|tsv|json|log|pdf|docx|pptx|xlsx|odt|ods|odp)$/i;
    if (!ALLOWED.test(file.name)) {
      setError(t('room.supportedFormats'));
      return;
    }
    if (file.size > 15_000_000) {
      setError(t('room.fileTooLarge'));
      return;
    }
    setUploadingDoc(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('groupId', groupId!);
      fd.append('file', file, file.name);
      const r = await fetch(`/api/projects/${projectId}/personas/${activePersonaId}/documents`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || t('room.uploadFailed'));
      setPersonaDocs(prev => [d.document, ...prev]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUploadingDoc(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const deleteDoc = async (doc: PersonaDoc) => {
    if (!token || !projectId || !activePersonaId) return;
    if (!confirm(t('room.deleteDocConfirm', { filename: doc.filename }))) return;
    try {
      const r = await fetch(`/api/projects/${projectId}/personas/${activePersonaId}/documents/${doc.id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || t('room.deleteFailed'));
      }
      setPersonaDocs(prev => prev.filter(d => d.id !== doc.id));
    } catch (e: any) {
      setError(e.message);
    }
  };

  // Initial load groepschat + realtime subscription.
  useEffect(() => {
    if (!groupId) return;
    let cancelled = false;
    const loadChat = async () => {
      const { data } = await supabase
        .from('group_chat_messages')
        .select('id, group_id, user_id, body, reactions, created_at, profiles(full_name, email)')
        .eq('group_id', groupId)
        .order('created_at', { ascending: true })
        .limit(200);
      if (cancelled) return;
      const next = (data as any) || [];
      // Ongewijzigd → dezelfde lijst laten staan, zodat periodiek verversen
      // (zonder Realtime) de chat niet telkens naar beneden laat scrollen.
      const key = (list: any[]) => JSON.stringify(list.map(m => [m.id, m.body, m.reactions]));
      setChatMessages(prev => (key(prev) === key(next) ? prev : next));
    };
    loadChat();

    const stopLive = liveUpdates(() => supabase
      .channel(`group-chat-${groupId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'group_chat_messages',
        filter: `group_id=eq.${groupId}`,
      }, async (payload) => {
        // Profielnaam erbij ophalen.
        const m = payload.new as any;
        let profileData = null;
        if (m.user_id) {
          const { data: p } = await supabase
            .from('profiles').select('full_name, email').eq('id', m.user_id).maybeSingle();
          profileData = p;
        }
        setChatMessages(prev => prev.find(x => x.id === m.id) ? prev : [...prev, { ...m, profiles: profileData }]);
      })
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'group_chat_messages',
        filter: `group_id=eq.${groupId}`,
      }, (payload) => {
        const m = payload.new as any;
        setChatMessages(prev => prev.map(x => x.id === m.id ? { ...x, reactions: m.reactions, body: m.body } : x));
      })
      .subscribe(), loadChat, 4000);

    return () => { cancelled = true; stopLive(); };
  }, [groupId]);

  useEffect(() => {
    personaScrollRef.current?.scrollTo({ top: personaScrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [personaMessages]);
  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [chatMessages]);

  const loadRelationships = useCallback(async () => {
    if (!projectId || !groupId || !token) return;
    try {
      const r = await fetch(`/api/projects/${projectId}/groups/${groupId}/relationships?lang=${lang}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) setRelationships(d.relationships || []);
      else if (r.status !== 503) console.warn('[relationships load]', d.error);
    } catch (e) { console.warn('[relationships load]', e); }
  }, [projectId, groupId, token, lang]);

  useEffect(() => { loadRelationships(); }, [loadRelationships]);

  const submitAdjust = async () => {
    if (!adjustingPersona || !projectId || !groupId || !token) return;
    if (!adjustNote.trim()) { setAdjustError(t('room.relationship.noteLabel')); return; }
    setAdjustSaving(true);
    setAdjustError(null);
    try {
      const r = await fetch(
        `/api/projects/${projectId}/groups/${groupId}/personas/${adjustingPersona.personaId}/relationship-adjust`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ level: adjustLevel, note: adjustNote.trim() }),
        },
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || t('room.relationship.adjustFailed'));
      setAdjustingPersona(null);
      setAdjustNote('');
      await loadRelationships();
    } catch (e: any) {
      setAdjustError(e.message);
    } finally {
      setAdjustSaving(false);
    }
  };

  const downloadMaterial = async (d: ProjectMaterialDoc) => {
    if (!projectId || !token) return;
    try {
      const r = await fetch(`/api/projects/${projectId}/documents/${d.id}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || t('room.downloadFailed'));
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = d.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) {
      setError(e.message || t('room.downloadFailed'));
    }
  };

  // Task #253: download van een (voor studenten zichtbaar gemaakte) rubric.
  const downloadRubric = async (personaId: string, rubric: EvaluatorRubric) => {
    if (!projectId || !token) return;
    try {
      const r = await fetch(`/api/projects/${projectId}/personas/${personaId}/documents/${rubric.id}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || t('room.downloadFailed'));
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = rubric.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) {
      setError(e.message || t('room.downloadFailed'));
    }
  };

  // Task #252: bepaalt of dit bericht een NIEUWE raadpleging start (geen open
  // thread) terwijl er een eindige limiet geldt — dan eerst bevestigen.
  const requestSendPersona = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !activePersonaId || !groupId || !token) return;
    const consult = consultations.find(c => c.personaId === activePersonaId);
    if (consult?.blocked) return; // input is dan toch al uitgeschakeld
    if (startsNewConsultation(consult, !!activeThreadId)) {
      setPendingPersonaText(trimmed);
      setConfirmConsult(consult!);
      return;
    }
    doSendPersona(trimmed);
  };

  const sendPersona = () => requestSendPersona(personaInput);

  const doSendPersona = async (text: string) => {
    if (!text || !activePersonaId || !groupId || !token) return;
    setPersonaInput('');
    const tempId = `local-${Date.now()}`;
    setPersonaMessages(prev => [...prev, {
      id: tempId, role: 'user', content: text,
      created_at: new Date().toISOString(), user_id: profile?.id || null,
    }]);
    setPersonaLoading(true);
    try {
      const r = await fetch('/api/projects/persona-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ groupId, personaId: activePersonaId, message: text, lang }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || t('room.personaChatFailed'));
      if (data.threadId) setActiveThreadId(data.threadId);
      setPersonaMessages(prev => [...prev, {
        id: `reply-${Date.now()}`, role: 'assistant',
        content: data.relationshipBroken ? t('room.relationship.brokenBanner', { name: activePersona ? personaName(activePersona) : '' }) : data.reply,
        created_at: new Date().toISOString(), user_id: null,
        rag_sources: data.relationshipBroken ? [] : data.ragSources,
      }]);
      // De server meldt een verbroken contact — herlaad zodat banner + label kloppen.
      if (data.relationshipBroken) loadRelationships();
      // Task #252: verbruik bijwerken (nieuwe raadpleging gestart of limiet
      // bereikt) zodat teller/banner/badge direct synchroniseren.
      if (data.consultation || data.consultationLimitReached) loadRoom();
    } catch (e: any) {
      setPersonaMessages(prev => [...prev, {
        id: `err-${Date.now()}`, role: 'assistant',
        content: `${t('room.errorPrefix')}: ${e.message}`, created_at: new Date().toISOString(), user_id: null,
      }]);
    } finally {
      setPersonaLoading(false);
    }
  };

  // Task #252: staff kent extra raadplegingen toe aan deze groep.
  const submitGrant = async () => {
    if (!grantingPersona || !projectId || !groupId || !token) return;
    setGrantSaving(true);
    setGrantError(null);
    try {
      const r = await fetch(
        `/api/projects/${projectId}/groups/${groupId}/personas/${grantingPersona.personaId}/consultations-grant`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ extra: grantExtra, note: grantNote.trim() || null }),
        },
      );
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || t('room.consultations.grantFailed'));
      setGrantingPersona(null);
      setGrantNote('');
      setGrantExtra(1);
      await loadRoom();
    } catch (e: any) {
      setGrantError(e.message);
    } finally {
      setGrantSaving(false);
    }
  };

  const sendChat = async () => {
    if (!chatInput.trim() || !groupId || !profile?.id) return;
    const body = chatInput.trim();
    setChatInput('');
    const { error: insErr } = await supabase
      .from('group_chat_messages')
      .insert({ group_id: groupId, user_id: profile.id, body });
    if (insErr) setError(insErr.message);
  };

  const addReaction = async (msg: ChatMsg, emoji: string) => {
    if (!profile?.id) return;
    // Race-mitigatie: lees de huidige reactions uit de DB vlak voor de write
    // zodat parallelle reacties van groepsgenoten niet stiekem overschreven
    // worden. Dit is een best-effort patch (echte atomicity vereist een RPC).
    const { data: latest } = await supabase
      .from('group_chat_messages')
      .select('reactions').eq('id', msg.id).maybeSingle();
    const reactions: Record<string, string[]> = { ...((latest?.reactions as any) || msg.reactions || {}) };
    const list = new Set(reactions[emoji] || []);
    if (list.has(profile.id)) list.delete(profile.id); else list.add(profile.id);
    if (list.size === 0) delete reactions[emoji]; else reactions[emoji] = [...list];
    await supabase.from('group_chat_messages').update({ reactions }).eq('id', msg.id);
  };

  const openCheckpoint = async (kind: 'checkpoint' | 'final') => {
    setShowCheckpointModal(kind);
    setCheckpointSaved(false);
    setCheckpointPreviewError(null);
    if (kind === 'checkpoint') {
      setCheckpointPreview(null);
      setCheckpointSynthesis(null);
      setCheckpointPreviewLoading(true);
      try {
        const r = await fetch(`/api/projects/groups/${groupId}/checkpoint-preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ lang }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || t('room.previewFailed'));
        setCheckpointPreview(data.threads || []);
        setCheckpointSynthesis(data.synthesis || null);
      } catch (e: any) {
        setCheckpointPreviewError(e.message);
      } finally {
        setCheckpointPreviewLoading(false);
      }
    }
  };

  const updatePreviewSummary = (threadId: string, field: 'studentSummary' | 'personaSummary', value: string) => {
    setCheckpointPreview(prev => prev ? prev.map(t => t.threadId === threadId ? { ...t, [field]: value } : t) : prev);
  };

  const submitCheckpoint = async () => {
    if (!showCheckpointModal || !groupId || !token) return;
    // kind='final' vereist handmatige reflectie; kind='checkpoint' gebruikt de preview.
    if (showCheckpointModal === 'final' && reflection.trim().length < 20) {
      setError(t('room.reflectionTooShort'));
      return;
    }
    setSubmittingCheckpoint(true);
    setError(null);
    try {
      const requestId = checkpointRequestId || (
        (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      if (!checkpointRequestId) setCheckpointRequestId(requestId);

      const body: Record<string, unknown> = { kind: showCheckpointModal, requestId, lang };
      if (showCheckpointModal === 'final') {
        body.reflection = reflection.trim();
      } else {
        // kind='checkpoint': altijd personaSummaries sturen; knop is verborgen als preview leeg is.
        if (!checkpointPreview || checkpointPreview.length === 0) {
          throw new Error(t('room.noConversationsToSave'));
        }
        body.personaSummaries = checkpointPreview;
      }

      const r = await fetch(`/api/projects/groups/${groupId}/checkpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || t('room.checkpointFailed'));
      setCheckpoints(prev => [data.checkpoint, ...prev]);
      setReflection('');
      setCheckpointPreview(null);
      setCheckpointSynthesis(null);
      setCheckpointRequestId(null);
      if (data.checkpoint?.kind === 'final') {
        // Afronden: sluit modal en herlaad kamer (status → finalized).
        setShowCheckpointModal(null);
        setCheckpointSaved(false);
        loadRoom();
      } else {
        // Tussentijds checkpoint: toon bevestigingsscherm in de modal.
        setCheckpointSaved(true);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmittingCheckpoint(false);
    }
  };

  const copyInvite = () => {
    if (!group) return;
    navigator.clipboard.writeText(group.invite_code);
  };

  const requestEvaluation = async () => {
    if (!groupId || !token) return;
    if (!confirm(t('room.assessmentConfirm'))) return;
    setEvaluating(true);
    setError(null);
    try {
      const requestId = evaluateRequestId || (
        (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      if (!evaluateRequestId) setEvaluateRequestId(requestId);
      const r = await fetch(`/api/projects/groups/${groupId}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ requestId, lang }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || t('room.assessmentFailed'));
      const okCount = (data.results || []).filter((x: any) => x.ok).length;
      setInfo(okCount > 0
        ? t('room.assessmentComplete', { count: String(okCount) })
        : t('room.assessmentNoFeedback'));
      setTimeout(() => setInfo(null), 7000);
      setEvaluateRequestId(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setEvaluating(false);
    }
  };

  const loadConversationLog = useCallback(async () => {
    if (!token || !groupId) return;
    setLogbookLoading(true);
    try {
      const r = await fetch(`/api/projects/groups/${groupId}/conversation-log`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      if (r.ok) {
        const convs: ClosedConversation[] = d.conversations || [];
        setConversationLog(convs);
        // Open de map van de actief geselecteerde persona standaard;
        // als die er niet is, open de eerste map.
        setOpenPersonaFolders(prev => {
          const ids = [...new Set(convs.map(c => c.personaId))];
          if (ids.length === 0) return prev;
          const toOpen = activePersonaId && ids.includes(activePersonaId)
            ? activePersonaId
            : ids[0];
          return new Set([...prev, toOpen]);
        });
      }
    } catch { /* stil */ } finally {
      setLogbookLoading(false);
    }
  }, [token, groupId, activePersonaId]);

  useEffect(() => { loadConversationLog(); }, [loadConversationLog]);

  const openCloseModal = async () => {
    if (!activeThreadId || !groupId || !token) return;
    setShowCloseModal(true);
    setCloseModalLoading(true);
    setClosePreviewData(null);
    setCloseModalError(null);
    try {
      const r = await fetch(`/api/projects/groups/${groupId}/threads/${activeThreadId}/close-preview`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang }),
      });
      const contentType = r.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(t('room.serverError', { status: String(r.status) }));
      }
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || t('room.previewFailed'));
      setClosePreviewData({ topics: d.topics || [], agreements: d.agreements || [] });
    } catch (e: any) {
      setCloseModalError(e.message);
    } finally {
      setCloseModalLoading(false);
    }
  };

  const confirmClose = async () => {
    if (!activeThreadId || !groupId || !token || !closePreviewData) return;
    setClosingConversation(true);
    setCloseModalError(null);
    try {
      const r = await fetch(`/api/projects/groups/${groupId}/threads/${activeThreadId}/close`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || t('room.closeFailed'));
      setShowCloseModal(false);
      setPersonaMessages([]);
      setActiveThreadId(null);
      setRightPanelTab('logboek');
      await loadConversationLog();
      // Task #252: thread is nu dicht → herlaad raadpleeg-status zodat
      // hasOpenThread/used/remaining vers zijn vóór een eventueel nieuw gesprek
      // (anders zou de bevestiging bij een nieuwe raadpleging overgeslagen worden).
      loadRoom();
      // Verstandhouding: de groep ziet meteen wat het gesprek ermee deed.
      if (d.reputation && d.reputation.step !== 0) {
        setInfo(d.reputation.broken
          ? t('room.relationship.brokenToast', { name: d.reputation.personaName || '' })
          : t('room.relationship.changedToast', {
            name: d.reputation.personaName || '',
            label: t(`room.relationship.label.${d.reputation.key as RelationshipKey}`),
            reason: d.reputation.reason || '',
          }));
        setTimeout(() => setInfo(null), 9000);
        loadRelationships();
      } else {
        setInfo(t('room.conversationClosed'));
        setTimeout(() => setInfo(null), 5000);
      }
    } catch (e: any) {
      setCloseModalError(e.message);
    } finally {
      setClosingConversation(false);
    }
  };

  // Auto-resize textarea: groei tot ~6 regels (≈ 144px), daarna scrollen.
  useEffect(() => {
    const ta = personaInputRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const max = 144;
    ta.style.height = Math.min(ta.scrollHeight, max) + 'px';
  }, [personaInput]);

  const activePersona = personas.find(p => p.id === activePersonaId);
  const isFinalized = group?.status === 'finalized';

  // Vertaal docent-content (briefing, persona-namen, rubric-criteria) naar de
  // actieve taal (Task #288). Hooks vóór de early-returns zodat de volgorde
  // stabiel blijft.
  const roomItems: Record<string, TranslatableItem> = {};
  if (project?.briefing_markdown) roomItems.briefing = { text: project.briefing_markdown, format: 'plain' };
  for (const p of personas) roomItems[`persona:${p.id}`] = { text: p.name, format: 'plain' };
  if (project && Array.isArray(project.rubric_criteria)) {
    project.rubric_criteria.forEach((c: any, i: number) => {
      if (typeof c === 'string') roomItems[`rubric:${i}`] = { text: c, format: 'plain' };
    });
  }
  const roomT = useContentTranslation(roomItems);
  const personaName = (p: { id: string; name: string }) => roomT.values[`persona:${p.id}`] || p.name;
  const activePersonaName = activePersona ? personaName(activePersona) : '';

  if (loadingRoom && !project) {
    return <div className="p-12 text-center text-gray-500">{t('room.loading')}</div>;
  }
  if (!project || !group) {
    return (
      <div className="p-12 text-center">
        <p className="text-red-600 mb-4">{error || t('room.notFound')}</p>
        <Link to="/projects" className="text-blue-600 hover:underline">← {t('room.backToProjects')}</Link>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-8rem)] flex flex-col gap-3">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 chic-card-sm px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={() => navigate('/projects')} className="p-2 hover:bg-gray-100 rounded-lg" data-testid="button-back-projects">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <h1 className="font-bold text-gray-900 truncate" data-testid="text-project-title">{project.title}</h1>
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-xs text-gray-500 truncate">{group.name}{isFinalized && ` · ${t('room.closed')}`}</p>
              {(() => {
                const lastCp = checkpoints.length > 0
                  ? checkpoints.reduce((a, b) => new Date(a.created_at) > new Date(b.created_at) ? a : b)
                  : null;
                return lastCp ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-blue-50 text-blue-700 text-[10px] rounded border border-blue-100" data-testid="badge-last-checkpoint">
                    <CheckCircle2 className="w-2.5 h-2.5" />
                    {t('room.lastCheckpoint')} {new Date(lastCp.created_at).toLocaleString(t('common.locale'), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-gray-50 text-gray-400 text-[10px] rounded border border-gray-200" data-testid="badge-no-checkpoint">
                    {t('room.noCheckpointYet')}
                  </span>
                );
              })()}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <button onClick={copyInvite} className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 hover:bg-gray-100 rounded-lg text-xs font-mono" title={t('room.copyInviteTitle')} data-testid="button-copy-invite">
            <Copy className="w-3.5 h-3.5" />
            {group.invite_code}
          </button>
          <span className="flex items-center gap-1 text-gray-600 text-xs">
            <Users className="w-4 h-4" />{members.length}
          </span>
          {project.submissions_enabled && !isFinalized && (
            <button
              onClick={() => { setSubmitError(null); setShowSubmitModal(true); }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 text-white hover:bg-amber-600 rounded-lg text-xs font-medium"
              data-testid="button-open-submit-product"
              title={t('room.submission.buttonTitle')}
            >
              <UploadCloud className="w-4 h-4" />
              {submissions.length > 0 ? t('room.submission.replace') : t('room.submission.submitProduct')}
            </button>
          )}
          {!isFinalized && (
            <>
              <button
                onClick={() => openCheckpoint('checkpoint')}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-lg text-xs font-medium"
                data-testid="button-open-checkpoint"
              >
                <CheckCircle2 className="w-4 h-4" /> {t('room.checkpoint')}
              </button>
              <button
                onClick={() => openCheckpoint('final')}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white hover:bg-green-700 rounded-lg text-xs font-medium"
                data-testid="button-open-finalize"
              >
                <Flag className="w-4 h-4" /> {t('room.finalise')}
              </button>
            </>
          )}
          {hasEvaluator && (
            <button
              onClick={requestEvaluation}
              disabled={evaluating}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 rounded-lg text-xs font-medium"
              data-testid="button-request-evaluation"
              title={t('room.assessmentTitle')}
            >
              {evaluating ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldAlert className="w-4 h-4" />}
              {evaluating ? t('room.assessing') : t('room.requestAssessment')}
            </button>
          )}
        </div>
      </div>

      {/* 3-column body */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-3 min-h-0">
        {/* LEFT: persona-chat */}
        <div className="lg:col-span-7 flex flex-col chic-card-sm min-h-0">
          <div className="border-b border-gray-200 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <label htmlFor="persona-select" className="text-xs font-medium text-gray-600 flex items-center gap-1">
                <Bot className="w-4 h-4" /> {t('room.personaLabel')}
              </label>
              {activePersona && <PersonaAvatar avatar={activePersona.avatar} name={activePersona.name} size={32} />}
              <select
                id="persona-select"
                value={activePersonaId || ''}
                onChange={e => setActivePersonaId(e.target.value || null)}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                data-testid="select-persona"
              >
                {personas.length === 0 && <option value="">{t('room.noPersonas')}</option>}
                {personas.map(p => {
                  const rel = relationships.find(r => r.personaId === p.id);
                  const labelSuffix = rel ? ` • ${t(`room.relationship.label.${rel.key}`)}${rel.broken ? ' ⛔' : ''}` : '';
                  return (
                    <option key={p.id} value={p.id} data-testid={`option-persona-${p.id}`}>
                      {(p.avatar_emoji || '🤖')} {personaName(p)}{labelSuffix}
                    </option>
                  );
                })}
              </select>
              {(() => {
                const rel = relationships.find(r => r.personaId === activePersonaId);
                if (!rel) return null;
                const style = RELATIONSHIP_BADGE[rel.key];
                return (
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-full border text-[10px] font-medium shrink-0 ${style.chip}`}
                    title={t('room.relationship.badgeTitle', { name: rel.personaName })}
                    data-testid={`badge-relationship-${rel.personaId}`}
                  >
                    <span className={`inline-block w-1.5 h-1.5 rounded-full ${style.dot}`} />
                    {t(`room.relationship.label.${rel.key}`)}
                  </span>
                );
              })()}
              {(() => {
                // Task #252: resterende raadplegingen naast de dropdown.
                const consult = consultations.find(c => c.personaId === activePersonaId);
                if (!consult || consult.limit === null) return null;
                const cls = consult.blocked
                  ? 'bg-red-50 text-red-700 border-red-200'
                  : (consult.remaining ?? 0) <= 1
                    ? 'bg-amber-50 text-amber-700 border-amber-200'
                    : 'bg-gray-50 text-gray-600 border-gray-200';
                return (
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-full border text-[10px] font-medium shrink-0 ${cls}`}
                    title={t('room.consultations.staffUsedOf', { used: consult.used, limit: consult.limit })}
                    data-testid={`badge-consultations-${consult.personaId}`}
                  >
                    <MessageCircle className="w-3 h-3" />
                    {consult.blocked
                      ? t('room.consultations.blockedBadge')
                      : t('room.consultations.remaining', { remaining: Math.max(0, consult.remaining ?? 0), limit: consult.limit })}
                  </span>
                );
              })()}
            </div>
            {activePersona && activePersonaId !== '__default__' && (
              <div className="flex items-center justify-between gap-2 text-xs text-gray-600">
                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                  <span className="text-gray-500">{t('room.documents')} ({personaDocs.length}):</span>
                  {personaDocs.length === 0 && <span className="italic text-gray-400">{t('room.none')}</span>}
                  {personaDocs.map(d => (
                    <span key={d.id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 rounded" data-testid={`doc-${d.id}`}>
                      <FileText className="w-3 h-3" />
                      <span className="max-w-[120px] truncate" title={d.filename}>{d.filename}</span>
                      <button onClick={() => deleteDoc(d)} className="text-red-500 hover:text-red-700" title={t('room.delete')} data-testid={`button-delete-doc-${d.id}`}>
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <label className={`inline-flex items-center gap-1 px-2 py-1 rounded cursor-pointer ${uploadingDoc ? 'bg-gray-100 text-gray-400' : 'bg-blue-50 text-blue-700 hover:bg-blue-100'}`}>
                  {uploadingDoc ? <Loader2 className="w-3 h-3 animate-spin" /> : <Paperclip className="w-3 h-3" />}
                  {t('room.upload')}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".txt,.md,.markdown,.csv,.tsv,.json,.log,.pdf,.docx,.pptx,.xlsx,.odt,.ods,.odp"
                    className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f); }}
                    disabled={uploadingDoc || isFinalized}
                    data-testid="input-upload-doc"
                  />
                </label>
              </div>
            )}
          </div>
          <div ref={personaScrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
            {personaMessages.length === 0 && activePersona && (
              <div className="text-center text-gray-500 text-sm py-8">
                <PersonaAvatar avatar={activePersona.avatar} name={activePersona.name} size={72} className="mx-auto mb-2 block" />
                <>{t('room.chatStartPromptBefore')} <strong>{activePersonaName}</strong>{t('room.chatStartPromptAfter')}</>  
              </div>
            )}
            {personaMessages.map(m => (
              <div key={m.id} className={`flex items-start gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {m.role === 'assistant' && activePersona && (
                  <PersonaAvatar avatar={activePersona.avatar} name={activePersona.name} size={28} className="mt-0.5" />
                )}
                <div
                  className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-sm ${
                    m.role === 'user' ? 'bg-blue-600 text-white whitespace-pre-wrap' : 'bg-gray-100 text-gray-900'
                  }`}
                  data-testid={`msg-persona-${m.id}`}
                >
                  {m.role === 'assistant' ? (
                    <PersonaMessageBody
                      messageId={m.id}
                      content={m.content}
                      sources={personaSourcesFrom(m.rag_sources)}
                      onOpenSource={(src) => setViewerDoc({ ...src, seq: ++viewerSeqRef.current })}
                    />
                  ) : m.content}
                </div>
              </div>
            ))}
            {personaLoading && (
              <div className="flex items-start gap-2 justify-start">
                {activePersona && <PersonaAvatar avatar={activePersona.avatar} name={activePersona.name} size={28} className="mt-0.5" />}
                <div className="bg-gray-100 px-4 py-2 rounded-2xl text-sm text-gray-500 flex items-center gap-2">
                  <Loader2 className="w-3 h-3 animate-spin" /> {t('room.thinking')}
                </div>
              </div>
            )}
          </div>
          <div className="border-t border-gray-200 p-3">
            {(() => {
              const rel = relationships.find(r => r.personaId === activePersonaId);
              if (!rel) return null;
              if (rel.broken) {
                return (
                  <div
                    className="mb-2 px-3 py-2 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700 flex items-start gap-2"
                    data-testid="banner-relationship-broken"
                  >
                    <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{t('room.relationship.brokenBanner', { name: rel.personaName })}</span>
                  </div>
                );
              }
              return (
                <div className={`mb-2 px-3 py-1.5 rounded-lg border text-[11px] flex flex-wrap items-center gap-x-1.5 ${RELATIONSHIP_BADGE[rel.key].chip}`} data-testid="text-relationship-status">
                  <span className="font-medium">{t('room.relationship.status', { name: rel.personaName, label: t(`room.relationship.label.${rel.key}`) })}</span>
                  {rel.lastReason && <span className="opacity-80">— {rel.lastReason.note}</span>}
                </div>
              );
            })()}
            {(() => {
              // Task #252: raadpleeglimiet bereikt → blokkade-banner.
              const consult = consultations.find(c => c.personaId === activePersonaId);
              if (!consult || !consult.blocked) return null;
              return (
                <div
                  className="mb-2 px-3 py-2 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700 flex items-start gap-2"
                  data-testid="banner-consultations-blocked"
                >
                  <MessageCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{t('room.consultations.blockedBanner', { limit: consult.limit ?? 0 })}</span>
                </div>
              );
            })()}
            <div className="flex gap-2 items-end">
              <textarea
                ref={personaInputRef}
                value={personaInput}
                onChange={e => setPersonaInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendPersona();
                  }
                }}
                placeholder={activePersona ? t('room.chatPlaceholderWith', { name: activePersonaName }) : t('room.chatPlaceholderNoPersona')}
                disabled={
                  !activePersona || personaLoading || isFinalized
                  || !!relationships.find(r => r.personaId === activePersonaId && r.broken)
                  || !!consultations.find(c => c.personaId === activePersonaId && c.blocked)
                }
                rows={6}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-50 resize-none leading-snug min-h-[150px] max-h-[300px]"
                data-testid="input-persona-message"
              />
              <div className="flex flex-col gap-1">
                <button
                  onClick={sendPersona}
                  disabled={
                    !personaInput.trim() || personaLoading || isFinalized
                    || !!relationships.find(r => r.personaId === activePersonaId && r.broken)
                    || !!consultations.find(c => c.personaId === activePersonaId && c.blocked)
                  }
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-40"
                  data-testid="button-send-persona"
                >
                  <Send className="w-4 h-4" />
                </button>
                <button
                  onClick={openCloseModal}
                  disabled={!activeThreadId || personaLoading || isFinalized}
                  className="px-4 py-2 border border-gray-200 text-gray-400 hover:bg-red-50 hover:border-red-200 hover:text-red-500 rounded-lg disabled:opacity-30 transition-colors"
                  title={t('room.saveConversationTitle')}
                  data-testid="button-close-conversation"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT col container: groepschat + briefing/checkpoints */}
        <div className="lg:col-span-5 flex flex-col gap-3 min-h-0">
          {/* Groepschat */}
          <div className="flex-1 flex flex-col chic-card-sm min-h-0">
            <div className="border-b border-gray-200 px-3 py-2 text-sm font-semibold text-gray-700 flex items-center gap-2">
              <MessageCircle className="w-4 h-4" /> {t('room.groupChat')}
            </div>
            <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-3 space-y-2">
              {chatMessages.length === 0 && (
                <p className="text-xs text-gray-400 text-center py-6">{t('room.noMessages')}</p>
              )}
              {chatMessages.map(m => {
                const isMe = m.user_id === profile?.id;
                const author = m.profiles?.full_name || m.profiles?.email?.split('@')[0] || t('room.someone');
                return (
                  <div key={m.id} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                    <div className="text-[10px] text-gray-400 mb-0.5">{isMe ? t('room.you') : author}</div>
                    <div className={`group max-w-[85%] px-3 py-2 rounded-2xl text-sm ${isMe ? 'bg-blue-100 text-blue-950' : 'bg-gray-100 text-gray-900'}`} data-testid={`msg-chat-${m.id}`}>
                      <div className="whitespace-pre-wrap break-words">{m.body}</div>
                      <div className="flex items-center gap-1 mt-1 opacity-60 group-hover:opacity-100 transition-opacity">
                        {QUICK_REACTIONS.map(emoji => {
                          const reactors = m.reactions?.[emoji] || [];
                          const active = reactors.includes(profile?.id || '');
                          return (
                            <button
                              key={emoji}
                              onClick={() => addReaction(m, emoji)}
                              className={`text-xs px-1.5 py-0.5 rounded ${active ? 'bg-white shadow-sm' : 'hover:bg-white/50'}`}
                              data-testid={`button-react-${emoji}-${m.id}`}
                            >
                              {emoji}{reactors.length > 0 && <span className="ml-0.5 text-[10px]">{reactors.length}</span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="border-t border-gray-200 p-2">
              <div className="flex gap-2">
                <input
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), sendChat())}
                  placeholder={t('room.chatPlaceholder')}
                  disabled={isFinalized}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-50"
                  data-testid="input-group-chat"
                />
                <button
                  onClick={sendChat}
                  disabled={!chatInput.trim() || isFinalized}
                  className="px-3 py-2 bg-gray-900 text-white rounded-lg disabled:opacity-40"
                  data-testid="button-send-chat"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
              <p className="text-[10px] text-gray-400 mt-1">{t('room.emojiTip')}</p>
            </div>
          </div>

          {/* Briefing / Logboek tabs */}
          <div className="chic-card-sm max-h-[40%] flex flex-col">
            {/* Tab-balk */}
            <div className="flex border-b border-gray-200 shrink-0">
              <button
                onClick={() => setRightPanelTab('briefing')}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${rightPanelTab === 'briefing' ? 'text-blue-700 border-b-2 border-blue-600 bg-blue-50/50' : 'text-gray-500 hover:bg-gray-50'}`}
                data-testid="tab-briefing"
              >
                <Clipboard className="w-3 h-3" /> {t('room.briefing')}
              </button>
              <button
                onClick={() => setRightPanelTab('logboek')}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${rightPanelTab === 'logboek' ? 'text-blue-700 border-b-2 border-blue-600 bg-blue-50/50' : 'text-gray-500 hover:bg-gray-50'}`}
                data-testid="tab-logboek"
              >
                <ScrollText className="w-3 h-3" /> {t('room.logbook')}
                {conversationLog.length > 0 && (
                  <span className="ml-0.5 bg-blue-100 text-blue-700 rounded-full px-1.5 py-0.5 text-[10px] font-semibold" data-testid="badge-logboek-count">
                    {conversationLog.length}
                  </span>
                )}
              </button>
            </div>

            {/* Tab-inhoud */}
            <div className="flex-1 overflow-y-auto p-3">

            {rightPanelTab === 'logboek' && (
              <div data-testid="section-logboek">
                {logbookLoading && (
                  <div className="flex items-center gap-2 text-gray-400 text-xs py-4 justify-center">
                    <Loader2 className="w-4 h-4 animate-spin" /> {t('room.loadingLogbook')}
                  </div>
                )}
                {!logbookLoading && conversationLog.length === 0 && (
                  <p className="text-xs text-gray-400 italic py-4 text-center">
                    <>{t('room.noClosedConversationsBefore')} <LogOut className="w-3 h-3 inline" />{t('room.noClosedConversationsAfter')}</>  
                  </p>
                )}
                {!logbookLoading && conversationLog.length > 0 && (() => {
                  // Groepeer per persona, nieuwste gesprek bovenaan per map.
                  const grouped = new Map<string, { personaName: string; avatarEmoji: string; avatar?: unknown; conversations: ClosedConversation[] }>();
                  for (const conv of conversationLog) {
                    if (!grouped.has(conv.personaId)) {
                      grouped.set(conv.personaId, { personaName: conv.personaName, avatarEmoji: conv.avatarEmoji, avatar: conv.avatar, conversations: [] });
                    }
                    grouped.get(conv.personaId)!.conversations.push(conv);
                  }
                  // Sorteer gesprekken per map: nieuwste bovenaan.
                  for (const g of grouped.values()) {
                    g.conversations.sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime());
                  }
                  return [...grouped.entries()].map(([personaId, { personaName, avatar, conversations }]) => {
                    const folderOpen = openPersonaFolders.has(personaId);
                    const toggleFolder = () => setOpenPersonaFolders(prev => {
                      const next = new Set(prev);
                      folderOpen ? next.delete(personaId) : next.add(personaId);
                      return next;
                    });
                    return (
                      <div key={personaId} className="mb-1" data-testid={`logboek-folder-${personaId}`}>
                        {/* Map-header */}
                        <button
                          onClick={toggleFolder}
                          className="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-100 transition-colors text-left"
                          data-testid={`logboek-folder-toggle-${personaId}`}
                        >
                          {folderOpen
                            ? <ChevronDown className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                            : <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" />}
                          <PersonaAvatar avatar={avatar} name={personaName} size={20} />
                          <span className="font-semibold text-gray-800 text-xs flex-1 truncate">{personaName}</span>
                          <span className="text-[10px] bg-gray-100 text-gray-500 rounded-full px-1.5 py-0.5 font-medium shrink-0">
                            {conversations.length}
                          </span>
                        </button>

                        {/* Uitklapbare items */}
                        {folderOpen && (
                          <div className="ml-5 mt-0.5 space-y-0.5">
                            {conversations.map(conv => {
                              const itemOpen = expandedLogItems.has(conv.threadId);
                              const toggleItem = () => setExpandedLogItems(prev => {
                                const next = new Set(prev);
                                itemOpen ? next.delete(conv.threadId) : next.add(conv.threadId);
                                return next;
                              });
                              const showCue = !!conv.reputation && conv.reputation.step !== 0;
                              const hasContent = conv.topics.length > 0 || conv.agreements.length > 0 || showCue;
                              return (
                                <div key={conv.threadId} className="border border-gray-100 rounded-lg overflow-hidden" data-testid={`logboek-entry-${conv.threadId}`}>
                                  <button
                                    onClick={hasContent ? toggleItem : undefined}
                                    className={`w-full flex items-center gap-2 px-2.5 py-2 text-left transition-colors ${hasContent ? 'hover:bg-gray-50 cursor-pointer' : 'cursor-default'} ${itemOpen ? 'bg-gray-50' : ''}`}
                                    data-testid={`logboek-item-toggle-${conv.threadId}`}
                                  >
                                    {hasContent
                                      ? (itemOpen
                                          ? <ChevronDown className="w-3 h-3 text-gray-400 shrink-0" />
                                          : <ChevronRight className="w-3 h-3 text-gray-400 shrink-0" />)
                                      : <span className="w-3 shrink-0" />}
                                    <span className="text-[11px] text-gray-600 flex-1">
                                      {new Date(conv.closedAt).toLocaleString(t('common.locale'), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                    {conv.agreements.length > 0 && (
                                      <span className="text-[10px] text-green-600 font-medium shrink-0">
                                        {conv.agreements.length} {t('room.agree')}
                                      </span>
                                    )}
                                  </button>

                                  {itemOpen && hasContent && (
                                    <div className="px-3 pb-3 pt-1 border-t border-gray-100">
                                      {showCue && conv.reputation && (
                                        <div className={`mb-2 px-2 py-1.5 rounded border ${conv.reputation.step > 0 ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-amber-50 border-amber-200 text-amber-900'}`} data-testid={`logboek-reputation-${conv.threadId}`}>
                                          <p className="text-[10px] font-semibold uppercase tracking-wide mb-0.5">{t('room.relationship.logLabel')}</p>
                                          <p className="text-xs">
                                            {conv.reputation.step > 0 ? t('room.relationship.logUp') : t('room.relationship.logDown')}
                                            {conv.reputation.reason && <span> — {conv.reputation.reason}</span>}
                                          </p>
                                        </div>
                                      )}
                                      {conv.topics.length > 0 && (
                                        <div className="mb-2">
                                          <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">{t('room.discussed')}</p>
                                          <ul className="space-y-0.5">
                                            {conv.topics.map((t, i) => (
                                              <li key={i} className="flex gap-1.5 text-xs text-gray-700">
                                                <span className="text-blue-400 shrink-0 mt-0.5">•</span>{t}
                                              </li>
                                            ))}
                                          </ul>
                                        </div>
                                      )}
                                      {conv.agreements.length > 0 && (
                                        <div>
                                          <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">{t('room.agreed')}</p>
                                          <ul className="space-y-0.5">
                                            {conv.agreements.map((a, i) => (
                                              <li key={i} className="flex gap-1.5 text-xs text-gray-700">
                                                <span className="text-green-500 shrink-0 mt-0.5">✓</span>{a}
                                              </li>
                                            ))}
                                          </ul>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  });
                })()}
              </div>
            )}

            {rightPanelTab === 'briefing' && (
            <div>
            {project.briefing_markdown ? (
              <div>
                <div className="text-xs text-gray-700 whitespace-pre-wrap" data-testid="text-briefing">
                  {roomT.values.briefing || project.briefing_markdown}
                </div>
                <AutoTranslatedNotice
                  isTranslating={roomT.isTranslating}
                  isTranslated={roomT.isTranslated}
                  showOriginal={roomT.showOriginal}
                  onToggle={roomT.setShowOriginal}
                  className="mt-1"
                />
              </div>
            ) : (
              <p className="text-xs text-gray-400 italic">{t('room.noBriefing')}</p>
            )}
            {projectMaterials.length > 0 && (
              <div className="mt-3 pt-3 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setBestandenOpen(v => !v)}
                  className="w-full flex items-center justify-between text-xs font-semibold text-gray-700 hover:text-gray-900"
                  data-testid="button-toggle-bestanden"
                >
                  {(() => {
                    const visibleCount = projectMaterials.filter(d => d.is_visible_to_students).length;
                    const hiddenCount = projectMaterials.length - visibleCount;
                    return (
                      <span className="flex items-center gap-1">
                        <Download className="w-3 h-3" /> {t('room.filesFromLecturer')} ({visibleCount}{isStaff && hiddenCount > 0 ? ` + ${hiddenCount} ${t('room.hidden')}` : ''})
                      </span>
                    );
                  })()}
                  <span className="text-gray-400">{bestandenOpen ? '▲' : '▼'}</span>
                </button>
                {bestandenOpen && (
                  <div className="mt-2">
                    <ul className="space-y-1">
                      {projectMaterials.map(d => (
                        <li
                          key={d.id}
                          className={`flex items-center gap-1.5 text-xs ${!d.is_visible_to_students ? 'opacity-60' : ''}`}
                          data-testid={`project-material-${d.id}`}
                        >
                          {/\.(omv|sav|jasp|rdata|rds|rda|dta|por|zsav|spv|jrp)$/i.test(d.filename || '')
                            ? <Database className="w-3 h-3 text-blue-400 shrink-0" />
                            : <FileText className="w-3 h-3 text-gray-400 shrink-0" />}
                          <button
                            type="button"
                            onClick={() => downloadMaterial(d)}
                            className="truncate text-left text-blue-700 hover:underline"
                            title={t('room.downloadTitle', { name: d.filename })}
                            data-testid={`button-download-material-${d.id}`}
                          >
                            {d.filename}
                          </button>
                          {d.byte_size ? (
                            <span className="text-[10px] text-gray-400 shrink-0">{Math.max(1, Math.round(d.byte_size / 1024))} KB</span>
                          ) : null}
                          {isStaff && !d.is_visible_to_students && (
                            <span
                              className="inline-flex items-center gap-0.5 text-[10px] text-amber-600 bg-amber-50 border border-amber-200 rounded px-1 shrink-0"
                              title={t('room.hiddenFromStudents')}
                              data-testid={`badge-hidden-${d.id}`}
                            >
                              <EyeOff className="w-2.5 h-2.5" /> {t('room.hidden')}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                    <p className="text-[10px] text-gray-400 mt-1.5">{t('room.clickToDownload')}</p>
                  </div>
                )}
              </div>
            )}
            {Array.isArray(project.rubric_criteria) && project.rubric_criteria.length > 0 && (
              <div className="mt-3 pt-3 border-t border-gray-100">
                <div className="text-xs font-semibold text-gray-700 mb-1">{t('room.rubric')}</div>
                <ul className="text-xs text-gray-600 list-disc list-inside space-y-0.5">
                  {project.rubric_criteria.map((c, i) => (
                    <li key={i}>{typeof c === 'string' ? (roomT.values[`rubric:${i}`] || c) : (c.title || c.name || JSON.stringify(c))}</li>
                  ))}
                </ul>
              </div>
            )}
            {evaluators.some(ev => (ev.rubrics || []).length > 0) && (
              <div className="mt-3 pt-3 border-t border-gray-100" data-testid="panel-evaluator-rubrics">
                <div className="text-xs font-semibold text-gray-700 mb-1 flex items-center gap-1">
                  <FileText className="w-3 h-3" /> {t('room.review.rubricsTitle')}
                </div>
                <ul className="space-y-1">
                  {evaluators.flatMap(ev => (ev.rubrics || []).map(rubric => (
                    <li key={rubric.id} className="flex items-center gap-2 text-xs text-gray-600" data-testid={`evaluator-rubric-${rubric.id}`}>
                      <PersonaAvatar avatar={ev.avatar} name={ev.name} size={18} />
                      <button
                        type="button"
                        onClick={() => downloadRubric(ev.id, rubric)}
                        className="flex items-center gap-1 text-blue-600 hover:underline truncate"
                        data-testid={`button-download-rubric-${rubric.id}`}
                      >
                        <Download className="w-3 h-3 shrink-0" />
                        <span className="truncate">{rubric.filename}</span>
                      </button>
                      {isStaff && rubric.visible_to_students === false && (
                        <span className="text-[10px] text-amber-600 inline-flex items-center gap-0.5">
                          <EyeOff className="w-2.5 h-2.5" /> {t('room.hidden')}
                        </span>
                      )}
                    </li>
                  )))}
                </ul>
              </div>
            )}
            {projectId && groupId && token && (
              <ProductFeedbackPanel
                projectId={projectId}
                groupId={groupId}
                token={token}
                disabled={isFinalized}
                onInfo={(m) => { setInfo(m); setTimeout(() => setInfo(null), 5000); }}
              />
            )}
            {isStaff && relationships.length > 0 && (
              <div className="mt-3 pt-3 border-t border-gray-100" data-testid="panel-relationships">
                <div className="text-xs font-semibold text-gray-700 mb-1 flex items-center gap-1">
                  <ShieldAlert className="w-3 h-3" /> {t('room.relationship.panelTitle')}
                </div>
                <p className="text-[10px] text-gray-400 mb-2">{t('room.relationship.panelHint')}</p>
                {relationships.length === 0 ? (
                  <p className="text-[11px] text-gray-400 italic">{t('room.relationship.noPersonas')}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead className="text-gray-500">
                        <tr>
                          <th className="text-left py-1 pr-2">Persona</th>
                          <th className="text-left py-1 pr-2">{t('room.relationship.colLabel')}</th>
                          <th className="text-left py-1 pr-2">{t('room.relationship.colHistory')}</th>
                          <th className="text-right py-1">{t('room.relationship.colActions')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {relationships.map(rel => {
                          return (
                            <tr key={rel.personaId} className="border-t border-gray-100 align-top" data-testid={`row-relationship-${rel.personaId}`}>
                              <td className="py-1 pr-2">
                                <PersonaAvatar avatar={rel.avatar} name={rel.personaName} size={16} className="mr-1" />
                                <span className="text-gray-800">{rel.personaName}</span>
                              </td>
                              <td className={`py-1 pr-2 ${RELATIONSHIP_BADGE[rel.key].text}`} data-testid={`text-relationship-level-${rel.personaId}`}>
                                {t(`room.relationship.label.${rel.key}`)}{rel.broken && <span className="ml-1">⛔</span>}
                              </td>
                              <td className="py-1 pr-2">
                                {!rel.history || rel.history.length === 0 ? (
                                  <span className="text-gray-400 italic">{t('room.relationship.noHistory')}</span>
                                ) : (
                                  <ul className="space-y-0.5">
                                    {rel.history.slice(0, 5).map((ev, i) => {
                                      const sourceKey = ev.source === 'staff_adjust' || ev.source === 'persona_chat_close'
                                        ? `room.relationship.eventSource.${ev.source}` : null;
                                      const lvl = (n?: number) => {
                                        const hit = RELATIONSHIP_LEVELS.find(x => x.level === n);
                                        return hit ? t(`room.relationship.label.${hit.key}`) : '';
                                      };
                                      return (
                                        <li key={i} className="text-gray-600">
                                          {ev.from !== undefined && ev.to !== undefined && (
                                            <span className="mr-1">{lvl(ev.from)} → {lvl(ev.to)}</span>
                                          )}
                                          <span className="text-gray-500">{sourceKey ? t(sourceKey) : (ev.source || '')}</span>
                                          {ev.note && <span className="text-gray-400"> — {ev.note}</span>}
                                          {ev.ts && (
                                            <span className="text-gray-300 ml-1">
                                              {new Date(ev.ts).toLocaleDateString(t('common.locale'), { day: 'numeric', month: 'short' })}
                                            </span>
                                          )}
                                        </li>
                                      );
                                    })}
                                  </ul>
                                )}
                              </td>
                              <td className="py-1 text-right">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setAdjustingPersona(rel);
                                    setAdjustLevel(rel.level);
                                    setAdjustNote('');
                                    setAdjustError(null);
                                  }}
                                  className="px-2 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 text-[10px]"
                                  data-testid={`button-adjust-relationship-${rel.personaId}`}
                                >
                                  {t('room.relationship.adjustBtn')}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
            {isStaff && consultations.length > 0 && (
              <div className="mt-3 pt-3 border-t border-gray-100" data-testid="panel-consultations">
                <div className="text-xs font-semibold text-gray-700 mb-2 flex items-center gap-1">
                  <MessageCircle className="w-3 h-3" /> {t('room.consultations.staffTitle')}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]">
                    <thead className="text-gray-500">
                      <tr>
                        <th className="text-left py-1 pr-2">Persona</th>
                        <th className="text-left py-1 pr-2">{t('room.consultations.colUsed')}</th>
                        <th className="text-left py-1 pr-2">{t('room.consultations.colExtra')}</th>
                        <th className="text-right py-1">{t('room.consultations.colActions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {consultations.map(c => {
                        const persona = personas.find(p => p.id === c.personaId);
                        const name = persona?.name || c.personaId;
                        return (
                          <tr key={c.personaId} className="border-t border-gray-100 align-top" data-testid={`row-consultations-${c.personaId}`}>
                            <td className="py-1 pr-2">
                              <PersonaAvatar avatar={persona?.avatar} name={name} size={16} className="mr-1" />
                              <span className="text-gray-800">{name}</span>
                            </td>
                            <td className="py-1 pr-2 font-mono" data-testid={`text-consultations-used-${c.personaId}`}>
                              {c.limit === null
                                ? `${c.used} / ${t('room.consultations.unlimited')}`
                                : `${c.used} / ${c.limit}`}
                              {c.blocked && <span className="ml-1 text-red-600">⛔</span>}
                            </td>
                            <td className="py-1 pr-2 font-mono">{c.extra > 0 ? `+${c.extra}` : '—'}</td>
                            <td className="py-1 text-right">
                              <button
                                type="button"
                                onClick={() => {
                                  setGrantingPersona({ personaId: c.personaId, personaName: name });
                                  setGrantExtra(c.extra > 0 ? c.extra + 1 : 1);
                                  setGrantNote('');
                                  setGrantError(null);
                                }}
                                className="px-2 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 text-[10px]"
                                data-testid={`button-grant-consultations-${c.personaId}`}
                              >
                                {t('room.consultations.grantBtn')}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {checkpoints.length > 0 && (
              <div className="mt-3 pt-3 border-t border-gray-100">
                <div className="text-xs font-semibold text-gray-700 mb-1 flex items-center gap-1">
                  <BookOpen className="w-3 h-3" /> {t('room.checkpointsCount', { count: String(checkpoints.length) })}
                </div>
                <ul className="space-y-1 text-xs">
                  {checkpoints.map(cp => (
                    <li key={cp.id} className="text-gray-600">
                      <span className={`inline-block px-1.5 rounded text-[10px] ${cp.kind === 'final' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                        {cp.kind === 'final' ? t('room.finalCheckpointLabel') : t('room.interimCheckpointLabel')}
                      </span>{' '}
                      <span className="text-gray-400">{new Date(cp.created_at).toLocaleDateString(t('common.locale'))}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            </div>
            )}

            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="fixed bottom-4 right-4 bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm" data-testid="text-error">
          {error}
          <button onClick={() => setError(null)} className="ml-2 font-bold">×</button>
        </div>
      )}
      {info && (
        <div className="fixed bottom-4 right-4 bg-green-50 border border-green-200 text-green-800 px-4 py-2 rounded-lg text-sm" data-testid="text-info">
          {info}
          <button onClick={() => setInfo(null)} className="ml-2 font-bold">×</button>
        </div>
      )}

      {/* Task #167 — Relatie corrigeren modal (staff) */}
      {adjustingPersona && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" data-testid="modal-adjust-relationship">
          <div className="bg-white rounded-2xl max-w-md w-full p-6">
            <h2 className="text-lg font-bold text-gray-900 mb-1">
              {t('room.relationship.adjustTitle', { name: adjustingPersona.personaName })}
            </h2>
            <p className="text-sm text-gray-600 mb-4">{t('room.relationship.adjustSub')}</p>
            <div className="space-y-3">
              <div>
                <label htmlFor="select-adjust-level" className="block text-xs font-medium text-gray-600 mb-1">
                  {t('room.relationship.levelLabel')}
                </label>
                <select
                  id="select-adjust-level"
                  value={adjustLevel}
                  onChange={e => setAdjustLevel(Number(e.target.value))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                  data-testid="select-adjust-level"
                >
                  {RELATIONSHIP_LEVELS.map(l => (
                    <option key={l.level} value={l.level}>{t(`room.relationship.label.${l.key}`)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  {t('room.relationship.noteLabel')}
                </label>
                <textarea
                  value={adjustNote}
                  onChange={e => setAdjustNote(e.target.value)}
                  rows={3}
                  placeholder={t('room.relationship.notePlaceholder')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  data-testid="input-adjust-note"
                />
              </div>
              {adjustError && (
                <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-xs" data-testid="text-adjust-error">
                  {adjustError}
                </div>
              )}
            </div>
            <div className="flex gap-2 justify-end mt-5">
              <button
                onClick={() => { setAdjustingPersona(null); setAdjustError(null); }}
                disabled={adjustSaving}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                data-testid="button-cancel-adjust"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={submitAdjust}
                disabled={adjustSaving || !adjustNote.trim() || adjustLevel === adjustingPersona.level}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
                data-testid="button-confirm-adjust"
              >
                {adjustSaving
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <ShieldAlert className="w-4 h-4" />}
                {adjustSaving ? t('room.relationship.saving') : t('room.relationship.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Task #252 — Extra raadplegingen toekennen modal (staff) */}
      {grantingPersona && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" data-testid="modal-grant-consultations">
          <div className="bg-white rounded-2xl max-w-md w-full p-6">
            <h2 className="text-lg font-bold text-gray-900 mb-1">
              {t('room.consultations.grantTitle', { name: grantingPersona.personaName })}
            </h2>
            <p className="text-sm text-gray-600 mb-4">{t('room.consultations.grantSub')}</p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  {t('room.consultations.grantExtraLabel')}
                </label>
                <input
                  type="number"
                  min={0}
                  max={1000}
                  step={1}
                  value={grantExtra}
                  onChange={e => setGrantExtra(Math.max(0, parseInt(e.target.value || '0', 10)))}
                  className="w-32 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"
                  data-testid="input-grant-extra"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  {t('room.consultations.grantNoteLabel')}
                </label>
                <textarea
                  value={grantNote}
                  onChange={e => setGrantNote(e.target.value)}
                  rows={3}
                  placeholder={t('room.consultations.grantNotePlaceholder')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  data-testid="input-grant-note"
                />
              </div>
              {grantError && (
                <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-xs" data-testid="text-grant-error">
                  {grantError}
                </div>
              )}
            </div>
            <div className="flex gap-2 justify-end mt-5">
              <button
                onClick={() => { setGrantingPersona(null); setGrantError(null); }}
                disabled={grantSaving}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                data-testid="button-cancel-grant"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={submitGrant}
                disabled={grantSaving}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
                data-testid="button-confirm-grant"
              >
                {grantSaving
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <MessageCircle className="w-4 h-4" />}
                {grantSaving ? t('room.consultations.grantSaving') : t('room.consultations.grantSave')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Task #252 — Bevestiging: nieuwe raadpleging starten */}
      {confirmConsult && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" data-testid="modal-confirm-consultation">
          <div className="bg-white rounded-2xl max-w-md w-full p-6">
            <h2 className="text-lg font-bold text-gray-900 mb-1">{t('room.consultations.confirmTitle')}</h2>
            <p className="text-sm text-gray-600 mb-4">
              {(confirmConsult.remaining ?? 0) <= 1
                ? t('room.consultations.confirmBodyLast', { limit: confirmConsult.limit ?? 0 })
                : t('room.consultations.confirmBody', {
                    remaining: Math.max(0, (confirmConsult.remaining ?? 0) - 1),
                    limit: confirmConsult.limit ?? 0,
                  })}
            </p>
            <div className="flex gap-2 justify-end mt-5">
              <button
                onClick={() => { setConfirmConsult(null); setPendingPersonaText(null); }}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
                data-testid="button-cancel-consultation"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => { const txt = pendingPersonaText ?? personaInput.trim(); setConfirmConsult(null); setPendingPersonaText(null); doSendPersona(txt); }}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
                data-testid="button-confirm-consultation"
              >
                <Send className="w-4 h-4" />
                {t('room.consultations.confirmStart')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Gesprek afsluiten modal */}
      {showCloseModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" data-testid="modal-close-conversation">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 max-h-[80vh] overflow-y-auto">
            <h2 className="text-lg font-bold text-gray-900 mb-1">{t('room.closeConversationTitle')}</h2>
            <p className="text-sm text-gray-600 mb-4">
              {t('room.closeConversationSub')}
            </p>

            {closeModalLoading && (
              <div className="flex flex-col items-center justify-center py-10 gap-3 text-gray-500">
                <Loader2 className="w-7 h-7 animate-spin text-blue-500" />
                <span className="text-sm">{t('room.creatingPreview')}</span>
              </div>
            )}

            {closeModalError && !closeModalLoading && (
              <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4" data-testid="text-close-modal-error">
                {closeModalError}
              </div>
            )}

            {!closeModalLoading && closePreviewData && (
              <div className="space-y-4">
                <div>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{t('room.topicsDiscussed')}</h3>
                  <ul className="space-y-1.5">
                    {closePreviewData.topics.map((t, i) => (
                      <li key={i} className="flex gap-2 text-sm text-gray-700">
                        <span className="text-blue-400 shrink-0">•</span>{t}
                      </li>
                    ))}
                  </ul>
                </div>
                {closePreviewData.agreements.length > 0 ? (
                  <div>
                    <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{t('room.agreed')}</h3>
                    <ul className="space-y-1.5">
                      {closePreviewData.agreements.map((a, i) => (
                        <li key={i} className="flex gap-2 text-sm text-gray-700">
                          <span className="text-green-500 shrink-0">✓</span>{a}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-xs text-gray-400 italic">{t('room.noAgreements')}</p>
                )}
              </div>
            )}

            <div className="flex gap-2 justify-end mt-6">
              <button
                onClick={() => setShowCloseModal(false)}
                disabled={closingConversation}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                data-testid="button-cancel-close-conversation"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={confirmClose}
                disabled={!closePreviewData || closingConversation}
                className="flex items-center gap-1.5 px-4 py-2 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700 disabled:opacity-50"
                data-testid="button-confirm-close-conversation"
              >
                {closingConversation
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <LogOut className="w-4 h-4" />}
                {closingConversation ? t('room.closing') : t('room.closeConversation')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Checkpoint modal */}
      {showCheckpointModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold text-gray-900 mb-1">
              {showCheckpointModal === 'final' ? t('room.checkpointTitleFinal') : t('room.checkpointTitleInterim')}
            </h2>

            {/* ── kind='final': reflectie-textarea (ongewijzigd) ── */}
            {showCheckpointModal === 'final' && (
              <>
                <p className="text-sm text-gray-600 mb-4">
                  {t('room.finalReflectionSub')}
                </p>
                <textarea
                  value={reflection}
                  onChange={e => setReflection(e.target.value)}
                  rows={10}
                  placeholder={t('room.reflectionPlaceholder')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  data-testid="textarea-reflection"
                />
                <div className="text-xs text-gray-400 mt-1">{reflection.trim().length} {t('room.characters')} · {t('room.minimum')} 20</div>
              </>
            )}

            {/* ── kind='checkpoint': AI-preview per gesprek ── */}
            {showCheckpointModal === 'checkpoint' && (
              <>
                <p className="text-sm text-gray-600 mb-4">
                  {t('room.checkpointSub')}
                </p>

                {checkpointPreviewLoading && (
                  <div className="flex flex-col items-center justify-center py-12 gap-3 text-gray-500" data-testid="checkpoint-preview-loading">
                    <Loader2 className="w-7 h-7 animate-spin text-blue-500" />
                    <span className="text-sm">{t('room.creatingSummaries')}</span>
                  </div>
                )}

                {checkpointPreviewError && !checkpointPreviewLoading && (
                  <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4" data-testid="checkpoint-preview-error">
                    {checkpointPreviewError}
                  </div>
                )}

                {!checkpointPreviewLoading && !checkpointPreviewError && checkpointPreview !== null && checkpointPreview.length === 0 && (
                  <p className="text-sm text-gray-500 italic py-4" data-testid="checkpoint-preview-empty">
                    {t('room.noConversationsToSummarise')}
                  </p>
                )}

                {!checkpointPreviewLoading && checkpointPreview && checkpointPreview.length > 0 && (
                  <div className="space-y-5" data-testid="checkpoint-preview-threads">
                    {checkpointPreview.map(thread => (
                      <div key={thread.threadId} className="border border-gray-200 rounded-xl p-4 bg-gray-50">
                        <div className="flex items-center gap-2 mb-3">
                          <PersonaAvatar avatar={personas.find(p => p.id === thread.personaId)?.avatar} name={thread.personaName} size={28} />
                          <span className="font-semibold text-gray-800 text-sm">{thread.personaName}</span>
                        </div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">{t('room.yourQuestions')}</label>
                        <textarea
                          value={thread.studentSummary}
                          onChange={e => updatePreviewSummary(thread.threadId, 'studentSummary', e.target.value)}
                          rows={3}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white mb-3 resize-none"
                          data-testid={`textarea-student-summary-${thread.threadId}`}
                        />
                        <label className="block text-xs font-medium text-gray-500 mb-1">{t('room.responseFrom', { name: thread.personaName })}</label>
                        <textarea
                          value={thread.personaSummary}
                          onChange={e => updatePreviewSummary(thread.threadId, 'personaSummary', e.target.value)}
                          rows={5}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white resize-none"
                          data-testid={`textarea-persona-summary-${thread.threadId}`}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {/* Cross-agent synthese — alleen als ≥ 2 afgesloten gesprekken */}
                {!checkpointPreviewLoading && checkpointSynthesis && (
                  <div className="mt-6 rounded-xl border border-indigo-200 bg-indigo-50/60 p-4" data-testid="checkpoint-synthesis">
                    <div className="flex items-center gap-2 mb-3">
                      <ScrollText className="w-4 h-4 text-indigo-600" />
                      <h3 className="font-semibold text-indigo-900 text-sm">{t('room.overviewAllConversations')}</h3>
                    </div>

                    {checkpointSynthesis.overeenstemming.length > 0 && (
                      <div className="mb-3">
                        <p className="text-[10px] font-semibold text-indigo-700 uppercase tracking-wide mb-1.5">{t('room.agreement')}</p>
                        <ul className="space-y-1">
                          {checkpointSynthesis.overeenstemming.map((item, i) => (
                            <li key={i} className="flex gap-2 text-xs text-gray-800">
                              <span className="text-indigo-500 shrink-0 mt-0.5">•</span>{item}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {checkpointSynthesis.spanningspunten.length > 0 && (
                      <div className="mb-3">
                        <p className="text-[10px] font-semibold text-amber-700 uppercase tracking-wide mb-1.5">{t('room.tensions')}</p>
                        <ul className="space-y-1">
                          {checkpointSynthesis.spanningspunten.map((item, i) => (
                            <li key={i} className="flex gap-2 text-xs text-gray-800">
                              <span className="text-amber-500 shrink-0 mt-0.5">⚡</span>{item}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {checkpointSynthesis.suggesties.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold text-green-700 uppercase tracking-wide mb-1.5">{t('room.suggestionsFollowup')}</p>
                        <ul className="space-y-1">
                          {checkpointSynthesis.suggesties.map((item, i) => (
                            <li key={i} className="flex gap-2 text-xs text-gray-800">
                              <span className="text-green-600 shrink-0 mt-0.5">→</span>{item}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {/* ── Bevestigingsscherm na tussentijds checkpoint ── */}
            {checkpointSaved && (
              <div className="mt-5 rounded-xl bg-blue-50 border border-blue-200 p-5 text-center" data-testid="checkpoint-saved-confirmation">
                <CheckCircle2 className="w-10 h-10 text-blue-500 mx-auto mb-3" />
                <p className="font-semibold text-gray-900 mb-1">{t('room.checkpointSaved')}</p>
                <p className="text-sm text-gray-600 mb-4">
                  {t('room.checkpointSavedSub')}
                </p>
                <button
                  onClick={() => { setShowCheckpointModal(null); setCheckpointSaved(false); }}
                  className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
                  data-testid="button-continue-after-checkpoint"
                >
                  {t('room.continueWithProject')}
                </button>
              </div>
            )}

            {!checkpointSaved && (
              <div className="flex gap-2 mt-5 justify-end">
                <button
                  onClick={() => { setShowCheckpointModal(null); setCheckpointSaved(false); setReflection(''); setCheckpointPreview(null); setCheckpointSynthesis(null); setCheckpointPreviewError(null); }}
                  className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg text-sm"
                  data-testid="button-cancel-checkpoint"
                >
                  {t('common.cancel')}
                </button>
                {/* Sla-knop: verberg bij lege preview of preview-fout */}
                {!(showCheckpointModal === 'checkpoint' && (checkpointPreviewError !== null || (checkpointPreview !== null && checkpointPreview.length === 0))) && (
                  <button
                    onClick={submitCheckpoint}
                    disabled={
                      submittingCheckpoint ||
                      checkpointPreviewLoading ||
                      (showCheckpointModal === 'final' && reflection.trim().length < 20)
                    }
                    className={`px-4 py-2 text-white rounded-lg text-sm disabled:opacity-40 ${showCheckpointModal === 'final' ? 'bg-green-600 hover:bg-green-700' : 'bg-blue-600 hover:bg-blue-700'}`}
                    data-testid="button-submit-checkpoint"
                  >
                    {submittingCheckpoint ? t('room.pleaseWait') : (showCheckpointModal === 'final' ? t('room.finaliseAndSave') : t('room.saveToJournal'))}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Inlever-dialoog projectproduct (Task #156) */}
      {showSubmitModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6">
            <h3 className="text-lg font-bold mb-2 flex items-center gap-2">
              <UploadCloud className="w-5 h-5 text-amber-600" /> {t('room.submission.modalTitle')}
            </h3>
            <p className="text-sm text-gray-600 mb-3">
              {t('room.submission.modalIntro')}
            </p>
            {submissions.length > 0 && (
              <div className="mb-3 p-3 bg-gray-50 border border-gray-200 rounded-lg" data-testid="current-submission">
                <div className="text-xs text-gray-500 mb-1">{t('room.submission.current')}</div>
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-gray-500" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{submissions[0].filename}</div>
                    <div className="text-[11px] text-gray-500">
                      {submissions[0].uploaded_by_name || submissions[0].uploaded_by_email
                        ? `${t('room.submission.uploadedBy', { name: String(submissions[0].uploaded_by_name || submissions[0].uploaded_by_email) })} · `
                        : ''}
                      {new Date(submissions[0].created_at).toLocaleString(t('common.locale'), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      {submissions[0].byte_size ? ` · ${Math.round(submissions[0].byte_size / 1024)} KB` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => downloadSubmission(submissions[0])}
                    className="p-1 text-blue-500 hover:bg-blue-50 rounded"
                    title={t('room.submission.downloadCurrent')}
                    data-testid="button-download-current-submission"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
            {submitError && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm mb-3" data-testid="text-submit-error">{submitError}</div>
            )}
            <input
              ref={submitFileRef}
              type="file"
              accept=".pdf,.docx,.pptx,.xlsx,.odt,.ods,.odp,.zip,.txt,.md,.markdown,.csv,.tsv,.json,.rtf,.jpg,.jpeg,.png,.html,.htm"
              onChange={e => { const f = e.target.files?.[0]; if (f) submitProduct(f); }}
              disabled={submitting}
              className="block w-full text-sm"
              data-testid="input-submit-file"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowSubmitModal(false)}
                disabled={submitting}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-40"
                data-testid="button-cancel-submit"
              >
                {t('common.close')}
              </button>
              {submitting && (
                <span className="inline-flex items-center gap-1.5 px-4 py-2 text-amber-700"><Loader2 className="w-4 h-4 animate-spin" /> {t('courseInfo.uploading')}</span>
              )}
            </div>
          </div>
        </div>
      )}

      {viewerDoc && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-stretch justify-center p-2 sm:p-6" role="dialog" aria-modal="true" data-testid="dialog-persona-source">
          <div className="chic-card w-full max-w-5xl flex flex-col overflow-hidden p-0">
            <ViewerErrorBoundary
              key={viewerDoc.documentId}
              documentId={viewerDoc.documentId}
              labels={{
                closeViewer: t('docViewer.closeViewer'),
                cannotDisplay: t('docViewer.cannotDisplay'),
                downloadInstead: t('docViewer.downloadInstead'),
              }}
              onClose={() => setViewerDoc(null)}
            >
              <Suspense fallback={<div className="p-6 text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />{t('common.loading')}</div>}>
                <DocumentViewer
                  documentId={viewerDoc.documentId}
                  title={viewerDoc.title}
                  lang={lang as 'nl' | 'en'}
                  initialPage={viewerDoc.page}
                  openSeq={viewerDoc.seq}
                  onClose={() => setViewerDoc(null)}
                />
              </Suspense>
            </ViewerErrorBoundary>
          </div>
        </div>
      )}
    </div>
  );
}

export default ProjectRoomPage;
