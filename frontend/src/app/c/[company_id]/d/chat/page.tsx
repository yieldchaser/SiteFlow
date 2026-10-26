"use client";
import Badge from "@/components/ui/Badge";

import {  getApiHost , readErrorDetail } from "@/lib/api";
import { authHeaders, formatDate, formatDateTime } from "@/lib/siteflow";
import React, { useState, useEffect, useRef } from "react";
import { useProject } from "@/context/ProjectContext";
import { useParams } from "next/navigation";
import Icon from "@/components/marketing/Icon";

import PageHeader from "@/components/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import FieldHint from "@/components/ui/FieldHint";
import AuthImage, { uploadProjectImage } from "@/components/ui/AuthImage";

interface ChatGroup {
  id: string;
  name: string;
  group_type: string;
  created_at: string;
  member_count: number;
  unread_count?: number;
  icon_url?: string | null;
  last_message?: string | null;
  last_sender?: string | null;
  last_message_at?: string | null;
}

interface ChatMessage {
  id: string;
  user_name?: string;
  message_text?: string;
  image_urls?: string[];
  is_mom: boolean;
  mom_date?: string;
  created_at: string;
  is_mine?: boolean;
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "Today", "Yesterday", or "24 Oct 2026" for the divider above a day's messages. */
const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return "Today";
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

/** Time for today's messages, otherwise the short date, as in the chat list. */
const listTime = (iso?: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (sameDay(d, new Date())) return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  return dayLabel(iso);
};

const isPictureUrl = (u: string) => /^https?:\/\//i.test(u) || u.startsWith("/apis/v3/files/file/");

const getAvatarColor = (type: string) => {
  switch (type.toLowerCase()) {
    case "site":
      return "bg-success text-white";
    case "finance":
      return "bg-chart-4 text-white";
    case "safety":
      return "bg-warning text-white";
    default:
      return "bg-info text-white";
  }
};

/** The group's picture, or its first letter on the category colour. */
function GroupAvatar({ group, size }: { group: ChatGroup; size: string }) {
  const letter = (
    <div className={`${size} rounded-full flex items-center justify-center font-bold shrink-0 ${getAvatarColor(group.group_type)}`}>
      {group.name.charAt(0).toUpperCase()}
    </div>
  );
  return group.icon_url ? (
    <AuthImage src={group.icon_url} alt={group.name} className={`${size} rounded-full object-cover shrink-0`} fallback={letter} />
  ) : letter;
}

interface ChatMember {
  id: string;
  user_id: string;
  role: string;
  joined_at: string;
  name?: string; // Resolved real name returned by the backend
}

export default function ChatPage() {
  const params = useParams();
  const companyId = params?.company_id as string;
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;

  useEffect(() => {
    if (!companyId || companyId === "e0000000-0000-0000-0000-000000000000") {
      if (typeof window !== "undefined") window.location.replace("/login");
    }
  }, [companyId]);

  // State managers
  const [groups, setGroups] = useState<ChatGroup[]>([]);
  const [activeGroup, setActiveGroup] = useState<ChatGroup | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [members, setMembers] = useState<ChatMember[]>([]);
  
  // Modals / Drawer views
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [showMembersModal, setShowMembersModal] = useState(false);
  const [showAddMemberModal, setShowAddMemberModal] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  
  // Tab within members modal
  const [membersTab, setMembersTab] = useState<"about" | "members">("members");
  
  // Search & input fields
  const [searchGroupQuery, setSearchGroupQuery] = useState("");
  const [searchMemberQuery, setSearchMemberQuery] = useState("");
  const [messageText, setMessageText] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [iconBusy, setIconBusy] = useState(false);
  const [newGroupIcon, setNewGroupIcon] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const iconInputRef = useRef<HTMLInputElement>(null);
  const newIconInputRef = useRef<HTMLInputElement>(null);
  const [isMom, setIsMom] = useState(false);
  const [momDate, setMomDate] = useState("");
  const [currentUserRole, setCurrentUserRole] = useState("member");
  const [memberForm, setMemberForm] = useState({ user_id: "", role: "member" });
  const [teamOptions, setTeamOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [showMobileList, setShowMobileList] = useState(true);
  
  // Auto-scroll ref
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastMessageIdRef = useRef<string | null>(null);

  // Group Details Inputs (for creation)
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupType, setNewGroupType] = useState("site");

  const fetchGroups = async () => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/chat/groups/${projectId}`, { headers: authHeaders() });
      if (res.ok) {
        const fresh: ChatGroup[] = await res.json();
        setGroups(fresh);
        // Keep the open conversation's header (name, icon) in step with the list.
        setActiveGroup((cur) => (cur ? fresh.find((g) => g.id === cur.id) ?? cur : cur));
      }
    } catch (e) {
      console.error("Failed to load groups", e);
    } finally {
      setGroupsLoaded(true);
    }
  };

  const fetchMessages = async (groupId: string, sinceId?: string) => {
    try {
      const url = `${getApiHost()}/apis/v3/chat/messages/${groupId}`;
      const query = sinceId ? `?since_id=${sinceId}` : "?limit=200";
      const res = await fetch(`${url}${query}`, { headers: authHeaders() });
      if (res.ok) {
        const fresh: ChatMessage[] = await res.json();
        setMessages((prev) => {
          if (!sinceId) return fresh;
          const seen = new Set(prev.map((m) => m.id));
          const added = fresh.filter((m) => !seen.has(m.id));
          // Same array when nothing arrived, so a quiet poll does not scroll someone reading older messages.
          return added.length ? [...prev, ...added] : prev;
        });
        if (fresh.length > 0) {
          lastMessageIdRef.current = fresh[fresh.length - 1].id;
        }
      }
    } catch (e) {
      console.error("Failed to load messages", e);
    } finally {
      if (!sinceId) setMessagesLoaded(true);
    }
  };

  const fetchTeamOptions = async () => {
    if (!companyId || companyId === "e0000000-0000-0000-0000-000000000000") return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/crm/team-members/${companyId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setTeamOptions(Array.isArray(data) ? data : []);
      }
    } catch (e) {
      console.error("Failed to load team", e);
    }
  };

  const fetchMembers = async (groupId: string) => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/chat/groups/${groupId}/members`, { headers: authHeaders() });
      if (res.ok) {
        const rawMembers = await res.json();
        // Use the real name resolved by the backend. Fall back to a neutral
        // label (never a person's name) only if a name is somehow missing.
        const resolved = rawMembers.map((m: ChatMember) => ({
          ...m,
          name: m.name || `User ${m.user_id.slice(0, 5)}`
        }));
        setMembers(resolved);

        // The server marks the caller's own row; member ids are company-team
        // ids, so they can never be matched against the login's user id.
        const currentMember = rawMembers.find((m: ChatMember & { is_me?: boolean }) => m.is_me);
        setCurrentUserRole(currentMember ? currentMember.role : "member");
      }
    } catch (e) {
      console.error("Failed to load members", e);
    }
  };

  useEffect(() => {
    if (!projectId) return;
    setGroupsLoaded(false);
    fetchGroups();
    // Refresh previews and unread counts for the other conversations.
    const t = setInterval(fetchGroups, 15000);
    return () => clearInterval(t);
  }, [projectId]);

  useEffect(() => {
    fetchTeamOptions();
  }, [companyId]);

  const activeGroupId = activeGroup?.id;
  useEffect(() => {
    if (!activeGroup) return;
    lastMessageIdRef.current = null;
    let interval: NodeJS.Timeout;
    setMessages([]);
    setMessagesLoaded(false);
    setAttachments([]);
    setRenameValue(activeGroup.name);

    fetchMessages(activeGroup.id);
    fetchMembers(activeGroup.id);
    
    // Mark group as read on open
    fetch(`${getApiHost()}/apis/v3/chat/groups/${activeGroup.id}/read`, {
      method: "POST",
      headers: authHeaders(),
    }).catch((e) => console.error("Failed to mark group as read", e));
    
    interval = setInterval(() => {
      fetchMessages(activeGroup.id, lastMessageIdRef.current || undefined);
    }, 4000);

    return () => {
      clearInterval(interval);
    };
    // Re-run only when a different group is opened, not when its preview refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGroupId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleCreateGroupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newGroupName.trim()) return;

    try {
      const res = await fetch(`${getApiHost()}/apis/v3/chat/groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        // R2-270: created_by references company_team.id, not users.id - it is
        // resolved server-side from the authenticated session, so the client
        // must not send an id of the wrong kind.
        body: JSON.stringify({
          company_id: companyId,
          project_id: projectId,
          name: newGroupName,
          group_type: newGroupType,
          icon_url: newGroupIcon,
        }),
      });
      if (res.ok) {
        const created: ChatGroup = await res.json();
        setNewGroupName("");
        setNewGroupIcon(null);
        setShowGroupModal(false);
        await fetchGroups();
        setActiveGroup(created);
        setShowMobileList(false);
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch (e) {
      console.error("Failed to create group", e);
    }
  };

  const handleAddMemberSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeGroup || !memberForm.user_id.trim()) return;

    try {
      const res = await fetch(`${getApiHost()}/apis/v3/chat/groups/${activeGroup.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          group_id: activeGroup.id,
          user_id: memberForm.user_id,
          role: memberForm.role,
        }),
      });
      if (res.ok) {
        setShowAddMemberModal(false);
        setMemberForm({ user_id: "", role: "member" });
        fetchMembers(activeGroup.id);
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch (e) {
      console.error("Failed to add member", e);
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!activeGroup) return;
    if (!confirm("Are you sure you want to remove this member from the group?")) return;

    try {
      const res = await fetch(
        `${getApiHost()}/apis/v3/chat/groups/${activeGroup.id}/members/${userId}`,
        { method: "DELETE", headers: authHeaders() }
      );
      if (res.ok) {
        fetchMembers(activeGroup.id);
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch (e) {
      console.error("Failed to remove member", e);
    }
  };

  const handleUpdateMemberRole = async (userId: string, newRole: "admin" | "member") => {
    if (!activeGroup) return;
    try {
      const res = await fetch(
        `${getApiHost()}/apis/v3/chat/groups/${activeGroup.id}/members/${userId}/role?role=${newRole}`,
        { method: "PATCH", headers: authHeaders() }
      );
      if (res.ok) {
        fetchMembers(activeGroup.id);
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Failed to update member role");
      }
    } catch (e) {
      console.error("Failed to update member role", e);
    }
  };

  const pickImage = (input: HTMLInputElement | null): File | null => {
    const file = input?.files?.[0] ?? null;
    if (input) input.value = "";
    if (file && !file.type.startsWith("image/")) {
      alert("Please choose a photo (JPG or PNG).");
      return null;
    }
    return file;
  };

  const handleAttachPhoto = async () => {
    const file = pickImage(photoInputRef.current);
    if (!file || !projectId) return;
    setUploading(true);
    try {
      const path = await uploadProjectImage(projectId, file);
      setAttachments((prev) => [...prev, path]);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const updateGroup = async (patch: { name?: string; icon_url?: string }) => {
    if (!activeGroup) return false;
    const res = await fetch(`${getApiHost()}/apis/v3/chat/groups/${activeGroup.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      alert((await readErrorDetail(res)) || "Could not update the group");
      return false;
    }
    const updated: ChatGroup = await res.json();
    setActiveGroup((cur) => (cur ? { ...cur, ...updated } : cur));
    fetchGroups();
    return true;
  };

  const handleChangeIcon = async () => {
    const file = pickImage(iconInputRef.current);
    if (!file || !projectId) return;
    setIconBusy(true);
    try {
      await updateGroup({ icon_url: await uploadProjectImage(projectId, file) });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setIconBusy(false);
    }
  };

  const handleNewGroupIcon = async () => {
    const file = pickImage(newIconInputRef.current);
    if (!file || !projectId) return;
    setIconBusy(true);
    try {
      setNewGroupIcon(await uploadProjectImage(projectId, file));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setIconBusy(false);
    }
  };

  const handleSendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!activeGroup || sending || uploading || (!messageText.trim() && attachments.length === 0)) return;
    if (isMom && !momDate) {
      alert("Choose the meeting date for these minutes.");
      return;
    }

    setSending(true);
    try {
      const body: Record<string, unknown> = {
        group_id: activeGroup.id,
        message_text: messageText.trim() || null,
        is_mom: isMom,
        mom_date: isMom ? new Date(momDate).toISOString() : null,
        image_urls: attachments,
      };
      const res = await fetch(`${getApiHost()}/apis/v3/chat/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const sent: ChatMessage = await res.json();
        setMessageText("");
        setAttachments([]);
        setIsMom(false);
        setMomDate("");
        setMessages((prev) => (prev.some((m) => m.id === sent.id) ? prev : [...prev, sent]));
        lastMessageIdRef.current = sent.id;
        fetchGroups();
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch (e) {
      console.error("Failed to send message", e);
    } finally {
      setSending(false);
    }
  };

  const handleDeleteGroup = async () => {
    if (!activeGroup) return;
    if (!confirm(`Are you sure you want to delete the group "${activeGroup.name}"?`)) return;

    try {
      const res = await fetch(`${getApiHost()}/apis/v3/chat/groups/${activeGroup.id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (res.ok) {
        setActiveGroup(null);
        setShowDropdown(false);
        fetchGroups();
      } else {
        const err = await res.json().catch(() => null);
        console.error("Failed to delete group", err?.detail || res.status);
      }
    } catch (e) {
      console.error("Failed to delete group", e);
    }
  };

  // Filters
  const filteredGroups = groups.filter((g) =>
    g.name.toLowerCase().includes(searchGroupQuery.toLowerCase())
  );

  const filteredMembers = members.filter((m) =>
    (m.name || m.user_id).toLowerCase().includes(searchMemberQuery.toLowerCase())
  );

  const isAdmin = currentUserRole === "admin";

  return (
    <div className="flex-1 flex flex-col h-full bg-background text-foreground overflow-hidden font-sans">
      <PageHeader
        title="Team Chat"
        subtitle="Internal project discussions and channel messaging"
        action={
          <button
            onClick={() => setShowGroupModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-primary hover:bg-primary/95 text-white rounded-md text-xs font-semibold transition-all cursor-pointer"
          >
            <Icon name="group" className="w-3.5 h-3.5" />
            Create Group
          </button>
        }
      />
      <div className="flex flex-1 overflow-hidden h-full">
        
        {/* Left Column: Recent Chats Sidebar */}
        <div className={`${showMobileList ? "flex" : "hidden"} md:flex w-full md:w-72 bg-card border-r border-border-custom flex-col shrink-0`}>
          <div className="p-4 border-b border-border-custom flex items-center justify-between">
            <h2 className="text-xs font-bold text-foreground uppercase tracking-wider">Recent Chats</h2>
            <button
              onClick={() => setShowGroupModal(true)}
              className="h-7 w-7 flex items-center justify-center bg-primary/10 hover:bg-primary text-primary hover:text-white rounded-lg text-sm font-bold transition-all cursor-pointer"
              title="Create Chat Group"
            >
              +
            </button>
          </div>

          {/* Group Search */}
          <div className="p-3 border-b border-border-custom/50">
            <div className="relative">
              <input
                type="text"
                placeholder="Search chats..."
                value={searchGroupQuery}
                onChange={(e) => setSearchGroupQuery(e.target.value)}
                className="w-full bg-elevated/40 border border-border-custom rounded-lg pl-8 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted focus:outline-none focus:border-primary transition-all"
              />
              <Icon name="search" className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted pointer-events-none select-none" />
            </div>
          </div>

          {/* Group List */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {filteredGroups.length > 0 ? (
              filteredGroups.map((g) => (
                <button
                  key={g.id}
                  onClick={() => {
                    setActiveGroup(g);
                    setCurrentUserRole("member");
                    setShowMobileList(false);
                  }}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all cursor-pointer ${
                    activeGroup?.id === g.id
                      ? "bg-elevated text-foreground font-semibold"
                      : "hover:bg-elevated/50 text-muted hover:text-foreground"
                  }`}
                >
                  <GroupAvatar group={g} size="h-10 w-10 text-sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="font-bold text-xs text-foreground truncate">{g.name}</div>
                      <div className={`text-[10px] shrink-0 ${g.unread_count ? "text-primary font-bold" : "text-muted"}`}>
                        {listTime(g.last_message_at)}
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      <div className="text-[11px] text-muted truncate">
                        {g.last_message
                          ? `${g.last_sender ? `${g.last_sender}: ` : ""}${g.last_message}`
                          : `${g.member_count} member${g.member_count !== 1 ? "s" : ""} · no messages yet`}
                      </div>
                      {!!g.unread_count && activeGroup?.id !== g.id && (
                        <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-white text-[10px] font-bold flex items-center justify-center shrink-0">
                          {g.unread_count > 99 ? "99+" : g.unread_count}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              ))
            ) : projectId && !groupsLoaded ? (
              <div className="space-y-2 p-1">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-12 rounded-lg bg-elevated/50 animate-pulse" />
                ))}
              </div>
            ) : projectId ? (
              <EmptyState
                title="No chats found"
                description="Start a conversation with project members or subconsultants."
                className="py-8"
              />
            ) : (
              <div className="text-center py-8 px-3 text-xs text-muted leading-relaxed">
                No active project selected. Pick a project from the "Pinned Projects" dropdown in the sidebar to view its chats.
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Chat Window */}
        <div className={`${showMobileList ? "hidden" : "flex"} md:flex flex-1 flex-col bg-elevated/5 relative overflow-hidden`}>
          {activeGroup ? (
            <>
              {/* Chat Header */}
              <div className="px-6 py-4 border-b border-border-custom bg-card flex items-center justify-between shrink-0">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setShowMobileList(true)}
                    className="md:hidden h-8 w-8 shrink-0 flex items-center justify-center rounded-lg hover:bg-elevated text-muted hover:text-foreground transition-all cursor-pointer"
                    title="Back to chats"
                  >
                    <span className="text-base leading-none">&#8592;</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setMembersTab("about"); setShowMembersModal(true); }}
                    className="cursor-pointer"
                    title="Group info"
                  >
                    <GroupAvatar group={activeGroup} size="h-9 w-9 text-sm" />
                  </button>
                  <div>
                    <h2 className="text-xs font-bold text-foreground leading-tight">{activeGroup.name}</h2>
                    <p className="text-[10px] text-muted capitalize">
                      {activeGroup.group_type} • {activeGroup.member_count} member{activeGroup.member_count !== 1 && "s"}
                    </p>
                  </div>
                </div>

                {/* Right Header Toolbar */}
                <div className="flex items-center gap-3">
                  {/* User avatars summary */}
                  <div
                    onClick={() => {
                      setMembersTab("members");
                      setShowMembersModal(true);
                    }}
                    className="flex -space-x-1.5 overflow-hidden cursor-pointer hover:opacity-85 transition-opacity"
                    title="View Members"
                  >
                    {members.slice(0, 3).map((m, idx) => (
                      <div
                        key={m.id}
                        className={`h-6 w-6 rounded-full border border-card flex items-center justify-center text-[9px] font-bold ${
                          idx === 0 ? "bg-primary text-white" : idx === 1 ? "bg-chart-4 text-white" : "bg-success text-white"
                        }`}
                      >
                        {(m.name || m.user_id).charAt(0).toUpperCase()}
                      </div>
                    ))}
                    {members.length > 3 && (
                      <div className="h-6 w-6 rounded-full border border-card bg-elevated flex items-center justify-center text-[9px] font-bold text-muted">
                        +{members.length - 3}
                      </div>
                    )}
                  </div>

                  {/* Add Member Button */}
                  <button
                    onClick={() => setShowAddMemberModal(true)}
                    className="h-7 w-7 flex items-center justify-center rounded-lg bg-primary/10 hover:bg-primary text-primary hover:text-white transition-all text-xs font-bold cursor-pointer"
                    title="Add Member"
                  >
                    +
                  </button>

                  {/* Settings Dropdown Menu */}
                  <div className="relative">
                    <button
                      onClick={() => setShowDropdown(!showDropdown)}
                      className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-elevated text-muted hover:text-foreground transition-all text-xs font-bold cursor-pointer"
                    >
                      •••
                    </button>
                    {showDropdown && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setShowDropdown(false)}></div>
                        <div className="absolute right-0 mt-1.5 w-40 bg-card border border-border-custom rounded-lg shadow-lg py-1 z-20">
                          <button
                            onClick={() => {
                              setShowDropdown(false);
                              setMembersTab("about");
                              setShowMembersModal(true);
                            }}
                            className="w-full text-left px-4 py-2 text-xs hover:bg-elevated text-foreground"
                          >
                            About Group
                          </button>
                          <button
                            onClick={() => {
                              setShowDropdown(false);
                              setMembersTab("members");
                              setShowMembersModal(true);
                            }}
                            className="w-full text-left px-4 py-2 text-xs hover:bg-elevated text-foreground"
                          >
                            Manage Members
                          </button>
                          {isAdmin && (
                            <>
                              <hr className="border-border-custom/50 my-1" />
                              <button
                                onClick={handleDeleteGroup}
                                className="w-full text-left px-4 py-2 text-xs hover:bg-danger/10 text-danger font-bold"
                              >
                                Delete Group
                              </button>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Chat Message list panel */}
              <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4 space-y-2">
                {!messagesLoaded ? (
                  <div className="space-y-3">
                    {[48, 64, 40].map((w, i) => (
                      <div key={i} className={`flex ${i % 2 ? "justify-end" : "justify-start"}`}>
                        <div className="h-14 rounded-2xl bg-elevated/50 animate-pulse" style={{ width: `${w}%` }} />
                      </div>
                    ))}
                  </div>
                ) : messages.length === 0 ? (
                  <div className="h-full flex items-center justify-center">
                    <EmptyState
                      title="No messages yet"
                      description="Say hello to the site team. You can send text, attach site photos, or record minutes of a meeting."
                    />
                  </div>
                ) : (
                  messages.map((msg, idx) => {
                    const isSystemMom = msg.is_mom;
                    const mine = !!msg.is_mine && !isSystemMom;
                    const prev = messages[idx - 1];
                    const newDay = !prev || !sameDay(new Date(prev.created_at), new Date(msg.created_at));
                    // Group consecutive messages from one sender under a single name.
                    const showName = !mine && !isSystemMom && (newDay || prev?.user_name !== msg.user_name || prev?.is_mom);
                    const pictures = (msg.image_urls || []).filter(isPictureUrl);
                    return (
                      <React.Fragment key={msg.id}>
                        {newDay && (
                          <div className="flex justify-center py-2">
                            <span className="text-[10px] font-semibold text-muted bg-elevated/60 border border-border-custom/50 rounded-full px-3 py-0.5">
                              {dayLabel(msg.created_at)}
                            </span>
                          </div>
                        )}
                        <div className={`flex ${isSystemMom ? "justify-center" : mine ? "justify-end" : "justify-start"}`}>
                          <div
                            className={`max-w-[85%] md:max-w-lg px-3.5 py-2.5 border transition-all ${
                              isSystemMom
                                ? "bg-primary/5 border-primary/20 text-center w-full max-w-md rounded-xl"
                                : mine
                                  ? "bg-primary/15 border-primary/25 rounded-2xl rounded-br-md"
                                  : "bg-card border-border-custom rounded-2xl rounded-bl-md"
                            }`}
                          >
                            {isSystemMom && (
                              <Badge tone="primary" icon="bolt" className="font-extrabold uppercase tracking-wider mb-2.5">Minutes of Meeting</Badge>
                            )}

                            {showName && (
                              <div className="text-[10px] font-bold text-primary mb-1">{msg.user_name || "Team member"}</div>
                            )}
                            {isSystemMom && msg.user_name && (
                              <div className="text-[10px] text-muted mb-1">Recorded by {msg.user_name}</div>
                            )}

                            {pictures.length > 0 && (
                              <div className={`grid gap-1.5 mb-1.5 ${pictures.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
                                {pictures.map((url, i) => (
                                  <AuthImage
                                    key={i}
                                    src={url}
                                    alt="Site photo"
                                    // Fixed height: the loading placeholder takes the same space, so the scroll to the newest message holds.
                                    className="rounded-lg w-full h-48 object-cover cursor-zoom-in hover:opacity-90 transition-opacity"
                                    fallback={<div className="rounded-lg bg-elevated text-[10px] text-muted p-3">Photo could not be loaded</div>}
                                    onClick={setLightbox}
                                  />
                                ))}
                              </div>
                            )}

                            {msg.message_text && (
                              <div className="text-xs text-foreground leading-relaxed whitespace-pre-wrap break-words">
                                {msg.message_text}
                              </div>
                            )}

                            {msg.mom_date && (
                              <div className="text-[10px] text-muted mt-2 font-medium flex items-center justify-center gap-1">
                                <Icon name="calendar" className="w-3 h-3" /> Meeting date: {formatDate(msg.mom_date)}
                              </div>
                            )}

                            <div className="text-[9px] text-muted/80 mt-1 text-right font-medium">
                              {new Date(msg.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                            </div>
                          </div>
                        </div>
                      </React.Fragment>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Chat Input controls */}
              <div className="p-4 border-t border-border-custom bg-card shrink-0">
                {currentUserRole === "viewer" ? (
                  <div className="flex items-center justify-center p-3.5 bg-elevated/20 border border-dashed border-border-custom rounded-xl">
                    <span className="text-[11px] text-muted font-bold flex items-center gap-1.5 select-none">
                      <Icon name="lock" className="w-3.5 h-3.5" /> Read-Only Access (You are a group viewer and cannot send messages)
                    </span>
                  </div>
                ) : (
                  <form onSubmit={handleSendMessage} className="space-y-3">
                    <div className="flex flex-col gap-2">
                      
                      {(attachments.length > 0 || uploading) && (
                        <div className="flex flex-wrap gap-2">
                          {attachments.map((url) => (
                            <div key={url} className="relative">
                              <AuthImage src={url} alt="Photo to send" className="h-16 w-16 rounded-lg object-cover border border-border-custom" />
                              <button
                                type="button"
                                onClick={() => setAttachments((prev) => prev.filter((u) => u !== url))}
                                className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-danger text-white text-[10px] font-bold flex items-center justify-center cursor-pointer"
                                title="Remove photo"
                              >
                                ×
                              </button>
                            </div>
                          ))}
                          {uploading && <div className="h-16 w-16 rounded-lg bg-elevated animate-pulse flex items-center justify-center text-[9px] text-muted">Uploading</div>}
                        </div>
                      )}

                      <div className="flex items-end gap-2">
                        <input ref={photoInputRef} type="file" accept="image/*" className="hidden" onChange={handleAttachPhoto} />
                        <button
                          type="button"
                          onClick={() => photoInputRef.current?.click()}
                          disabled={uploading}
                          className="h-9 w-9 shrink-0 flex items-center justify-center rounded-lg border border-border-custom text-muted hover:text-primary hover:border-primary transition-all cursor-pointer disabled:opacity-50"
                          title="Attach a photo"
                        >
                          <Icon name="image" className="w-4 h-4" />
                        </button>
                        <textarea
                          value={messageText}
                          onChange={(e) => setMessageText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              handleSendMessage();
                            }
                          }}
                          rows={1}
                          placeholder="Type a message. Enter to send, Shift+Enter for a new line"
                          className="flex-1 min-w-0 resize-none max-h-32 bg-elevated/35 border border-border-custom rounded-lg px-4 py-2 text-xs text-foreground placeholder:text-muted focus:outline-none focus:border-primary transition-all"
                        />
                      </div>

                      {/* Bottom controls row (MOM toggle & Send) */}
                      <div className="flex items-center justify-between pt-1">
                        <div className="flex items-center gap-4">
                          <label className="flex items-center gap-2 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={isMom}
                              onChange={(e) => setIsMom(e.target.checked)}
                              className="rounded border-border-custom text-primary focus:ring-primary h-3.5 w-3.5"
                            />
                            <span className="text-[11px] font-bold text-muted hover:text-foreground transition-colors">Minutes of meeting</span>
                          </label>

                          {isMom && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] text-muted">Meeting date:</span>
                              <input
                                type="date"
                                value={momDate}
                                onChange={(e) => setMomDate(e.target.value)}
                                className="bg-elevated border border-border-custom rounded-lg px-3 py-1 text-[11px] text-foreground focus:outline-none focus:border-primary"
                              />
                            </div>
                          )}
                        </div>

                        <button
                          type="submit"
                          disabled={sending || uploading || (!messageText.trim() && attachments.length === 0)}
                          className="px-5 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <span>{sending ? "Sending" : "Send"}</span>
                          <Icon name="envelope" className="w-3.5 h-3.5" />
                        </button>
                      </div>

                    </div>
                  </form>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8 space-y-4">
              <Icon name="chat_bubble" className="w-16 h-16 text-muted/30" />
              <div className="space-y-1">
                <h3 className="text-sm font-bold text-foreground">Team Chat</h3>
                <p className="text-xs text-muted max-w-sm">
                  Pick a group on the left to read and reply, or press Create Group to start one for this project.
                </p>
              </div>
            </div>
          )}
        </div>

      </div>

      {/* Full-size photo viewer */}
      {lightbox && (
        <div
          className="fixed inset-0 bg-black/85 flex items-center justify-center z-[60] p-4 cursor-zoom-out"
          onClick={() => setLightbox(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="Site photo" className="max-h-full max-w-full rounded-lg object-contain" />
        </div>
      )}

      {/* MODAL 1: Create Group Modal */}
      {showGroupModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border-custom rounded-xl p-6 w-full max-w-md shadow-2xl relative">
            {/* Close */}
            <button
              onClick={() => setShowGroupModal(false)}
              className="absolute right-4 top-4 text-muted hover:text-foreground cursor-pointer"
            >
              <Icon name="close" className="w-5 h-5" />
            </button>

            <h2 className="text-sm font-extrabold text-foreground uppercase tracking-wider mb-6 text-center">Create Group</h2>
            
            <form onSubmit={handleCreateGroupSubmit} className="space-y-4">
              {/* Group icon */}
              <div className="flex flex-col items-center justify-center gap-2 mb-4">
                <input ref={newIconInputRef} type="file" accept="image/*" className="hidden" onChange={handleNewGroupIcon} />
                <button
                  type="button"
                  onClick={() => newIconInputRef.current?.click()}
                  disabled={iconBusy}
                  className="h-16 w-16 rounded-full bg-elevated/40 border border-border-custom flex items-center justify-center text-muted hover:border-primary hover:text-primary transition-all overflow-hidden cursor-pointer"
                  title="Choose a group picture"
                >
                  {iconBusy ? (
                    <span className="text-[9px]">Uploading</span>
                  ) : newGroupIcon ? (
                    <AuthImage src={newGroupIcon} alt="Group picture" className="h-16 w-16 object-cover" />
                  ) : (
                    <Icon name="camera" className="w-7 h-7" />
                  )}
                </button>
                <span className="text-[10px] text-muted">{newGroupIcon ? "Tap to change the picture" : "Add a group picture (optional)"}</span>
              </div>

              <div>
                <label className="block text-[10px] font-extrabold text-muted uppercase tracking-wider mb-1.5">Group Name</label>
                <input
                  type="text"
                  required
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  placeholder="e.g. Site Announcements"
                  className="w-full bg-elevated/35 border border-border-custom rounded-lg px-4 py-2 text-xs text-foreground placeholder:text-muted focus:outline-none focus:border-primary"
                />
              </div>

              <div>
                <label className="block text-[10px] font-extrabold text-muted uppercase tracking-wider mb-1.5">Group Category / Type</label>
                <select
                  value={newGroupType}
                  onChange={(e) => setNewGroupType(e.target.value)}
                  className="w-full bg-elevated border border-border-custom rounded-lg px-4 py-2 text-xs text-foreground focus:outline-none focus:border-primary"
                >
                  <option value="site">Site & Logistics</option>
                  <option value="finance">Finance & Accounts</option>
                  <option value="safety">Safety & Compliance</option>
                  <option value="general">General Discussions</option>
                </select>
              </div>

              <div className="flex gap-3 pt-4">
                <button
                  type="submit"
                  className="flex-1 px-4 py-2.5 bg-primary hover:bg-primary-hover text-white rounded-lg text-xs font-bold transition-all cursor-pointer"
                >
                  Create Chat Group
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: Group Details & Members List Tabbed Drawer */}
      {showMembersModal && activeGroup && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border-custom rounded-xl p-6 w-full max-w-md shadow-2xl relative">
            {/* Close */}
            <button
              onClick={() => setShowMembersModal(false)}
              className="absolute right-4 top-4 text-muted hover:text-foreground cursor-pointer"
            >
              <Icon name="close" className="w-5 h-5" />
            </button>

            {/* Header info */}
            <div className="flex items-center gap-3 pb-4 mb-4 border-b border-border-custom/50">
              <GroupAvatar group={activeGroup} size="h-11 w-11 text-sm" />
              <div>
                <h3 className="text-xs font-bold text-foreground leading-tight">{activeGroup.name}</h3>
                <p className="text-[10px] text-muted capitalize">{activeGroup.group_type} Group</p>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-border-custom/50 mb-4">
              <button
                onClick={() => setMembersTab("about")}
                className={`flex-1 text-center py-2 text-xs font-bold transition-all border-b-2 cursor-pointer ${
                  membersTab === "about" ? "border-primary text-primary" : "border-transparent text-muted hover:text-foreground"
                }`}
              >
                About
              </button>
              <button
                onClick={() => setMembersTab("members")}
                className={`flex-1 text-center py-2 text-xs font-bold transition-all border-b-2 cursor-pointer ${
                  membersTab === "members" ? "border-primary text-primary" : "border-transparent text-muted hover:text-foreground"
                }`}
              >
                Members ({members.length})
              </button>
            </div>

            {/* Tab content 1: About */}
            {membersTab === "about" && (
              <div className="space-y-4 py-2">
                <div className="flex flex-col items-center gap-2">
                  <GroupAvatar group={activeGroup} size="h-24 w-24 text-3xl" />
                  {isAdmin && (
                    <div className="flex items-center gap-3">
                      <input ref={iconInputRef} type="file" accept="image/*" className="hidden" onChange={handleChangeIcon} />
                      <button
                        type="button"
                        onClick={() => iconInputRef.current?.click()}
                        disabled={iconBusy}
                        className="text-[11px] font-bold text-primary hover:underline cursor-pointer disabled:opacity-50"
                      >
                        {iconBusy ? "Uploading..." : activeGroup.icon_url ? "Change picture" : "Add group picture"}
                      </button>
                      {activeGroup.icon_url && !iconBusy && (
                        <button
                          type="button"
                          onClick={() => updateGroup({ icon_url: "" })}
                          className="text-[11px] font-bold text-muted hover:text-danger cursor-pointer"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div>
                  <h4 className="text-[9px] font-extrabold text-muted uppercase tracking-wider">Group Name</h4>
                  {isAdmin ? (
                    <form
                      className="flex gap-2 mt-1"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (renameValue.trim() && renameValue.trim() !== activeGroup.name) updateGroup({ name: renameValue.trim() });
                      }}
                    >
                      <input
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        maxLength={255}
                        className="flex-1 bg-elevated/35 border border-border-custom rounded-lg px-3 py-1.5 text-xs text-foreground focus:outline-none focus:border-primary"
                      />
                      <button
                        type="submit"
                        disabled={!renameValue.trim() || renameValue.trim() === activeGroup.name}
                        className="px-3 py-1.5 bg-primary text-white rounded-lg text-[11px] font-bold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Save
                      </button>
                    </form>
                  ) : (
                    <p className="text-xs text-foreground font-medium mt-0.5">{activeGroup.name}</p>
                  )}
                </div>
                <div>
                  <h4 className="text-[9px] font-extrabold text-muted uppercase tracking-wider">Category</h4>
                  <p className="text-xs text-foreground capitalize mt-0.5">{activeGroup.group_type}</p>
                </div>
                <div>
                  <h4 className="text-[9px] font-extrabold text-muted uppercase tracking-wider">Created At</h4>
                  <p className="text-xs text-foreground mt-0.5">
                    {formatDateTime(activeGroup.created_at)}
                  </p>
                </div>
                {!isAdmin && (
                  <p className="text-[10px] text-muted">Only a group admin can change the picture or the name.</p>
                )}
              </div>
            )}

            {/* Tab content 2: Members */}
            {membersTab === "members" && (
              <div className="space-y-3 flex flex-col h-72 overflow-hidden">
                {/* Search members */}
                <div className="relative shrink-0">
                  <input
                    type="text"
                    placeholder="Search Members"
                    value={searchMemberQuery}
                    onChange={(e) => setSearchMemberQuery(e.target.value)}
                    className="w-full bg-elevated/40 border border-border-custom rounded-lg pl-8 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted focus:outline-none focus:border-primary"
                  />
                  <Icon name="search" className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted pointer-events-none" />
                </div>

                {/* Scrollable list */}
                <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                  {filteredMembers.length > 0 ? (
                    filteredMembers.map((m) => (
                      <div
                        key={m.id}
                        className="flex items-center justify-between p-2 rounded-lg bg-elevated/20 border border-border-custom/30 hover:border-border-custom transition-all"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="h-7 w-7 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-[10px] shrink-0">
                        {(m.name || m.user_id).charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="text-xs font-bold text-foreground truncate">
                              {m.name || `User ${m.user_id.slice(0, 8)}`}
                              {(m as ChatMember & { is_me?: boolean }).is_me && <span className="text-muted font-medium"> (you)</span>}
                            </div>
                            <div className="text-[9px] text-muted capitalize font-medium">{m.role === "admin" ? "Group Admin" : "Member"}</div>
                          </div>
                        </div>
                        {isAdmin && !(m as ChatMember & { is_me?: boolean }).is_me && (
                        <div className="flex items-center gap-2">
                          <select
                            value={m.role}
                            onChange={(e) => handleUpdateMemberRole(m.user_id, e.target.value as "admin" | "member")}
                            className="bg-elevated border border-border-custom text-[10px] rounded px-1.5 py-0.5 text-foreground cursor-pointer"
                          >
                            <option value="member">Member</option>
                            <option value="admin">Admin</option>
                          </select>
                          {m.role !== "admin" && (
                            <button
                              onClick={() => handleRemoveMember(m.user_id)}
                              className="p-1 text-muted hover:text-danger transition-colors cursor-pointer"
                              title="Remove Member"
                            >
                              <Icon name="trash" className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="text-center py-8 text-xs text-muted">No members match search.</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* MODAL 3: Add Member Modal */}
      {showAddMemberModal && activeGroup && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border-custom rounded-xl p-6 w-full max-w-md shadow-2xl relative">
            {/* Close */}
            <button
              onClick={() => setShowAddMemberModal(false)}
              className="absolute right-4 top-4 text-muted hover:text-foreground cursor-pointer"
            >
              <Icon name="close" className="w-5 h-5" />
            </button>

            <h2 className="text-sm font-extrabold text-foreground uppercase tracking-wider mb-6 text-center">Add Member</h2>

            <form onSubmit={handleAddMemberSubmit} className="space-y-4">
              <div>
                <label className="block text-[10px] font-extrabold text-muted uppercase tracking-wider mb-1.5">Team Member</label>
                <select
                  required
                  value={memberForm.user_id}
                  onChange={(e) => setMemberForm({ ...memberForm, user_id: e.target.value })}
                  className="w-full bg-elevated border border-border-custom rounded-lg px-4 py-2 text-xs text-foreground focus:outline-none focus:border-primary"
                >
                  <option value="">Select a team member</option>
                  {teamOptions.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
                {teamOptions.length === 0 && (
                  <FieldHint text="No team members available. Invite members in Settings." href={`/c/${companyId}/settings`} linkLabel="Go to Settings" />
                )}
              </div>

              <div>
                <label className="block text-[10px] font-extrabold text-muted uppercase tracking-wider mb-1.5">Role Permission</label>
                <select
                  value={memberForm.role}
                  onChange={(e) => setMemberForm({ ...memberForm, role: e.target.value })}
                  className="w-full bg-elevated border border-border-custom rounded-lg px-4 py-2 text-xs text-foreground focus:outline-none focus:border-primary"
                >
                  <option value="member">Member</option>
                  <option value="viewer">Viewer / Auditor</option>
                </select>
              </div>

              <div className="flex gap-3 pt-4">
                <button
                  type="submit"
                  className="flex-1 px-4 py-2.5 bg-primary hover:bg-primary-hover text-white rounded-lg text-xs font-bold transition-all cursor-pointer"
                >
                  Add Member
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}