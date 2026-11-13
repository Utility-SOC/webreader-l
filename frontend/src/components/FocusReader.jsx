import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, ChevronLeft, ChevronRight, Minimize2, Minus, Plus } from 'lucide-react';
import RSVPDisplay from './RSVPDisplay';

// Full-screen reader. Tap: play/pause (and show the controls for a few seconds). Swipe left/right: speed (1 WPM
// steps). Swipe up/down: scrub through the text. Controls fade out on their own; a thin progress line stays.
const FocusReader = ({ words, images, index, setIndex, settings, setSettings, appearance, isDark, isPlaying, onToggle, onExit }) => {
  const [show, setShow] = useState(true);
  const [hint, setHint] = useState(null);
  const g = useRef(null);
  const hideTimer = useRef(0), hintTimer = useRef(0);

  const reveal = () => { setShow(true); clearTimeout(hideTimer.current); hideTimer.current = setTimeout(() => setShow(false), 3500); };
  useEffect(() => {   // controls start visible, then fade out
    hideTimer.current = setTimeout(() => setShow(false), 3500);
    return () => { clearTimeout(hideTimer.current); clearTimeout(hintTimer.current); };
  }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onExit(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  const flashHint = (t) => { setHint(t); clearTimeout(hintTimer.current); hintTimer.current = setTimeout(() => setHint(null), 900); };
  const setWpm = (wpm) => setSettings((prev) => (prev.wpm === wpm ? prev : { ...prev, wpm }));

  const down = (e) => {
    g.current = { x: e.clientX, y: e.clientY, wpm: settings.wpm, idx: index, w: window.innerWidth || 600, mode: null };
  };
  const move = (e) => {
    const s = g.current; if (!s) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (!s.mode) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 12) return;
      s.mode = Math.abs(dx) > Math.abs(dy) ? 'speed' : 'scrub';
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    }
    if (s.mode === 'speed') {
      const wpm = Math.max(100, Math.min(900, Math.round(s.wpm + (dx / s.w) * 250)));
      setWpm(wpm); flashHint(`${wpm} WPM`);
    } else {
      const next = Math.max(0, Math.min(words.length - 1, s.idx + Math.round(-dy / 5)));
      setIndex(next); flashHint(`${next + 1} / ${words.length}`);
    }
  };
  const up = () => {
    const s = g.current; g.current = null;
    if (!s) return;
    if (!s.mode) { onToggle(); reveal(); }
  };

  const stop = (e) => e.stopPropagation();
  const btn = `w-11 h-11 rounded-full flex items-center justify-center active:scale-90 ${isDark ? 'bg-white/15 text-white' : 'bg-gray-900/10 text-gray-900'}`;

  return (
    <div role="region" aria-label="Focus reader" className={`fixed inset-0 z-50 select-none ${isDark ? 'bg-[#0b0c10] text-gray-100' : 'bg-white text-gray-900'}`}
      style={{ touchAction: 'none', paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { g.current = null; }}>
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <RSVPDisplay words={words} images={images} index={index} settings={settings} appearance={appearance} isDark={isDark} fill />
      </div>

      {hint && <div aria-live="polite" className="absolute top-3 left-1/2 -translate-x-1/2 px-4 py-1.5 rounded-full bg-black/70 text-white font-mono text-sm pointer-events-none">{hint}</div>}

      <div className={`absolute left-0 right-0 bottom-0 px-3 pb-3 pt-8 flex items-center justify-center gap-3 transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        style={{ background: isDark ? 'linear-gradient(transparent, rgba(0,0,0,0.75))' : 'linear-gradient(transparent, rgba(255,255,255,0.9))' }}
        onPointerDown={(e) => { stop(e); reveal(); }} onPointerUp={stop} onPointerMove={stop}>
        <button onClick={onExit} aria-label="Exit focus mode" className={btn}><Minimize2 size={20} /></button>
        <button onClick={() => { setIndex(Math.max(0, index - 50)); reveal(); }} aria-label="Back 50 words" className={btn}><ChevronLeft size={22} /></button>
        <button onClick={() => { onToggle(); reveal(); }} aria-label={isPlaying ? 'Pause' : 'Play'} className={`${btn} !w-14 !h-14 ${isDark ? '!bg-white !text-black' : '!bg-gray-900 !text-white'}`}>
          {isPlaying ? <Pause size={26} fill="currentColor" /> : <Play size={26} fill="currentColor" className="ml-1" />}
        </button>
        <button onClick={() => { setIndex(Math.min(words.length - 1, index + 50)); reveal(); }} aria-label="Forward 50 words" className={btn}><ChevronRight size={22} /></button>
        <div className="flex items-center gap-1">
          <button onClick={() => { setWpm(Math.max(100, settings.wpm - 10)); reveal(); }} aria-label="Slower" className={btn}><Minus size={18} /></button>
          <span className={`font-mono text-sm w-16 text-center ${isDark ? 'text-indigo-300' : 'text-indigo-700'}`}>{settings.wpm}<br /><span className="text-[10px] opacity-70">WPM</span></span>
          <button onClick={() => { setWpm(Math.min(900, settings.wpm + 10)); reveal(); }} aria-label="Faster" className={btn}><Plus size={18} /></button>
        </div>
      </div>

      <div aria-hidden="true" className="absolute left-0 right-0 bottom-0 h-0.5 bg-white/10 pointer-events-none">
        <div className="h-full bg-indigo-500" style={{ width: `${(index / Math.max(1, words.length - 1)) * 100}%` }} />
      </div>
    </div>
  );
};

export default FocusReader;
