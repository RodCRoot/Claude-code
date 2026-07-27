import { useEffect, useRef, useState } from "react";
import { api } from "../api";

interface Thread { id: string; with: string; preview: string; lastMessageAt: string; unread: number; }
interface Msg { id: string; body: string; createdAt: string; mine: boolean; }
interface Recipient { id: string; name: string; role: string; }

export default function Messages() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openWith, setOpenWith] = useState("");

  function loadThreads() { api.get<{ threads: Thread[] }>("/messages").then((r) => setThreads(r.threads)); }
  useEffect(() => {
    loadThreads();
    api.get<{ recipients: Recipient[] }>("/messages/recipients").then((r) => setRecipients(r.recipients));
  }, []);

  async function startWith(userId: string, name: string) {
    const r = await api.post<{ threadId: string }>("/messages/start", { toUserId: userId });
    setOpenId(r.threadId); setOpenWith(name);
  }

  if (openId) {
    return <ThreadView id={openId} title={openWith} onBack={() => { setOpenId(null); loadThreads(); }} />;
  }

  return (
    <div>
      <header className="page-head"><h1>Messages</h1></header>

      <div className="card" style={{ marginBottom: 14 }}>
        <span className="muted small">Start a conversation</span>
        <div className="filters" style={{ marginTop: 6 }}>
          <select id="recip" defaultValue="">
            <option value="" disabled>Choose someone…</option>
            {recipients.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.role.toLowerCase()})</option>)}
          </select>
          <button onClick={() => { const el = document.getElementById("recip") as HTMLSelectElement; const r = recipients.find((x) => x.id === el.value); if (r) startWith(r.id, r.name); }}>Message</button>
        </div>
      </div>

      {threads.length === 0 && <div className="muted">No conversations yet.</div>}
      <div className="feed">
        {threads.map((t) => (
          <button key={t.id} className="card as-button thread-row" onClick={() => { setOpenId(t.id); setOpenWith(t.with); }}>
            <div className="thread-main">
              <span className="athlete-name">{t.with}</span>
              <span className="muted small thread-preview">{t.preview}</span>
            </div>
            {t.unread > 0 && <span className="badge">{t.unread}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function ThreadView({ id, title, onBack }: { id: string; title: string; onBack: () => void }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [body, setBody] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  function load() { api.get<{ messages: Msg[] }>(`/messages/${id}`).then((r) => { setMessages(r.messages); setTimeout(() => endRef.current?.scrollIntoView(), 50); }); }
  useEffect(() => { load(); }, [id]);

  async function send() {
    if (!body.trim()) return;
    const r = await api.post<{ message: Msg }>(`/messages/${id}`, { body });
    setMessages((prev) => [...prev, r.message]);
    setBody("");
    setTimeout(() => endRef.current?.scrollIntoView(), 50);
  }

  return (
    <div>
      <header className="page-head">
        <div><button className="link-btn" onClick={onBack}>← Messages</button><h1>{title}</h1></div>
      </header>
      <div className="card chat">
        <div className="chat-log">
          {messages.map((m) => (
            <div key={m.id} className={`bubble ${m.mine ? "mine" : "theirs"}`}>
              <div>{m.body}</div>
              <div className="muted small bubble-time">{new Date(m.createdAt).toLocaleString()}</div>
            </div>
          ))}
          {messages.length === 0 && <div className="muted small">Say hello 👋</div>}
          <div ref={endRef} />
        </div>
        <div className="chat-input">
          <input placeholder="Type a message…" value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }} />
          <button onClick={send} disabled={!body.trim()}>Send</button>
        </div>
      </div>
    </div>
  );
}
