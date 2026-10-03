import { useState, type FormEvent } from "react";
import { ArrowRight, Eye, EyeOff, LockKeyhole, ShieldCheck, Sparkles } from "lucide-react";

export type PortalUser = {
  id: string;
  login: string;
  displayName: string;
  role: string;
};

export default function LoginPage({
  onAuthenticated
}: {
  onAuthenticated: (user: PortalUser) => void;
}) {
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const submitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    const form = event.currentTarget;
    const formData = new FormData(form);
    setSubmitting(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // credentials: "include" обязателен, иначе cookie сессии не сохранится.
        credentials: "include",
        body: JSON.stringify({
          login: String(formData.get("username") ?? ""),
          password: String(formData.get("password") ?? ""),
          rememberMe
        })
      });
      const data = await response.json() as { user?: PortalUser; error?: string };

      if (!response.ok || !data.user) {
        setError(data.error ?? "Не удалось войти в портал.");
        return;
      }

      // Пароль сразу вычищаем из формы, чтобы он не оставался в DOM.
      form.reset();
      onAuthenticated(data.user);
    } catch {
      setError("Не удалось связаться с сервером. Проверьте, что API запущен.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-brand-panel">
        <a className="login-brand" href="#" onClick={(event) => event.preventDefault()}>
          <span className="brand-mark"><span /><span /><span /><span /></span>
          <span className="brand-copy"><strong>yougile</strong><small>OPERATIONS PORTAL</small></span>
        </a>
        <div className="login-brand-content">
          <span className="login-overline"><Sparkles size={14} /> РАБОЧЕЕ ПРОСТРАНСТВО</span>
          <h1>Рабочие процессы<br />под контролем.</h1>
          <p>Назначения, аудит и история операций YouGile — в одном рабочем пространстве.</p>
          <div className="login-security-note"><ShieldCheck size={17} /><span><strong>Доступ к порталу</strong><small>Используйте учётную запись рабочего пространства.</small></span></div>
        </div>
        <span className="login-brand-footer">YOUGILE OPERATIONS PORTAL <span>·</span> v0.1</span>
        <span className="login-decoration login-decoration-one" />
        <span className="login-decoration login-decoration-two" />
      </section>

      <section className="login-form-panel">
        <div className="login-form-wrap">
          <div className="login-mobile-brand">
            <span className="brand-mark"><span /><span /><span /><span /></span>
            <span className="brand-copy"><strong>yougile</strong><small>OPERATIONS PORTAL</small></span>
          </div>
          <div className="login-heading">
            <span className="login-lock-icon"><LockKeyhole size={19} /></span>
            <span className="login-form-eyebrow">С ВОЗВРАЩЕНИЕМ</span>
            <h2>Войдите в аккаунт</h2>
            <p>Введите свои данные для доступа к рабочему пространству.</p>
          </div>

          <form className="login-form" onSubmit={submitLogin}>
            <label className="login-field">
              <span>Логин</span>
              <input name="username" type="text" autoComplete="username" placeholder="Введите логин" required />
            </label>
            <label className="login-field">
              <span>Пароль</span>
              <span className="login-password-wrap">
                <input name="password" type={passwordVisible ? "text" : "password"} autoComplete="current-password" placeholder="Введите пароль" required />
                <button
                  className="login-password-toggle"
                  type="button"
                  aria-label={passwordVisible ? "Скрыть пароль" : "Показать пароль"}
                  onClick={() => setPasswordVisible((visible) => !visible)}
                >
                  {passwordVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </span>
            </label>
            <div className="login-form-options">
              <label className="login-remember"><input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} /> <span>Запомнить меня</span></label>
              <span className="login-reset-unavailable">Забыли пароль?</span>
            </div>
            <button className="login-submit" type="submit" disabled={submitting}>
              {submitting ? "Проверяем…" : <>Войти <ArrowRight size={16} /></>}
            </button>
            {error && <p className="login-notice login-notice-error" role="alert">{error}</p>}
            {notice && <p className="login-notice" role="status">{notice}</p>}
          </form>

          <p className="login-form-footer">Доступ предоставляется администратором рабочего пространства.</p>
        </div>
      </section>
    </main>
  );
}
