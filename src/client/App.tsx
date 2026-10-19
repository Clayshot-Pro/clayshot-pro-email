import { AddInboxModal, type AddInboxMode } from "./components/AddInboxModal";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DETAIL_CACHE_MS,
  EMPTY_COMPOSE,
  FOLDERS,
  ADMIN_ACCOUNT_ID,
  base64UrlToArrayBuffer,
  belongsInFolder,
  draftSenderKey,
  forwardedBody,
  hasDraftContent,
  needsHomeScreenInstall,
  notificationControlsDisabled,
  type DetailCacheEntry,
} from "./appModel";
import { ComposeModal } from "./components/ComposeModal";
import { DeleteConfirmationDialog } from "./components/DeleteConfirmationDialog";
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
import { chunkBulkMessageIds, toggleVisibleSelection } from "./mailBulk";
import { applyMailMutationShields, mailMutationKey, type MailMutationFlags, type MailMutationShield } from "./mailMutationShields";
import { useActiveAccountAppearance } from "./appearance";
import { useAdminView } from "./adminView";
import {
  ALL_INBOXES_ID,
  accountLabel,
  allInboxesAvailable,
  groupByAccount,
  startingAccountId,
  mergeAccountLists,
  threadKey,
  unifiedAccounts,
  type AccountListResult,
} from "./allInboxes";

