import { AddInboxModal, type AddInboxMode } from "./components/AddInboxModal";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DETAIL_CACHE_MS,
  EMPTY_COMPOSE,
  FOLDERS,
  NATIVE_ACCOUNT_ID,
  base64UrlToArrayBuffer,
  belongsInFolder,
  draftSenderKey,
  forwardedBody,
  hasDraftContent,
  notificationControlsDisabled,
  type DetailCacheEntry,
} from "./appModel";
import { ComposeModal } from "./components/ComposeModal";
import { MailList } from "./components/MailList";
import { MessageReader } from "./components/MessageReader";
import { MobileNav } from "./components/MobileNav";
import { ProfileModal } from "./components/ProfileModal";
import { SessionListModal, type SessionInfo } from "./components/SessionListModal";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import type {
  ComposeState,
  ConnectedAccount,
  DraftDetail,
  Folder,
  MessageDetail,
  MessageListItem,
  NotificationState,
} from "./mailTypes";
import { forwardSubject, replySubject } from "./mailUtils";
import { applyMailMutationShields, mailMutationKey, type MailMutationFlags, type MailMutationShield } from "./mailMutationShields";
import { useActiveAccountAppearance } from "./appearance";

export function App() {
  const [folder, setFolder] = useState<Folder>("inbox");
  const [messages, setMessages] = useState<MessageListItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [draftCount, setDraftCount] = useState(0);
  const [selected, setSelected] = useState<MessageDetail | null>(null);
  const [thread, setThread] = useState<MessageDetail[]>([]);
  const [openingMessageId, setOpeningMessageId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMailIds, setSelectedMailIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [compose, setCompose] = useState<ComposeState>(EMPTY_COMPOSE);
  const [composeAccountId, setComposeAccountId] = useState(NATIVE_ACCOUNT_ID);
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [draftStatus, setDraftStatus] = useState<"saving" | "saved" | null>(null);
  const [notificationState, setNotificationState] = useState<NotificationState>("checking");
  const [pushPublicKey, setPushPublicKey] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [addInboxMode, setAddInboxMode] = useState<AddInboxMode>(null);
  const [activeAccountId, setActiveAccountId] = useState(NATIVE_ACCOUNT_ID);
  // Theme, accent, density, text size and icons follow the open mailbox.
  useActiveAccountAppearance(activeAccountId);
  const [connectingGmail, setConnectingGmail] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profilePhotoUrl, setProfilePhotoUrl] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState<string | null>(null);
  const [sessionCount, setSessionCount] = useState<number | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [sessionsOpen, setSessionsOpen] = useState(false);

  const persistedDraftIds = useRef(new Set<string>());
  const detailCache = useRef(new Map<string, DetailCacheEntry>());
  const openRequest = useRef(0);
  const listRequest = useRef(0);
  const mutationShields = useRef(new Map<string, MailMutationShield>());
  const mailViewRef = useRef({ folder, search, accountId: activeAccountId });
  mailViewRef.current = { folder, search, accountId: activeAccountId };

  const detailCacheKey = useCallback(
    (id: string) => `${activeAccountId}:${id}`,
    [activeAccountId],
  );

  const refreshAccounts = useCallback(async () => {
    const response = await fetch("/api/accounts", { cache: "no-store" });
    if (response.ok) {
      setAccounts((await response.json() as { accounts: ConnectedAccount[] }).accounts);
      setAccountsLoaded(true);
    }
  }, []);

  useEffect(() => {
    fetch("/api/device/status", {cache:"no-store"})
      .then(response => response.ok ? response.json() as Promise<{isAdmin:boolean}> : null)
      .then(status => setIsAdmin(Boolean(status?.isAdmin))).catch(() => undefined);
    void refreshAccounts();
    fetch("/api/profile", { cache: "no-store" })
      .then(async (response) => response.ok
        ? response.json() as Promise<{ hasPhoto: boolean; version: string | null }>
        : null)
      .then((profile) => {
        setProfilePhotoUrl(profile?.hasPhoto
          ? `/api/profile/photo?v=${encodeURIComponent(profile.version ?? "1")}`
          : null);
      })
      .catch(() => undefined);
  }, [refreshAccounts]);

  const refreshSessions = useCallback(async () => {
    const response = await fetch("/api/auth/sessions", { cache: "no-store" });
    if (!response.ok) return;

    const next = await response.json() as { sessions: SessionInfo[] };
    setSessions(next.sessions);
    setSessionCount(next.sessions.length);
  }, []);

  useEffect(() => {
    if (settingsOpen) void refreshSessions();
  }, [settingsOpen, refreshSessions]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (
        !("serviceWorker" in navigator)
        || !("PushManager" in window)
        || !("Notification" in window)
      ) {
        setNotificationState("unsupported");
        return;
      }

      try {
        const response = await fetch("/api/push/config", { cache: "no-store" });
        const config = await response.json() as {
          configured: boolean;
          publicKey: string | null;
        };
        if (!config.configured || !config.publicKey) {
          setNotificationState("unconfigured");
          return;
        }

        setPushPublicKey(config.publicKey);
        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
        });
        const subscription = await registration.pushManager.getSubscription();
        if (!cancelled) {
          setNotificationState(
            Notification.permission === "denied"
              ? "blocked"
              : subscription
                ? "on"
                : "off",
          );
        }
      } catch {
        if (!cancelled) setNotificationState("unsupported");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const loadMessages = useCallback(
    async (activeFolder = folder, query = search, silent = false) => {
      const requestId = ++listRequest.current;
      if (!silent) {
        setLoading(true);
        setError(null);
      }

      try {
        const params = new URLSearchParams({
          folder: activeFolder,
          accountId: activeAccountId,
        });
        if (query.trim()) params.set("q", query.trim());

        const response = await fetch(`/api/messages?${params}`);
        if (!response.ok) throw new Error("Could not load mail");
        const data = await response.json() as {
          messages: MessageListItem[];
          unreadCount: number;
          draftCount: number;
        };
        if (requestId !== listRequest.current) return;
        const guarded = applyMailMutationShields(activeFolder, activeAccountId, data.messages, mutationShields.current);
        setMessages(guarded);
        const visibleIds = new Set(guarded.map(item => item.id));
        const shieldedUnread = data.messages.filter(item =>
          !visibleIds.has(item.id) && item.direction === "inbound" && !item.isRead).length;
        setUnreadCount(Math.max(0, data.unreadCount - shieldedUnread));
        setDraftCount(data.draftCount);
      } catch (caught) {
        if (!silent && requestId === listRequest.current) {
          setError(caught instanceof Error ? caught.message : "Could not load mail");
        }
      } finally {
        if (!silent && requestId === listRequest.current) setLoading(false);
      }
    },
    [folder, search, activeAccountId],
  );

  useEffect(() => {
    // Do not request the previous default native account before the device's
    // actual authorized account list has loaded.
    if (!accountsLoaded || !accounts.some(account => account.id === activeAccountId)) return;
    const timer = setTimeout(
      () => void loadMessages(folder, search),
      search ? 250 : 0,
    );
    return () => clearTimeout(timer);
  }, [folder, search, activeAccountId, loadMessages, accountsLoaded, accounts]);

  useEffect(() => {
    const refresh = () => {
      if (accountsLoaded && accounts.some(account => account.id === activeAccountId) && document.visibilityState === "visible") {
        void loadMessages(folder, search, true);
      }
    };
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
    };
  }, [folder, search, loadMessages, accountsLoaded, accounts, activeAccountId]);

  const openAddInbox = () => {
    setError(null);
    setSettingsOpen(false);
    setAddInboxMode("choose");
  };

  const connectGmail = async () => {
    setConnectingGmail(true);
    setError(null);
    try {
      const response = await fetch("/api/accounts/gmail/connect", { method: "POST" });
      const data = await response.json() as {
        authorizationUrl?: string;
        error?: string;
      };
      if (!response.ok || !data.authorizationUrl) {
        throw new Error(data.error || "Could not start Gmail connection");
      }
      window.location.assign(data.authorizationUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not connect Gmail");
      setConnectingGmail(false);
    }
  };

  const switchAccount = (id: string) => {
    openRequest.current += 1;
    listRequest.current += 1;
    setMessages([]);
    setSelectionMode(false);
    setSelectedMailIds([]);
    setUnreadCount(0);
    setDraftCount(0);
    setLoading(true);
    setActiveAccountId(id);
    localStorage.setItem("ltm:active-mail-account", id);
    setSelected(null);
    setThread([]);
    setOpeningMessageId(null);
    setSearch("");
  };

  useEffect(() => {
    if (!accountsLoaded || accounts.length === 0) return;
    if (accounts.some(account => account.id === activeAccountId)) return;
    const remembered = localStorage.getItem("ltm:active-mail-account");
    const selectedId = accounts.find(account => account.id === remembered)?.id ?? accounts[0].id;
    switchAccount(selectedId);
  }, [accountsLoaded, accounts, activeAccountId]);

  const persistDraft = useCallback(async (current: ComposeState) => {
    if (!current.draftId || !hasDraftContent(current)) return;
    setDraftStatus("saving");
    try {
      const response = await fetch("/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: current.draftId,
          accountId: composeAccountId,
          to: current.to,
          cc: current.cc,
          bcc: current.bcc,
          subject: current.subject,
          text: current.text,
          replyToMessageId: current.replyToMessageId,
          forwardMessageId: current.forwardMessageId,
        }),
      });
      if (!response.ok) throw new Error();

      const known = persistedDraftIds.current.has(current.draftId);
      persistedDraftIds.current.add(current.draftId);
      if (!known) setDraftCount((count) => count + 1);
      setDraftStatus("saved");
    } catch {
      setDraftStatus(null);
    }
  }, [composeAccountId]);

  useEffect(() => {
    if (!composeOpen || sending || !hasDraftContent(compose)) return;
    const timer = setTimeout(() => void persistDraft(compose), 900);
    return () => clearTimeout(timer);
  }, [compose, composeOpen, sending, persistDraft]);

  const changeFolder = (nextFolder: Folder) => {
    openRequest.current += 1;
    setSelectionMode(false);
    setSelectedMailIds([]);
    setFolder(nextFolder);
    setSelected(null);
    setThread([]);
    setOpeningMessageId(null);
    setSearch("");
  };

  const toggleNotifications = async () => {
    if (
      !pushPublicKey
      || notificationControlsDisabled(notificationState)
    ) {
      return;
    }

    setNotificationState("working");
    try {
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: existing.endpoint }),
        });
        await existing.unsubscribe();
        setNotificationState("off");
        return;
      }

      if (await Notification.requestPermission() !== "granted") {
        setNotificationState("off");
        return;
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToArrayBuffer(pushPublicKey),
      });
      const response = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!response.ok) throw new Error();
      setNotificationState("on");
    } catch {
      setNotificationState("off");
      setError("Could not update notifications");
    }
  };

  const removeAccount = async (id: string) => {
    if (!confirm("Sign out this email account on this device? Other devices stay signed in.")) return;
    setSettingsBusy("remove");
    try {
      const response = await fetch(
        `/api/device/accounts/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error();

      if (activeAccountId === id && accounts.length > 1) {
        const replacement = accounts.find(account => account.id !== id);
        if (replacement) switchAccount(replacement.id);
      }
      if (composeAccountId === id) {
        setComposeAccountId(NATIVE_ACCOUNT_ID);
        if (compose.draftId) {
          localStorage.setItem(draftSenderKey(compose.draftId), NATIVE_ACCOUNT_ID);
        }
      }
      await refreshAccounts();
      if (!isAdmin && accounts.length <= 1) window.location.reload();
    } catch {
      setError("Could not sign out this email account");
    } finally {
      setSettingsBusy(null);
    }
  };

  const removeSession = async (sessionId: string) => {
    if (!confirm("Sign out this browser session?")) return;

    setSettingsBusy(`session:${sessionId}`);
    try {
      const response = await fetch(`/api/auth/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error();

      setSessions((current) => current
        ? current.filter((session) => session.id !== sessionId)
        : current);
      setSessionCount((current) => current === null ? current : Math.max(0, current - 1));
    } catch {
      setError("Could not remove session");
    } finally {
      setSettingsBusy(null);
    }
  };

  const resetSessions = async () => {
    if (!confirm("Sign out every other browser and device? This device stays signed in.")) {
      return;
    }
    setSettingsBusy("sessions");
    try {
      const response = await fetch("/api/auth/sessions/reset", { method: "POST" });
      if (!response.ok) throw new Error();
      setSessions((current) => current ? current.filter((session) => session.current) : current);
      setSessionCount(1);
    } catch {
      setError("Could not reset sessions");
    } finally {
      setSettingsBusy(null);
    }
  };

  const logout = async () => {
    setSettingsBusy("logout");
    await fetch("/api/device/logout", { method: "POST" }).catch(() => undefined);
    location.reload();
  };

  const openMessage = async (id: string) => {
    const listItem = messages.find((message) => message.id === id);
    if (listItem?.isDraft || folder === "drafts") {
      try {
        const response = await fetch(`/api/drafts/${encodeURIComponent(id)}?accountId=${encodeURIComponent(activeAccountId)}`);
        const data = await response.json() as { draft: DraftDetail };
        if (!response.ok) throw new Error();

        const draft = data.draft;
        const savedSenderId = localStorage.getItem(draftSenderKey(draft.id));
        const draftSenderId = savedSenderId
          && accounts.some(
            (account) => account.id === savedSenderId && account.status === "active",
          )
          ? savedSenderId
          : draft.accountId || activeAccountId;
        setCompose({
          to: draft.to,
          cc: draft.cc,
          bcc: draft.bcc,
          subject: draft.subject,
          text: draft.text,
          replyToMessageId: draft.replyToMessageId,
          forwardMessageId: draft.forwardMessageId,
          draftId: draft.id,
        });
        setComposeAccountId(draftSenderId);
        setComposeOpen(true);
      } catch {
        setError("Could not open message");
      }
      return;
    }

    const requestId = ++openRequest.current;
    const key = detailCacheKey(id);
    const cached = detailCache.current.get(key);
    const wasUnread = Boolean(listItem && !listItem.isRead);

    setError(null);
    if (wasUnread) {
      setMessages((current) => current.map((message) =>
        message.id === id ? { ...message, isRead: true } : message));
      setUnreadCount((count) => Math.max(0, count - 1));
    }

    if (cached && Date.now() - cached.savedAt < DETAIL_CACHE_MS) {
      setSelected(cached.message);
      setThread(cached.thread);
      setOpeningMessageId(null);
    } else {
      if (cached) detailCache.current.delete(key);
      setSelected(null);
      setThread([]);
      setOpeningMessageId(id);
    }

    try {
      const params = new URLSearchParams({ accountId: activeAccountId });
      if (listItem?.threadId) params.set("threadId", listItem.threadId);
      const response = await fetch(
        `/api/messages/${encodeURIComponent(id)}?${params}`,
      );
      if (!response.ok) throw new Error();
      const data = await response.json() as {
        message: MessageDetail;
        thread: MessageDetail[];
        newlyReadCount: number;
      };
      if (requestId !== openRequest.current) return;

      const message = listItem?.senderAvatarUrl && !data.message.senderAvatarUrl
        ? { ...data.message, senderAvatarUrl: listItem.senderAvatarUrl }
        : data.message;
      const nextThread = data.thread.map((item) =>
        item.id === message.id ? message : item);
      detailCache.current.set(key, {
        savedAt: Date.now(),
        message,
        thread: nextThread,
      });
      setSelected(message);
      setThread(nextThread);
      setOpeningMessageId(null);
      setMessages((current) => current.map((item) =>
        item.id === id ? { ...item, isRead: true } : item));
      if (!wasUnread && data.newlyReadCount) {
        setUnreadCount((count) => Math.max(0, count - data.newlyReadCount));
      }
    } catch {
      if (requestId !== openRequest.current) return;
      setOpeningMessageId(null);
      if (wasUnread) {
        setMessages((current) => current.map((message) =>
          message.id === id ? { ...message, isRead: false } : message));
        setUnreadCount((count) => count + 1);
      }
      setError("Could not open message");
    }
  };

  const patchSelected = async (patch: Record<string, boolean>, close = false) => {
    if (!selected) return;

    const target = selected;
    const key = detailCacheKey(target.id);
    const previousMessages = messages;
    const previousSelected = selected;
    const previousThread = thread;
    const previousUnreadCount = unreadCount;
    const nextSelected = { ...target, ...patch } as MessageDetail;
    // The reader displays a collapsed conversation. Delete/restore that whole
    // conversation, not only its representative item (which would resurface
    // an older message with the same subject after the next refresh).
    const conversationMutation = typeof patch.isDeleted === "boolean";
    const matchesTarget = (message: MessageListItem) => conversationMutation
      ? message.threadId === target.threadId
      : message.id === target.id;
    const shieldKey = mailMutationKey(activeAccountId,
      conversationMutation ? target.threadId : target.id,
      conversationMutation ? "thread" : "message");
    mutationShields.current.set(shieldKey, {
      flags: patch as MailMutationFlags,
      updatedAt: Date.now(),
    });
    // Reject all GETs started before this write, including focus/pull refreshes.
    listRequest.current += 1;
    const keepInCurrentFolder = belongsInFolder(folder, nextSelected);

    setError(null);
    setMessages((current) => current
      .map((message) =>
        matchesTarget(message)
          ? { ...message, ...patch } as MessageListItem
          : message)
      .filter((message) =>
        !matchesTarget(message) || belongsInFolder(folder, message)));
    setThread((current) => current.map((message) =>
      message.id === target.id
        ? { ...message, ...patch } as MessageDetail
        : message));

    if (close || !keepInCurrentFolder) {
      setSelected(null);
      setThread([]);
    } else {
      setSelected(nextSelected);
    }

    const cached = detailCache.current.get(key);
    if (cached) {
      const cachedMessage = { ...cached.message, ...patch } as MessageDetail;
      const cachedThread = cached.thread.map((message) =>
        message.id === target.id ? cachedMessage : message);
      detailCache.current.set(key, {
        savedAt: Date.now(),
        message: cachedMessage,
        thread: cachedThread,
      });
    }

    try {
      const response = await fetch(
        `/api/messages/${encodeURIComponent(target.id)}?accountId=${encodeURIComponent(activeAccountId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(conversationMutation ? { ...patch, scope: "thread" } : patch),
        },
      );
      if (!response.ok) throw new Error();
      detailCache.current.delete(key);
      if (conversationMutation) {
        for (const item of previousThread) detailCache.current.delete(detailCacheKey(item.id));
      }
      if (mailViewRef.current.accountId === activeAccountId &&
          mailViewRef.current.folder === folder && mailViewRef.current.search === search) {
        await loadMessages(folder, search, true);
      }
    } catch {
      if (mailViewRef.current.accountId !== activeAccountId || mailViewRef.current.folder !== folder) return;
      mutationShields.current.delete(shieldKey);
      setMessages(previousMessages);
      setSelected(previousSelected);
      setThread(previousThread);
      setUnreadCount(previousUnreadCount);
      if (cached) detailCache.current.set(key, cached);
      else detailCache.current.delete(key);
      setError("Could not update message");
    }
  };

  const toggleMailSelection = (id: string) => {
    setSelectedMailIds((current) => current.includes(id)
      ? current.filter((value) => value !== id)
      : current.length < 50 ? [...current, id] : current);
  };

  const toggleAllMailSelection = (ids: string[]) => {
    setSelectedMailIds((current) => {
      const allSelected = ids.length > 0 && ids.every((id) => current.includes(id));
      return allSelected
        ? current.filter((id) => !ids.includes(id))
        : [...new Set([...current, ...ids])].slice(0, 50);
    });
  };

  const performBulkAction = async (action: string) => {
    if (bulkBusy || selectedMailIds.length === 0) return;
    const count = selectedMailIds.length;
    if (action === "permanent" &&
      !confirm("Permanently delete " + count + " message(s)? This cannot be undone.")) return;
    if (action === "deleteDraft" &&
      !confirm("Delete " + count + " draft(s) permanently? This cannot be undone.")) return;
    setBulkBusy(true);
    setError(null);
    const requestedIds = [...selectedMailIds];
    const flags: MailMutationFlags =
      action === "trash" ? { isDeleted: true } :
      action === "restore" ? { isDeleted: false } :
      action === "archive" ? { isArchived: true } :
      action === "unarchive" ? { isArchived: false } :
      action === "read" ? { isRead: true } :
      action === "unread" ? { isRead: false } :
      action === "junk" ? { isJunk: true } :
      action === "notJunk" ? { isJunk: false } :
      action === "star" ? { isStarred: true } :
      action === "unstar" ? { isStarred: false } : {};
    const hide = action === "permanent" || action === "deleteDraft";
    for (const id of requestedIds) {
      mutationShields.current.set(mailMutationKey(activeAccountId, id), {
        flags,
        hide,
        updatedAt: Date.now(),
      });
    }
    listRequest.current += 1;
    setMessages(current => applyMailMutationShields(folder, activeAccountId, current, mutationShields.current));
    try {
      const response = await fetch(
        "/api/messages/bulk?accountId=" + encodeURIComponent(activeAccountId),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: selectedMailIds, action }),
        },
      );
      const result = await response.json() as {
        error?: string; succeeded?: string[];
        failed?: Array<{id:string;error:string}>;
      };
      if (!response.ok && !result.succeeded?.length) throw new Error(result.error || result.failed?.[0]?.error || "Bulk action failed");
      for (const failure of result.failed ?? []) {
        mutationShields.current.delete(mailMutationKey(activeAccountId, failure.id));
      }
      if (mailViewRef.current.accountId !== activeAccountId ||
          mailViewRef.current.folder !== folder || mailViewRef.current.search !== search) return;
      const successIds = new Set(result.succeeded ?? []);
      for (const id of successIds) detailCache.current.delete(detailCacheKey(id));
      if (selected && successIds.has(selected.id)) {
        openRequest.current += 1;
        setSelected(null);
        setThread([]);
        setOpeningMessageId(null);
      }
      setSelectedMailIds(result.failed?.map((failure) => failure.id) ?? []);
      if (!result.failed?.length) setSelectionMode(false);
      await loadMessages(folder, search, true);
      if (result.failed?.length) {
        setError(result.failed.length + " message(s) could not be updated: " + result.failed[0].error);
      }
    } catch (cause) {
      for (const id of requestedIds) mutationShields.current.delete(mailMutationKey(activeAccountId, id));
      if (mailViewRef.current.accountId === activeAccountId && mailViewRef.current.folder === folder) {
        void loadMessages(folder, search, true);
      }
      setError(cause instanceof Error ? cause.message : "Bulk action failed");
    } finally {
      setBulkBusy(false);
    }
  };

  const permanentlyDeleteSelected = async () => {
    if (!selected || activeAccountId.startsWith("gmail:")) return;
    if (!confirm("Permanently delete this message? This cannot be undone.")) return;
    const id = selected.id;
    const shieldKey = mailMutationKey(activeAccountId, id);
    mutationShields.current.set(shieldKey, { flags: {}, hide: true, updatedAt: Date.now() });
    listRequest.current += 1;
    setMessages(current => current.filter(item => item.id !== id));
    setError(null);
    try {
      const response = await fetch(
        "/api/messages/" + encodeURIComponent(id) + "?accountId=" + encodeURIComponent(activeAccountId),
        { method: "DELETE" },
      );
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as {error?:string};
        throw new Error(data.error || "Could not delete permanently");
      }
      if (mailViewRef.current.accountId !== activeAccountId || mailViewRef.current.folder !== folder) return;
      openRequest.current += 1;
      setSelected(null);
      setThread([]);
      setOpeningMessageId(null);
      detailCache.current.delete(detailCacheKey(id));
      await loadMessages(folder, search, true);
    } catch (cause) {
      mutationShields.current.delete(shieldKey);
      if (mailViewRef.current.accountId === activeAccountId && mailViewRef.current.folder === folder) {
        void loadMessages(folder, search, true);
      }
      setError(cause instanceof Error ? cause.message : "Could not delete permanently");
    }
  };

  const startCompose = () => {
    const draftId = crypto.randomUUID();
    setCompose({ ...EMPTY_COMPOSE, draftId });
    setComposeAccountId(activeAccountId);
    localStorage.setItem(draftSenderKey(draftId), activeAccountId);
    setFiles([]);
    setDraftStatus(null);
    setComposeOpen(true);
  };

  const startReply = () => {
    if (!selected) return;
    const target = thread.at(-1) ?? selected;
    const draftId = crypto.randomUUID();
    setCompose({
      ...EMPTY_COMPOSE,
      to: target.direction === "inbound"
        ? target.fromAddress
        : target.toAddresses[0] ?? "",
      subject: replySubject(target.subject),
      replyToMessageId: target.id,
      draftId,
    });
    setComposeAccountId(activeAccountId);
    localStorage.setItem(draftSenderKey(draftId), activeAccountId);
    setComposeOpen(true);
  };

  const startForward = () => {
    if (!selected) return;
    const draftId = crypto.randomUUID();
    setCompose({
      ...EMPTY_COMPOSE,
      subject: forwardSubject(selected.subject),
      text: forwardedBody(selected),
      forwardMessageId: selected.id,
      draftId,
    });
    setComposeAccountId(activeAccountId);
    localStorage.setItem(draftSenderKey(draftId), activeAccountId);
    setComposeOpen(true);
  };

  const changeComposeAccount = (accountId: string) => {
    if (accountId === composeAccountId) return;
    // Draft IDs are mailbox-owned. Moving the sender must create a new draft
    // identity rather than trying to update an ID owned by another mailbox.
    const oldId = compose.draftId;
    const previousAccountId = composeAccountId;
    const nextId = crypto.randomUUID();
    setCompose((current) => ({ ...current, draftId: nextId }));
    setComposeAccountId(accountId);
    localStorage.setItem(draftSenderKey(nextId), accountId);
    if (oldId) {
      localStorage.removeItem(draftSenderKey(oldId));
      persistedDraftIds.current.delete(oldId);
      void fetch(`/api/drafts/${encodeURIComponent(oldId)}?accountId=${encodeURIComponent(previousAccountId)}`, {
        method: "DELETE",
      }).catch(() => undefined);
    }
  };

  const closeCompose = () => {
    if (hasDraftContent(compose)) void persistDraft(compose);
    setComposeOpen(false);
  };

  const discardCompose = async () => {
    if (compose.draftId) {
      localStorage.removeItem(draftSenderKey(compose.draftId));
      await fetch(`/api/drafts/${encodeURIComponent(compose.draftId)}?accountId=${encodeURIComponent(composeAccountId)}`, {
        method: "DELETE",
      }).catch(() => undefined);
    }
    setComposeOpen(false);
    setCompose(EMPTY_COMPOSE);
    setComposeAccountId(activeAccountId);
    setFiles([]);
    if (folder === "drafts") void loadMessages("drafts", search, true);
  };

  const submitCompose = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSending(true);
    try {
      const form = new FormData();
      form.set("accountId", composeAccountId);
      for (const key of [
        "to",
        "cc",
        "bcc",
        "subject",
        "text",
        "replyToMessageId",
        "forwardMessageId",
        "draftId",
      ] as const) {
        if (compose[key]) form.set(key, compose[key]);
      }
      files.forEach((file) => form.append("attachments", file));

      const response = await fetch("/api/send", { method: "POST", body: form });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error || "Email could not be sent");
      }

      if (compose.draftId) {
        localStorage.removeItem(draftSenderKey(compose.draftId));
      }
      setComposeOpen(false);
      setCompose(EMPTY_COMPOSE);
      setFiles([]);
      if (composeAccountId !== activeAccountId) {
        setActiveAccountId(composeAccountId);
      }
      setFolder("sent");
      if (folder === "sent" && composeAccountId === activeAccountId) void loadMessages("sent", search, true);
      setSelected(null);
      setThread([]);
      setOpeningMessageId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Email could not be sent");
    } finally {
      setSending(false);
    }
  };

  const closeReader = () => {
    openRequest.current += 1;
    setSelected(null);
    setThread([]);
    setOpeningMessageId(null);
  };

  const label = useMemo(
    () => FOLDERS.find((item) => item.key === folder)?.label ?? "Mail",
    [folder],
  );
  const notificationsDisabled = notificationControlsDisabled(notificationState);
  const readerOpen = Boolean(selected || openingMessageId);

  return (
    <main className={`app-shell ${readerOpen ? "message-open" : ""}`}>
      <Sidebar
        folders={FOLDERS}
        activeFolder={folder}
        unreadCount={unreadCount}
        draftCount={draftCount}
        notificationState={notificationState}
        notificationsDisabled={notificationsDisabled}
        accounts={accounts}
        activeAccountId={activeAccountId}
        connectingGmail={connectingGmail}
        onAccountChange={switchAccount}
        onAddInbox={openAddInbox}
        onFolderChange={changeFolder}
        onCompose={startCompose}
        onToggleNotifications={() => void toggleNotifications()}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="mail-workspace">
        <MailList
          folder={folder}
          folderLabel={label}
          messages={messages}
          selectedId={selected?.id ?? openingMessageId}
          loading={loading}
          search={search}
          unreadCount={unreadCount}
          notificationState={notificationState}
          notificationsDisabled={notificationsDisabled}
          onSearchChange={setSearch}
          onRefresh={() => loadMessages()}
          selectionMode={selectionMode}
          selectedIds={selectedMailIds}
          bulkBusy={bulkBusy}
          canPermanentlyDelete={accounts.find((account) => account.id === activeAccountId)?.provider === "native"}
          onToggleSelection={() => {
            setSelectionMode((current) => !current);
            setSelectedMailIds([]);
          }}
          onToggleMailSelected={toggleMailSelection}
          onToggleSelectAll={toggleAllMailSelection}
          onBulkAction={(action) => void performBulkAction(action)}
          onOpenMessage={(id) => void openMessage(id)}
          onToggleNotifications={() => void toggleNotifications()}
        />
        <MessageReader
          message={selected}
          thread={thread}
          folderLabel={label}
          loading={Boolean(openingMessageId && !selected)}
          accountId={activeAccountId}
          onBack={closeReader}
          onReply={startReply}
          onForward={startForward}
          onPatch={(patch, closeAfter) => void patchSelected(patch, closeAfter)}
          canPermanentlyDelete={accounts.find((account) => account.id === activeAccountId)?.provider === "native"}
          onPermanentDelete={() => void permanentlyDeleteSelected()}
        />
      </div>
      <MobileNav
        folders={FOLDERS}
        activeFolder={folder}
        unreadCount={unreadCount}
        draftCount={draftCount}
        accounts={accounts}
        activeAccountId={activeAccountId}
        connectingGmail={connectingGmail}
        onAccountChange={switchAccount}
        onAddInbox={openAddInbox}
        onOpenSettings={() => setSettingsOpen(true)}
        onFolderChange={changeFolder}
        onCompose={startCompose}
      />
      <ComposeModal
        open={composeOpen}
        compose={compose}
        files={files}
        sending={sending}
        draftStatus={draftStatus}
        accounts={accounts}
        senderAccountId={composeAccountId}
        onSenderAccountChange={changeComposeAccount}
        onChange={setCompose}
        onFilesChange={setFiles}
        onClose={closeCompose}
        onDiscard={() => void discardCompose()}
        onSubmit={submitCompose}
      />
      <SettingsModal
        open={settingsOpen}
        accounts={accounts}
        notificationState={notificationState}
        notificationsDisabled={notificationsDisabled}
        connectingGmail={connectingGmail}
        sessionCount={sessionCount}
        busy={settingsBusy}
        isAdmin={isAdmin}
        onClose={() => setSettingsOpen(false)}
        onToggleNotifications={() => void toggleNotifications()}
        onAddInbox={openAddInbox}
        onRemoveAccount={(id) => void removeAccount(id)}
        onEditProfile={() => {
          setSettingsOpen(false);
          setProfileOpen(true);
        }}
        onViewSessions={() => {
          setSessionsOpen(true);
          void refreshSessions();
        }}
        onResetSessions={() => void resetSessions()}
        onLogout={() => void logout()}
      />
      <AddInboxModal
        mode={addInboxMode}
        connectingGmail={connectingGmail}
        gmailError={addInboxMode === "choose" ? error : null}
        onClose={() => setAddInboxMode(null)}
        onBack={() => setAddInboxMode("choose")}
        onChooseCustom={() => setAddInboxMode("custom")}
        onChooseGmail={() => void connectGmail()}
        onCustomSignedIn={() => window.location.reload()}
      />
      <SessionListModal
        open={sessionsOpen}
        sessions={sessions}
        busy={settingsBusy !== null}
        onClose={() => setSessionsOpen(false)}
        onResetSessions={() => void resetSessions()}
        onRemoveSession={(id) => void removeSession(id)}
      />
      <ProfileModal
        open={profileOpen}
        photoUrl={profilePhotoUrl}
        onClose={() => {
          setProfileOpen(false);
          setSettingsOpen(true);
        }}
        onPhotoChange={(url) => {
          setProfilePhotoUrl(url);
          void refreshAccounts();
        }}
      />
      {error ? <div className="toast-error" role="alert">{error}</div> : null}
    </main>
  );
}
