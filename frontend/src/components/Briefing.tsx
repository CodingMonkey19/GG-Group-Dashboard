interface Props {
  eyebrow: string;
  title: string;
  lede: string;
}

export function Briefing({ eyebrow, title, lede }: Props): JSX.Element {
  return (
    <section className="briefing">
      <div className="briefing__eyebrow">{eyebrow}</div>
      <h1 className="briefing__title">{title}</h1>
      <p className="briefing__lede">{lede}</p>
    </section>
  );
}
