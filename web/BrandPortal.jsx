import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createOnboardingTransport } from './lib/onboarding.mjs';
import { visibleNav, money, pct, greeting, STATUS_LABEL, linkFromHash, monthOptions, reportUrl, ROLE_HELP, initials } from './lib/brand-portal.mjs';
import './brand-portal.css';

const ICON = { dashboard: '◍', products: '❀', payouts: '◈', team: '✦', settings: '⚙' };

/** Brand portal: own session transport; never bootstraps an owner session. */
export default function BrandPortal() {
  const transport = useRef(null); if (!transport.current) transport.current = createOnboardingTransport();
  const call = useCallback((path, options) => transport.current.request(path, options), []);
  const [me, setMe] = useState(null), [loading, setLoading] = useState(true), [tab, setTab] = useState('dashboard'), [error, setError] = useState('');
  const refreshMe = useCallback(async () => { const value = await call('/api/brand-auth/me'); transport.current.setSession(value); setMe(value); return value; }, [call]);
  useEffect(() => {
    let active = true;
    (async () => {
      const link = linkFromHash(window.location.hash);
      if (link) {
        window.history.replaceState(null, '', window.location.pathname); // drop the secret from the address bar
        try { const s = await call('/api/brand-auth/login/verify', { method: 'POST', body: { token: link.token } }); transport.current.setSession(s); }
        catch (e) { if (active) setError(e.message); }
      }
      try { await refreshMe(); } catch { if (active) setMe(null); }
      if (active) setLoading(false);
    })();
    const onHash = () => { if (linkFromHash(window.location.hash)) window.location.reload(); };
    window.addEventListener('hashchange', onHash);
    return () => { active = false; window.removeEventListener('hashchange', onHash); };
  }, [call, refreshMe]);
  if (loading) return <div className="bp-shell bp-center"><div className="bp-logo">ava<i>fem</i></div><p className="bp-mute">Opening your portal…</p></div>;
  if (!me) return <Login call={call} initialError={error} onSignedIn={async s => { transport.current.setSession(s); await refreshMe(); }} />;
  const nav = visibleNav(me.scopes);
  const signOut = async () => { await call('/api/brand-auth/logout', { method: 'POST', body: {} }).catch(() => {}); transport.current.setSession(null); setMe(null); };
  return (
    <div className="bp-shell bp-layout">
      <aside className="bp-side">
        <div><div className="bp-logo">ava<i>fem</i></div><div className="bp-kicker">Brand portal</div></div>
        <nav>{nav.map(([key, label]) => <button key={key} className={`bp-nav ${tab === key ? 'on' : ''}`} onClick={() => setTab(key)}><span>{ICON[key]}</span>{label}</button>)}</nav>
        <div className="bp-who"><div className="bp-avatar">{initials(me.brandName)}</div><div><b>{me.brandName}</b><small>{me.email || 'Invite link session'} · {me.role}</small></div></div>
      </aside>
      <main className="bp-main">
        {tab === 'dashboard' && <Dashboard call={call} me={me} go={setTab} />}
        {tab === 'products' && <Products call={call} me={me} />}
        {tab === 'payouts' && <Payouts />}
        {tab === 'team' && <Team call={call} me={me} />}
        {tab === 'settings' && <Settings call={call} me={me} onSignOut={signOut} />}
        <p className="bp-foot">Sandbox · emails are simulated and money movement is test-only.</p>
      </main>
    </div>
  );
}

function Login({ call, onSignedIn, initialError }) {
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [mode, setMode] = useState('link');
  const [sent, setSent] = useState(false), [error, setError] = useState(initialError || ''), [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (mode === 'link') { await call('/api/brand-auth/login/request', { method: 'POST', body: { email } }); setSent(true); }
      else { const s = await call('/api/brand-auth/login/password', { method: 'POST', body: { email, password } }); setPassword(''); await onSignedIn(s); }
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="bp-shell bp-login">
      <section className="bp-login-copy">
        <div className="bp-logo">ava<i>fem</i></div>
        <h1>Your brand,<br /><em>beautifully</em> run.</h1>
        <p>Sales, listings, payouts and your team, in one calm place. Sign in with the email your team owner invited.</p>
      </section>
      <form className="bp-card bp-login-card" onSubmit={submit}>
        <span className="bp-kicker">Brand sign in</span>
        {sent ? <><h2>Check your inbox</h2><p className="bp-mute">If that email belongs to a brand team, a single-use link is on its way. It expires in 15 minutes.</p><button type="button" className="bp-ghost" onClick={() => setSent(false)}>Use a different email</button></> : <>
          <h2>{mode === 'link' ? 'Get a sign-in link' : 'Sign in with password'}</h2>
          <label>Work email<input type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@yourbrand.com" /></label>
          {mode === 'password' && <label>Password<input type="password" autoComplete="current-password" required minLength={12} value={password} onChange={e => setPassword(e.target.value)} /></label>}
          {error && <p className="bp-error" role="alert">{error}</p>}
          <button className="bp-btn" disabled={busy}>{busy ? 'One moment…' : mode === 'link' ? 'Email me a link →' : 'Sign in →'}</button>
          <button type="button" className="bp-ghost" onClick={() => { setMode(mode === 'link' ? 'password' : 'link'); setError(''); }}>{mode === 'link' ? 'Use a password instead' : 'Email me a link instead'}</button>
        </>}
      </form>
    </div>
  );
}

