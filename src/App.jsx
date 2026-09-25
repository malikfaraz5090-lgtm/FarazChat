import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import {
  ArrowLeft, Bell, Camera, Check, Download, FileText, ImagePlus, KeyRound, LockKeyhole,
  LogOut, MessageCircle, Moon, Paperclip, Plus, Search, Send, Settings, Shield, ShieldCheck,
  Smile, UserRound, UsersRound, X,
} from 'lucide-react';

const TOKEN_KEY = 'farazchat-token';

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

function apiUrl(path) {
  if (/^(https?:|blob:|data:)/.test(path)) return path;
  return apiBaseUrl ? `${apiBaseUrl}${path.startsWith('/') ? '' : '/'}${path}` : path;
}

async function api(path, token, options = {}) {
  const isFormData = options.body instanceof FormData;
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: {
      ...(options.body && !isFormData ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Something went wrong. Try again.');
  return result;
}

async function uploadAvatar(token, file) {
  const response = await fetch(apiUrl('/api/me/avatar'), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.type },
    body: file,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Could not upload your photo.');
  return result.user;
}

function relativeTime(date) {
  if (!date) return '';
  const parsed = new Date(`${date.replace(' ', 'T')}Z`);
  const now = new Date();
  if (parsed.toDateString() === now.toDateString()) {
    return parsed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return parsed.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function Avatar({ name = '?', src = '', large = false }) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => { setImageFailed(false); }, [src]);
  const imageUrl = src ? apiUrl(src) : '';
  return <div className={`avatar${large ? ' avatar-large' : ''}`} aria-hidden="true">{imageUrl && !imageFailed ? <img src={imageUrl} alt="" onError={() => setImageFailed(true)} /> : name.slice(0, 1).toUpperCase()}</div>;
}

function formatFileSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentCard({ attachment, token }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = '';
    fetch(apiUrl(attachment.url), {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    }).then((response) => {
      if (!response.ok) throw new Error('Attachment unavailable');
      return response.blob();
    }).then((blob) => {
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch((error) => {
      if (error.name !== 'AbortError') setFailed(true);
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.url, token]);

  if (failed) return <div className="attachment-unavailable">Attachment unavailable</div>;
  if (!url) return <div className="attachment-loading"><FileText size={17} /> Loading {attachment.name}…</div>;
  if (attachment.inline && attachment.type.startsWith('image/')) {
    return <a className="message-attachment-image" href={url} target="_blank" rel="noreferrer"><img src={url} alt={attachment.name} loading="lazy" /></a>;
  }
  if (attachment.type.startsWith('audio/')) {
    return <audio className="message-attachment-media" controls preload="metadata" src={url}>{attachment.name}</audio>;
  }
  if (attachment.type.startsWith('video/')) {
    return <video className="message-attachment-media" controls preload="metadata" src={url}>{attachment.name}</video>;
  }
  return <a className="message-file" href={url} download={attachment.name}><span className="file-icon"><FileText size={18} /></span><span><strong>{attachment.name}</strong><small>{formatFileSize(attachment.size)}</small></span><Download size={16} /></a>;
}

function ContactProfileModal({ token, person, online, savedName, onClose, onSaveContact }) {
  const [nickname, setNickname] = useState(savedName || person.saved_as || person.display_name || person.username);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function saveContact(event) {
    event.preventDefault();
    const value = nickname.trim();
    if (!value) {
      setError('Enter a name to save this contact.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSaveContact(person, value);
      onClose();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="contact-profile-modal" role="dialog" aria-modal="true" aria-label={`${person.profile_name || person.display_name || person.username} profile`}>
        <button className="icon-button contact-profile-close" onClick={onClose} aria-label="Close profile"><X size={19} /></button>
        <Avatar name={person.profile_name || person.display_name || person.username} src={person.avatar_url} large />
        <h2>{person.profile_name || person.display_name || person.username}</h2>
        <span className="contact-profile-username">#{person.contact_code || person.username}</span>
        <span className={`contact-profile-status${online ? ' contact-is-online' : ''}`}><i />{online ? 'Online' : 'Offline'}</span>
        <p>{person.bio || 'No bio yet.'}</p>
        <form className="save-contact-form" onSubmit={saveContact}><label htmlFor="saved-contact-name">Save this contact as</label><input id="saved-contact-name" className="profile-input" value={nickname} onChange={(event) => setNickname(event.target.value)} maxLength={40} required /><button className="primary-button" disabled={busy}>{busy ? 'Saving…' : savedName ? 'Update saved name' : 'Save contact'}</button>{error && <span className="form-error" role="alert">{error}</span>}</form>
      </section>
    </div>
  );
}

function AuthScreen({ onLogin }) {
  const [screen, setScreen] = useState('welcome');
  const [registerStep, setRegisterStep] = useState(1);
  const [displayName, setDisplayName] = useState('');
  const [contactCode, setContactCode] = useState('');
  const [bio, setBio] = useState('');
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [policiesAccepted, setPoliciesAccepted] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!photoPreview.startsWith('blob:')) return undefined;
    return () => URL.revokeObjectURL(photoPreview);
  }, [photoPreview]);

  function selectPhoto(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) {
      setError('Choose a JPEG, PNG, or WebP photo under 2 MB.');
      event.target.value = '';
      return;
    }
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
    setError('');
  }

  function continueRegistration() {
    setError('');
    if (registerStep === 1 && !/^\d{8}$/.test(contactCode)) {
      setError('Enter a valid 8-digit code.');
      return;
    }
    if (registerStep === 2) {
      if (password.length < 8 || password.length > 72) {
        setError('Password must be between 8 and 72 characters.');
        return;
      }
      if (password !== confirmPassword) {
        setError('Your passwords do not match.');
        return;
      }
    }
    if (registerStep === 3 && !displayName.trim()) {
      setError('Enter your profile name to continue.');
      return;
    }
    setRegisterStep((step) => Math.min(step + 1, 4));
  }

  async function submit(event) {
    event.preventDefault();
    if (screen === 'register' && !policiesAccepted) return setError('Please accept the account policies to finish registration.');
    setError('');
    setBusy(true);
    try {
      const isRegister = screen === 'register';
      const result = await api(`/api/auth/${isRegister ? 'register' : 'login'}`, null, {
        method: 'POST',
        body: JSON.stringify(isRegister
          ? { contactCode, password, displayName, bio, policiesAccepted }
          : { code: contactCode, password }),
      });
      if (isRegister && photoFile) {
        result.user = await uploadAvatar(result.token, photoFile);
      }
      onLogin(result);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-topline"><a className="brand" href="#"><img className="brand-mark-image" src="/farazchat-mark.svg" alt="" /><span>Faraz<span className="brand-light">Chat</span></span></a><span className="private-note"><LockKeyhole size={13} /> PRIVATE MESSAGING</span></div>
      <section className="auth-content">
        <div className="auth-copy">
          <div className="eyebrow"><span className="live-dot" /> YOUR PEOPLE, RIGHT HERE</div>
          <h1>Good conversations<br />start with <span>hello.</span></h1>
          <p>A quieter place for the people you want to keep close. Find them by their 8-digit contact code and pick up the conversation.</p>
          <div className="auth-footnote"><ShieldCheck size={17} /><span>Accounts and messages stay on your FarazChat server.</span></div>
        </div>
        <div className="auth-form-wrap">
          {screen === 'welcome' && <div className="auth-choice-screen"><span className="form-icon"><MessageCircle size={19} /></span><h2>Welcome to FarazChat</h2><p>Choose how you want to continue.</p><button className="primary-button" onClick={() => setScreen('register')}>Create account <span>→</span></button><button className="secondary-button" onClick={() => setScreen('login')}>Log in <span>→</span></button></div>}
          {screen === 'login' && <>
            <div className="auth-form-heading"><span className="form-icon"><LockKeyhole size={19} /></span><div><h2>Log in</h2><p>Enter your 8-digit contact code and password.</p></div></div>
            <form className="auth-form" onSubmit={submit}>
              <label htmlFor="login-code">8-digit contact code</label>
              <div className="field-with-icon"><UserRound size={17} /><input id="login-code" autoComplete="username" value={contactCode} onChange={(event) => setContactCode(event.target.value.trim().slice(0, 24))} placeholder="8-digit contact code" maxLength={24} required /></div>
              <p className="auth-hint">Older accounts can still use their previous username.</p>
              <label htmlFor="login-password">Password</label>
              <div className="field-with-icon"><LockKeyhole size={17} /><input id="login-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" placeholder="Your password" required /></div>
              {error && <p className="form-error" role="alert">{error}</p>}
              <button className="primary-button auth-submit" disabled={busy}>{busy ? 'Signing in…' : 'Log in'}<span>→</span></button>
            </form>
            <button className="auth-back-button" onClick={() => { setScreen('welcome'); setError(''); }}>← Back</button>
          </>}
          {screen === 'register' && <>
            <div className="register-progress"><span>STEP {registerStep} OF 4</span><div><i style={{ width: `${registerStep * 25}%` }} /></div><button onClick={() => { setScreen('welcome'); setRegisterStep(1); setError(''); }}>Cancel</button></div>
            <form className="auth-form register-step-form" onSubmit={registerStep === 4 ? submit : (event) => { event.preventDefault(); continueRegistration(); }}>
              {registerStep === 1 && <>
                <div className="auth-form-heading"><span className="form-icon"><UserRound size={19} /></span><div><h2>Choose your code</h2><p>People will use this unique code to find you.</p></div></div>
                <label htmlFor="register-code">8-digit contact code</label>
                <div className="field-with-icon"><span className="code-prefix">#</span><input id="register-code" inputMode="numeric" autoComplete="off" value={contactCode} onChange={(event) => setContactCode(event.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="8 numbers" pattern="[0-9]{8}" minLength={8} maxLength={8} required /></div>
                <p className="auth-hint">Use this code to log in and let friends find you.</p>
              </>}
              {registerStep === 2 && <>
                <div className="auth-form-heading"><span className="form-icon"><LockKeyhole size={19} /></span><div><h2>Secure your account</h2><p>Choose a password and confirm it.</p></div></div>
                <label htmlFor="register-password">Password</label>
                <div className="field-with-icon"><LockKeyhole size={17} /><input id="register-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" placeholder="At least 8 characters" minLength={8} maxLength={72} required /></div>
                <label htmlFor="register-password-confirm">Confirm password</label>
                <div className="field-with-icon"><LockKeyhole size={17} /><input id="register-password-confirm" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" placeholder="Enter it again" minLength={8} maxLength={72} required /></div>
              </>}
              {registerStep === 3 && <>
                <div className="auth-form-heading"><span className="form-icon"><Camera size={19} /></span><div><h2>Make it yours</h2><p>Add your name and a profile photo.</p></div></div>
                <div className="signup-photo-row"><Avatar name={displayName || contactCode} src={photoPreview} large /><label className="photo-pick-button"><Camera size={15} /> Add profile photo<input type="file" accept="image/jpeg,image/png,image/webp" onChange={selectPhoto} /></label><span>Optional · up to 2 MB</span></div>
                <label htmlFor="display-name">Your name</label>
                <div className="field-with-icon"><UserRound size={17} /><input id="display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" placeholder="Your name" maxLength={40} required /></div>
              </>}
              {registerStep === 4 && <>
                <div className="auth-form-heading"><span className="form-icon"><ShieldCheck size={19} /></span><div><h2>One last thing</h2><p>Add a short bio and review the policies.</p></div></div>
                <label htmlFor="register-bio">Bio <span className="optional-label">OPTIONAL</span></label>
                <textarea className="profile-textarea signup-bio" id="register-bio" value={bio} onChange={(event) => setBio(event.target.value)} placeholder="A little about you" maxLength={160} />
                <div className="account-policies"><strong>Before you join</strong><ul><li>Your password cannot be recovered. Keep it somewhere safe.</li><li>Your 8-digit code is how other members find you.</li><li>Messages and files are stored on this app’s server, not end-to-end encrypted.</li><li>Status updates disappear after 24 hours. Use privacy settings to control search visibility.</li></ul></div>
                <label className="policy-consent"><input type="checkbox" checked={policiesAccepted} onChange={(event) => setPoliciesAccepted(event.target.checked)} /><span>I understand and agree to these account policies.</span></label>
              </>}
              {error && <p className="form-error" role="alert">{error}</p>}
              <div className="register-step-actions">{registerStep > 1 && <button type="button" className="secondary-button" onClick={() => { setError(''); setRegisterStep((step) => step - 1); }}>Back</button>}<button type="submit" className="primary-button auth-submit" disabled={busy || (registerStep === 4 && !policiesAccepted)}>{busy ? 'Creating…' : registerStep === 4 ? 'Create account' : 'Continue'}<span>→</span></button></div>
            </form>
          </>}
          {screen !== 'welcome' && <p className="auth-mode-switch">{screen === 'login' ? 'New to FarazChat?' : 'Already registered?'} <button onClick={() => { setScreen(screen === 'login' ? 'register' : 'login'); setRegisterStep(1); setError(''); }}> {screen === 'login' ? 'Create account' : 'Log in'}</button></p>}
        </div>
      </section>
      <footer className="auth-footer"><span>FARAZCHAT</span><span>Made for the conversations that matter.</span><span>YOUR SPACE, YOUR PEOPLE</span></footer>
    </main>
  );
}

function NewChatModal({ token, onClose, onSelect }) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState([]);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    let alive = true;
    if (!/^\d{8}$/.test(query.trim())) {
      setUsers([]);
      setError('');
      return () => { alive = false; };
    }
    const timer = setTimeout(async () => {
      try {
        const result = await api(`/api/users/search?q=${encodeURIComponent(query.trim())}`, token);
        if (alive) { setUsers(result.users); setError(''); }
      } catch (requestError) {
        if (alive) setError(requestError.message);
      }
    }, 180);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, token]);

  return (
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="new-chat-modal" role="dialog" aria-modal="true" aria-labelledby="new-chat-title">
        <div className="modal-heading"><div><span className="modal-kicker">START A CONVERSATION</span><h2 id="new-chat-title">New chat</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button></div>
        <label className="search-field modal-search"><Search size={17} /><input ref={inputRef} inputMode="numeric" value={query} onChange={(event) => setQuery(event.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="Enter full 8-digit code" maxLength={8} /></label>
        <div className="search-results" aria-live="polite">
          {!/^\d{8}$/.test(query.trim()) && <div className="search-empty"><span className="search-empty-icon"><UserRound size={21} /></span><strong>Find your people</strong><span>Enter the complete 8-digit contact code.</span></div>}
          {error && <p className="form-error search-error">{error}</p>}
          {/^\d{8}$/.test(query.trim()) && !error && users.length === 0 && <div className="search-empty"><span className="search-empty-icon"><Search size={20} /></span><strong>No account for that code</strong><span>Check all 8 digits and try again.</span></div>}
          {users.map((person) => <button className="result-user" key={person.id} onClick={() => onSelect(person)}><Avatar name={person.display_name || person.username} src={person.avatar_url} /><span className="result-user-name"><strong>{person.display_name || person.username}</strong><span>#{person.contact_code || person.username}{person.bio ? ` · ${person.bio}` : ''}</span></span><span className="result-arrow">↗</span></button>)}
        </div>
      </section>
    </div>
  );
}

function GroupModal({ token, onClose, onCreate }) {
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState(() => new Map());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!/^\d{8}$/.test(query.trim())) {
      setUsers([]);
      return () => { alive = false; };
    }
    const timer = setTimeout(async () => {
      try {
        const result = await api(`/api/users/search?q=${encodeURIComponent(query.trim())}`, token);
        if (alive) { setUsers(result.users); setError(''); }
      } catch (requestError) {
        if (alive) setError(requestError.message);
      }
    }, 180);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, token]);

  function toggleMember(user) {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(user.id)) next.delete(user.id);
      else if (next.size < 49) next.set(user.id, user);
      return next;
    });
  }

  async function createGroup(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await api('/api/groups', token, {
        method: 'POST',
        body: JSON.stringify({ name, memberIds: [...selected.keys()] }),
      });
      onCreate(result.group);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="new-chat-modal group-create-modal" role="dialog" aria-modal="true" aria-labelledby="group-title">
        <div className="modal-heading"><div><span className="modal-kicker">BRING EVERYONE TOGETHER</span><h2 id="group-title">New group</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button></div>
        <form className="group-create-form" onSubmit={createGroup}>
          <label htmlFor="group-name">Group name</label>
          <input className="profile-input" id="group-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Weekend plans" maxLength={40} required />
          <label className="search-field modal-search group-search"><Search size={17} /><input inputMode="numeric" value={query} onChange={(event) => setQuery(event.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="Find by 8-digit code" maxLength={8} /></label>
          <div className="group-selected"><strong>{selected.size} selected</strong>{[...selected.values()].map((person) => <button key={person.id} type="button" onClick={() => toggleMember(person)}>{person.display_name || person.username}<X size={13} /></button>)}</div>
          <div className="group-user-results" aria-live="polite">
            {!/^\d{8}$/.test(query.trim()) && <span className="group-search-hint">Enter the complete 8-digit code to add someone.</span>}
            {users.map((person) => <button type="button" key={person.id} className={`group-user-result${selected.has(person.id) ? ' is-selected' : ''}`} onClick={() => toggleMember(person)}><Avatar name={person.display_name || person.username} src={person.avatar_url} /><span><strong>{person.display_name || person.username}</strong><small>#{person.contact_code || person.username}</small></span><span className="member-check">{selected.has(person.id) ? '✓' : '+'}</span></button>)}
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button group-create-submit" disabled={busy || selected.size === 0}>{busy ? 'Creating…' : `Create group${selected.size ? ` · ${selected.size + 1} members` : ''}`}</button>
        </form>
      </section>
    </div>
  );
}

function StatusComposerModal({ token, onClose, onPublished }) {
  const [body, setBody] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef(null);
  const emojis = ['😀', '😂', '😍', '🥰', '😎', '🎉', '❤️', '🔥', '🙏', '✨', '👍', '😊'];

  useEffect(() => {
    if (!preview) return undefined;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);

  function chooseMedia(event) {
    const selectedFile = event.target.files?.[0];
    event.target.value = '';
    if (!selectedFile) return;
    if ((!selectedFile.type.startsWith('image/') && !selectedFile.type.startsWith('video/'))
      || selectedFile.size > 15 * 1024 * 1024) {
      setError('Choose an image or video under 15 MB.');
      return;
    }
    setError('');
    setFile(selectedFile);
    setPreview(URL.createObjectURL(selectedFile));
  }

  function insertEmoji(emoji) {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? body.length;
    const end = textarea?.selectionEnd ?? body.length;
    const nextBody = `${body.slice(0, start)}${emoji}${body.slice(end)}`;
    if (nextBody.length > 700) return;
    setBody(nextBody);
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  }

  async function submit(event) {
    event.preventDefault();
    if (!body.trim() && !file) {
      setError('Add some text or a photo/video first.');
      return;
    }
    setBusy(true);
    setError('');
    const formData = new FormData();
    formData.append('body', body.trim());
    if (file) formData.append('file', file);
    try {
      await api('/api/statuses', token, { method: 'POST', body: formData });
      onPublished();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="new-chat-modal status-composer-modal" role="dialog" aria-modal="true" aria-labelledby="status-composer-title">
        <div className="modal-heading"><div><span className="modal-kicker">DISAPPEARS AFTER 24 HOURS</span><h2 id="status-composer-title">Add a status</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button></div>
        <form className="status-composer-form" onSubmit={submit}>
          <div className="status-text-heading"><label htmlFor="status-text">Your update</label><button type="button" className="icon-button" onClick={() => setEmojiOpen((open) => !open)} aria-label="Add emoji" title="Add emoji"><Smile size={19} /></button></div>
          <textarea ref={textareaRef} id="status-text" value={body} onChange={(event) => setBody(event.target.value)} maxLength={700} placeholder="What’s happening?" aria-label="Status text" />
          {emojiOpen && <div className="status-emoji-picker" aria-label="Choose an emoji">{emojis.map((emoji) => <button key={emoji} type="button" onClick={() => insertEmoji(emoji)} aria-label={`Insert ${emoji}`}>{emoji}</button>)}</div>}
          {preview && <div className="status-preview">{file?.type.startsWith('video/') ? <video src={preview} controls /> : <img src={preview} alt="Status preview" />}<button type="button" className="icon-button" onClick={() => { setFile(null); setPreview(''); }}>×</button></div>}
          <div className="status-composer-actions"><label className="photo-pick-button"><Camera size={15} /> Add photo/video<input type="file" accept="image/*,video/*" onChange={chooseMedia} /></label><span>{body.length}/700</span><button className="primary-button" disabled={busy}>{busy ? 'Sharing…' : 'Share status'}</button></div>
          {error && <p className="form-error" role="alert">{error}</p>}
        </form>
      </section>
    </div>
  );
}

function StatusViewerModal({ token, update, onClose, onDelete }) {
  const [index, setIndex] = useState(0);
  const [error, setError] = useState('');
  const status = update.statuses[index];
  const canGoBack = index > 0;
  const canGoForward = index < update.statuses.length - 1;

  useEffect(() => {
    if (status && !update.own) api(`/api/statuses/${status.id}/view`, token, { method: 'POST' }).catch(() => {});
  }, [status?.id, token, update.own]);

  async function deleteStatus() {
    try {
      await api(`/api/statuses/${status.id}`, token, { method: 'DELETE' });
      onDelete(status.id);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  return (
    <div className="modal-scrim status-viewer-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="status-viewer" role="dialog" aria-modal="true" aria-label={`${update.user.display_name}'s status`}>
        <header><Avatar name={update.user.display_name || update.user.username} src={update.user.avatar_url} /><span><strong>{update.own ? 'My status' : update.user.display_name || update.user.username}</strong><small>{new Date(status.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small></span><button className="icon-button" onClick={onClose} aria-label="Close status"><X size={19} /></button></header>
        <div className="status-progress"><i style={{ width: `${((index + 1) / update.statuses.length) * 100}%` }} /></div>
        <main>{status.attachment && <AttachmentCard attachment={status.attachment} token={token} />}{status.body && <p>{status.body}</p>}</main>
        <footer>{canGoBack && <button onClick={() => setIndex(index - 1)}>Previous</button>}<span>{index + 1} / {update.statuses.length}</span>{canGoForward && <button onClick={() => setIndex(index + 1)}>Next</button>}{update.own && <button className="status-delete" onClick={deleteStatus}>Delete</button>}</footer>
        {error && <p className="form-error">{error}</p>}
      </section>
    </div>
  );
}

function GroupDetailsModal({ token, group, onClose }) {
  const [members, setMembers] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    api(`/api/groups/${group.id}`, token).then((result) => {
      if (alive) setMembers(result.members);
    }).catch((requestError) => { if (alive) setError(requestError.message); });
    return () => { alive = false; };
  }, [group.id, token]);

  return (
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="contact-profile-modal group-details-modal" role="dialog" aria-modal="true" aria-label={`${group.name} group details`}>
        <button className="icon-button contact-profile-close" onClick={onClose} aria-label="Close group details"><X size={19} /></button>
        <span className="group-details-icon"><UsersRound size={28} /></span><h2>{group.name}</h2><span className="contact-profile-username">{members.length || group.member_count} members</span>
        <div className="group-member-list">{members.map((member) => <div key={member.id}><Avatar name={member.display_name || member.username} src={member.avatar_url} /><span><strong>{member.display_name || member.username}</strong><small>#{member.contact_code || member.username}{member.role === 'admin' ? ' · admin' : ''}</small></span></div>)}</div>
        {error && <p className="form-error">{error}</p>}
      </section>
    </div>
  );
}

function SettingsModal({ token, user, initialSection, onClose, onSave, onSignOut }) {
  const [section, setSection] = useState(initialSection);
  const [displayName, setDisplayName] = useState(user.display_name || user.username);
  const [bio, setBio] = useState(user.bio || '');
  const [notificationsEnabled, setNotificationsEnabled] = useState(Boolean(user.notifications_enabled));
  const [discoverable, setDiscoverable] = useState(user.discoverable !== false);
  const [darkMode, setDarkMode] = useState(Boolean(user.dark_mode));
  const [photoPreview, setPhotoPreview] = useState(user.avatar_url || '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const sections = [
    { id: 'profile', label: 'Profile', icon: UserRound },
    { id: 'privacy', label: 'Privacy', icon: Shield },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'appearance', label: 'Appearance', icon: Moon },
    { id: 'account', label: 'Account', icon: KeyRound },
  ];

  async function requestNotifications(event) {
    const enabled = event.target.checked;
    setError('');
    if (enabled) {
      if (!('Notification' in window)) {
        setError('This browser does not support desktop notifications.');
        return;
      }
      try {
        const permission = Notification.permission === 'default'
          ? await Notification.requestPermission()
          : Notification.permission;
        if (permission !== 'granted') {
          setError('Allow notifications in your browser settings to turn this on.');
          return;
        }
      } catch {
        setError('Could not request notification permission from this browser.');
        return;
      }
    }
    setNotificationsEnabled(enabled);
  }

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await api('/api/me', token, {
        method: 'PATCH',
        body: JSON.stringify({ displayName, bio, notificationsEnabled, discoverable, darkMode }),
      });
      onSave(result.user);
      setNotice('Settings saved.');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function selectPhoto(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) {
      setError('Choose a JPEG, PNG, or WebP photo under 2 MB.');
      return;
    }
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const profile = await uploadAvatar(token, file);
      setPhotoPreview(profile.avatar_url);
      onSave(profile);
      setNotice('Profile photo updated.');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(event) {
    event.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await api('/api/me/password', token, {
        method: 'PATCH',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setNotice('Password changed.');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  function chooseSection(nextSection) {
    setSection(nextSection);
    setError('');
    setNotice('');
  }

  return (
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-header"><div><span className="modal-kicker">FARAZCHAT</span><h2 id="settings-title">Settings</h2><p>#{user.contact_code || user.username}</p></div><button className="icon-button" onClick={onClose} aria-label="Close settings"><X size={19} /></button></header>
        <nav className="settings-nav" aria-label="Settings sections">
          {sections.map(({ id, label, icon: Icon }) => <button key={id} className={`settings-nav-item${section === id ? ' settings-nav-active' : ''}`} onClick={() => chooseSection(id)}><Icon size={17} /><span>{label}</span></button>)}
        </nav>
        <div className="settings-content">
          <div className="settings-section-heading"><span className="modal-kicker">{sections.find((item) => item.id === section)?.label.toUpperCase()}</span><h3>{section === 'profile' ? 'Your profile' : section === 'privacy' ? 'Privacy' : section === 'notifications' ? 'Notifications' : section === 'appearance' ? 'Appearance' : 'Account security'}</h3></div>
          {section === 'profile' && <form className="settings-form" onSubmit={submit}>
            <label className="photo-picker" title="Change profile photo"><Avatar name={displayName || user.username} src={photoPreview} large /><span><Camera size={15} /> Change photo</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={selectPhoto} /></label>
            <div className="settings-field"><label htmlFor="edit-display-name">Profile name</label><input className="profile-input" id="edit-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={40} required /></div>
            <div className="settings-field"><label htmlFor="edit-bio">Bio</label><textarea className="profile-textarea" id="edit-bio" value={bio} onChange={(event) => setBio(event.target.value)} placeholder="A little about you" maxLength={160} /><span className="bio-counter">{bio.length}/160</span></div>
            <button className="primary-button settings-save" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>
          </form>}
          {section === 'privacy' && <div className="settings-panel"><div className="settings-row"><span className="setting-icon"><Search size={17} /></span><span className="notification-setting-copy"><strong>Find me by contact code</strong><span>{discoverable ? 'Other members can find you using your full 8-digit code.' : 'You will not appear in code search.'}</span></span><label className="switch-control" aria-label="Find me by contact code"><input type="checkbox" checked={discoverable} onChange={(event) => setDiscoverable(event.target.checked)} /><span className="switch-track" /></label></div><button className="primary-button settings-save" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save privacy settings'}</button></div>}
          {section === 'notifications' && <div className="settings-panel"><div className="settings-row"><span className="setting-icon"><Bell size={17} /></span><span className="notification-setting-copy"><strong>Desktop message notifications</strong><span>Show alerts when the app is open but the conversation is not active. Browser permission is required.</span></span><label className="switch-control" aria-label="Message notifications"><input type="checkbox" checked={notificationsEnabled} onChange={requestNotifications} /><span className="switch-track" /></label></div><button className="primary-button settings-save" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save notification settings'}</button></div>}
          {section === 'appearance' && <div className="settings-panel"><div className="settings-row"><span className="setting-icon"><Moon size={17} /></span><span className="notification-setting-copy"><strong>Dark mode</strong><span>Use a darker color scheme for the chat and settings.</span></span><label className="switch-control" aria-label="Dark mode"><input type="checkbox" checked={darkMode} onChange={(event) => setDarkMode(event.target.checked)} /><span className="switch-track" /></label></div><button className="primary-button settings-save" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save appearance'}</button></div>}
          {section === 'account' && <div className="settings-panel"><div className="account-identity"><span className="setting-icon"><UserRound size={17} /></span><span className="notification-setting-copy"><strong>#{user.contact_code || user.username}</strong><span>Your contact code is how others find you.</span></span></div><form className="settings-form password-form" onSubmit={changePassword}><h4>Change password</h4><div className="settings-field"><label htmlFor="current-password">Current password</label><input className="profile-input" type="password" id="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required /></div><div className="settings-field"><label htmlFor="new-password">New password</label><input className="profile-input" type="password" id="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={8} maxLength={72} autoComplete="new-password" required /></div><button className="primary-button settings-save" disabled={busy}>{busy ? 'Updating…' : 'Update password'}</button></form>{confirmSignOut ? <div className="signout-confirm" role="alertdialog" aria-label="Confirm sign out"><strong>Sign out of this account?</strong><span>You can sign back in with your contact code and password.</span><div><button className="cancel-button" onClick={() => setConfirmSignOut(false)}>Cancel</button><button className="confirm-signout-button" onClick={onSignOut}>Sign out</button></div></div> : <button className="signout-button" onClick={() => setConfirmSignOut(true)}><LogOut size={16} /> Sign out</button>}</div>}
          {error && <p className="form-error settings-feedback" role="alert">{error}</p>}
          {notice && <p className="settings-success" role="status">{notice}</p>}
        </div>
        <span className="settings-footer">FarazChat · Version 1.0</span>
      </section>
    </div>
  );
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(Boolean(localStorage.getItem(TOKEN_KEY)));
  const [conversations, setConversations] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [groups, setGroups] = useState([]);
  const [inboxView, setInboxView] = useState('chats');
  const [statusUpdates, setStatusUpdates] = useState([]);
  const [active, setActive] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [statusComposerOpen, setStatusComposerOpen] = useState(false);
  const [activeStatus, setActiveStatus] = useState(null);
  const [groupDetailsOpen, setGroupDetailsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState('profile');
  const [contactProfileOpen, setContactProfileOpen] = useState(false);
  const [mobileChat, setMobileChat] = useState(false);
  const [socketReady, setSocketReady] = useState(false);
  const [onlineUsers, setOnlineUsers] = useState(() => new Set());
  const [contactTyping, setContactTyping] = useState(false);
  const [typingName, setTypingName] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [error, setError] = useState('');
  const messageEndRef = useRef(null);
  const socketRef = useRef(null);
  const activeRef = useRef(active);
  const typingTimerRef = useRef(null);
  const photoInputRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => { activeRef.current = active; }, [active]);

  useEffect(() => {
    if (!token) { setLoading(false); return; }
    let alive = true;
    api('/api/me', token).then((result) => {
      if (alive) setUser(result.user);
    }).catch(() => {
      localStorage.removeItem(TOKEN_KEY);
      if (alive) { setToken(null); setUser(null); }
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [token]);

  async function loadConversations() {
    if (!token) return;
    const [directResult, groupResult, contactResult] = await Promise.all([
      api('/api/conversations', token),
      api('/api/groups', token),
      api('/api/contacts', token),
    ]);
    setConversations(directResult.conversations);
    setGroups(groupResult.groups);
    setContacts(contactResult.contacts);
  }

  async function loadStatuses() {
    if (!token) return;
    const result = await api('/api/statuses', token);
    setStatusUpdates(result.updates);
  }

  useEffect(() => {
    if (!token || !user) return;
    let alive = true;
    loadConversations().catch((loadError) => { if (alive) setError(loadError.message); });
    const socket = io(apiBaseUrl || undefined, { auth: { token } });
    socketRef.current = socket;
    socket.on('connect', () => setSocketReady(true));
    socket.on('disconnect', () => setSocketReady(false));
    socket.on('presence:sync', (userIds) => setOnlineUsers(new Set(userIds)));
    socket.on('presence:update', ({ userId, online }) => {
      setOnlineUsers((current) => {
        const next = new Set(current);
        if (online) next.add(userId);
        else next.delete(userId);
        return next;
      });
    });
    socket.on('typing', (typingEvent) => {
      const { userId, isTyping, groupId, username } = typingEvent;
      const selected = activeRef.current;
      const matches = selected?.kind === 'group'
        ? selected.id === groupId
        : selected?.id === userId;
      if (!matches) return;
      setContactTyping(isTyping);
      setTypingName(isTyping ? (username || '') : '');
      clearTimeout(typingTimerRef.current);
      if (isTyping) typingTimerRef.current = setTimeout(() => {
        setContactTyping(false);
        setTypingName('');
      }, 2200);
    });
    socket.on('message', (message) => {
      const selected = activeRef.current;
      const matches = selected?.kind === 'group'
        ? message.group_id === selected.id
        : !message.group_id && selected?.id === (message.sender_id === user.id ? message.recipient_id : message.sender_id);
      if (matches) {
        setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
      }
      if (message.sender_id !== user.id && user.notifications_enabled
        && (document.hidden || activeRef.current?.id !== message.sender_id)
        && 'Notification' in window && Notification.permission === 'granted') {
        new Notification(message.sender_username || 'New message', {
          body: message.body,
          tag: `farazchat-${message.sender_id}`,
        });
      }
      loadConversations().catch(() => {});
    });
    socket.on('group:created', (group) => {
      setGroups((current) => current.some((item) => item.id === group.id) ? current : [group, ...current]);
    });
    socket.on('status:new', () => loadStatuses().catch(() => {}));
    return () => {
      alive = false;
      socket.disconnect();
      socketRef.current = null;
      clearTimeout(typingTimerRef.current);
    };
  }, [token, user]);

  useEffect(() => {
    if (inboxView !== 'status' || !token) return;
    loadStatuses().catch((loadError) => setError(loadError.message));
  }, [inboxView, token]);

  useEffect(() => {
    if (!active || !token) { setMessages([]); return; }
    let alive = true;
    const historyPath = active.kind === 'group'
      ? `/api/groups/${active.id}/messages`
      : `/api/conversations/${active.id}/messages`;
    api(historyPath, token).then((result) => {
      if (alive) setMessages(result.messages);
    }).catch((loadError) => { if (alive) setError(loadError.message); });
    return () => { alive = false; };
  }, [active, token]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  function handleLogin(result) {
    localStorage.setItem(TOKEN_KEY, result.token);
    setToken(result.token);
    setUser(result.user);
    setError('');
  }

  function signOut() {
    localStorage.removeItem(TOKEN_KEY);
    socketRef.current?.disconnect();
    setToken(null); setUser(null); setActive(null); setConversations([]); setGroups([]); setMessages([]); setStatusUpdates([]); setSettingsOpen(false);
  }

  function openSettings(section = 'profile') {
    setSettingsSection(section);
    setSettingsOpen(true);
  }

  function updateProfile(profile) {
    setUser(profile);
    setConversations((current) => current.map((person) => person.id === profile.id ? { ...person, ...profile } : person));
    setActive((current) => current?.id === profile.id ? { ...current, ...profile } : current);
  }

  async function saveContact(person, nickname) {
    await api(`/api/contacts/${person.id}`, token, {
      method: 'PUT',
      body: JSON.stringify({ nickname }),
    });
    const savedPerson = {
      ...person,
      profile_name: person.profile_name || person.display_name,
      display_name: nickname,
      saved_as: nickname,
    };
    setContacts((current) => [savedPerson, ...current.filter((contact) => contact.id !== person.id)]);
    setConversations((current) => current.map((conversation) => conversation.id === person.id
      ? { ...conversation, display_name: nickname, saved_as: nickname, profile_name: conversation.profile_name || conversation.display_name }
      : conversation));
    setActive((current) => current?.id === person.id
      ? { ...current, display_name: nickname, saved_as: nickname, profile_name: current.profile_name || current.display_name }
      : current);
  }

  function emitTyping(chat, isTyping) {
    if (!chat) return;
    if (chat.kind === 'group') {
      socketRef.current?.emit('typing', { groupId: chat.id, isTyping });
    } else {
      socketRef.current?.emit('typing', { recipientId: chat.id, isTyping });
    }
  }

  function chooseConversation(person) {
    emitTyping(activeRef.current, false);
    setActive({ ...person, kind: 'direct' });
    setModalOpen(false);
    setMobileChat(true);
    setContactTyping(false);
    setTypingName('');
    setSelectedFile(null);
    setError('');
    if (!conversations.some((conversation) => conversation.id === person.id)) {
      setConversations((current) => [person, ...current]);
    }
  }

  function chooseGroup(group) {
    emitTyping(activeRef.current, false);
    setActive({ ...group, kind: 'group' });
    setGroupModalOpen(false);
    setMobileChat(true);
    setContactTyping(false);
    setTypingName('');
    setSelectedFile(null);
    setError('');
  }

  async function handleGroupCreated(group) {
    setGroupModalOpen(false);
    await loadConversations();
    chooseGroup(group);
  }

  async function publishStatus() {
    setStatusComposerOpen(false);
    setInboxView('status');
    await loadStatuses();
  }

  function removeStatus(statusId) {
    setStatusUpdates((current) => current.map((update) => ({
      ...update,
      statuses: update.statuses.filter((status) => status.id !== statusId),
    })).filter((update) => update.statuses.length > 0));
    setActiveStatus(null);
  }

  function updateDraft(value) {
    setDraft(value);
    if (!active) return;
    const isTyping = Boolean(value.trim());
    emitTyping(active, isTyping);
    clearTimeout(typingTimerRef.current);
    if (isTyping) {
      typingTimerRef.current = setTimeout(() => {
        emitTyping(active, false);
      }, 1200);
    }
  }

  function selectAttachment(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
      setError('Choose a file that is 15 MB or smaller.');
      return;
    }
    setError('');
    setSelectedFile(file);
  }

  async function sendMessage(event) {
    event.preventDefault();
    const body = draft.trim();
    if ((!body && !selectedFile) || !active || sendingMessage) return;
    setDraft('');
    setSendingMessage(true);
    clearTimeout(typingTimerRef.current);
    emitTyping(active, false);
    const formData = new FormData();
    formData.append('body', body);
    if (selectedFile) formData.append('file', selectedFile);
    try {
      const messagePath = active.kind === 'group'
        ? `/api/groups/${active.id}/messages`
        : '/api/messages';
      if (active.kind !== 'group') formData.append('recipientId', String(active.id));
      const result = await api(messagePath, token, {
        method: 'POST',
        body: formData,
      });
      setMessages((current) => current.some((message) => message.id === result.message.id) ? current : [...current, result.message]);
      setSelectedFile(null);
      await loadConversations();
    } catch (sendError) {
      setDraft(body);
      setError(sendError.message);
    } finally {
      setSendingMessage(false);
    }
  }

  const filteredConversations = conversations.filter((conversation) =>
    `${conversation.display_name || ''} ${conversation.username}`.toLowerCase().includes(filter.toLowerCase()));
  const filteredGroups = groups.filter((group) => group.name.toLowerCase().includes(filter.toLowerCase()));

  if (loading) return <main className="loading-screen"><div className="loading-mark"><MessageCircle size={23} /></div><span>Opening your chats…</span></main>;
  if (!user) return <AuthScreen onLogin={handleLogin} />;

  return (
    <main className="messenger-shell" data-theme={user.dark_mode ? 'dark' : 'light'}>
      <aside className={`sidebar${mobileChat ? ' sidebar-hidden-mobile' : ''}`}>
        <header className="sidebar-header">
          <a className="brand app-brand" href="#"><img className="brand-mark-image" src="/farazchat-mark.svg" alt="" /><span>Faraz<span className="brand-light">Chat</span></span></a>
          <div className="header-actions"><span className={`connection-indicator${socketReady ? ' is-online' : ''}`} title={socketReady ? 'Connected' : 'Connecting'} /><button className="icon-button add-button" onClick={() => setModalOpen(true)} aria-label="New chat" title="New chat"><Plus size={21} /></button><button className="icon-button group-create-button" onClick={() => setGroupModalOpen(true)} aria-label="Create group" title="Create group"><UsersRound size={18} /></button><button className="icon-button settings-button" onClick={() => openSettings('profile')} aria-label="Settings" title="Settings"><Settings size={18} /></button></div>
        </header>
        <div className="inbox-title-row"><div><span className="inbox-kicker">YOUR SPACE</span><h1>Messages <span>{conversations.length || ''}</span></h1></div><button className="text-new-chat" onClick={() => setModalOpen(true)}><Plus size={15} /> New chat</button></div>
        <nav className="inbox-tabs" aria-label="Inbox views">
          <button className={inboxView === 'chats' ? 'inbox-tab-active' : ''} onClick={() => setInboxView('chats')}>Chats <span>{conversations.length || ''}</span></button>
          <button className={inboxView === 'groups' ? 'inbox-tab-active' : ''} onClick={() => setInboxView('groups')}>Groups <span>{groups.length || ''}</span></button>
          <button className={inboxView === 'status' ? 'inbox-tab-active' : ''} onClick={() => setInboxView('status')}>Status</button>
        </nav>
        <label className="search-field conversation-search"><Search size={16} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search conversations" /><kbd>/</kbd></label>
        <div className="conversation-list">
          {inboxView === 'chats' && filteredConversations.map((conversation) => <button key={conversation.id} className={`conversation-item${active?.id === conversation.id ? ' conversation-active' : ''}`} onClick={() => chooseConversation(conversation)}>
            <span className="conversation-avatar-wrap"><Avatar name={conversation.display_name || conversation.username} src={conversation.avatar_url} />{onlineUsers.has(conversation.id) && <i className="presence-dot" />}</span>
            <span className="conversation-copy"><span className="conversation-top"><strong>{conversation.display_name || conversation.username}</strong><time>{relativeTime(conversation.last_message_at)}</time></span><span className="conversation-bottom"><span>{conversation.last_message || `#${conversation.contact_code || conversation.username}`}</span>{onlineUsers.has(conversation.id) && <i className="conversation-online-label">Online</i>}</span></span>
          </button>)}
          {inboxView === 'groups' && filteredGroups.map((group) => <button key={group.id} className={`conversation-item group-conversation${active?.kind === 'group' && active.id === group.id ? ' conversation-active' : ''}`} onClick={() => chooseGroup(group)}><span className="group-avatar"><UsersRound size={18} /></span><span className="conversation-copy"><span className="conversation-top"><strong>{group.name}</strong><time>{relativeTime(group.last_message_at)}</time></span><span className="conversation-bottom"><span>{group.last_message || `${group.member_count} members`}</span></span></span></button>)}
          {inboxView === 'status' && <div className="status-list"><button className="status-list-item my-status-item" onClick={() => { const ownStatus = statusUpdates.find((update) => update.own); if (ownStatus) setActiveStatus(ownStatus); else setStatusComposerOpen(true); }}><span className="status-ring status-add-ring"><Avatar name={user.display_name || user.username} src={user.avatar_url} /><i>+</i></span><span><strong>My status</strong><small>{statusUpdates.find((update) => update.own)?.statuses.length ? `${statusUpdates.find((update) => update.own).statuses.length} updates · tap to view` : 'Share a photo or update'}</small></span><span className="status-add-control" aria-hidden="true"><Plus size={17} /></span></button>{statusUpdates.filter((update) => !update.own).map((update) => <button className="status-list-item" key={update.user.id} onClick={() => setActiveStatus(update)}><span className={`status-ring${update.statuses.some((status) => !status.viewed) ? ' status-unviewed' : ''}`}><Avatar name={update.user.display_name || update.user.username} src={update.user.avatar_url} /></span><span><strong>{update.user.display_name || update.user.username}</strong><small>{update.statuses.length} update{update.statuses.length === 1 ? '' : 's'} · {relativeTime(new Date(update.statuses.at(-1).created_at).toISOString().slice(0, 19).replace('T', ' '))}</small></span></button>)}</div>}
          {inboxView === 'chats' && filteredConversations.length === 0 && <div className="inbox-empty"><span className="empty-art"><MessageCircle size={24} /></span><strong>{filter ? 'No matches' : 'A little quiet here'}</strong><span>{filter ? 'Try a different name.' : 'Start a conversation with someone.'}</span>{!filter && <button onClick={() => setModalOpen(true)}>Find someone <span>↗</span></button>}</div>}
          {inboxView === 'groups' && filteredGroups.length === 0 && <div className="inbox-empty"><span className="empty-art"><UsersRound size={24} /></span><strong>{filter ? 'No matches' : 'No groups yet'}</strong><span>{filter ? 'Try another group name.' : 'Bring people together in a group.'}</span>{!filter && <button onClick={() => setGroupModalOpen(true)}>Create group <span>↗</span></button>}</div>}
        </div>
        <button className="profile-footer profile-edit-button" onClick={() => openSettings('profile')} title="Edit profile"><Avatar name={user.display_name || user.username} src={user.avatar_url} /><span className="profile-name"><strong>{user.display_name || user.username}</strong><span>#{user.contact_code || user.username}</span></span><Settings size={16} /></button>
      </aside>

      <section className={`chat-panel${mobileChat ? ' chat-mobile-visible' : ''}`}>
        {active ? <>
          <header className="chat-header"><button className="icon-button back-button" onClick={() => setMobileChat(false)} aria-label="Back to messages"><ArrowLeft size={19} /></button><button className="contact-profile-trigger" onClick={() => active.kind === 'group' ? setGroupDetailsOpen(true) : setContactProfileOpen(true)}><span className={active.kind === 'group' ? 'group-avatar chat-group-avatar' : ''}>{active.kind === 'group' ? <UsersRound size={19} /> : <Avatar name={active.display_name || active.username} src={active.avatar_url} />}</span><span className="chat-contact"><strong>{active.display_name || active.name || active.username}</strong><span className={`contact-status${active.kind !== 'group' && onlineUsers.has(active.id) ? ' is-online' : ''}`}><i />{contactTyping ? <>{typingName && `${typingName} `}typing<span className="typing-dots" aria-hidden="true"><i /><i /><i /></span></> : active.kind === 'group' ? `${active.member_count || active.members?.length || 0} members` : <>{onlineUsers.has(active.id) ? 'Online' : 'Offline'} · #{active.contact_code || active.username}</>}</span></span></button></header>
          <div className="message-stage">
            <div className="message-date"><span>YOUR CONVERSATION</span></div>
            {messages.length === 0 && <div className="first-message"><Avatar name={active.kind === 'group' ? active.name : active.display_name || active.username} src={active.avatar_url} large /><strong>{active.kind === 'group' ? active.name : `You and ${active.display_name || active.username}`}</strong><span>{active.kind === 'group' ? 'Your group conversation starts here.' : 'This is the beginning of your conversation.'}</span><span className="first-message-rule" /></div>}
            {messages.map((message, index) => {
              const mine = message.sender_id === user.id;
              const previous = messages[index - 1];
              const showAuthor = !previous || previous.sender_id !== message.sender_id;
              return <div className={`message-row${mine ? ' message-mine' : ''}${showAuthor ? ' message-first' : ''}`} key={message.id}>
                {!mine && showAuthor && <Avatar name={active.kind === 'group' ? message.sender_display_name || message.sender_username : active.display_name || active.username} src={active.kind === 'group' ? '' : active.avatar_url} />}
                <div className="message-stack">{active.kind === 'group' && showAuthor && !mine && <span className="group-message-author">{message.sender_display_name || message.sender_username}</span>}{message.body && <div className="message-bubble">{message.body}</div>}{message.attachment && <AttachmentCard attachment={message.attachment} token={token} />}<span className="message-time">{relativeTime(message.created_at)}</span></div>
              </div>;
            })}
            <div ref={messageEndRef} />
          </div>
          {error && <div className="chat-error" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss"><X size={14} /></button></div>}
          {selectedFile && <div className="attachment-draft"><FileText size={17} /><span><strong>{selectedFile.name}</strong><small>{formatFileSize(selectedFile.size)}</small></span><button className="icon-button" onClick={() => setSelectedFile(null)} type="button" aria-label="Remove attachment"><X size={15} /></button></div>}
          <form className="composer" onSubmit={sendMessage}>
            <input ref={photoInputRef} className="hidden-file-input" type="file" accept="image/*,video/*" onChange={selectAttachment} />
            <input ref={fileInputRef} className="hidden-file-input" type="file" onChange={selectAttachment} />
            <button className="composer-tool" type="button" onClick={() => photoInputRef.current?.click()} aria-label="Add photo or video" title="Add photo or video"><ImagePlus size={19} /></button>
            <button className="composer-tool" type="button" onClick={() => fileInputRef.current?.click()} aria-label="Attach file" title="Attach file"><Paperclip size={18} /></button>
            <input value={draft} onChange={(event) => updateDraft(event.target.value)} placeholder={`Message ${active.kind === 'group' ? active.name : active.display_name || active.username}…`} maxLength={4000} aria-label="Message" />
            <span className="composer-divider" />
            <button type="submit" className="send-button" disabled={(!draft.trim() && !selectedFile) || sendingMessage} aria-label="Send message" title="Send message"><Send size={17} /></button>
          </form>
          <div className="chat-privacy"><LockKeyhole size={12} /> Messages are stored on your FarazChat server.</div>
        </> : <div className="welcome-panel"><div className="welcome-illustration"><div className="welcome-orbit orbit-one" /><div className="welcome-orbit orbit-two" /><span className="welcome-icon"><MessageCircle size={35} /></span><span className="orbit-dot dot-one" /><span className="orbit-dot dot-two" /><span className="orbit-dot dot-three" /></div><span className="welcome-eyebrow">A SPACE OF YOUR OWN</span><h2>Make room for<br />a good <span>conversation.</span></h2><p>Choose someone you know, or find a new face by their username.</p><button className="primary-button welcome-button" onClick={() => setModalOpen(true)}><Plus size={17} /> Start a new chat</button><span className="welcome-bottom"><Check size={14} /> Your messages, delivered in real time</span></div>}
      </section>
      {modalOpen && <NewChatModal token={token} onClose={() => setModalOpen(false)} onSelect={chooseConversation} />}
      {groupModalOpen && <GroupModal token={token} onClose={() => setGroupModalOpen(false)} onCreate={handleGroupCreated} />}
      {statusComposerOpen && <StatusComposerModal token={token} onClose={() => setStatusComposerOpen(false)} onPublished={publishStatus} />}
      {activeStatus && <StatusViewerModal token={token} update={activeStatus} onClose={() => setActiveStatus(null)} onDelete={removeStatus} />}
      {groupDetailsOpen && active?.kind === 'group' && <GroupDetailsModal token={token} group={active} onClose={() => setGroupDetailsOpen(false)} />}
      {settingsOpen && <SettingsModal token={token} user={user} initialSection={settingsSection} onClose={() => setSettingsOpen(false)} onSave={updateProfile} onSignOut={signOut} />}
      {contactProfileOpen && active && <ContactProfileModal token={token} person={active} online={onlineUsers.has(active.id)} savedName={contacts.find((contact) => contact.id === active.id)?.nickname || active.saved_as} onSaveContact={saveContact} onClose={() => setContactProfileOpen(false)} />}
    </main>
  );
}

export default App;