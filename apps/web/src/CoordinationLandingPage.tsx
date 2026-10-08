import { ArrowRight, FileText } from "lucide-react";
import type { Section } from "./router.js";
import { PORTAL_VERSION } from "./version";

/**
 * Страница раздела «Согласование/Оповещение»: карточки сценариев, как на обзоре.
 * Пока сценарий один — «Согласование АВР», он открывает подраздел
 * `/coordination/avr` со страницей письма.
 */
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

      <footer className="page-footer">
        <span>YouGile Operations Portal <span className="footer-version">{PORTAL_VERSION}</span></span>
        <span>Получатели настраиваются в разделе «Конфигурация портала», отправка журналируется</span>
      </footer>
    </section>
  );
}