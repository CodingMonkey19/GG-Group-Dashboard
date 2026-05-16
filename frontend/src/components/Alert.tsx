import type { ReactNode } from 'react';

export type AlertTone = 'err' | 'warn' | 'info';

interface Props {
  tone: AlertTone;
  title: string;
  children: ReactNode;
}

export function Alert({ tone, title, children }: Props): JSX.Element {
  const icon = tone === 'err' ? '!' : tone === 'warn' ? '!' : 'i';
  return (
    <div className={`alert alert--${tone}`}>
      <span className="alert__icon" aria-hidden="true">
        {icon}
      </span>
      <div className="alert__body">
        <div className="alert__title">{title}</div>
        <div className="alert__msg">{children}</div>
      </div>
    </div>
  );
}