function useLoad(call, path) {
  const [data, setData] = useState(null), [error, setError] = useState('');
  const load = useCallback(() => call(path).then(setData).catch(e => setError(e.message)), [call, path]);
  useEffect(() => { load(); }, [load]);
  return [data, error, load];
}

function Dashboard({ call, me, go }) {
  const [d, error] = useLoad(call, '/api/brand-portal/dashboard');
  if (error) return <p className="bp-error">{error}</p>;
  if (!d) return <p className="bp-mute">Loading…</p>;
  const store = d.store?.find(s => s.status === 'connected');
  const listed = d.listings?.listed || 0, review = d.listings?.inReview || 0, share = listed + review ? listed / (listed + review) : 0;
  return <>
    <header className="bp-head"><div><span className="bp-kicker">Last 30 days</span><h1>{greeting()}, {d.brand.name}</h1></div>
      {d.store && <span className={`bp-pill ${store ? 'ok' : ''}`}>● {store ? `Store connected · ${store.platform}` : 'No store connected'}</span>}</header>
    <section className="bp-stats">
      {d.sales && <Stat label="Sales" value={money(d.sales.grossSalesCents)} sub={d.sales.changeRate == null ? `${d.sales.bags} orders` : `${d.sales.changeRate >= 0 ? '▲' : '▼'} ${pct(Math.abs(d.sales.changeRate))} vs prior 30 days`} tone={d.sales.changeRate < 0 ? 'down' : 'up'} />}
      {d.conversion && <Stat label="Swipe → purchase" value={pct(d.conversion.rate)} sub={`${d.conversion.likes.toLocaleString()} likes · ${d.conversion.bags} orders`} tone="up" />}
      {d.returns && <Stat label="Returns" value={pct(d.returns.rate)} sub={`${d.returns.refundedBags} of ${d.returns.bags} orders`} tone="down" />}
      {d.upcomingPayout && <Stat label="Upcoming payout" value={money(d.upcomingPayout.scheduledCents)} sub={d.upcomingPayout.nextDueAt ? `${new Date(d.upcomingPayout.nextDueAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · after return window` : d.upcomingPayout.scheduledCents ? 'Releases after the return window' : d.upcomingPayout.heldCents ? `${money(d.upcomingPayout.heldCents)} on hold` : 'Nothing scheduled yet'} tone="up" />}
    </section>
    <section className="bp-grid">
      {d.topProducts && <div className="bp-card"><h3>Top products</h3>{d.topProducts.length ? d.topProducts.map((p, i) => <div className="bp-row" key={p.sku}><span className={`bp-swatch s${i % 4}`} /><div><b>{p.title}</b><small>{p.units} sold</small></div><span>{money(p.revenueCents)}</span></div>) : <p className="bp-mute">Your first sales will show here.</p>}</div>}
      {d.listings && <div className="bp-card"><h3>Listings</h3><div className="bp-split"><div className="bp-tile sage"><small>Listed</small><b>{listed}</b></div><div className="bp-tile sand"><small>In review</small><b>{review}</b></div></div>
        <div className="bp-bar"><i style={{ width: `${Math.round(share * 100)}%` }} /></div>
        <p className="bp-mute">Avafem’s curators review each product. Price and stock changes sync automatically without review.</p>
        {d.listings.needsAttention > 0 && me.scopes.includes('catalog:read') && <button className="bp-link" onClick={() => go('products')}>{d.listings.needsAttention} need your attention →</button>}</div>}
      {d.placements && <div className="bp-card bp-promo"><span className="bp-kicker">Promote on Avafem</span><h3>Get discovered</h3>
        <div className="bp-price"><span>Featured spot</span><b>{money(d.placements.pricing.featuredSpotPerDayCents)} / day</b></div>
        <div className="bp-price"><span>Sponsored swipe card</span><b>{money(d.placements.pricing.sponsoredSwipePer1000Cents)} / 1,000 views</b></div>
        <div className="bp-price"><span>Sampling box</span><b>{money(d.placements.pricing.samplingBoxPerUnitCents)} / unit</b></div>
        <p className="bp-promo-note">{d.placements.active ? `${d.placements.active} campaign(s) in progress` : 'Request a campaign for any listed product.'}</p></div>}
    </section>
  </>;
}
const Stat = ({ label, value, sub, tone }) => <div className="bp-card bp-stat"><small>{label}</small><b>{value}</b><span className={tone}>{sub}</span></div>;

