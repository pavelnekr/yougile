import { ArrowRight, FileText, Settings2 } from "lucide-react";
import type { Section } from "./router.js";
import { PORTAL_VERSION } from "./version";

/** Главная страница пространства «Согласование/Оповещение». */
export default function CoordinationLandingPage({ onNavigate }: { onNavigate: (section: Section) => void }) {
  return (
    <section className="section-view coordination-landing-page">
      <div className="eyebrow"><span className="eyebrow-line" /> ПИСЬМО СОГЛАСОВАНИЯ АВР · ОТПРАВКА ПО SMTP</div>
      <div className="sites-page-heading">
        <div>
          <h1>Согласование/Оповещение</h1>
          <p>Сценарии отправки писем: DOCX-план работ превращается в письмо согласования АВР и уходит получателям по SMTP.</p>
        </div>
      </div>

      <section className="actions-grid coordination-landing-grid" aria-label="Сценарии раздела">
        <button className="action-card" onClick={() => onNavigate("Согласование АВР")}>
          <div className="action-card-top">
            <span className="action-icon blue"><FileText size={19} /></span>
            <span className="action-number">01</span>
          </div>
          <h3>Согласование АВР</h3>
          <p>Загрузите DOCX-план работ и укажите регион, подрядчика и день работ. Портал проверит предпросмотр письма и отправит его получателям.</p>
          <span className="action-link">Открыть сценарий <ArrowRight size={15} /></span>
        </button>
      </section>

      <div className="coordination-landing-divider" aria-hidden="true" />

      <h2 className="coordination-settings-group-title">Настройки рабочего пространства</h2>

      <section className="actions-grid coordination-landing-grid" aria-label="Настройки раздела">
        <button className="action-card" onClick={() => onNavigate("Настройки согласования")}>
          <div className="action-card-top">
            <span className="action-icon orange"><Settings2 size={19} /></span>
          </div>
          <h3>Настройки</h3>
          <p>Управляйте получателями писем и шаблоном письма для сценариев этого пространства.</p>
          <span className="action-link">Открыть настройки <ArrowRight size={15} /></span>
        </button>
      </section>

      <footer className="page-footer">
        <span>YouGile Operations Portal <span className="footer-version">{PORTAL_VERSION}</span></span>
        <span>Параметры SMTP задаются в конфигурации портала, отправка журналируется</span>
      </footer>
    </section>
  );
}
