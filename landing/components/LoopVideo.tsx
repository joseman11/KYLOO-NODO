"use client";

import { useEffect, useRef, useState } from "react";

/** Video mp4 que se reproduce solo cuando está a la vista (mudo, en bucle) y se puede pausar. */
export function LoopVideo({ src, poster, label, className }: { src: string; poster: string; label: string; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const manual = useRef(false);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const io = new IntersectionObserver(
      ([e]) => {
        if (reduce || manual.current) return;
        if (e.isIntersecting) v.play().catch(() => {});
        else v.pause();
      },
      { threshold: 0.4 },
    );
    io.observe(v);
    return () => io.disconnect();
  }, []);

  return (
    <div className={`vid ${className ?? ""}`}>
      <video
        ref={ref}
        src={src}
        poster={poster}
        muted
        loop
        playsInline
        preload="metadata"
        aria-label={label}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <button
        type="button"
        className="vid-btn"
        onClick={() => {
          const v = ref.current;
          if (!v) return;
          if (v.paused) { manual.current = false; v.play().catch(() => {}); } else { manual.current = true; v.pause(); }
        }}
        aria-label={playing ? "Pausar video" : "Reproducir video"}
      >
        {playing ? "❚❚" : "▶"}
      </button>
    </div>
  );
}