function Products({ call, me }) {
  const [d, error, load] = useLoad(call, '/api/brand-portal/products');
  const [filter, setFilter] = useState('all'), [open, setOpen] = useState(null), [msg, setMsg] = useState('');
  if (error) return <p className="bp-error">{error}</p>;
  if (!d) return <p className="bp-mute">Loading…</p>;
  const list = d.products.filter(p => filter === 'all' || p.status === filter);
  const resubmit = async p => { setMsg(''); try { await call(`/api/brand-portal/products/${encodeURIComponent(p.id)}/resubmit`, { method: 'POST', body: {} }); setMsg(`${p.title} is back in review.`); await load(); } catch (e) { setMsg(e.message); } };
  return <>
    <header className="bp-head"><div><span className="bp-kicker">Catalog</span><h1>Your products</h1></div></header>
    <div className="bp-chips">{['all', 'approved', 'in_review', 'rejected', 'draft'].map(s => <button key={s} className={filter === s ? 'on' : ''} onClick={() => setFilter(s)}>{s === 'all' ? `All ${d.products.length}` : `${STATUS_LABEL[s]} ${d.counts[s] || 0}`}</button>)}</div>
    {msg && <p className="bp-note">{msg}</p>}
    <div className="bp-card bp-table">{list.length ? list.map(p => <div key={p.id} className="bp-prod">
      <button className="bp-prod-top" onClick={() => setOpen(open === p.id ? null : p.id)} aria-expanded={open === p.id}>
        <div><b>{p.title || p.sku}</b><small>{p.sku} · {money(p.priceCents)} · {p.inventoryQty} in stock</small></div>
        <span className={`bp-status ${p.status}`}>{STATUS_LABEL[p.status]}</span></button>
      {open === p.id && <div className="bp-prod-body">
        {p.whatToFix.length ? <ul>{p.whatToFix.map((f, i) => <li key={i} className={f.kind}><b>{f.kind === 'compliance_block' ? 'Must fix' : f.kind === 'compliance_warning' ? 'Check' : f.kind === 'reviewer_note' ? 'Reviewer note' : 'Fix'}</b> {f.message}{f.match ? <em> (“{f.match}” in {f.field})</em> : null}</li>)}</ul> : <p className="bp-mute">No issues found.</p>}
        {p.compliance.needsAvafemOverride && <p className="bp-mute">Blocked claims need rewording, or an Avafem reviewer override.</p>}
        {p.canResubmit && me.scopes.includes('catalog:write') && <button className="bp-btn sm" onClick={() => resubmit(p)}>Resubmit for review</button>}
        {p.status === 'rejected' && !p.canResubmit && <p className="bp-mute">Edit this product in your store or catalog, then resubmit.</p>}
      </div>}
    </div>) : <p className="bp-mute">Nothing here.</p>}</div>
    <p className="bp-mute">{d.note}</p>
  </>;
}

