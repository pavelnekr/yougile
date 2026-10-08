import type { LucideIcon } from "lucide-react";
import { Wrench } from "lucide-react";
import { PORTAL_VERSION } from "./version";

/**
 * Заглушка для разделов, которые ещё не реализованы.
 *
 * Показывает название раздела, краткое описание и явную пометку
 * «Раздел в разработке» вместо пустой страницы или ошибки.
 */
export default function UnderDevelopmentPage({
  icon: Icon,
  title,
  description
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <section className="section-view">
      <div className="eyebrow"><span className="eyebrow-line" /> РАБОЧЕЕ ПРОСТРАНСТВО</div>
      <div className="section-hero">
        <span className="section-hero-icon"><Icon size={22} /></span>
        <div><h1>{title}</h1><p>{description}</p></div>
      </div>
      <div className="panel section-panel under-dev-panel">
        <span className="under-dev-badge">В РАЗРАБОТКЕ</span>
        <span className="under-dev-icon"><Wrench size={24} /></span>
        <h2>Раздел находится в разработке</h2>
        <p>Сценарий ещё не перенесён в портал. Когда раздел будет готов, здесь появятся его шаги и данные.</p>
      </div>
      <footer className="page-footer">
        <span>YouGile Operations Portal <span className="footer-version">{PORTAL_VERSION}</span></span>
        <span>Раздел готовится к запуску</span>
      </footer>
    </section>
  );
}