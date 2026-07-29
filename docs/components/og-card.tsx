import { generate as DefaultImage } from 'fumadocs-ui/og';

interface OgCardProps {
  title: string;
  description: string;
}

function NatuiGlyph() {
  return (
    <svg width={52} height={52} viewBox="0 0 501 490" fill="none">
      <path
        d="M45 345.5V145.5C45 89.9954 89.9954 45 145.5 45C201.005 45 246 89.9954 246 145.5V245.5V345.5C246 400.452 290.548 445 345.5 445C400.452 445 445 400.452 445 345.5V245.5"
        stroke="#e94f37"
        strokeWidth="90"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="445.5" cy="99.5" r="55" fill="#e94f37" />
    </svg>
  );
}

export function OgCard({ title, description }: OgCardProps) {
  return (
    <DefaultImage
      title={title}
      description={description}
      site="NatUI"
      primaryColor="rgba(233, 79, 55, 0.38)"
      primaryTextColor="#e94f37"
      icon={<NatuiGlyph />}
    />
  );
}
