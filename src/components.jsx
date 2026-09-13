import React, { useRef, useEffect } from 'react';
import { Clapperboard, X } from 'lucide-react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import { statusLabels } from './lib';
gsap.registerPlugin(useGSAP);
export function Brand() { return <div className="brand"><span className="brand-icon"><Clapperboard size={23}/></span><span>orangie<span className="brand-dot">.</span><small>CLIP ROOM</small></span></div>; }
export function Status({ status }) { return <span className={`status status-${status}`}>{statusLabels[status] || status}</span>; }
export function Modal({ title, children, close, wide = false }) {
  const ref = useRef();
  useEffect(() => { const dialog = ref.current; const previous = document.activeElement; dialog.showModal(); return () => { dialog.close(); previous?.focus?.(); }; }, []);
  return <dialog ref={ref} aria-label={title} className={`modal ${wide ? 'wide' : ''}`} onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === ref.current) close(); }}><div className="modal-inner"><div className="modal-heading"><h2>{title}</h2><button className="icon-button" onClick={close} aria-label="Close dialog"><X size={20}/></button></div>{children}</div></dialog>;
}
export function PageTransition({ children, page }) {
  const ref = useRef();
  useGSAP(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    gsap.fromTo(ref.current, { opacity: 0.5, y: 7 }, { opacity: 1, y: 0, duration: 0.24, ease: 'power2.out', clearProps: 'all' });
  }, { scope: ref, dependencies: [page], revertOnUpdate: true });
  return <div ref={ref} className="page-content">{children}</div>;
}
