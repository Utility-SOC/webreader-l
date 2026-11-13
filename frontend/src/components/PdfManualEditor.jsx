import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, ArrowRight, Trash2, Check, X, Image as ImageIcon, Type, Plus, Volume2, Move } from 'lucide-react';
import Modal from './Modal';

// Plain hex / rgba() colours on purpose: they work in every browser, including ones that don't understand the newer
// colour functions the stylesheet uses, and in high-contrast modes.
const BOX_COLORS = {
    text:  { border: '#2563eb', selected: '#1d4ed8', fill: 'rgba(37, 99, 235, 0.10)', label: '#1d4ed8' },
    image: { border: '#f97316', selected: '#c2410c', fill: 'rgba(249, 115, 22, 0.20)', label: '#c2410c' },
};
const FILL_KEY = 'webreader:box-fill';

// The tint is drawn on its own layer with multiply blending: even if some browser, extension or display setting
// turned it fully opaque, dark text underneath still shows through (multiplying by a light colour keeps it dark).
// It must sit in the SAME stacking context as the page image (a sibling of it): inside a z-indexed box it would be
// isolated, and a blend can't reach the image behind an isolated layer.
const BoxFill = ({ rect, color }) => (
    <div className="wr-box-fill absolute pointer-events-none"
         style={{ ...rect, backgroundColor: color, mixBlendMode: 'multiply' }} />
);

const touchUI = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

