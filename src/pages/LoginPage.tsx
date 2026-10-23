import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { Mail, Lock, LogIn, KeyRound, User, BookOpen } from 'lucide-react';
import { fetchOpenCourses, registerOpen, isVuEmail, EnrollmentError, type OpenCourse } from '../services/enrollment.service';
import { supabase } from '../lib/supabase';
import { useLanguage } from '../i18n';
import { EmailCodeLogin } from '../components/EmailCodeLogin';
import type { TranslationKey } from '../i18n/translations';

// Mapt een ruwe auth-foutmelding naar een i18n-sleutel met een nette,
// gebruikersvriendelijke melding. Geeft `null` terug als er geen specifieke
// vertaling is, zodat de aanroeper de ruwe melding kan tonen.
export function mapAuthErrorToKey(message: string): TranslationKey | null {
  if (message.includes('Invalid login credentials')) {
    return 'login.err.invalidCredentials';
  }
  if (message.includes('User already registered')) {
    return 'login.err.alreadyRegistered';
  }
  if (message.includes('Email not confirmed')) {
    return 'login.err.emailNotConfirmed';
  }
  return null;
}

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Registratie-modus: toont naast e-mail/wachtwoord ook het naam-veld.
  const [isSignUp, setIsSignUp] = useState(false);
  const [fullName, setFullName] = useState('');
  const [signUpSuccess, setSignUpSuccess] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Wachtwoord-vergeten-modus: toont een apart e-mailformulier i.p.v. login.
  const [isForgot, setIsForgot] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  // Inloggen met een code per e-mail (wie via Canvas in LEAP kwam, server/lti.js).
  const [isCode, setIsCode] = useState(false);
  // Na het zelf verwijderen van een account (Mijn gegevens) een bevestiging tonen.
  const [accountDeleted] = useState(() => typeof window !== 'undefined' && (window.history.state as { usr?: { notice?: string } } | null)?.usr?.notice === 'accountDeleted');
  const { signIn } = useAuth();
  const { t, lang, setLang } = useLanguage();
  // Open registratie (server/enrollment.js): de nieuwe gebruiker kiest één of
  // meer cursussen die open zijn voor aanmelding.
  const [openCourses, setOpenCourses] = useState<OpenCourse[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  useEffect(() => {
    if (!isSignUp || openCourses) return;
    fetchOpenCourses().then(setOpenCourses).catch(() => setOpenCourses([]));
  }, [isSignUp, openCourses]);
  const toggleCourse = (id: string) => setChosen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const handleForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      // Stuur altijd een neutrale bevestiging, ongeacht of het adres bestaat,
      // zodat we niet onthullen welke e-mailadressen geregistreerd zijn.
      await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
    } catch (err) {
      console.error('Reset email error:', err);
    } finally {
      setForgotSent(true);
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSignUpSuccess(false);
    setLoading(true);
    try {
      if (isSignUp) {
        if (!fullName.trim()) {
          setError(t('login.err.nameRequired'));
          setLoading(false);
          return;
        }
        if (isVuEmail(email)) {
          setError(t('login.err.vuEmail'));
          setLoading(false);
          return;
        }
        if (password.length < 6) {
          setError(t('login.err.passwordTooShort'));
          setLoading(false);
          return;
        }
        if (chosen.length === 0) {
          setError(t('login.err.courseRequired'));
          setLoading(false);
          return;
        }
        try {
          await registerOpen({ fullName: fullName.trim(), email: email.trim(), password, courseIds: chosen });
        } catch (regErr) {
          if (regErr instanceof EnrollmentError && regErr.code === 'alreadyRegistered') throw new Error('User already registered');
          throw regErr;
        }
        setChosen([]);
        // Met e-mailbevestiging aan komt er geen sessie terug en navigeert de
        // app niet weg: toon een bevestiging en schakel terug naar inloggen.
        setSignUpSuccess(true);
        setIsSignUp(false);
        setPassword('');
      } else {
        await signIn(email, password);
      }
    } catch (err: any) {
      console.error('Auth error:', err);
      const errorMessage = err.message || t('login.err.generic');
      const mappedKey = mapAuthErrorToKey(errorMessage);
      setError(mappedKey ? t(mappedKey) : errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const subtitle = isForgot
    ? t('login.forgotSubtitle')
    : isSignUp
    ? t('login.signUpSubtitle')
    : t('login.signInSubtitle');

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-green-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-xl p-8 border border-gray-100">
          <div className="flex flex-col items-center mb-8">
            <img src="/leap-vu-logo.png" alt="LEAP-VU logo" className="h-24 w-auto mb-4" />
            <h1 className="text-2xl font-bold text-gray-900 mb-2 text-center">
              LEAP-VU
            </h1>
            <p className="text-gray-600 text-center">
              {subtitle}
            </p>
            {/* Language toggle on login page */}
            <button
              data-testid="button-lang-toggle-login"
              onClick={() => setLang(lang === 'nl' ? 'en' : 'nl')}
              className="mt-3 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors border border-gray-200"
            >
              <span>{lang === 'nl' ? '🇳🇱 NL' : '🇬🇧 EN'}</span>
              <span>→</span>
              <span>{lang === 'nl' ? '🇬🇧 EN' : '🇳🇱 NL'}</span>
            </button>
          </div>

          {isCode ? (
            <EmailCodeLogin onCancel={() => setIsCode(false)} onDone={() => { /* de inlogpagina stuurt zelf door zodra je bent ingelogd */ }} />
          ) : isForgot ? (
            forgotSent ? (
              <div className="space-y-5">
                <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-lg text-sm" data-testid="text-forgot-sent">
                  {t('login.forgotSent')}
                </div>
                <button
                  onClick={() => { setIsForgot(false); setForgotSent(false); setError(''); }}
                  className="w-full text-blue-600 hover:text-blue-700 font-medium transition-colors"
                  data-testid="button-back-to-login"
                >
                  {t('login.backToLogin')}
                </button>
              </div>
            ) : (
              <form onSubmit={handleForgotSubmit} className="space-y-5">
                <div>
                  <label htmlFor="forgot-email" className="block text-sm font-semibold text-gray-700 mb-2">
                    {t('login.email')}
                  </label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <input
                      id="forgot-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full pl-11 pr-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none"
                      placeholder={t('login.emailPlaceholder')}
                      required
                      data-testid="input-forgot-email"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-gradient-to-r from-blue-500 to-green-500 text-white font-semibold py-3 rounded-lg hover:from-blue-600 hover:to-green-600 transition-all shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  data-testid="button-send-reset"
                >
                  {loading ? (
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <>
                      <KeyRound className="w-5 h-5" />
                      {t('login.forgotSendBtn')}
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => { setIsForgot(false); setError(''); }}
                  className="w-full text-blue-600 hover:text-blue-700 font-medium transition-colors"
                  data-testid="button-cancel-forgot"
                >
                  {t('login.backToLogin')}
                </button>
              </form>
            )
          ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            {accountDeleted && (
              <div className="rounded-lg border border-accent-200 bg-accent-50 px-4 py-3 text-sm text-accent-800" role="status" data-testid="text-account-deleted">
                {t('myData.delete.done')}
              </div>
            )}
            {isSignUp && (
              <div>
                <label htmlFor="fullName" className="block text-sm font-semibold text-gray-700 mb-2">
                  {t('login.fullName')}
                </label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                  <input
                    id="fullName"
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className="w-full pl-11 pr-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none"
                    placeholder={t('login.fullNamePlaceholder')}
                    required
                    data-testid="input-fullname"
                  />
                </div>
              </div>
            )}

            <div>
              <label htmlFor="email" className="block text-sm font-semibold text-gray-700 mb-2">
                {t('login.email')}
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-11 pr-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none"
                  placeholder={t('login.emailPlaceholder')}
                  required
                  data-testid="input-email"
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-semibold text-gray-700 mb-2">
                {t('login.password')}
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-11 pr-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none"
                  placeholder="••••••••"
                  required
                  minLength={6}
                  data-testid="input-password"
                />
              </div>
            </div>

            {isSignUp && (
              <fieldset data-testid="fieldset-signup-courses">
                <legend className="block text-sm font-semibold text-gray-700 mb-1">{t('login.coursesLabel')}</legend>
                <p className="text-xs text-gray-500 mb-2">{t('login.coursesHint')}</p>
                {openCourses === null ? (
                  <p className="text-sm text-gray-500">{t('common.loading')}</p>
                ) : openCourses.length === 0 ? (
                  <p className="text-sm text-amber-700" data-testid="text-no-open-courses">{t('login.noOpenCourses')}</p>
                ) : (
                  <ul className="max-h-48 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-100">
                    {openCourses.map((c) => (
                      <li key={c.id}>
                        <label className="flex items-start gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50">
                          <input type="checkbox" className="mt-1" checked={chosen.includes(c.id)} onChange={() => toggleCourse(c.id)} data-testid={`checkbox-signup-course-${c.id}`} />
                          <span className="min-w-0">
                            <span className="flex items-center gap-1.5 text-sm font-medium text-gray-900"><BookOpen className="w-3.5 h-3.5 text-blue-600 shrink-0" />{c.name}</span>
                            {c.description && <span className="block text-xs text-gray-500">{c.description}</span>}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-gray-500 mt-2">{t('login.vuNotice')}</p>
              </fieldset>
            )}

            {signUpSuccess && (
              <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-lg text-sm" data-testid="text-signup-success">
                {t('login.signUpSuccess')}
              </div>
            )}

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm" data-testid="text-login-error">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || (isSignUp && openCourses !== null && openCourses.length === 0)}
              className="w-full bg-gradient-to-r from-blue-500 to-green-500 text-white font-semibold py-3 rounded-lg hover:from-blue-600 hover:to-green-600 transition-all shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              data-testid="button-login"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <LogIn className="w-5 h-5" />
                  {isSignUp ? t('login.signUpBtn') : t('login.loginBtn')}
                </>
              )}
            </button>

            <div className="space-y-3 text-center">
              <button
                type="button"
                onClick={() => {
                  setIsSignUp((prev) => !prev);
                  setError('');
                  setSignUpSuccess(false);
                }}
                className="block w-full text-sm text-blue-600 hover:text-blue-700 font-medium transition-colors"
                data-testid="button-toggle-signup"
              >
                {isSignUp ? t('login.switchToSignIn') : t('login.switchToSignUp')}
              </button>

              {!isSignUp && (
                <button
                  type="button"
                  onClick={() => { setIsForgot(true); setForgotSent(false); setError(''); setSignUpSuccess(false); }}
                  className="block w-full text-sm text-blue-600 hover:text-blue-700 font-medium transition-colors"
                  data-testid="button-forgot-password"
                >
                  {t('login.forgotLink')}
                </button>
              )}

              {!isSignUp && (
                <button
                  type="button"
                  onClick={() => { setIsCode(true); setError(''); setSignUpSuccess(false); }}
                  className="block w-full text-sm text-blue-600 hover:text-blue-700 font-medium transition-colors"
                  data-testid="button-code-login"
                >
                  {t('login.code.link')}
                </button>
              )}
            </div>
          </form>
          )}
        </div>
      </div>
    </div>
  );
}
