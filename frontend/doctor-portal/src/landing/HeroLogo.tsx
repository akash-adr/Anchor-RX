import { useState } from 'react';

const LOGO_POSTER = '/anchor-rx-logo-poster.png';

/**
 * Two encodings of the same transparent logo animation — each browser plays the first <source> it supports:
 *  1. HEVC with alpha in a QuickTime .mov — Safari (macOS + iOS). Safari can't show VP9-alpha WebM transparently.
 *     Declared as video/quicktime so Chrome/Edge/Firefox skip it (Chrome on macOS can decode HEVC, but not its alpha).
 *  2. VP9 with alpha in WebM — Chrome, Edge, Firefox.
 * Deployment note: the host must serve .mov as a video type (video/quicktime), not application/octet-stream,
 * or Safari silently falls back to the static poster.
 */
const LOGO_SOURCES = [
  { src: '/anchor-rx-logo-alpha.mov', type: 'video/quicktime; codecs="hvc1"' },
  { src: '/anchor-rx-logo-transparent.webm', type: 'video/webm; codecs="vp9"' },
] as const;

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

/**
 * The animated bubble-letter logo — the ONLY playful element on the page.
 * Space is reserved with a 16:9 box before anything loads, so the page never jumps.
 * The source frame has ~16% transparent padding above and ~13% below the lettering; the small negative
 * margins pull surrounding content in so there's no large empty band.
 * The static poster is used only when the visitor prefers reduced motion, or when no source can be played.
 */
export default function HeroLogo() {
  const [useStatic, setUseStatic] = useState(prefersReducedMotion);

  return (
    <div className="mx-auto -mb-[5%] -mt-[3%] w-full max-w-[860px]">
      <div className="relative aspect-video w-full">
        {useStatic ? (
          <img
            src={LOGO_POSTER}
            alt="Anchor Rx"
            data-testid="hero-logo-static"
            decoding="async"
            className="absolute inset-0 h-full w-full object-contain"
          />
        ) : (
          <video
            poster={LOGO_POSTER}
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
            aria-label="Anchor Rx animated logo"
            data-testid="hero-video"
            onError={(event) => {
              // React also delivers <source> children's error events here. A browser skipping a source it can't
              // play (e.g. Chrome skipping the .mov) is NOT a failure — only the video element's own error is.
              if (event.target === event.currentTarget) setUseStatic(true);
            }}
            className="absolute inset-0 h-full w-full object-contain"
          >
            {LOGO_SOURCES.map(({ src, type }, index) => (
              <source
                key={src}
                src={src}
                type={type}
                // A <video> with <source> children reports load failures on the LAST <source>, not on itself:
                // once every candidate has failed, show the poster instead of a broken video element.
                onError={index === LOGO_SOURCES.length - 1 ? () => setUseStatic(true) : undefined}
              />
            ))}
          </video>
        )}
      </div>
    </div>
  );
}
