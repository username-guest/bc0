'use client';
/**
 * Team tab (ADR 0011). Everyone signed in sees who has access; owners invite, change roles,
 * resend invites and remove people. The server enforces every rule (owner-only, never the last
 * owner, CSRF); this UI mirrors them and explains refusals in plain words.
 */
import { useCallback, useEffect, useState } from 'react';
import { isApiError, type AdminClient, type ApiError } from './client';

type Role = 'tenant_owner' | 'tenant_admin';
interface Member {
  id: string;
  email: string;
  role: Role;
  status: 'active' | 'invited';
  lastSignInAt: string | null;
  addedAt: string;
  invitedBy: string | null;
  isYou: boolean;
}
interface TeamDto {
  members: Member[];
  canManage: boolean;
  /** Adding people is plan-gated ("Multi-user admin", Enterprise). */
  canInvite: boolean;
  inviteUpgradeable: boolean;
  maxSize: number;
}

const ROLE: Record<Role, { label: string; help: string }> = {
  tenant_owner: { label: 'Owner', help: 'Everything, including pricing, where leads go, and the team.' },
  tenant_admin: { label: 'Admin', help: 'Works leads, and changes the storefront look and email gate.' },
};
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const asError = (e: unknown): ApiError => (isApiError(e) ? e : { status: 0, code: 'unknown', message: 'Something went wrong. Try again.' });

