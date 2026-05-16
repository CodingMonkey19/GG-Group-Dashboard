import type { ReactNode } from 'react';

export interface PanelLegendItem {
  label: string;
  cls: string;
}

interface Props {
  title: string;
  subtitle?: string;
  legend?: PanelLegendItem[];
  children: ReactNode;
}

export function Panel({ title, subtitle, legend, children }: Props): JSX.Element {
  return (
    <section className="panel">
      <header className="panel__head">
        <div className="panel__titles">
          <h2 className="panel__title">{title}</h2>
          {subtitle && <span className="panel__subtitle">{subtitle}</span>}
        </div>
        {legend && (
          <div className="legend" aria-label={`${title} legend`}>
            {legend.map((item) => (
              <span key={item.label} className="legend__item">
                <span className={`legend__dot ${item.cls}`} />
                {item.label}
              </span>
            ))}
          </div>
        )}
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}
