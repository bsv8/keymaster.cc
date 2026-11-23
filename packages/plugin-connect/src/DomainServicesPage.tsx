import { useEffect, useState } from "react";
import { Button, PageHeader, TextInput } from "@keymaster/ui";
import type { DomainService, DomainServiceInput } from "./domain.js";

interface DomainSettingsClient {
  list(): Promise<DomainService[]>;
  save(service: DomainServiceInput, editing: boolean): Promise<DomainService[]>;
  remove(id: string): Promise<DomainService[]>;
}

const blank = { id: "", name: "", baseUrl: "" };

export function DomainServicesPage({ services }: { services: DomainSettingsClient }) {
  const [rows, setRows] = useState<DomainService[]>([]);
  const [draft, setDraft] = useState<DomainServiceInput>(blank);
  const [editing, setEditing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void services.list().then(next => {
      if (active) { setRows(next); setLoaded(true); }
    }, failure => {
      if (active) setError(failure instanceof Error ? failure.message : "无法读取域名服务");
    });
    return () => { active = false; };
  }, [services]);
  function reset() { setDraft(blank); setEditing(false); }
  async function run(action: () => Promise<DomainService[]>) {
    setBusy(true);
    setError("");
    try { setRows(await action()); reset(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "无法保存域名服务"); }
    finally { setBusy(false); }
  }
  return <div className="apps-page">
    <PageHeader title="域名服务" />
    <section aria-label="内置域名服务">
      <h2>BSV8（内置默认）</h2>
      <p>.bsv8</p>
    </section>
    <section aria-label="第三方域名服务">
      <h2>第三方域名服务</h2>
      {rows.map(service => <div key={service.id} className="app-details__row">
        <div>
          <strong>{service.name}</strong> <span>{service.id}</span>
          <p>{service.baseUrl}</p>
          <p>{service.suffixes.map(value => "." + value).join("、")}</p>
        </div>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => { setDraft(service); setEditing(true); }}>编辑</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => void run(() => services.remove(service.id))}>移除</Button>
      </div>)}
      <form onSubmit={event => { event.preventDefault(); void run(() => services.save(draft, editing)); }}>
        <TextInput label="服务 ID" required value={draft.id} disabled={editing || busy} onChange={event => setDraft({ ...draft, id: event.currentTarget.value })} />
        <TextInput label="显示名称" required value={draft.name} onChange={event => setDraft({ ...draft, name: event.currentTarget.value })} />
        <TextInput label="服务基址" type="url" placeholder="https://" required value={draft.baseUrl} onChange={event => setDraft({ ...draft, baseUrl: event.currentTarget.value })} />
        <Button type="submit" disabled={!loaded || busy}>{editing ? "保存修改" : "添加域名服务"}</Button>
        {editing && <Button type="button" variant="ghost" disabled={busy} onClick={reset}>取消</Button>}
      </form>
    </section>
    {error && <p role="alert">{error}</p>}
  </div>;
}
