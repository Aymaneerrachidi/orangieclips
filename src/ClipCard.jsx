import React, { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, Film, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { Status } from './components';
import { bytes, postingLabels } from './lib';

const clock = n => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;

export default function ClipCard({ clip, open }) {
  const video = useRef(null);
  const active = useRef(false);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const stop = () => { active.current = false; video.current?.pause(); setMuted(true); };
  useEffect(() => {
    const hide = () => { if (document.hidden) stop(); };
    // A click can replace the play icon before the browser emits pointerleave.
    const leave = e => { if (active.current && e.pointerType === 'mouse' && !video.current?.closest('.media-stage')?.contains(e.target)) stop(); };
    document.addEventListener('pointermove', leave, { passive: true });
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('blur', stop);
    return () => { document.removeEventListener('pointermove', leave); document.removeEventListener('visibilitychange', hide); window.removeEventListener('blur', stop); };
  }, []);
  async function play() {
    active.current = true;
    try { await video.current?.play(); if (!active.current) video.current?.pause(); } catch { setPlaying(false); }
  }
  function hover() {
    if (window.matchMedia('(hover: hover) and (prefers-reduced-motion: no-preference)').matches) play();
  }
  function watch() { stop(); open(clip); }
  return <article className={`media-card ${playing ? 'is-playing' : ''}`}>
    <div className="media-stage" onPointerEnter={e => { if (e.pointerType === 'mouse') hover(); }} onPointerLeave={e => { if (e.pointerType === 'mouse') stop(); }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) stop(); }}>
      <button className="media-preview" onClick={watch} aria-label={`Preview ${clip.title}`}>
        {failed ? <div className="media-fallback"><Film size={38}/><span>Download to play this format</span></div> :
          <video ref={video} preload="metadata" muted={muted} loop playsInline src={`/api/clips/${clip.id}/preview#t=0.1`}
            onCanPlay={() => { if (active.current && video.current?.paused) play(); }}
            onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onError={() => setFailed(true)}
            onLoadedMetadata={e => { if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration); }}
            onTimeUpdate={e => setPosition(e.currentTarget.currentTime)}/>}
        <span className="media-play"><Play size={21} fill="currentColor"/></span>
        <span className="media-format">{clip.original_name.split('.').pop().toUpperCase()}</span>
        {duration > 0 && <span className="media-duration">{clock(duration)}</span>}
        <span className="media-watch">Open player<ArrowUpRight size={14}/></span>
      </button>
      {!failed && <div className="inline-controls" aria-label={`Playback controls for ${clip.title}`}>
        <button onClick={() => playing ? stop() : play()} aria-label={`${playing ? 'Pause' : 'Play'} inline preview`} title={playing ? 'Pause' : 'Play'}>{playing ? <Pause size={16}/> : <Play size={16}/>}</button>
        <button onClick={() => setMuted(v => !v)} aria-label={muted ? 'Unmute preview' : 'Mute preview'} title={muted ? 'Sound on' : 'Sound off'}>{muted ? <VolumeX size={16}/> : <Volume2 size={16}/>}</button>
        <input type="range" aria-label={`Seek ${clip.title}`} min="0" max={duration || 1} step="0.05" value={Math.min(position, duration || 1)} disabled={!duration} onChange={e => { video.current.currentTime = Number(e.target.value); setPosition(Number(e.target.value)); }}/>
        <span>{clock(position)}</span>
      </div>}
    </div>
    <div className="media-card-details"><div className="media-card-status"><Status status={clip.status}/><span>{bytes(clip.size)}</span></div>
      {clip.posting_tag&&<span className="posting-tag">{postingLabels[clip.posting_tag]}</span>}
      <button className="media-title" onClick={watch}>{clip.title}</button>
      {clip.review_note&&<button className="card-note" onClick={watch} aria-label={`Read note for ${clip.title}`}><strong>{clip.status==='not_posting'?'Why not posting: ':'Team note: '}</strong>{clip.review_note}</button>}
      <div className="media-card-footer"><span className="media-creator"><span className="avatar">{clip.creator[0]}</span>{clip.creator}</span>
        <a className="media-download" href={`/api/clips/${clip.id}/download`} download><ArrowDownToLine size={16}/><span>Download original</span></a>
      </div>
    </div>
  </article>;
}
