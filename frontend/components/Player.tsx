import type Hls from 'hls.js';
import { useEffect, useRef, useState } from 'react';

interface Props {
  manifestUrl: string;
  posterUrl?: string;
}

export function Player({ manifestUrl, posterUrl }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [heights, setHeights] = useState<number[]>([]);
  const [selected, setSelected] = useState(-1); // -1 = automatic
  const [current, setCurrent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    setHeights([]);
    setSelected(-1);
    setCurrent(null);
    setError(null);

    void (async () => {
      try {
        // Downloaded only when a video is actually about to play.
        const { default: HlsLib } = await import('hls.js');
        if (cancelled) return;

        if (HlsLib.isSupported()) {
          const hls = new HlsLib();
          hlsRef.current = hls;

          hls.on(HlsLib.Events.MANIFEST_PARSED, () =>
            setHeights(hls.levels.map((level) => level.height)),
          );
          hls.on(HlsLib.Events.LEVEL_SWITCHED, (_event, data) =>
            setCurrent(hls.levels[data.level]?.height ?? null),
          );
          hls.on(HlsLib.Events.ERROR, (_event, data) => {
            if (data.fatal) setError(`Playback problem: ${data.type} / ${data.details}`);
          });

          hls.loadSource(manifestUrl);
          hls.attachMedia(video);
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = manifestUrl; // Safari plays HLS natively
        } else {
          setError('This browser cannot play HLS video.');
        }
      } catch {
        if (!cancelled) setError('The video player could not be loaded. Check your connection and refresh.');
      }
    })();

    return () => {
      cancelled = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [manifestUrl]);

  const choose = (index: number) => {
    setSelected(index);
    if (hlsRef.current) hlsRef.current.currentLevel = index; // -1 returns to automatic
  };

   return (
    <div className="player">
      <video ref={videoRef} poster={posterUrl} controls playsInline className="video" />
      {error && <p className="error">{error}</p>}
      {heights.length > 0 && (
        <div className="player-bar">
          <label>
            Quality{' '}
            <select value={selected} onChange={(e) => choose(Number(e.target.value))}>
              <option value={-1}>Auto</option>
              {heights.map((height, index) => (
                <option key={index} value={index}>
                  {height}p
                </option>
              ))}
            </select>
          </label>
          {current !== null && <span className="muted">Now playing {current}p</span>}
        </div>
      )}
    </div>
  );
}