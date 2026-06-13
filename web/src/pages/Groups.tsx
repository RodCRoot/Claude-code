import { useEffect, useState } from "react";
import { api } from "../api";

interface GroupSummary { id: string; name: string; type: string; _count: { memberships: number }; }
interface Member { id: string; firstName: string; lastName: string; sport: string; sex: string; }
interface Athlete { id: string; firstName: string; lastName: string; }

export default function Groups() {
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [athletes, setAthletes] = useState<Athlete[]>([]);
  const [name, setName] = useState("");
  const [type, setType] = useState("TEAM");
  const [openId, setOpenId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [addId, setAddId] = useState("");

  function loadGroups() { api.get<{ groups: GroupSummary[] }>("/groups").then((r) => setGroups(r.groups)); }
  useEffect(() => {
    loadGroups();
    api.get<{ athletes: Athlete[] }>("/athletes").then((r) => { setAthletes(r.athletes); if (r.athletes[0]) setAddId(r.athletes[0].id); });
  }, []);

  function openGroup(id: string) {
    setOpenId(id);
    api.get<{ members: Member[] }>(`/groups/${id}`).then((r) => setMembers(r.members));
  }
  async function create() {
    if (!name) return;
    await api.post("/groups", { name, type });
    setName(""); loadGroups();
  }
  async function addMember() {
    if (!openId || !addId) return;
    await api.post(`/groups/${openId}/members`, { athleteId: addId });
    openGroup(openId); loadGroups();
  }
  async function removeMember(athleteId: string) {
    if (!openId) return;
    await api.del(`/groups/${openId}/members/${athleteId}`);
    openGroup(openId); loadGroups();
  }

  return (
    <div>
      <header className="page-head"><h1>Teams &amp; Groups</h1></header>

      <div className="card quick-entry">
        <span className="muted small">New group</span>
        <input placeholder="Group name" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="TEAM">Team</option>
          <option value="SQUAD">Squad</option>
          <option value="PRIVATE">Private</option>
        </select>
        <button onClick={create}>Create</button>
      </div>

      <div className="grid" style={{ marginTop: 14 }}>
        {groups.map((g) => (
          <button key={g.id} className={`card athlete-card as-button ${openId === g.id ? "active-card" : ""}`} onClick={() => openGroup(g.id)}>
            <div>
              <div className="athlete-name">{g.name}</div>
              <div className="muted small">{g.type} · {g._count.memberships} athletes</div>
            </div>
          </button>
        ))}
      </div>

      {openId && (
        <div className="card" style={{ marginTop: 14 }}>
          <h2>Members</h2>
          <div className="quick-entry" style={{ padding: 0, border: "none" }}>
            <select value={addId} onChange={(e) => setAddId(e.target.value)}>
              {athletes.map((a) => <option key={a.id} value={a.id}>{a.firstName} {a.lastName}</option>)}
            </select>
            <button onClick={addMember}>+ Add</button>
          </div>
          <table className="data-table" style={{ marginTop: 10 }}>
            <thead><tr><th>Athlete</th><th>Sport</th><th></th></tr></thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>{m.firstName} {m.lastName} <span className="muted small">{m.sex}</span></td>
                  <td className="muted small">{m.sport}</td>
                  <td><button className="link-btn" onClick={() => removeMember(m.id)}>remove</button></td>
                </tr>
              ))}
              {members.length === 0 && <tr><td colSpan={3} className="muted">No members yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
