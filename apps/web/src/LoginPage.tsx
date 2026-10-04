import { useState, type FormEvent } from "react";
import { ArrowRight, Eye, EyeOff, LockKeyhole, ShieldCheck, Sparkles, UserPlus } from "lucide-react";
import { apiFetch } from "./apiClient";

export type PortalUser = {
  id: string;
  login: string;
  displayName: string;
  role: string;
};

type Mode = "login" | "register";

const minPasswordLength = 8;

export default function LoginPage({
  onAuthenticated
}: {
  onAuthenticated: (user: PortalUser) => void;
}) {
  const [mode, setMode] = useState<Mode>("login");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const switchMode = () => {
    if (submitting) return;
    setMode((current) => (current === "login" ? "register" : "login"));
    setError("");
    setNotice("");
  };

  const submitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    const form = event.currentTarget;
    const formData = new FormData(form);
    setSubmitting(true);
    setError("");
    setNotice("");

    try {
      // Cookie сессии проставляет apiFetch: credentials: "same-origin" по умолчанию.
      const response = await apiFetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

  const submitRegister = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    const form = event.currentTarget;
    const formData = new FormData(form);
    const password = String(formData.get("password") ?? "");
    const passwordRepeat = String(formData.get("passwordRepeat") ?? "");

    if (password.length < minPasswordLength) {
      setError(`Пароль должен быть не короче ${minPasswordLength} символов.`);
      return;
    }
    if (password !== passwordRepeat) {
      setError("Пароли не совпадают.");
      return;
    }

    setSubmitting(true);
    setError("");
    setNotice("");

    try {
      const response = await apiFetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          login: String(formData.get("username") ?? ""),
          displayName: String(formData.get("displayName") ?? "").trim() || undefined,
          password,
          registrationKey: String(formData.get("registrationKey") ?? "")
        })
      });
      const data = await response.json() as { user?: PortalUser; error?: string };

      if (!response.ok || !data.user) {
        setError(data.error ?? "Не удалось зарегистрироваться.");
        return;
      }

      // Сессия выдаётся сразу после регистрации, вводить пароль ещё раз не нужно.
      form.reset();
      onAuthenticated(data.user);
    } catch {
      setError("Не удалось связаться с сервером. Проверьте, что API запущен.");
    } finally {
      setSubmitting(false);
    }
  };

  const passwordField = (name: string, autoComplete: string, placeholder: string, enterKeyHint: "next" | "go" = "next") => (
    <span className="login-password-wrap">
      <input name={name} type={passwordVisible ? "text" : "password"} autoComplete={autoComplete} autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint={enterKeyHint} placeholder={placeholder} required />
      <button
        className="login-password-toggle"
        type="button"
        aria-label={passwordVisible ? "Скрыть пароль" : "Показать пароль"}
        onClick={() => setPasswordVisible((visible) => !visible)}
      >
        {passwordVisible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </span>
  );

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
            <span className="login-lock-icon">{mode === "login" ? <LockKeyhole size={19} /> : <UserPlus size={19} />}</span>
            <span className="login-form-eyebrow">{mode === "login" ? "С ВОЗВРАЩЕНИЕМ" : "НОВЫЙ АККАУНТ"}</span>
            <h2>{mode === "login" ? "Войдите в аккаунт" : "Регистрация в портале"}</h2>
            <p>{mode === "login"
              ? "Введите свои данные для доступа к рабочему пространству."
              : "Придумайте логин и пароль, ключ регистрации выдаёт администратор."}</p>
          </div>

          {mode === "login" ? (
            <form className="login-form" onSubmit={submitLogin}>
              <label className="login-field">
                <span>Логин</span>
                <input name="username" type="text" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="next" placeholder="Введите логин" required />
              </label>
              <label className="login-field">
                <span>Пароль</span>
                {passwordField("password", "current-password", "Введите пароль", "go")}
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
          ) : (
            <form className="login-form" onSubmit={submitRegister}>
              <label className="login-field">
                <span>Логин</span>
                <input name="username" type="text" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="next" placeholder="Придумайте логин" minLength={3} required />
              </label>
              <label className="login-field">
                <span>Имя пользователя</span>
                <input name="displayName" type="text" autoComplete="name" autoCapitalize="words" enterKeyHint="next" placeholder="Как вас показывать в портале" />
              </label>
              <label className="login-field">
                <span>Пароль</span>
                {passwordField("password", "new-password", `Не короче ${minPasswordLength} символов`)}
              </label>
              <label className="login-field">
                <span>Повторите пароль</span>
                {passwordField("passwordRepeat", "new-password", "Ещё раз для проверки")}
              </label>
              <label className="login-field">
                <span>Ключ регистрации</span>
                {passwordField("registrationKey", "off", "Ключ от администратора", "go")}
                <small className="login-field-hint">Без правильного ключа регистрация не пройдёт.</small>
              </label>
              <button className="login-submit" type="submit" disabled={submitting}>
                {submitting ? "Создаём аккаунт…" : <>Зарегистрироваться <ArrowRight size={16} /></>}
              </button>
              {error && <p className="login-notice login-notice-error" role="alert">{error}</p>}
              {notice && <p className="login-notice" role="status">{notice}</p>}
            </form>
          )}

          <button className="login-mode-switch" type="button" onClick={switchMode} disabled={submitting}>
            {mode === "login" ? <>Нет учётной записи? <strong>Зарегистрироваться</strong></> : <>Уже есть учётная запись? <strong>Войти</strong></>}
          </button>
          <p className="login-form-footer">
            {mode === "login"
              ? "Доступ предоставляется администратором рабочего пространства."
              : "Ключ регистрации выдаёт администратор рабочего пространства."}
          </p>
        </div>
      </section>
    </main>
  );
}