const TAB_ACCOUNT_KEY = "ltm:tab-mail-account";

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
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const [folderTotalCount, setFolderTotalCount] = useState<number | null>(null);
  const [pendingDeletion, setPendingDeletion] = useState<{
    kind: "single" | "bulk" | "draft";
    ids: string[];
    accountId: string;
    folder: Folder;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [compose, setCompose] = useState<ComposeState>(EMPTY_COMPOSE);
  const [composeAccountId, setComposeAccountId] = useState(ADMIN_ACCOUNT_ID);
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<"saving" | "saved" | "failed" | null>(null);
  const [notificationState, setNotificationState] = useState<NotificationState>("checking");
  const [pushPublicKey, setPushPublicKey] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [addInboxMode, setAddInboxMode] = useState<AddInboxMode>(null);
  // The app opens on All inboxes (or the only account) once accounts load;
  // returning from the admin panel keeps the mailbox open in this tab.
  const [activeAccountId, setActiveAccountId] = useState(() => {
    try { return sessionStorage.getItem(TAB_ACCOUNT_KEY) ?? ""; } catch { return ""; }
  });
  // The account of the open message; in All inboxes it differs per message.
  const [readerAccountId, setReaderAccountId] = useState<string | null>(null);
  const adminView = useAdminView();
  const unified = activeAccountId === ALL_INBOXES_ID;
  // Theme, accent, density, text size and icons follow the open mailbox.
  useActiveAccountAppearance(unified ? readerAccountId : activeAccountId);
  const [connectingGmail, setConnectingGmail] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The custom mailbox whose profile photo is being edited.
  const [profileAccountId, setProfileAccountId] = useState<string | null>(null);
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

  const detailCacheKey = (accountId: string, id: string) => `${accountId}:${id}`;
  // The account a listed message belongs to (its own in All inboxes).
  const accountOf = (id: string) => messages.find(message => message.id === id)?.accountId ?? activeAccountId;
  const knownAccount = (id: string) => id === ALL_INBOXES_ID
    ? allInboxesAvailable(accounts)
    : accounts.some(account => account.id === id);
  const defaultSenderId = () => unified
    ? (unifiedAccounts(accounts).find(account => account.id === ADMIN_ACCOUNT_ID)
      ?? unifiedAccounts(accounts)[0])?.id ?? ADMIN_ACCOUNT_ID
    : activeAccountId;

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
      if (needsHomeScreenInstall(navigator, matchMedia("(display-mode: standalone)").matches)) {
        setNotificationState("install");
        return;
      }
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
        // A subscription belongs to the sign-in it was made in. Re-register it on
        // every start, so a new sign-in (or an expired one) keeps receiving alerts.
        if (subscription && Notification.permission === "granted") {
          await fetch("/api/push/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(subscription.toJSON()),
          }).catch(() => undefined);
        }
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
        const fetchList = async (accountId: string) => {
          const params = new URLSearchParams({ folder: activeFolder, accountId });
          if (query.trim()) params.set("q", query.trim());
          const response = await fetch(`/api/messages?${params}`);
          if (!response.ok) throw new Error("Could not load mail");
          return await response.json() as {
            messages: MessageListItem[];
            unreadCount: number;
            draftCount: number;
            folderTotalCount?: number | null;
          };
        };
        let data: Awaited<ReturnType<typeof fetchList>>;
        let failedNames: string[] = [];
        if (activeAccountId === ALL_INBOXES_ID) {
          const targets = unifiedAccounts(accounts);
          const results = await Promise.all(targets.map(async (account): Promise<AccountListResult> => {
            try {
              return { accountId: account.id, ok: true, ...await fetchList(account.id) };
            } catch {
              return { accountId: account.id, ok: false };
            }
          }));
          const merged = mergeAccountLists(results);
          if (targets.length && merged.failedAccountIds.length === targets.length) throw new Error("Could not load mail");
          failedNames = merged.failedAccountIds.map(id => accountLabel(accounts.find(account => account.id === id)));
          data = merged;
        } else {
          data = await fetchList(activeAccountId);
        }
        if (requestId !== listRequest.current) return;
        if (failedNames.length && !silent) setError(`Could not load ${failedNames.join(", ")}. Other accounts are shown.`);
        const guarded = applyMailMutationShields(activeFolder, activeAccountId, data.messages, mutationShields.current);
        setMessages(guarded);
        setFolderTotalCount(typeof data.folderTotalCount === "number" ? data.folderTotalCount : null);
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
    [folder, search, activeAccountId, accounts],
  );

  useEffect(() => {
    // Do not request the previous default native account before the device's
    // actual authorized account list has loaded.
    if (!accountsLoaded || !knownAccount(activeAccountId)) return;
    const timer = setTimeout(
      () => void loadMessages(folder, search),
      search ? 250 : 0,
    );
    return () => clearTimeout(timer);
  }, [folder, search, activeAccountId, loadMessages, accountsLoaded, accounts]);

  useEffect(() => {
    const refresh = () => {
      if (accountsLoaded && knownAccount(activeAccountId) && document.visibilityState === "visible") {
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
    // Re-selecting the open account refreshes it; resetting state here would
    // leave the list on "Loading mail…" because the account never changes.
    if (id === activeAccountId) {
      void loadMessages(folder, search);
      return;
    }
    openRequest.current += 1;
    listRequest.current += 1;
    setMessages([]);
    setSelectionMode(false);
    setSelectedMailIds([]);
    setPendingDeletion(null);
    setBulkNotice(null);
    setFolderTotalCount(null);
    setUnreadCount(0);
    setDraftCount(0);
    setLoading(true);
    setActiveAccountId(id);
    try { sessionStorage.setItem(TAB_ACCOUNT_KEY, id); } catch { /* private mode */ }
    setSelected(null);
    setThread([]);
    setOpeningMessageId(null);
    setReaderAccountId(null);
    setSearch("");
  };

  useEffect(() => {
    if (!accountsLoaded || accounts.length === 0) return;
    if (knownAccount(activeAccountId)) return;
    const selectedId = startingAccountId(accounts);
    if (selectedId) switchAccount(selectedId);
  }, [accountsLoaded, accounts, activeAccountId]);

  // Draft saves run one at a time, in order, so a slow earlier save never
  // overwrites newer text. A draft that was sent, discarded or moved to
  // another account is closed: queued saves for it are dropped, and its
  // deletion waits for the save in flight (which would otherwise recreate it).
  const draftSaves = useRef<Promise<void>>(Promise.resolve());
  const closedDraftIds = useRef(new Set<string>());
  const closeDraft = (id: string) => {
    closedDraftIds.current.add(id);
    persistedDraftIds.current.delete(id);
    return draftSaves.current;
  };

  const persistDraft = useCallback((current: ComposeState) => {
    if (!current.draftId || !hasDraftContent(current)) return draftSaves.current;
    const accountId = composeAccountId;
    const save = async () => {
      if (closedDraftIds.current.has(current.draftId)) return;
      setDraftStatus("saving");
      try {
        const response = await fetch("/api/drafts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({
            id: current.draftId,
            accountId,
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
        if (closedDraftIds.current.has(current.draftId)) return;

        const known = persistedDraftIds.current.has(current.draftId);
        persistedDraftIds.current.add(current.draftId);
        if (!known) setDraftCount((count) => count + 1);
        setDraftStatus("saved");
      } catch {
        // Shown in the compose window: a draft that cannot be saved is never silent.
        if (!closedDraftIds.current.has(current.draftId)) setDraftStatus("failed");
      }
    };
    draftSaves.current = draftSaves.current.then(save, save);
    return draftSaves.current;
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
    setPendingDeletion(null);
    setBulkNotice(null);
    setFolderTotalCount(null);
    setFolder(nextFolder);
    setSelected(null);
    setThread([]);
    setOpeningMessageId(null);
    setReaderAccountId(null);
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
        setComposeAccountId(ADMIN_ACCOUNT_ID);
        if (compose.draftId) {
          localStorage.setItem(draftSenderKey(compose.draftId), ADMIN_ACCOUNT_ID);
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
    const accountId = listItem?.accountId ?? activeAccountId;
    if (listItem?.isDraft || folder === "drafts") {
      try {
        const response = await fetch(`/api/drafts/${encodeURIComponent(id)}?accountId=${encodeURIComponent(accountId)}`);
        const data = await response.json() as { draft: DraftDetail };
        if (!response.ok) throw new Error();

        const draft = data.draft;
        const savedSenderId = localStorage.getItem(draftSenderKey(draft.id));
        const draftSenderId = savedSenderId
          && accounts.some(
            (account) => account.id === savedSenderId && account.status === "active",
          )
          ? savedSenderId
          : draft.accountId || accountId;
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
        // An opened draft is already saved: editing it must not count it again.
        // It may have been closed earlier in this tab (a failed discard): reopen it.
        persistedDraftIds.current.add(draft.id);
        closedDraftIds.current.delete(draft.id);
        setComposeAccountId(draftSenderId);
        setComposeOpen(true);
      } catch {
        setError("Could not open message");
      }
      return;
    }

    const requestId = ++openRequest.current;
    const key = detailCacheKey(accountId, id);
    setReaderAccountId(accountId);
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
      const params = new URLSearchParams({ accountId });
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
      // Opening reads the whole native conversation (Gmail only the opened
      // message); the optimistic -1 above already covered the opened item.
      const wholeThread = listItem && !accountId.startsWith("gmail:");
      setMessages((current) => current.map((item) =>
        item.id === id || (wholeThread && threadKey(item) === threadKey(listItem))
          ? { ...item, isRead: true } : item));
      const furtherRead = data.newlyReadCount - (wasUnread ? 1 : 0);
      if (furtherRead) setUnreadCount((count) => Math.max(0, count - furtherRead));
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
    const accountId = readerAccountId ?? activeAccountId;
    const key = detailCacheKey(accountId, target.id);
    const previousMessages = messages;
    const previousSelected = selected;
    const previousThread = thread;
    const previousUnreadCount = unreadCount;
    const nextSelected = { ...target, ...patch } as MessageDetail;
    // The reader displays a collapsed conversation. Delete, archive or junk
    // that whole conversation, not only its representative item (which would
    // resurface an older message of the conversation after the next refresh).
    const conversationMutation = Object.keys(patch).length === 1 &&
      ["isDeleted", "isArchived", "isJunk"].some((key) => typeof patch[key] === "boolean");
    // Same rule as the server: archiving or junking moves the received mail
    // and the opened message, so your own replies stay in Sent; undoing it,
    // and deleting, take the whole conversation.
    const wholeThread = typeof patch.isDeleted === "boolean" || Object.values(patch).every(value => value === false);
    const inThread = (message: { id: string; threadId: string; direction: string }) => message.id === target.id
      || (message.threadId === target.threadId && (wholeThread || message.direction === "inbound"));
    const matchesTarget = (message: MessageListItem) => (message.accountId ?? activeAccountId) === accountId
      && (conversationMutation ? inThread(message) : message.id === target.id);
    // A thread shield covers every message of the conversation; archive and
    // junk shield exactly the messages they move.
    const shieldKeys = conversationMutation && wholeThread
      ? [mailMutationKey(accountId, target.threadId, "thread")]
      : messages.filter(matchesTarget).map(message => mailMutationKey(accountId, message.id))
        .concat(mailMutationKey(accountId, target.id));
    for (const key of shieldKeys) {
      mutationShields.current.set(key, {
        flags: patch as MailMutationFlags,
        updatedAt: Date.now(),
      });
    }
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
      (conversationMutation && inThread(message)) || message.id === target.id
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
        `/api/messages/${encodeURIComponent(target.id)}?accountId=${encodeURIComponent(accountId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(conversationMutation ? { ...patch, scope: "thread" } : patch),
        },
      );
      if (!response.ok) throw new Error();
      detailCache.current.delete(key);
      if (conversationMutation) {
        for (const item of previousThread) detailCache.current.delete(detailCacheKey(accountId, item.id));
      }
      if (mailViewRef.current.accountId === activeAccountId &&
          mailViewRef.current.folder === folder && mailViewRef.current.search === search) {
        await loadMessages(folder, search, true);
      }
    } catch {
      if (mailViewRef.current.accountId !== activeAccountId || mailViewRef.current.folder !== folder) return;
      for (const key of shieldKeys) mutationShields.current.delete(key);
      setMessages(previousMessages);
      setSelected(previousSelected);
      setThread(previousThread);
      setUnreadCount(previousUnreadCount);
      if (cached) detailCache.current.set(key, cached);
      else detailCache.current.delete(key);
      setError("Could not update message");
    }
  };

  // Mailbox refreshes can replace the first page and remove permanently
  // deleted records. Never keep dangling selected IDs after a completed edit.
  useEffect(() => {
    if (!selectionMode || bulkBusy) return;
    const listed = new Set(messages.map(item => item.id));
    setSelectedMailIds(current => {
      const next = current.filter(id => listed.has(id));
      return next.length === current.length ? current : next;
    });
  }, [messages, selectionMode, bulkBusy]);

  const toggleMailSelection = (id: string) => {
    if (bulkBusy) return;
    setSelectedMailIds((current) => current.includes(id)
      ? current.filter((value) => value !== id)
      : [...current, id]);
  };

  const toggleAllMailSelection = (ids: string[]) => {
    if (bulkBusy) return;
    setSelectedMailIds((current) => toggleVisibleSelection(current, ids));
  };

  const performBulkAction = async (
    action: string,
    ids: string[] = selectedMailIds,
    confirmed = false,
  ) => {
    if (bulkBusy || ids.length === 0) return;
    if (!confirmed && (action === "permanent" || action === "deleteDraft")) {
      setPendingDeletion({
        kind: action === "permanent" ? "bulk" : "draft",
        ids: [...ids],
        accountId: activeAccountId,
        folder,
      });
      return;
    }

    const requestedIds = [...new Set(ids)];
    setBulkBusy(true);
    setError(null);
    setBulkNotice(null);
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
    const owners = new Map(requestedIds.map(id => [id, accountOf(id)]));
    const ownerOf = (id: string) => owners.get(id) ?? activeAccountId;
    for (const id of requestedIds) {
      mutationShields.current.set(mailMutationKey(ownerOf(id), id), {
        flags,
        hide,
        updatedAt: Date.now(),
      });
    }
    // Invalidate stale GET requests to avoid resurrecting deleted mail.
    listRequest.current += 1;
    setMessages(current => applyMailMutationShields(folder, activeAccountId, current, mutationShields.current));

    const succeeded: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    try {
      const batches = [...groupByAccount(requestedIds, ownerOf)]
        .flatMap(([accountId, ids]) => chunkBulkMessageIds(ids).map(batch => ({ accountId, batch })));
      for (const { accountId, batch } of batches) {
        try {
          const response = await fetch(
            "/api/messages/bulk?accountId=" + encodeURIComponent(accountId),
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ids: batch, action }),
              signal: AbortSignal.timeout(20_000),
            },
          );
          const result = await response.json() as {
            error?: string;
            succeeded?: string[];
            failed?: Array<{id:string;error:string}>;
          };
          const batchSuccess = new Set((result.succeeded ?? []).filter(id => batch.includes(id)));
          if (!response.ok && batchSuccess.size === 0) {
            throw new Error(result.error || result.failed?.[0]?.error || "Bulk action failed");
          }
          const failures = new Map((result.failed ?? []).map(item => [item.id, item.error]));
          for (const id of batch) {
            if (batchSuccess.has(id)) succeeded.push(id);
            else failed.push({ id, error: failures.get(id) || result.error || "Message was not updated" });
          }
        } catch (cause) {
          const error = cause instanceof Error ? cause.message : "Bulk action failed";
          for (const id of batch) failed.push({ id, error });
        }
      }

      for (const item of failed) {
        mutationShields.current.delete(mailMutationKey(ownerOf(item.id), item.id));
      }
      if (mailViewRef.current.accountId !== activeAccountId ||
          mailViewRef.current.folder !== folder || mailViewRef.current.search !== search) return;
      const successIds = new Set(succeeded);
      for (const id of successIds) detailCache.current.delete(detailCacheKey(ownerOf(id), id));
      if (selected && successIds.has(selected.id)) {
        openRequest.current += 1;
        setSelected(null);
        setThread([]);
        setOpeningMessageId(null);
      }
      // Always exit selection mode after a completed attempt, including
      // partial failures. A permanently removed message must never remain
      // checked or count toward a future bulk action.
      setSelectedMailIds([]);
      setSelectionMode(false);
      await loadMessages(folder, search, true);
      if (failed.length) {
        setError(`${succeeded.length} updated; ${failed.length} could not be updated: ${failed[0].error}. Select the remaining messages to retry.`);
      } else {
        setBulkNotice(`${succeeded.length} message(s) ${action === "permanent" ? "permanently deleted" : action === "trash" ? "moved to Trash" : "updated"}. More messages may appear from the next page.`);
      }
    } finally {
      // A timed-out or interrupted batch must not leave every checkbox
      // permanently disabled. Refresh the authoritative server state so
      // already-committed deletes can be reconciled.
      setBulkBusy(false);
    }
  };

  const permanentlyDeleteSelected = async (confirmed = false, targetId = selected?.id) => {
    const accountId = readerAccountId ?? activeAccountId;
    if (!selected || !targetId || selected.id !== targetId || accountId.startsWith("gmail:")) return;
    if (!confirmed) {
      setPendingDeletion({ kind: "single", ids: [targetId], accountId: activeAccountId, folder });
      return;
    }
    const id = targetId;
    const shieldKey = mailMutationKey(accountId, id);
    mutationShields.current.set(shieldKey, { flags: {}, hide: true, updatedAt: Date.now() });
    listRequest.current += 1;
    setMessages(current => current.filter(item => !(item.id === id && (item.accountId ?? activeAccountId) === accountId)));
    setError(null);
    try {
      const response = await fetch(
        "/api/messages/" + encodeURIComponent(id) + "?accountId=" + encodeURIComponent(accountId),
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
      detailCache.current.delete(detailCacheKey(accountId, id));
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
    const sender = defaultSenderId();
    setComposeAccountId(sender);
    localStorage.setItem(draftSenderKey(draftId), sender);
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
    // Reply from the account that received the message.
    const sender = readerAccountId ?? activeAccountId;
    setComposeAccountId(sender);
    localStorage.setItem(draftSenderKey(draftId), sender);
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
    const sender = readerAccountId ?? activeAccountId;
    setComposeAccountId(sender);
    localStorage.setItem(draftSenderKey(draftId), sender);
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
      void closeDraft(oldId).then(() => fetch(`/api/drafts/${encodeURIComponent(oldId)}?accountId=${encodeURIComponent(previousAccountId)}`, {
        method: "DELETE",
      })).catch(() => undefined);
    }
  };

  const closeCompose = () => {
    if (hasDraftContent(compose)) void persistDraft(compose);
    setComposeOpen(false);
  };

  const discardCompose = async () => {
    if (compose.draftId) {
      localStorage.removeItem(draftSenderKey(compose.draftId));
      await closeDraft(compose.draftId);
      await fetch(`/api/drafts/${encodeURIComponent(compose.draftId)}?accountId=${encodeURIComponent(composeAccountId)}`, {
        method: "DELETE",
      }).catch(() => undefined);
    }
    setComposeOpen(false);
    setCompose(EMPTY_COMPOSE);
    setComposeAccountId(defaultSenderId());
    setFiles([]);
    if (folder === "drafts") void loadMessages("drafts", search, true);
  };

  const submitCompose = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setComposeError(null);
    setSending(true);
    try {
      // The send deletes the draft: let an autosave in flight land first.
      await draftSaves.current;
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
        void closeDraft(compose.draftId);
      }
      setComposeOpen(false);
      setComposeError(null);
      setCompose(EMPTY_COMPOSE);
      setFiles([]);
      // All inboxes stays open and shows the sent message among the others.
      // switchAccount also clears the old mailbox's list, counts and tab memory.
      if (!unified && composeAccountId !== activeAccountId) {
        switchAccount(composeAccountId);
      }
      setFolder("sent");
      if (folder === "sent" && (unified || composeAccountId === activeAccountId)) void loadMessages("sent", search, true);
      setSelected(null);
      setThread([]);
      setOpeningMessageId(null);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Email could not be sent";
      setError(message);
      setComposeError(message);
    } finally {
      setSending(false);
    }
  };

  const blockSender = async (address: string) => {
    const accountId = readerAccountId ?? activeAccountId;
    const mailbox = accounts.find(account => account.id === accountId)?.emailAddress ?? "this mailbox";
    if (!confirm(`Block ${address}? Their mail to ${mailbox} will go straight to Junk, including messages already here. You can unblock them in Settings.`)) return;
    setError(null);
    try {
      const response = await fetch(`/api/blocked-senders?accountId=${encodeURIComponent(accountId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender: address, moveExisting: true }),
      });
      const data = await response.json().catch(() => ({})) as { moved?: number; error?: string };
      if (!response.ok) throw new Error(data.error || "Could not block the sender");
      // Moved messages changed folders: drop cached copies and refresh.
      for (const key of [...detailCache.current.keys()]) {
        if (key.startsWith(`${accountId}:`)) detailCache.current.delete(key);
      }
      if (folder !== "junk") closeReader();
      setBulkNotice(`${address} blocked${data.moved ? `; ${data.moved} message(s) moved to Junk` : ""}.`);
      await loadMessages(folder, search, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not block the sender");
    }
  };

  const closeReader = () => {
    openRequest.current += 1;
    setSelected(null);
    setThread([]);
    setOpeningMessageId(null);
    setReaderAccountId(null);
  };

  const label = useMemo(() => {
    const folderLabel = FOLDERS.find((item) => item.key === folder)?.label ?? "Mail";
    if (!unified) return folderLabel;
    return folder === "inbox" ? "All inboxes" : `${folderLabel} · all accounts`;
  }, [folder, unified]);
  const readerAccount = accounts.find(account => account.id === (readerAccountId ?? activeAccountId));
  const showAllInboxes = allInboxesAvailable(accounts);
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
        showAllInboxes={showAllInboxes}
        connectingGmail={connectingGmail}
        onAccountChange={switchAccount}
        onAddInbox={openAddInbox}
        onFolderChange={changeFolder}
        onCompose={startCompose}
        onToggleNotifications={() => void toggleNotifications()}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenAdmin={adminView.isAdmin ? adminView.openAdmin : undefined}
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
          folderTotalCount={folderTotalCount}
          bulkNotice={bulkNotice}
          canPermanentlyDelete={unified
            ? unifiedAccounts(accounts).some((account) => account.provider === "native")
            : accounts.find((account) => account.id === activeAccountId)?.provider === "native"}
          accountLabelFor={unified
            ? (message) => accountLabel(accounts.find((account) => account.id === message.accountId))
            : undefined}
          onToggleSelection={() => {
            if (bulkBusy) return;
            setSelectionMode((current) => !current);
            setSelectedMailIds([]);
            setBulkNotice(null);
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
          accountId={readerAccountId ?? activeAccountId}
          onBack={closeReader}
          onReply={startReply}
          onForward={startForward}
          onPatch={(patch, closeAfter) => void patchSelected(patch, closeAfter)}
          canPermanentlyDelete={readerAccount?.provider === "native"}
          onBlockSender={readerAccount?.provider === "native" ? (address) => void blockSender(address) : undefined}
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
        showAllInboxes={showAllInboxes}
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
        sendError={composeError}
        draftStatus={draftStatus}
        accounts={accounts}
        senderAccountId={composeAccountId}
        onSenderAccountChange={(id) => { setComposeError(null); changeComposeAccount(id); }}
        onChange={(next) => { setComposeError(null); setCompose(next); }}
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
        activeAccountId={unified ? readerAccountId : activeAccountId}
        onOpenAdmin={adminView.isAdmin ? adminView.openAdmin : undefined}
        onClose={() => setSettingsOpen(false)}
        onToggleNotifications={() => void toggleNotifications()}
        onAddInbox={openAddInbox}
        onRemoveAccount={(id) => void removeAccount(id)}
        onEditProfile={(accountId) => {
          setSettingsOpen(false);
          setProfileAccountId(accountId);
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
        open={profileAccountId !== null}
        accountId={profileAccountId ?? ""}
        emailAddress={accounts.find(account => account.id === profileAccountId)?.emailAddress ?? ""}
        photoUrl={accounts.find(account => account.id === profileAccountId)?.avatarUrl ?? null}
        onClose={() => {
          setProfileAccountId(null);
          setSettingsOpen(true);
        }}
        onPhotoChange={() => void refreshAccounts()}
      />
      {pendingDeletion ? (
        <DeleteConfirmationDialog
          kind={pendingDeletion.kind}
          count={pendingDeletion.ids.length}
          onCancel={() => setPendingDeletion(null)}
          onConfirm={() => {
            const target = pendingDeletion;
            setPendingDeletion(null);
            if (bulkBusy || target.accountId !== activeAccountId || target.folder !== folder) return;
            if (target.kind === "single") {
              void permanentlyDeleteSelected(true, target.ids[0]);
            } else {
              void performBulkAction(target.kind === "draft" ? "deleteDraft" : "permanent", target.ids, true);
            }
          }}
        />
      ) : null}
      {error ? <div className="toast-error" role="alert">{error}</div> : null}
    </main>
  );
}
