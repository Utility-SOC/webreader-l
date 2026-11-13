import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, ArrowUp, X } from 'lucide-react';
import RSVPDisplay from './RSVPDisplay';

const POS_KEY = 'webreader:mini-pos:v1';
const W = 176, H = 112, VIRTUAL_W = 560, SCALE = W / VIRTUAL_W;   // the real display, scaled down: shows every setting live

const clampPos = (p) => ({
  x: Math.max(4, Math.min(window.innerWidth - W - 4, p.x)),
  y: Math.max(4, Math.min(window.innerHeight - H - 4, p.y)),
});
const loadPos = () => {
  try { const p = JSON.parse(localStorage.getItem(POS_KEY)); if (p && typeof p.x === 'number') return clampPos(p); } catch { /* no saved position */ }
  return clampPos({ x: window.innerWidth - W - 12, y: 12 });   // top-right by default
};

// Floating mini player shown while the main reader is scrolled out of view (e.g. you're down in the settings).
// Drag it anywhere; tap the text to play/pause; the arrow scrolls back up to the full reader.
const MiniReader = ({ words, images, index, settings, appearance, isDark, isPlaying, onToggle, onJump, onClose }) => {
  const [pos, setPos] = useState(loadPos);
  const drag = useRef(null);

  useEffect(() => {
    const onResize = () => setPos((p) => clampPos(p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const down = (e) => {
    if (e.target.closest('button')) return;
    drag.current = { sx: e.clientX, sy: e.clientY, px: pos.x, py: pos.y, moved: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  };
  const move = (e) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 6) d.moved = true;
    if (d.moved) setPos(clampPos({ x: d.px + dx, y: d.py + dy }));
  };
  const up = () => {
    const d = drag.current; drag.current = null;
    if (!d) return;
    if (d.moved) { try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch { /* storage unavailable */ } }
    else onToggle();                                   // a tap on the text plays/pauses
  };

  return (
    <div
      role="region" aria-label="Mini reader"
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { drag.current = null; }}
      className={`fixed z-40 rounded-2xl shadow-2xl border overflow-hidden select-none ${isDark ? 'bg-[#0f1014] border-white/15' : 'bg-white border-gray-300'}`}
      style={{ left: pos.x, top: pos.y, width: W, height: H, touchAction: 'none' }}
    >
      <div style={{ width: VIRTUAL_W, transform: `scale(${SCALE})`, transformOrigin: 'top left', pointerEvents: 'none' }}>
        <RSVPDisplay words={words} images={images} index={index} settings={settings} appearance={appearance} isDark={isDark} />
      </div>
      <div className="absolute bottom-1 left-1 right-1 flex items-center justify-between">
        <button onClick={onToggle} aria-label={isPlaying ? 'Pause' : 'Play'} className={`w-7 h-7 rounded-full flex items-center justify-center ${isDark ? 'bg-white/15 text-white' : 'bg-gray-900/10 text-gray-900'}`}>
          {isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" className="ml-0.5" />}
        </button>
        <span className={`text-[10px] font-mono ${isDark ? 'text-indigo-300' : 'text-indigo-700'}`}>{settings.wpm} WPM</span>
        <span className="flex gap-1">
          <button onClick={onJump} aria-label="Back to the full reader" className={`w-7 h-7 rounded-full flex items-center justify-center ${isDark ? 'bg-white/15 text-white' : 'bg-gray-900/10 text-gray-900'}`}><ArrowUp size={14} /></button>
          <button onClick={onClose} aria-label="Hide mini reader" className={`w-7 h-7 rounded-full flex items-center justify-center ${isDark ? 'bg-white/15 text-white' : 'bg-gray-900/10 text-gray-900'}`}><X size={14} /></button>
        </span>
      </div>
    </div>
  );
};

export default MiniReader;
