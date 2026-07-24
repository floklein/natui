import { generate as DefaultImage } from 'fumadocs-ui/og';

interface OgCardProps {
  title: string;
  description: string;
}

function NativeWindowMark() {
  return (
    <div
      style={{
        display: 'flex',
        width: 58,
        height: 58,
        flexDirection: 'column',
        overflow: 'hidden',
        border: '2px solid #e94f37',
        borderRadius: 12,
        backgroundColor: '#171717',
      }}
    >
      <div
        style={{
          display: 'flex',
          height: 17,
          alignItems: 'center',
          gap: 4,
          paddingLeft: 7,
          borderBottom: '2px solid rgba(233, 79, 55, 0.45)',
        }}
      >
        <span style={{ width: 5, height: 5, borderRadius: 99, backgroundColor: '#ff5f57' }} />
        <span style={{ width: 5, height: 5, borderRadius: 99, backgroundColor: '#febc2e' }} />
        <span style={{ width: 5, height: 5, borderRadius: 99, backgroundColor: '#28c840' }} />
      </div>
      <div
        style={{
          display: 'flex',
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          color: '#e94f37',
          fontSize: 21,
          fontWeight: 800,
        }}
      >
        N
      </div>
    </div>
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
      icon={<NativeWindowMark />}
    />
  );
}
