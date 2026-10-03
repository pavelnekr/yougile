import { useState, type FormEvent } from "react";
import { ArrowRight, Eye, EyeOff, LockKeyhole, ShieldCheck, Sparkles } from "lucide-react";

export default function LoginPage({ onPreview }: { onPreview: () => void }) {
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [notice, setNotice] = useState("");

  const submitLogin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice("Проверка логина и пароля ещё не подключена. Сейчас можно открыть портал в режиме предварительного просмотра.");
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
              <label className="login-remember"><input type="checkbox" /> <span>Запомнить меня</span></label>
              <span className="login-reset-unavailable">Забыли пароль?</span>
            </div>
            <button className="login-submit" type="submit">Войти <ArrowRight size={16} /></button>
            {notice && <p className="login-notice" role="status">{notice}</p>}
          </form>

          <div className="login-preview">
            <span>Пока настраивается вход?</span>
            <button type="button" onClick={onPreview}>Открыть предварительный просмотр <ArrowRight size={14} /></button>
          </div>
          <p className="login-form-footer">Доступ предоставляется администратором рабочего пространства.</p>
        </div>
      </section>
    </main>
  );
}
