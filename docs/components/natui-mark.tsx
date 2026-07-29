export function NatuiMark({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 501 490"
      fill="none"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M45 345.5V145.5C45 89.9954 89.9954 45 145.5 45C201.005 45 246 89.9954 246 145.5V245.5V345.5C246 400.452 290.548 445 345.5 445C400.452 445 445 400.452 445 345.5V245.5"
        stroke="currentColor"
        strokeWidth="90"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="445.5" cy="99.5" r="55" fill="currentColor" />
    </svg>
  );
}