export function TeamPanel({ api, onRoleChanged, onSignedOut }: { api: AdminClient; onRoleChanged: () => void; onSignedOut: () => void }) {
  const [team, setTeam] = useState<TeamDto | null>(null);
  const [loadErr, setLoadErr] = useState<ApiError | null>(null);
  const [msg, setMsg] = useState<{ ok?: string; err?: string; at: 'list' | 'invite' } | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // member id or 'invite'
  const [confirming, setConfirming] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('tenant_admin');

  const reload = useCallback(
    () =>
      api
        .get<TeamDto>('team')
        .then((t) => (setTeam(t), setLoadErr(null)))
        .catch((e) => setLoadErr(asError(e))),
    [api],
  );
  useEffect(() => void reload(), [reload]);

  if (loadErr) return <p className="error" role="alert">{loadErr.message}</p>;
  if (!team) return <p className="fine">Loading…</p>;

  async function run(key: string, action: () => Promise<string | void>) {
    const at = key === 'invite' ? 'invite' : 'list';
    setBusy(key);
    setMsg(null);
    // Reload BEFORE showing the result, so the confirmation never appears next to a stale list.
    let result: { ok?: string; err?: string; at: 'list' | 'invite' } | null = null;
    try {
      const ok = await action();
      if (ok) result = { ok, at };
    } catch (e) {
      result = { err: asError(e).message, at };
    }
    await reload();
    setBusy(null);
    if (result) setMsg(result);
  }

  const invite = (e: { preventDefault(): void }) => {
    e.preventDefault();
    void run('invite', async () => {
      const r = await api.post<{ member: Member; emailSent: boolean }>('team/invite', { email, role });
      setEmail('');
      setRole('tenant_admin');
      return r.emailSent
        ? `Invite sent to ${r.member.email}. The link works for 3 days.`
        : `Added ${r.member.email}, but the invite email didn't go out. Use “Resend invite” to try again.`;
    });
  };

  const changeRole = (m: Member, next: Role) =>
    run(m.id, async () => {
      await api.put('team/' + m.id, { role: next });
      if (m.isYou) onRoleChanged();
      return `${m.isYou ? 'You are' : `${m.email} is`} now ${next === 'tenant_owner' ? 'an owner' : 'an admin'}.`;
    });

  const resend = (m: Member) =>
    run(m.id, async () => {
      const r = await api.post<{ emailSent: boolean }>(`team/${m.id}/resend`);
      return r.emailSent ? `Invite sent to ${m.email}. The link works for 3 days.` : `The invite email to ${m.email} didn't go out. Try again in a moment.`;
    });

  const remove = (m: Member) =>
    run(m.id, async () => {
      setConfirming(null);
      const r = await api.del<{ signedOut: boolean }>('team/' + m.id);
      if (r.signedOut) {
        onSignedOut();
        return;
      }
      return `${m.email} no longer has access.`;
    });

  const owners = team.members.filter((m) => m.role === 'tenant_owner').length;
  const full = team.members.length >= team.maxSize;

  return (
    <div className="settings team">
      <section className="settings-section">
        <h2 className="admin-h2">People with access</h2>
        {!team.canManage && <p className="note">Only owners can invite, change or remove people.</p>}
        <ul className="team-list">
          {team.members.map((m) => {
            const soleOwner = m.role === 'tenant_owner' && owners <= 1;
            return (
              <li key={m.id} className="team-row" aria-busy={busy === m.id || undefined}>
                <div className="team-who">
                  <span className="team-email">{m.email}</span>
                  {m.isYou && <span className="tag">You</span>}
                  {m.status === 'invited' && m.invitedBy ? <span className="tag tag-pending">Invited</span> : null}
                  <span className="fine team-meta">
                    {m.status === 'active' && m.lastSignInAt ? `Last signed in ${day(m.lastSignInAt)}` : m.invitedBy ? `Invited by ${m.invitedBy}` : 'Hasn’t signed in yet'}
                  </span>
                </div>
                <div className="team-actions">
                  {team.canManage && team.canInvite && m.status === 'invited' && (
                    <button type="button" className="btn-quiet" disabled={busy !== null} onClick={() => void resend(m)}>
                      {m.invitedBy ? 'Resend invite' : 'Email an invite'}
                    </button>
                  )}
                  {team.canManage && !soleOwner && confirming !== m.id && (
                    <button type="button" className="btn-quiet btn-danger-quiet" disabled={busy !== null} onClick={() => setConfirming(m.id)}>
                      {m.isYou ? 'Leave' : 'Remove'}
                    </button>
                  )}
                  {team.canManage ? (
                    <label className="team-role">
                      <span className="sr-only">Role for {m.email}</span>
                      <select
                        value={m.role}
                        disabled={busy !== null || (soleOwner && m.role === 'tenant_owner')}
                        title={soleOwner ? 'Every workspace needs an owner. Make someone else an owner first.' : undefined}
                        onChange={(e: { target: HTMLSelectElement }) => void changeRole(m, e.target.value as Role)}
                      >
                        <option value="tenant_owner">Owner</option>
                        <option value="tenant_admin">Admin</option>
                      </select>
                    </label>
                  ) : (
                    <span className="team-role-text">{ROLE[m.role].label}</span>
                  )}
                </div>
                {confirming === m.id && (
                  <div className="team-confirm" role="group" aria-label={`Confirm removing ${m.email}`}>
                    <p>{m.isYou ? 'Leave this workspace? You’ll be signed out and lose access.' : `Remove ${m.email}? They lose access immediately.`}</p>
                    <button type="button" className="btn-danger" onClick={() => void remove(m)}>
                      {m.isYou ? 'Leave' : 'Remove'}
                    </button>
                    <button type="button" className="btn-quiet" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {team.canManage && owners <= 1 && (
          <p className="fine">You’re the only owner. To change your role or leave, make someone else an owner first.</p>
        )}
        {msg?.at === 'list' && msg.ok && <p className="saved" role="status">{msg.ok}</p>}
        {msg?.at === 'list' && msg.err && <p className="error" role="alert">{msg.err}</p>}
      </section>

      {team.canManage && !team.canInvite && (
        <section className="settings-section">
          <h2 className="admin-h2">Invite someone</h2>
          <p className="note">
            {team.inviteUpgradeable
              ? 'Inviting teammates is available on the Enterprise plan. You can still change roles and remove people here.'
              : 'Inviting teammates is turned off for this workspace. You can still change roles and remove people here.'}
          </p>
        </section>
      )}

      {team.canManage && team.canInvite && (
        <section className="settings-section">
          <h2 className="admin-h2">Invite someone</h2>
          <form onSubmit={invite}>
            <fieldset disabled={busy !== null || full}>
              <label htmlFor="t-email">Email address</label>
              <input id="t-email" type="email" required autoComplete="off" placeholder="name@company.com" value={email} onChange={(e: { target: HTMLInputElement }) => setEmail(e.target.value)} />
              <fieldset className="team-roles">
                <legend className="sr-only">Role</legend>
                {(Object.keys(ROLE) as Role[]).reverse().map((r) => (
                <label key={r} className="radio">
                  <input type="radio" name="team-role" value={r} checked={role === r} onChange={() => setRole(r)} />
                  <span>
                    <strong>{ROLE[r].label}</strong> <span className="fine-inline">{ROLE[r].help}</span>
                  </span>
                </label>
                ))}
              </fieldset>
              <button type="submit" className="btn-brand">{busy === 'invite' ? 'Sending…' : 'Send invite'}</button>
            </fieldset>
          </form>
          {msg?.at === 'invite' && msg.ok && <p className="saved" role="status">{msg.ok}</p>}
          {msg?.at === 'invite' && msg.err && <p className="error" role="alert">{msg.err}</p>}
          <p className="fine">{full ? `This workspace has reached ${team.maxSize} people. Remove someone to invite more.` : 'They get an email with a sign-in link that works once, for 3 days. No password needed.'}</p>
        </section>
      )}
    </div>
  );
}
