import React, { useEffect, useRef, useState } from 'react';
import { Upload, LoaderCircle } from 'lucide-react';
import { Modal } from './components';
import { bytes } from './lib';
import { uploadParts } from './cloudUpload';
export function UploadDialog({ day, close, onUploaded }) {
  const [file, setFile] = useState(null); const [title, setTitle] = useState(''); const [uploadDay, setUploadDay] = useState(day); const [progress, setProgress] = useState(null); const [error, setError] = useState(''); const [dragging, setDragging] = useState(false); const request = useRef(null); const submitting = useRef(false);
  useEffect(() => () => request.current?.abort(), []);
  function choose(file) { if (!file) return; if (!/\.(mp4|mov|webm|m4v)$/i.test(file.name)) return setError('Choose an MP4, MOV, M4V, or WebM video.'); if (file.size > 2 * 1024 ** 3) return setError('Choose a video smaller than 2 GB.'); setFile(file); setError(''); if (!title) setTitle(file.name.replace(/\.[^.]+$/, '').slice(0, 120)); }
  async function submit(e) {
    e.preventDefault(); if (submitting.current) return; if (!file) return setError('Choose a video first.'); setError(''); setProgress(0); submitting.current = true;
    const controller = new AbortController(); request.current = controller;
    try {
      const configResponse = await fetch('/api/upload-config', { signal: controller.signal });
      const config = await configResponse.json();
      if (!configResponse.ok) throw new Error(config.error || 'Could not start your upload.');
      if (!config.available) throw new Error('Video storage is not connected yet. Please ask Orangie to connect storage.');
      if (config.mode === 'cloud') {
        const send = async (url, body) => {
          const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
          const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Upload failed.'); return data;
        };
        const pending = await send('/api/uploads', { title, day: uploadDay, name: file.name, size: file.size });
        try {
          await uploadParts(pending, file, controller.signal, setProgress);
          await send(`/api/uploads/${pending.id}/complete`, {});
        } catch (error) {
          controller.abort();
          fetch(`/api/uploads/${pending.id}/cancel`, { method: 'POST', keepalive: true }).catch(() => {});
          throw error;
        }
        if (!controller.signal.aborted) onUploaded(uploadDay); return;
      }
    } catch (error) { submitting.current = false; if (error.name !== 'AbortError') { setError(error.message || 'Upload failed. Please try again.'); setProgress(null); } return; }
    const form = new FormData(); form.append('title', title); form.append('day', uploadDay); form.append('video', file);
    if (controller.signal.aborted) return;
    const xhr = new XMLHttpRequest(); controller.signal.addEventListener('abort', () => xhr.abort(), { once: true }); xhr.open('POST', '/api/clips');
    xhr.upload.onprogress = e => { if (e.lengthComputable) setProgress(Math.round(e.loaded / e.total * 100)); };
    xhr.onload = () => { submitting.current = false; if (controller.signal.aborted) return; if (xhr.status >= 200 && xhr.status < 300) onUploaded(uploadDay); else { try { setError(JSON.parse(xhr.responseText).error); } catch { setError('Upload failed. Please try again.'); } setProgress(null); } };
    xhr.onerror = () => { submitting.current = false; setError('Connection lost. Please try your upload again.'); setProgress(null); }; xhr.send(form);
  }
  return <Modal title="Add a clip" close={close} dismissOnBackdrop={false}><p className="modal-description">Your original file, ready for Orangie to download.</p><form onSubmit={submit} className="account-form"><label className={`dropzone ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); if (progress === null) choose(e.dataTransfer.files[0]); }}><input type="file" accept=".mp4,.mov,.webm,.m4v" onChange={e => choose(e.target.files[0])} disabled={progress !== null}/><span className="upload-icon"><Upload size={24}/></span><strong>{file ? file.name : 'Choose a video or drop it here'}</strong><span>{file ? bytes(file.size) : 'MP4, MOV, M4V or WebM · Up to 2 GB'}</span><small>No compression. No quality lost.</small></label><label>Clip title<input value={title} onChange={e => setTitle(e.target.value)} required maxLength={120} disabled={progress !== null} placeholder="Give this moment a name" autoComplete="off"/></label><label>Add to date<input type="date" value={uploadDay} onChange={e => setUploadDay(e.target.value)} required disabled={progress !== null}/></label>{error && <p className="error" role="alert">{error}</p>}{progress !== null && <div className="progress-wrap" role="status"><div><span>{progress === 100 ? 'Saving your clip…' : 'Uploading original file…'}</span><span>{progress}%</span></div><progress max="100" value={progress}/></div>}<button className="button primary" disabled={progress !== null}>{progress !== null ? <LoaderCircle className="spin" size={17}/> : <Upload size={17}/>} {progress !== null ? 'Uploading…' : 'Add clip'}</button></form></Modal>;
}
