import React, { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, RefreshCw, Play } from 'lucide-react';
import { PLATFORM_SECTIONS, platformRows, platformColumns, formatCell } from './lib/platform-panel.mjs';

/** Minimal operator panels for the CRM, money/ops, brand and compliance modules. */
export default function PlatformPanel({ request, owner }) {
  const sections = PLATFORM_SECTIONS.filter(s => owner || !s.adminOnly);
  const [active, setActive] = useState(sections[0]?.id);
  const [state, setState] = useState({ loading: false, error: '', data: null });
  const section = sections.find(s => s.id === active);
  const load = useCallback(async () => {
    if (!section) return;
    setState(s => ({ ...s, loading: true, error: '' }));
    try { setState({ loading: false, error: '', data: await request(section.path) }); }
    catch (error) { setState({ loading: false, error: error.message, data: null }); }
  }, [section, request]);
  useEffect(() => { load(); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  async function runAction(action) {
    try { await request(action.path, { method: 'POST', body: action.body || {} }); await load(); }
    catch (error) { setState(s => ({ ...s, error: error.message })); }
  }
  const list = platformRows(state.data); const columns = platformColumns(list);
  return <section className="card" aria-label="Platform modules">
    <div className="card-header"><h2>Backend &amp; CRM</h2>
      <button className="button small" onClick={load} disabled={state.loading}>{state.loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}Refresh</button></div>
    <div className="tabs" role="tablist">{sections.map(s => <button key={s.id} role="tab" aria-selected={s.id === active} className={`button small ${s.id === active ? 'primary' : ''}`} onClick={() => setActive(s.id)}>{s.label}</button>)}</div>
    {section?.actions?.length ? <div className="row-actions">{section.actions.map(a => <button key={a.label} className="button small" onClick={() => runAction(a)}><Play size={14} />{a.label}</button>)}</div> : null}
    {state.error && <p role="alert" className="form-error">{state.error}</p>}
    {section?.note && <p className="checkout-fixture-note">{section.note}</p>}
    {list.length ? <div className="table-wrap"><table><thead><tr>{columns.map(c => <th key={c}>{c}</th>)}</tr></thead>
      <tbody>{list.slice(0, 100).map((row, i) => <tr key={row.id || i}>{columns.map(c => <td key={c}>{formatCell(c, row[c])}</td>)}</tr>)}</tbody></table></div>
      : !state.loading && <p className="muted">No records yet.</p>}
  </section>;
}