function Payouts() {
  const months = monthOptions(); const [month, setMonth] = useState(months[0].value); const [year, setYear] = useState(new Date().getUTCFullYear());
  return <>
    <header className="bp-head"><div><span className="bp-kicker">Finance</span><h1>Payouts & reports</h1></div></header>
    <section className="bp-grid two">
      <div className="bp-card"><h3>Monthly statement</h3><p className="bp-mute">Every transfer for the month: merchandise, Avafem commission, refunds and your net.</p>
        <label>Month<select value={month} onChange={e => setMonth(e.target.value)}>{months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</select></label>
        <div className="bp-actions"><a className="bp-btn sm" href={reportUrl('statement', month, 'csv')} download>Download CSV</a><a className="bp-ghost" href={reportUrl('statement', month, 'json')} target="_blank" rel="noreferrer">View JSON</a></div></div>
      <div className="bp-card"><h3>Annual 1099-K style report</h3><p className="bp-mute">Gross volume, transactions, refunds and net transfers by month. Data only, not a tax form.</p>
        <label>Year<select value={year} onChange={e => setYear(e.target.value)}>{[0, 1, 2].map(i => { const y = new Date().getUTCFullYear() - i; return <option key={y} value={y}>{y}</option>; })}</select></label>
        <div className="bp-actions"><a className="bp-btn sm" href={reportUrl('annual', year, 'csv')} download>Download CSV</a><a className="bp-ghost" href={reportUrl('annual', year, 'json')} target="_blank" rel="noreferrer">View JSON</a></div></div>
    </section>
  </>;
}

function Team({ call, me }) {
  const [list, error, load] = useLoad(call, '/api/brand-portal/members');
  const [email, setEmail] = useState(''), [role, setRole] = useState('staff'), [msg, setMsg] = useState('');
  const act = async (fn, ok) => { setMsg(''); try { await fn(); setMsg(ok); await load(); } catch (e) { setMsg(e.message); } };
  const invite = e => { e.preventDefault(); const operationId = `invite_${crypto.randomUUID().replaceAll('-', '')}`; act(() => call('/api/brand-portal/members', { method: 'POST', body: { operationId, email, role } }), `Invitation sent to ${email} (simulated).`).then(() => setEmail('')); };
  if (error) return <p className="bp-error">{error}</p>;
  return <>
    <header className="bp-head"><div><span className="bp-kicker">Team</span><h1>People & roles</h1></div></header>
    <section className="bp-grid two">
      <div className="bp-card bp-table">{(list || []).map(m => <div key={m.id} className="bp-member"><div className="bp-avatar sm">{initials(m.email)}</div><div><b>{m.email}</b><small>{m.status === 'invited' ? 'Invitation pending' : m.lastLoginAt ? `Last seen ${new Date(m.lastLoginAt).toLocaleDateString()}` : 'Active'}</small></div>
        <select value={m.role} disabled={m.id === me.memberId} onChange={e => act(() => call(`/api/brand-portal/members/${m.id}`, { method: 'PATCH', body: { role: e.target.value } }), 'Role updated.')}>{Object.keys(ROLE_HELP).map(r => <option key={r}>{r}</option>)}</select>
        {m.id !== me.memberId && <button className="bp-ghost" onClick={() => window.confirm(`Remove ${m.email}?`) && act(() => call(`/api/brand-portal/members/${m.id}`, { method: 'DELETE' }), 'Removed and signed out.')}>Remove</button>}</div>)}
        {list && !list.length && <p className="bp-mute">Only you so far. Invite your team.</p>}</div>
      <form className="bp-card" onSubmit={invite}><h3>Invite a teammate</h3>
        <label>Email<input type="email" required value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label>Role<select value={role} onChange={e => setRole(e.target.value)}>{Object.keys(ROLE_HELP).map(r => <option key={r}>{r}</option>)}</select></label>
        <p className="bp-mute">{ROLE_HELP[role]}</p><button className="bp-btn sm">Send invitation</button>
        {msg && <p className="bp-note">{msg}</p>}</form>
    </section>
  </>;
}

function Settings({ call, me, onSignOut }) {
  const [current, setCurrent] = useState(''), [next, setNext] = useState(''), [msg, setMsg] = useState('');
  const save = async e => { e.preventDefault(); setMsg(''); try { await call('/api/brand-auth/password', { method: 'PUT', body: { ...(me.hasPassword ? { currentPassword: current } : {}), newPassword: next } }); setCurrent(''); setNext(''); setMsg('Password saved. Other sessions were signed out.'); } catch (err) { setMsg(err.message); } };
  return <>
    <header className="bp-head"><div><span className="bp-kicker">Settings</span><h1>Your account</h1></div></header>
    <section className="bp-grid two">
      <div className="bp-card"><h3>Signed in as</h3><p><b>{me.email || 'Invitation link (owner)'}</b></p><p className="bp-mute">Role: {me.role}. {ROLE_HELP[me.role]}</p><button className="bp-btn sm" onClick={onSignOut}>Sign out</button></div>
      {me.memberId ? <form className="bp-card" onSubmit={save}><h3>{me.hasPassword ? 'Change password' : 'Add a password'}</h3><p className="bp-mute">Optional. Email links always work.</p>
        {me.hasPassword && <label>Current password<input type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} required /></label>}
        <label>New password<input type="password" autoComplete="new-password" minLength={12} value={next} onChange={e => setNext(e.target.value)} required /></label>
        <button className="bp-btn sm">Save password</button>{msg && <p className="bp-note">{msg}</p>}</form>
        : <div className="bp-card"><h3>Add your email</h3><p className="bp-mute">You’re using an invitation link. Invite yourself as an owner from Team, then sign in with your email.</p></div>}
    </section>
  </>;
}