const PdfManualEditor = ({ filename, pageCount, initialBoxes, onCancel, onFinish, localDoc }) => {
    const isTouchUI = useRef(touchUI()).current;
    const [loadError, setLoadError] = useState('');
    const [diag, setDiag] = useState('');
    useEffect(() => { localDoc?.prefetch?.(); return () => localDoc?.close?.(); }, [localDoc]);
    useEffect(() => {   // keep the status line (cache progress) current
        if (!localDoc?.diagText) return;
        const t = setInterval(() => setDiag(localDoc.diagText()), 1500);
        return () => clearInterval(t);
    }, [localDoc]);
    const [pageIdx, setPageIdx] = useState(0);
    const [tool, setTool] = useState('text'); // 'text' | 'image'
    const [imageUrl, setImageUrl] = useState(null);

    const [boxesMap, setBoxesMap] = useState(initialBoxes || {});
    const [selectedBoxIdx, setSelectedBoxIdx] = useState(null);

    // New State
    const [startPage, setStartPage] = useState(1);
    const [fitWidth, setFitWidth] = useState(true);
    // 'tint' (a light fill) or 'outline' (border only) -- an escape hatch for displays that render the fill badly
    const [boxFill, setBoxFill] = useState(() => { try { return localStorage.getItem(FILL_KEY) === 'outline' ? 'outline' : 'tint'; } catch { return 'tint'; } });
    const toggleBoxFill = () => setBoxFill(prev => {
        const next = prev === 'tint' ? 'outline' : 'tint';
        try { localStorage.setItem(FILL_KEY, next); } catch { /* storage unavailable: the choice just won't persist */ }
        setAnnouncement(next === 'outline' ? 'Boxes now show an outline only.' : 'Boxes now show a light tint.');
        return next;
    });

    // Interaction State
    const [interaction, setInteraction] = useState({
        mode: 'idle', // 'idle', 'drawing', 'moving', 'resizing'
        startPoint: { x: 0, y: 0 },
        initialBox: null,
        handle: null
    });

    // Drawing State (Draft box)
    const [draftBox, setDraftBox] = useState(null);

    const imgRef = useRef(null);

    // Screen-reader announcements + first/last-word preview of the selected box
    const [announcement, setAnnouncement] = useState('');
    const [toast, setToast] = useState('');
    const toastTimer = useRef(0);
    const flash = (msg) => { setAnnouncement(msg); setToast(msg); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 3500); };
    const [preview, setPreview] = useState(null);

    // Load Image
    useEffect(() => {
        const loadPage = async () => {
            // Using proxy path from vite config
            setLoadError('');
            let url;
            try { url = localDoc ? await localDoc.pageUrl(pageIdx) : `/pdf/${filename}/page/${pageIdx + 1}`; }
            catch (err) { setLoadError(`This page could not be drawn: ${err.message}`); return; }
            setImageUrl(url);
            if (localDoc?.diagText) setDiag(localDoc.diagText());
            localDoc?.warm?.(pageIdx);
            setSelectedBoxIdx(null);
            setPreview(null);
        };
        loadPage();
    }, [filename, pageIdx, localDoc]);

    // ---------------------------
    // MOUSE HANDLERS
    // ---------------------------
    const getLoc = (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        let scale = 1;
        if (fitWidth && imgRef.current) {
            scale = imgRef.current.naturalWidth / rect.width;
        }

        return {
            x: (e.clientX - rect.left) * scale,
            y: (e.clientY - rect.top) * scale
        };
    };

    const handleMouseDown = (e) => {
        const { x, y } = getLoc(e);

        // 1. Check for Resize Handle Hit (if selection active)
        if (selectedBoxIdx !== null && boxesMap[String(pageIdx)]) {
            const handle = getHandleAt(x, y, boxesMap[String(pageIdx)][selectedBoxIdx]);
            if (handle) {
                setInteraction({
                    mode: 'resizing',
                    startPoint: { x, y },
                    initialBox: { ...boxesMap[String(pageIdx)][selectedBoxIdx] },
                    handle
                });
                e.stopPropagation();
                return;
            }
        }

        // 2. Check for Box Hit (Move or Select)
        const hitIdx = getBoxAt(x, y);
        if (hitIdx !== null) {
            setSelectedBoxIdx(hitIdx);
            setInteraction({
                mode: 'moving',
                startPoint: { x, y },
                initialBox: { ...boxesMap[String(pageIdx)][hitIdx] },
                handle: null
            });
            e.stopPropagation();
            return;
        }

        // 3. Background -> Start Drawing
        setSelectedBoxIdx(null);
        setInteraction({ mode: 'drawing', startPoint: { x, y }, initialBox: null, handle: null });
        setDraftBox({ x, y, w: 0, h: 0, type: tool });
    };

    const handleMouseMove = (e) => {
        const { x, y } = getLoc(e);

        if (interaction.mode === 'drawing') {
            const start = interaction.startPoint;
            setDraftBox({
                x: Math.min(start.x, x),
                y: Math.min(start.y, y),
                w: Math.abs(x - start.x),
                h: Math.abs(y - start.y),
                type: tool
            });
        } else if (interaction.mode === 'moving') {
            const dx = x - interaction.startPoint.x;
            const dy = y - interaction.startPoint.y;

            updateBox(selectedBoxIdx, {
                x: interaction.initialBox.x + dx,
                y: interaction.initialBox.y + dy
            });
        } else if (interaction.mode === 'resizing') {
            const dx = x - interaction.startPoint.x;
            const dy = y - interaction.startPoint.y;
            const init = interaction.initialBox;
            let newBox = { ...init };

            // Handle Logic
            if (interaction.handle.includes('e')) newBox.w = Math.max(5, init.w + dx);
            if (interaction.handle.includes('s')) newBox.h = Math.max(5, init.h + dy);
            if (interaction.handle.includes('w')) {
                newBox.x = init.x + dx;
                newBox.w = Math.max(5, init.w - dx);
            }
            if (interaction.handle.includes('n')) {
                newBox.y = init.y + dy;
                newBox.h = Math.max(5, init.h - dy);
            }

            updateBox(selectedBoxIdx, newBox);
        }
    };

    // ---- Touch / pen / mouse via pointer events -------------------------------------------------
    // One finger: draw, move, or drag a corner. Two fingers: pinch to resize the selected box (each axis scales
    // with the finger spread on that axis), or pan the page when no box is selected.
    const pointers = useRef(new Map());
    const pinch = useRef(null);
    const scrollerRef = useRef(null);

    const pinchGeom = () => {
        const [a, b] = [...pointers.current.values()];
        return { dx: Math.max(Math.abs(a.x - b.x), 40), dy: Math.max(Math.abs(a.y - b.y), 40), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    };

    // Touch: one finger scrolls the page (with momentum); dragging a corner resizes; dragging the centre grip of the
    // selected box moves it; two fingers pinch-resize. Tapping a box selects it, tapping empty page deselects.
    const scrollGesture = useRef(null);
    const flingRaf = useRef(0);
    const GRIP = 34;   // screen px radius of the move grip

    const screenScale = () => (fitWidth && imgRef.current ? imgRef.current.clientWidth / (imgRef.current.naturalWidth || 800) : 1);
    const onGrip = (x, y, box) => {
        const r = GRIP / screenScale();
        return Math.abs(x - (box.x + box.w / 2)) <= r && Math.abs(y - (box.y + box.h / 2)) <= r;
    };

    const startFling = (vx, vy) => {
        cancelAnimationFrame(flingRaf.current);
        let last = performance.now();
        const step = (now) => {
            const el = scrollerRef.current; if (!el) return;
            const dt = now - last; last = now;
            el.scrollLeft -= vx * dt; el.scrollTop -= vy * dt;
            vx *= Math.pow(0.95, dt / 16); vy *= Math.pow(0.95, dt / 16);
            if (Math.abs(vx) > 0.02 || Math.abs(vy) > 0.02) flingRaf.current = requestAnimationFrame(step);
        };
        flingRaf.current = requestAnimationFrame(step);
    };

    const handlePointerDown = (e) => {
        cancelAnimationFrame(flingRaf.current);
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
        if (pointers.current.size === 2) {
            // Second finger: abort the first finger's gesture and start a pinch on the selected box
            scrollGesture.current = null;
            setDraftBox(null);
            setInteraction({ mode: 'idle', startPoint: { x: 0, y: 0 }, initialBox: null, handle: null });
            const sel = selectedBoxIdx !== null ? (boxesMap[String(pageIdx)] || [])[selectedBoxIdx] : null;
            pinch.current = { ...pinchGeom(), box: sel ? { ...sel } : null, scrollLeft: scrollerRef.current?.scrollLeft || 0, scrollTop: scrollerRef.current?.scrollTop || 0 };
            return;
        }
        if (pointers.current.size !== 1) return;
        if (e.pointerType !== 'touch') { handleMouseDown(e); return; }

        const { x, y } = getLoc(e);
        const sel = selectedBoxIdx !== null ? (boxesMap[String(pageIdx)] || [])[selectedBoxIdx] : null;
        if (sel) {
            const handle = getHandleAt(x, y, sel);
            if (handle) { setInteraction({ mode: 'resizing', startPoint: { x, y }, initialBox: { ...sel }, handle }); return; }
            if (onGrip(x, y, sel)) { setInteraction({ mode: 'moving', startPoint: { x, y }, initialBox: { ...sel }, handle: null }); return; }
        }
        const el = scrollerRef.current;
        scrollGesture.current = { sx: e.clientX, sy: e.clientY, left: el?.scrollLeft || 0, top: el?.scrollTop || 0, moved: false, x, y, vx: 0, vy: 0, t: performance.now(), lx: e.clientX, ly: e.clientY };
    };

    const handlePointerMove = (e) => {
        if (!pointers.current.has(e.pointerId)) { if (e.pointerType === 'mouse') handleMouseMove(e); return; }
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.current.size >= 2 && pinch.current) {
            const g = pinchGeom(); const p0 = pinch.current;
            if (p0.box) {
                const nw = imgRef.current?.naturalWidth || 800, nh = imgRef.current?.naturalHeight || 1100;
                const w = Math.min(nw, Math.max(10, p0.box.w * (g.dx / p0.dx)));
                const h = Math.min(nh, Math.max(10, p0.box.h * (g.dy / p0.dy)));
                const x = Math.max(0, Math.min(nw - w, p0.box.x + (p0.box.w - w) / 2));
                const y = Math.max(0, Math.min(nh - h, p0.box.y + (p0.box.h - h) / 2));
                updateBox(selectedBoxIdx, { x, y, w, h });
            } else if (scrollerRef.current) {
                scrollerRef.current.scrollLeft = p0.scrollLeft - (g.cx - p0.cx);
                scrollerRef.current.scrollTop = p0.scrollTop - (g.cy - p0.cy);
            }
            return;
        }
        const sg = scrollGesture.current;
        if (sg && scrollerRef.current) {
            const dx = e.clientX - sg.sx, dy = e.clientY - sg.sy;
            if (Math.abs(dx) + Math.abs(dy) > 6) sg.moved = true;
            scrollerRef.current.scrollLeft = sg.left - dx;
            scrollerRef.current.scrollTop = sg.top - dy;
            const now = performance.now(), dt = Math.max(1, now - sg.t);
            sg.vx = 0.8 * sg.vx + 0.2 * ((e.clientX - sg.lx) / dt);
            sg.vy = 0.8 * sg.vy + 0.2 * ((e.clientY - sg.ly) / dt);
            sg.t = now; sg.lx = e.clientX; sg.ly = e.clientY;
            return;
        }
        handleMouseMove(e);
    };

    const handlePointerUp = (e) => {
        const wasPinching = pointers.current.size >= 2;
        pointers.current.delete(e.pointerId);
        if (wasPinching) { pinch.current = null; if (pointers.current.size === 0) handleMouseUp(); return; }
        const sg = scrollGesture.current;
        if (sg) {
            scrollGesture.current = null;
            if (!sg.moved) {                                     // a tap: select the box under the finger, or deselect
                const hit = getBoxAt(sg.x, sg.y);
                setSelectedBoxIdx(hit);
            } else if (e.type === 'pointerup' && performance.now() - sg.t < 80) {
                startFling(sg.vx, sg.vy);
            }
            return;
        }
        handleMouseUp();
    };

    const handleMouseUp = () => {
        if (interaction.mode === 'drawing' && draftBox) {
            if (draftBox.w > 5 && draftBox.h > 5) {
                addBox(draftBox);
                setSelectedBoxIdx((boxesMap[String(pageIdx)] || []).length);
            }
            setDraftBox(null);
        }
        setInteraction({ mode: 'idle', startPoint: { x: 0, y: 0 }, initialBox: null, handle: null });
    };

    // Helpers
    const getBoxAt = (x, y) => {
        const boxes = boxesMap[String(pageIdx)] || [];
        // Check in reverse order (top first)
        for (let i = boxes.length - 1; i >= 0; i--) {
            const b = boxes[i];
            if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return i;
        }
        return null;
    };

    const getHandleAt = (mx, my, box) => {
        // ~26 screen px (fingertip-sized) expressed in page pixels
        const sc = fitWidth && imgRef.current ? imgRef.current.clientWidth / (imgRef.current.naturalWidth || 800) : 1;
        const HANDLE_SIZE = 26 / sc;
        const hit = (hx, hy) => Math.abs(mx - hx) <= HANDLE_SIZE && Math.abs(my - hy) <= HANDLE_SIZE;

        if (hit(box.x, box.y)) return 'nw';
        if (hit(box.x + box.w, box.y)) return 'ne';
        if (hit(box.x, box.y + box.h)) return 'sw';
        if (hit(box.x + box.w, box.y + box.h)) return 'se';
        return null;
    };

    const addBox = (box) => {
        setBoxesMap(prev => {
            const k = String(pageIdx);
            return { ...prev, [k]: [...(prev[k] || []), box] };
        });
    };

    const updateBox = (idx, newAttrs) => {
        setBoxesMap(prev => {
            const k = String(pageIdx);
            const list = [...(prev[k] || [])];
            list[idx] = { ...list[idx], ...newAttrs };
            return { ...prev, [k]: list };
        });
    };

    const deleteSelectedBox = useCallback(() => {
        if (selectedBoxIdx === null) return;
        setBoxesMap(prev => {
            const k = String(pageIdx);
            const list = prev[k].filter((_, i) => i !== selectedBoxIdx);
            return { ...prev, [k]: list };
        });
        setAnnouncement(`Box ${selectedBoxIdx + 1} deleted.`);
        setSelectedBoxIdx(null);
    }, [selectedBoxIdx, pageIdx]);

    // Keyboard-only box creation: a default-sized box in the middle of the page, ready to move/resize.
    const addBoxAtCenter = () => {
        const nw = imgRef.current?.naturalWidth || 800;
        const nh = imgRef.current?.naturalHeight || 1100;
        const sc = screenScale();
        let cy = nh * 0.45, vis = nh * 0.3;
        if (imgRef.current && scrollerRef.current) {
            const ir = imgRef.current.getBoundingClientRect(), sr = scrollerRef.current.getBoundingClientRect();
            const top = Math.max(sr.top, ir.top), bottom = Math.min(sr.bottom, ir.bottom);
            if (bottom > top) { cy = ((top + bottom) / 2 - ir.top) / sc; vis = (bottom - top) / sc; }
        }
        const h = Math.max(30, Math.min(nh * 0.2, vis * 0.4));
        const box = { x: nw * 0.08, y: Math.max(0, Math.min(nh - h, cy - h / 2)), w: nw * 0.84, h, type: tool };
        const count = (boxesMap[String(pageIdx)] || []).length;
        addBox(box);
        setSelectedBoxIdx(count);
        setAnnouncement(`${tool === 'image' ? 'Image' : 'Text'} box ${count + 1} added.`);
    };

    // Geometry of a box as fractions of the page (what the backend expects)
    const toRelative = useCallback((b) => {
        if (b.relative) return b;
        const nw = imgRef.current?.naturalWidth || 800;
        const nh = imgRef.current?.naturalHeight || 1100;
        return { ...b, relative: true, x: b.x / nw, y: b.y / nh, w: b.w / nw, h: b.h / nh };
    }, []);

    const selectedBox = selectedBoxIdx !== null ? (boxesMap[String(pageIdx)] || [])[selectedBoxIdx] : null;

    // Fetch first/last words of the selected text box (debounced while it is being moved/resized)
    useEffect(() => {
        if (!selectedBox || selectedBox.type === 'image') return;
        let cancelled = false;
        const t = setTimeout(async () => {
            try {
                let data;
                if (localDoc) {
                    data = await localDoc.boxText(pageIdx, toRelative(selectedBox));
                } else {
                    const res = await fetch(`/pdf/${filename}/box_text`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ page: pageIdx, box: toRelative(selectedBox) })
                    });
                    if (!res.ok) throw new Error('preview failed');
                    data = await res.json();
                }
                if (!cancelled) setPreview(data);
            } catch {
                if (!cancelled) setPreview({ word_count: 0, first: '', last: '', error: true });
            }
        }, 400);
        return () => { cancelled = true; clearTimeout(t); };
    }, [selectedBox, pageIdx, filename, toRelative, localDoc]);

    const speak = (text) => {
        if (!text || !('speechSynthesis' in window)) return;
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    };
    const hear = (which) => {
        const text = preview && (which === 'first' ? preview.first : preview.last);
        if (!text) { setAnnouncement('No text found in this box.'); return; }
        speak(text);
    };
    const HS = isTouchUI ? { width: 22, height: 22, margin: -5 } : undefined;
    const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

    // Keyboard: Delete, move (arrows), resize (Shift+arrows), Ctrl = 10px steps,
    // N = new box, [ / ] = previous/next box, F / L = hear first / last words.
    useEffect(() => {
        const handleKeyDown = (e) => {
            const tag = e.target?.tagName;
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
            if (e.altKey || e.metaKey) return;

            const k = String(pageIdx);
            const count = (boxesMap[k] || []).length;

            if ((e.key === 'n' || e.key === 'N') && !e.ctrlKey) { e.preventDefault(); addBoxAtCenter(); return; }
            if (e.key === ']' || e.key === '[') {
                if (count === 0) return;
                e.preventDefault();
                const dir = e.key === ']' ? 1 : -1;
                const next = selectedBoxIdx === null ? (dir === 1 ? 0 : count - 1) : (selectedBoxIdx + dir + count) % count;
                setSelectedBoxIdx(next);
                setAnnouncement(`Box ${next + 1} of ${count} selected.`);
                return;
            }
            if (selectedBoxIdx === null) return;

            if (e.key === 'f' || e.key === 'F') { e.preventDefault(); hear('first'); return; }
            if (e.key === 'l' || e.key === 'L') { e.preventDefault(); hear('last'); return; }

            if (e.key === 'Delete' || e.key === 'Backspace') {
                deleteSelectedBox();
                return;
            }

            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                e.preventDefault();
                const step = e.ctrlKey ? 10 : 1;
                const dx = (e.key === 'ArrowRight' ? step : (e.key === 'ArrowLeft' ? -step : 0));
                const dy = (e.key === 'ArrowDown' ? step : (e.key === 'ArrowUp' ? -step : 0));

                setBoxesMap(prev => {
                    const list = [...(prev[k] || [])];
                    if (!list[selectedBoxIdx]) return prev;

                    const box = { ...list[selectedBoxIdx] };

                    if (e.shiftKey) {
                        // RESIZE (Expand/Contract dimensions)
                        box.w = Math.max(5, box.w + dx);
                        box.h = Math.max(5, box.h + dy);
                    } else {
                        // MOVE
                        box.x += dx;
                        box.y += dy;
                    }
                    list[selectedBoxIdx] = box;
                    return { ...prev, [k]: list };
                });
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedBoxIdx, pageIdx, boxesMap, tool, preview, deleteSelectedBox]);

    const setAsStart = () => {
        setStartPage(pageIdx + 1);
        setAnnouncement(`Reading will start from page ${pageIdx + 1}.`);
    };

    const prevPage = () => {
        if (pageIdx <= 0) return;
        const cur = boxesMap[String(pageIdx)] || [], prev = boxesMap[String(pageIdx - 1)];
        if (cur.length > 0 && (!prev || prev.length === 0)) setBoxesMap(m => ({ ...m, [String(pageIdx - 1)]: [...cur] }));
        setPageIdx(pageIdx - 1); setPreview(null);
    };
    // Same layout everywhere: put this page's boxes on every page that has none yet
    const copyToAllPages = () => {
        const cur = boxesMap[String(pageIdx)] || [];
        if (!cur.length) { flash('Add a box on this page first.'); return; }
        setBoxesMap(m => { const out = { ...m }; for (let i = 0; i < pageCount; i++) { if (!(out[String(i)] || []).length) out[String(i)] = cur.map(b => ({ ...b })); } return out; });
        flash('Boxes copied to every page that had none. Flip through to check, or press Done.');
    };
    const nextPage = () => {
        if (pageIdx >= pageCount - 1) return;
        const nextIdx = pageIdx + 1;
        // Auto Copy
        const currentBoxes = boxesMap[String(pageIdx)] || [];
        const nextBoxes = boxesMap[String(nextIdx)];
        if (currentBoxes.length > 0 && (!nextBoxes || nextBoxes.length === 0)) {
            setBoxesMap(prev => ({ ...prev, [String(nextIdx)]: [...currentBoxes] }));
            flash(`Copied ${currentBoxes.length} box${currentBoxes.length === 1 ? '' : 'es'} from page ${pageIdx + 1}. Adjust if this page differs.`);
        }
        setPageIdx(nextIdx);
        setPreview(null);
    };

    return (
        <Modal labelId="editor-title" onClose={() => {}} className="fixed inset-0 bg-gray-900 bg-opacity-95 z-50 flex flex-col text-white select-none">
            <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
            {toast && <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] max-w-[90vw] px-4 py-2 rounded-full bg-black/85 text-white text-sm shadow-xl pointer-events-none">{toast}</div>}
            {/* Toolbar */}
            <div className="p-3 bg-gray-800 flex flex-wrap gap-2 justify-between items-center shadow-md border-b border-gray-700">
                <div className="flex items-center gap-2">
                    <h2 id="editor-title" className="font-bold text-lg text-blue-300 hidden sm:block">PDF Layout Editor</h2>
                    <div className="flex bg-gray-700 rounded p-0.5">
                        <button onClick={prevPage} disabled={pageIdx === 0} aria-label="Previous page" className="px-3 py-1 hover:bg-gray-600 rounded-l disabled:opacity-50 border-r border-gray-600">
                            <ArrowLeft size={16} />
                        </button>
                        <span aria-live="polite" className="px-3 py-1 font-mono text-sm flex items-center bg-gray-600">Page {pageIdx + 1} / {pageCount}</span>
                        <button onClick={nextPage} disabled={pageIdx === pageCount - 1} aria-label="Next page (copies this page's boxes if the next page has none)" className="px-3 py-1 hover:bg-gray-600 rounded-r disabled:opacity-50">
                            <ArrowRight size={16} />
                        </button>
                    </div>
                </div>

                <div className="flex gap-2 items-center overflow-x-auto">
                    <button onClick={() => setTool('text')} title="Text box tool" aria-label="Text box tool" aria-pressed={tool === 'text'} className={`p-2 rounded flex items-center gap-1 text-xs font-bold ${tool === 'text' ? 'bg-blue-700 ring-1 ring-white' : 'bg-gray-700'}`}>
                        <Type size={20} /> <span className="hidden md:inline">Text</span>
                    </button>
                    <button onClick={() => setTool('image')} title="Image box tool" aria-label="Image box tool" aria-pressed={tool === 'image'} className={`p-2 rounded flex items-center gap-1 text-xs font-bold ${tool === 'image' ? 'bg-orange-700 ring-1 ring-white' : 'bg-gray-700'}`}>
                        <ImageIcon size={20} /> <span className="hidden md:inline">Image</span>
                    </button>
                    <button onClick={copyToAllPages} title="Copy this page's boxes to every page that has none" className="px-2 py-2 rounded bg-gray-700 text-xs font-bold whitespace-nowrap">Same on all pages</button>
                    <button onClick={addBoxAtCenter} title="Add a box (N)" aria-keyshortcuts="N" className="px-2 py-2 rounded bg-gray-700 text-xs font-bold flex items-center gap-1 whitespace-nowrap">
                        <Plus size={16} /> Add box <span className="hidden md:inline opacity-80">(N)</span>
                    </button>
                    <button onClick={() => setFitWidth(!fitWidth)} aria-label="Page zoom" aria-pressed={fitWidth} title="Toggle fit-to-width / actual size" className={`p-2 rounded bg-gray-700 text-xs font-bold w-12`}>{fitWidth ? 'FIT' : '1:1'}</button>
                    <button type="button" onClick={toggleBoxFill} aria-pressed={boxFill === 'outline'}
                            aria-label="Show boxes as outline only"
                            title="Outline only: hides the light fill inside boxes, if your display shows it too strongly"
                            className="px-2 py-2 rounded bg-gray-700 text-xs font-bold whitespace-nowrap">
                        {boxFill === 'outline' ? 'Outline' : 'Tint'}
                    </button>

                    {selectedBoxIdx !== null ? (
                        <button onClick={deleteSelectedBox} aria-label={`Delete box ${selectedBoxIdx + 1} (Delete key)`} title="Delete box" className="p-2 bg-red-700 rounded">
                            <Trash2 size={20} />
                        </button>
                    ) : (
                        <button onClick={setAsStart} className="px-2 py-1 bg-purple-700 rounded text-xs font-bold whitespace-nowrap" title="Start from this page">Start Here (pg{startPage})</button>
                    )}
                </div>

                <div className="flex gap-2">
                    <button onClick={onCancel} className="px-3 py-1 text-gray-300 hover:text-white text-sm flex items-center gap-1">
                        <X size={16} /> Cancel
                    </button>
                    <button onClick={() => {
                        // Normalize Scale to Relative (0.0 - 1.0)
                        const nw = imgRef.current ? imgRef.current.naturalWidth : 800;
                        const nh = imgRef.current ? imgRef.current.naturalHeight : 1100;
                        const normMap = {};
                        Object.keys(boxesMap).forEach(k => {
                            normMap[k] = boxesMap[k].map(b => {
                                // If already relative, keep as is
                                if (b.relative) return b;
                                // If absolute (pixels), normalize
                                return {
                                    ...b,
                                    relative: true,
                                    x: b.x / nw,
                                    y: b.y / nh,
                                    w: b.w / nw,
                                    h: b.h / nh
                                };
                            });
                        });
                        onFinish(normMap, startPage);
                    }} className="px-3 py-1 bg-green-700 hover:bg-green-600 rounded font-bold shadow-lg flex items-center gap-1">
                        <Check size={16} /> DONE
                    </button>
                </div>
            </div>

            {/* Selected-box panel: keyboard help, geometry, and first/last words */}
            <div className="px-3 py-2 bg-gray-800 border-b border-gray-700 text-sm flex flex-wrap gap-x-6 gap-y-1 items-center">
                {selectedBox ? (
                    <>
                        <strong>{selectedBox.type === 'image' ? 'Image' : 'Text'} box {selectedBoxIdx + 1} of {(boxesMap[String(pageIdx)] || []).length}</strong>
                        {selectedBox.type !== 'image' && (
                            <>
                                <span>{preview ? `${preview.word_count} words` : 'Reading box…'}</span>
                                <button onClick={() => hear('first')} disabled={!speechSupported || !preview?.first} aria-keyshortcuts="F" className="px-2 py-1 bg-green-700 rounded font-semibold flex items-center gap-1 disabled:opacity-60"><Volume2 size={14} /> Hear first words (F)</button>
                                <button onClick={() => hear('last')} disabled={!speechSupported || !preview?.last} aria-keyshortcuts="L" className="px-2 py-1 bg-blue-700 rounded font-semibold flex items-center gap-1 disabled:opacity-60"><Volume2 size={14} /> Hear last words (L)</button>
                                <span className="text-gray-200"><b>First:</b> {preview?.first || '—'} <b className="ml-3">Last:</b> {preview?.last || '—'}</span>
                            </>
                        )}
                    </>
                ) : (
                    <span className="text-gray-200">{isTouchUI ? 'Tap Add box, then drag a corner or pinch to fit it.' : 'No box selected. Press N to add a box, Tab or [ ] to select one, or drag on the page.'}</span>
                )}
                <span className="text-gray-300 text-xs ml-auto">{isTouchUI ? 'Drag to scroll · corners or two fingers resize · ✥ moves' : 'Drag to draw/move · Arrows move · Shift+arrows resize · Delete removes'}</span>
            </div>

            {diag && <div className="px-3 py-1 text-[10px] text-gray-400 bg-gray-900 border-b border-gray-700 break-words">{diag}{localDoc?.clearCache && <button onClick={async () => { await localDoc.clearCache(); setDiag(localDoc.diagText()); }} className="ml-2 underline text-gray-300">Clear cache</button>}</div>}
            <div ref={scrollerRef} tabIndex={0} role="region" aria-label="PDF page. Scrollable." className="flex-1 overflow-auto bg-gray-500 flex justify-center p-2 sm:p-4 cursor-default">
                <div className="relative shadow-2xl bg-white select-none box-default outline-none"
                    style={{
                        alignSelf: 'flex-start',
                        width: fitWidth ? '100%' : 'auto',
                        maxWidth: fitWidth ? '100%' : 'unset'
                    }}
                >
                    {loadError && <div className="p-6 text-red-700 bg-white">{loadError}</div>}
                    {imageUrl && (
                        <img
                            ref={imgRef}
                            src={imageUrl}
                            draggable="false"
                            alt={`PDF page ${pageIdx + 1} of ${pageCount}. Use the box tools and keyboard shortcuts to mark regions.`}
                            className="block"
                            onLoad={(e) => {
                                const nw = e.target.naturalWidth;
                                const nh = e.target.naturalHeight;
                                const currentBoxes = boxesMap[String(pageIdx)];

                                if (currentBoxes && currentBoxes.some(b => b.relative)) {
                                    setBoxesMap(prev => {
                                        const list = prev[String(pageIdx)].map(b => {
                                            if (!b.relative) return b;
                                            return {
                                                ...b,
                                                relative: false,
                                                x: b.x * nw,
                                                y: b.y * nh,
                                                w: b.w * nw,
                                                h: b.h * nh
                                            };
                                        });
                                        return { ...prev, [String(pageIdx)]: list };
                                    });
                                }
                            }}
                            style={{
                                width: fitWidth ? '100%' : 'auto',
                                maxWidth: 'unset',
                                pointerEvents: 'none',
                                userSelect: 'none'
                            }}
                        />
                    )}
                    {/* Tints: a plain layer right above the page image (no z-index, so no isolated stacking context) */}
                    {boxFill === 'tint' && (
                        <div aria-hidden="true" className="absolute inset-0 pointer-events-none">
                            {(boxesMap[String(pageIdx)] || []).map((box, i) => {
                                const sc = fitWidth && imgRef.current ? (imgRef.current.clientWidth / (imgRef.current.naturalWidth || 800)) : 1;
                                return <BoxFill key={i} color={BOX_COLORS[box.type === 'image' ? 'image' : 'text'].fill}
                                                rect={{ left: box.x * sc, top: box.y * sc, width: box.w * sc, height: box.h * sc }} />;
                            })}
                            {draftBox && (() => {
                                const sc = fitWidth && imgRef.current ? (imgRef.current.clientWidth / imgRef.current.naturalWidth) : 1;
                                return <BoxFill color={BOX_COLORS[draftBox.type === 'image' ? 'image' : 'text'].fill}
                                                rect={{ left: draftBox.x * sc, top: draftBox.y * sc, width: draftBox.w * sc, height: draftBox.h * sc }} />;
                            })()}
                        </div>
                    )}
                    {/* Overlay */}
                    <div className="absolute inset-0 z-10"
                        style={{ touchAction: 'none' }}
                        onPointerDown={handlePointerDown}
                        onPointerMove={handlePointerMove}
                        onPointerUp={handlePointerUp}
                        onPointerCancel={handlePointerUp}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {(boxesMap[String(pageIdx)] || []).map((box, i) => {
                            const isSelected = selectedBoxIdx === i;
                            const naturalW = imgRef.current?.naturalWidth || 800;
                            const scale = fitWidth && imgRef.current ? (imgRef.current.clientWidth / naturalW) : 1;
                            const col = BOX_COLORS[box.type === 'image' ? 'image' : 'text'];
                            const typeLabel = box.type === 'image' ? 'Image' : 'Text';

                            return (
                                <div key={i}
                                    tabIndex={0}
                                    role="button"
                                    aria-label={`${typeLabel} box ${i + 1} of ${(boxesMap[String(pageIdx)] || []).length}${isSelected ? ', selected' : ''}`}
                                    aria-pressed={isSelected}
                                    onFocus={() => { if (selectedBoxIdx !== i) setSelectedBoxIdx(i); }}
                                    className={`wr-box absolute border-2 flex items-center justify-center group focus-visible:ring-4 focus-visible:ring-white ${box.type === 'image' ? 'border-dotted' : 'border-solid'}`}
                                    style={{
                                        left: box.x * scale,
                                        top: box.y * scale,
                                        width: box.w * scale,
                                        height: box.h * scale,
                                        borderColor: isSelected ? col.selected : col.border,
                                        zIndex: isSelected ? 20 : 10,
                                        cursor: 'move'
                                    }}>
                                    {/* Small label above the box. Only the selected box spells out its type (the border style also differs:
                                        image boxes are dotted), so the labels cover as little of the page as possible. */}
                                    <div className={`absolute -top-4 left-0 text-[10px] leading-4 px-1 font-bold rounded-sm text-white ${isSelected ? 'ring-1 ring-white' : ''}`}
                                         style={{ backgroundColor: col.label }}>{isSelected ? `${i + 1} ${typeLabel}` : i + 1}</div>
                                    {isSelected && (<><div aria-hidden="true" style={HS} className="absolute -top-1.5 -left-1.5 w-3 h-3 bg-white border border-gray-500 cursor-nw-resize hover:bg-blue-200"></div><div aria-hidden="true" style={HS} className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-white border border-gray-500 cursor-ne-resize hover:bg-blue-200"></div><div aria-hidden="true" style={HS} className="absolute -bottom-1.5 -left-1.5 w-3 h-3 bg-white border border-gray-500 cursor-sw-resize hover:bg-blue-200"></div><div aria-hidden="true" style={HS} className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-white border border-gray-500 cursor-se-resize hover:bg-blue-200"></div>{isTouchUI && (<div aria-hidden="true" className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/90 border-2 border-blue-700 text-blue-800 flex items-center justify-center pointer-events-none" style={{ width: 44, height: 44 }}><Move size={22} /></div>)}</>)}
                                </div>
                            );
                        })}
                        {draftBox && (() => {
                            const col = BOX_COLORS[draftBox.type === 'image' ? 'image' : 'text'];
                            const sc = fitWidth && imgRef.current ? (imgRef.current.clientWidth / imgRef.current.naturalWidth) : 1;
                            return (
                                <div className="wr-box absolute border-2 border-dashed"
                                    style={{ left: draftBox.x * sc, top: draftBox.y * sc, width: draftBox.w * sc, height: draftBox.h * sc,
                                             borderColor: col.border, pointerEvents: 'none' }} />
                            );
                        })()}
                    </div>
                </div>
            </div>
        </Modal>
    );
};

export default PdfManualEditor;
