import { useId } from 'react';

const FUR = '#C99661';
const INK = '#171210';
const BOBO_WHITE = '#FFFFFF';
const BOBO_SHADE = '#EAE6DC';
const BUTTER = '#F2CA62';
const NAVY = '#1E3158';
const CUP_RED = '#C83D33';

function CrayonFilterDef({ id, scale = 1.9 }: { id: string; scale?: number }) {
  return (
    <defs>
      <filter id={id} x="-10%" y="-10%" width="120%" height="120%">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.62"
          numOctaves="4"
          seed="7"
          result="noise"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="noise"
          scale={Math.min(2.1, scale)}
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </defs>
  );
}

/**
 * Compact Dinotaeng Quokka + BOBO Vector Avatar Badge (100% lineless high-freq pastel filter)
 */
export function QuokkaRecorderMiniBadge({
  isRecording = false,
  className = 'w-11 h-11',
}: {
  isRecording?: boolean;
  className?: string;
}) {
  const uid = useId().replace(/:/g, '');
  const filterId = `crayon_${uid}`;
  return (
    <svg viewBox="0 0 96 96" className={className} aria-hidden="true">
      <CrayonFilterDef id={filterId} />
      <rect x="2" y="2" width="92" height="92" rx="26" fill="#DEDCD3" />
      <g filter={`url(#${filterId})`} transform="translate(48, 52)">
        {/* Unibody bare caramel Quokka head & shoulders, close crown ears, zero mouth */}
        <path
          d="M -0.8 -25
             C -8 -39, -28 -34, -23 -15
             C -32 -5, -32 18, -22 27
             C -13 34, 13 34, 22 27
             C 32 18, 32 -5, 23 -15
             C 28 -34, 8 -39, 0.8 -25 Z"
          fill={FUR}
        />
        <circle cx="-6.2" cy="-8.5" r="2.6" fill={INK} />
        <circle cx="6.2" cy="-8.5" r="2.6" fill={INK} />
        <ellipse cx="0" cy="2.8" rx="6" ry="7.2" fill={INK} />
        {/* Butter yellow mini cassette held by tiny black paws */}
        <rect x="-15" y="14" width="30" height="17" rx="4" fill={BUTTER} />
        <rect x="-9" y="19" width="18" height="6.5" rx="3.2" fill={NAVY} />
        <circle cx="-4.2" cy="22.2" r="1.6" fill="#FAF8F3" />
        <circle cx="4.2" cy="22.2" r="1.6" fill="#FAF8F3" />
        <circle
          cx="10.5"
          cy="17.2"
          r="2.2"
          fill={CUP_RED}
          className={isRecording ? 'anim-rec-dot' : ''}
        />
        <ellipse cx="-15" cy="22.5" rx="4.2" ry="3.4" fill={INK} />
        <ellipse cx="15" cy="22.5" rx="4.2" ry="3.4" fill={INK} />
      </g>
    </svg>
  );
}

/**
 * Empty State Illustration when no recordings exist yet (BOBO & Marsh on oatmeal stage)
 */
export function BoboEmptyStageBadge({ className = 'w-28 h-24' }: { className?: string }) {
  const uid = useId().replace(/:/g, '');
  const filterId = `crayon_empty_${uid}`;
  return (
    <svg viewBox="0 0 140 112" className={className} aria-hidden="true">
      <CrayonFilterDef id={filterId} />
      <rect x="6" y="8" width="128" height="96" rx="28" fill="#DEDCD3" />
      <g filter={`url(#${filterId})`}>
        {/* Wooden stool */}
        <rect x="64" y="76" width="46" height="6.5" rx="3" fill="#785634" />
        <rect x="70" y="81" width="6.5" height="15" rx="2" fill="#785634" />
        <rect x="97" y="81" width="6.5" height="15" rx="2" fill="#785634" />
        {/* Snow-white BOBO with upturned ω smile */}
        <g transform="translate(87, 50)">
          <path
            d="M -11 -19
               C -20 -25, -25 -16, -19 -7
               C -24 2, -23 20, -13 26
               C -8 29, -4 24, 0 24
               C 4 24, 8 29, 13 26
               C 23 20, 24 2, 19 -7
               C 25 -16, 20 -25, 11 -19
               C 4 -20, -4 -20, -11 -19 Z"
            fill={BOBO_SHADE}
            transform="translate(1.2, 1.5)"
          />
          <path
            d="M -11 -19
               C -20 -25, -25 -16, -19 -7
               C -24 2, -23 20, -13 26
               C -8 29, -4 24, 0 24
               C 4 24, 8 29, 13 26
               C 23 20, 24 2, 19 -7
               C 25 -16, 20 -25, 11 -19
               C 4 -20, -4 -20, -11 -19 Z"
            fill={BOBO_WHITE}
          />
          <circle cx="-4.2" cy="-8.5" r="1.8" fill={INK} />
          <circle cx="4.2" cy="-8.5" r="1.8" fill={INK} />
          <path
            d="M 0 -4.8 L 0 -1.3 M -4.8 -1.4 Q -2.4 2 0 -1.4 Q 2.4 2 4.8 -1.4"
            fill="none"
            stroke={INK}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* Retro microphone */}
          <rect x="-15" y="4" width="4" height="11" rx="2" fill={INK} />
          <ellipse cx="-13" cy="2" rx="5" ry="6" fill={CUP_RED} />
        </g>
        {/* Marshmallow stack */}
        <g transform="translate(42, 79)">
          <rect x="-9" y="-7" width="18" height="14" rx="4" fill={BOBO_WHITE} />
          <circle cx="-2.8" cy="-1" r="1.2" fill={INK} />
          <circle cx="2.8" cy="-1" r="1.2" fill={INK} />
          <path d="M-2 2.2 Q0 3.8 2 2.2" fill="none" stroke={INK} strokeWidth="1.2" strokeLinecap="round" />
        </g>
        <g transform="translate(43, 64) rotate(-4)">
          <rect x="-8.5" y="-6.5" width="17" height="13" rx="4" fill={BOBO_WHITE} />
          <circle cx="-2.6" cy="-1" r="1.1" fill={INK} />
          <circle cx="2.6" cy="-1" r="1.1" fill={INK} />
          <path d="M-1.8 2 Q0 3.5 1.8 2" fill="none" stroke={INK} strokeWidth="1.1" strokeLinecap="round" />
        </g>
        {/* Sound wave doodles */}
        <path
          d="M 52 44 Q 56 36, 59 44 T 66 44"
          fill="none"
          stroke={BUTTER}
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
